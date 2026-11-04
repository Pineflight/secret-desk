import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { writePrivateFile } from "./platform.js";
import { parseDocument, type Document } from "yaml";
import {
  VariableSchema,
  type VariableEntry,
  EnvEntrySchema,
  EnvTemplateSchema,
  InventorySchema,
  ProviderDefSchema,
  ResourceMapEntrySchema,
  type ResourceMapEntry,
  SecretSchema,
  type EnvTemplate,
  type Inventory,
  type ProviderDef,
  type SecretEntry,
} from "./types.js";
import { StageDefSchema, StageError, resolvePlaces, type StageDef } from "./stages.js";
import type { VariableSource } from "./variable-sources.js";
import type { z } from "zod";

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

/**
 * The file changed on disk and a pending change could not be applied to the new content (or the new content is not
 * valid). Nothing was overwritten. Subclass of InventoryError so existing handlers still catch it; the portal maps it to 409.
 */
export class InventoryConflictError extends InventoryError {
  constructor(message: string) {
    super(message);
    this.name = "InventoryConflictError";
  }
}

/** The file on disk cannot be parsed or validated (a writer may still be working on it). */
class InvalidDiskError extends InventoryConflictError {}

/** A change that was applied in memory but is not on disk yet. `replay` re-applies it to a freshly loaded document. */
interface PendingChange {
  replay: () => void;
  replayable: boolean;
}

/** Why the file on disk is not taken over. Reported after it stayed invalid for `INVALID_GRACE_MS`. */
export interface InventoryProblem {
  message: string;
  since: string;
  persistent: boolean;
}

/** How long an unreadable file is tolerated silently (editors and non-atomic writers need a moment). */
const INVALID_GRACE_MS = 3000;
/** Without a stat change the content is hashed again after this long (mtime granularity, copies that keep the mtime). */
const REHASH_AFTER_MS = 1000;
/** An invalid file is looked at again at most this often. */
const INVALID_RETRY_MS = 250;
const SAVE_ATTEMPTS = 6;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FileStat {
  mtimeMs: number;
  size: number;
  ino: number;
}

const sameStat = (a: FileStat | null, b: FileStat | null): boolean => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;

function statOf(path: string): FileStat | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    return null;
  }
}

/** Eine Aenderung an einem Eintrag fuer applyEdits: nur diese Felder, alles andere bleibt unveraendert. */
export interface EntryEdit {
  kind: "secret" | "variable";
  id: string;
  name?: string;
  stage?: string;
  /** Nur Secrets. */
  provider?: string;
  /** Nur Secrets: setzt diese Parameter-Schluessel, andere Parameter bleiben. */
  params?: Record<string, unknown>;
  /** Nur Variablen. */
  from?: VariableSource;
}

type Patchable = Pick<SecretEntry, "expires" | "rotatedAt" | "verifiedAt" | "verifiedBy" | "externalId" | "notes" | "ttlDays" | "expiry" | "title" | "description" | "owner" | "link" | "tags" | "product">;

/** Die einzigen Felder, die patchSecret setzt. Gleicht patch.ts (SecretHumanPatchSchema) ab; ein Test haelt beide gleich. */
export const PATCHABLE_SECRET_KEYS: readonly string[] = ["expires", "rotatedAt", "verifiedAt", "verifiedBy", "externalId", "notes", "ttlDays", "expiry", "title", "description", "owner", "link", "tags", "product"];

/**
 * Das Inventar als YAML-Datei. Nur Metadaten, nie Werte. Aenderungen gehen ueber das
 * YAML-Dokument, damit Kommentare und Reihenfolge erhalten bleiben.
 *
 * Mehrere Prozesse (Portal, CLI, Skripte) schreiben dieselbe Datei. Deshalb folgt der Speicher der Datei:
 *  - Vor jedem Lesen prueft er billig (stat, dann Inhalts-Hash), ob die Datei anders ist als beim letzten Laden oder
 *    Schreiben, und laedt sie dann neu. Eine Datei, die nicht parst oder nicht validiert, wird nicht uebernommen.
 *  - Jede Aenderung wird als Funktion des Dokuments gemerkt. Hat sich die Datei zwischen Aenderung und save() geaendert,
 *    wird frisch geladen, die Aenderung erneut angewendet und dann geschrieben. Nie ueber eine neuere Datei schreiben.
 */
export class InventoryStore {
  #doc: Document;
  #data!: Inventory;
  #saving: Promise<void> = Promise.resolve();
  /** Hash des Dateiinhalts, auf dem `#doc` (ohne `#pending`) beruht. null = noch nie gelesen oder geschrieben. */
  #baseHash: string | null = null;
  #stat: FileStat | null = null;
  #verifiedAt = 0;
  /** true, solange der Speicher aus Text mit Pfad stammt und die Datei noch nie geschrieben wurde. */
  #unwritten = false;
  #pending: PendingChange[] = [];
  #version = 0;
  #problem: { message: string; since: number } | null = null;
  #invalidStat: FileStat | null = null;
  #invalidAt = 0;
  #stale = false;
  #saveRuns = 0;
  #refreshing = false;
  readonly #listeners = new Set<() => void>();

  private constructor(
    readonly path: string | null,
    text: string,
    fromFile: boolean,
  ) {
    const built = buildDocument(text);
    this.#doc = built.doc;
    this.#data = built.data;
    if (path) {
      if (fromFile) {
        this.#baseHash = sha256(text);
        this.#stat = statOf(path);
        this.#verifiedAt = Date.now();
      } else this.#unwritten = true;
    }
  }

  static async open(path: string): Promise<InventoryStore> {
    return new InventoryStore(path, await readFile(path, "utf8"), true);
  }

  static fromText(text: string, path: string | null = null): InventoryStore {
    return new InventoryStore(path, text, false);
  }

  get data(): Inventory {
    this.#refresh();
    return this.#data;
  }

  /** Zaehlt jede Aenderung des Inhalts hoch (eigene und fremde). Die Oberflaeche vergleicht sie, um neu zu laden. */
  get version(): number {
    this.#refresh();
    return this.#version;
  }

  /** Gesetzt, wenn die Datei auf der Platte laenger als ein paar Sekunden nicht gelesen werden kann. Der alte Stand bleibt. */
  get problem(): InventoryProblem | null {
    this.#refresh();
    if (!this.#problem) return null;
    return { message: this.#problem.message, since: new Date(this.#problem.since).toISOString(), persistent: Date.now() - this.#problem.since >= INVALID_GRACE_MS };
  }

  /** Wird nach jedem Nachladen einer von aussen geaenderten Datei aufgerufen (Cache-Invalidierung, Freigaben pruefen). */
  onExternalChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Beobachtet das Verzeichnis (nicht die Datei: atomares Schreiben ersetzt die Datei) und laedt entprellt neu. Nur ein
   * Hinweis: Auf Bind-Mounts und Netzwerkdateisystemen fehlen Ereignisse, deshalb prueft jedes Lesen die Datei ohnehin.
   */
  watch(options: { debounceMs?: number } = {}): () => void {
    if (!this.path) return () => undefined;
    const file = basename(this.path);
    const debounce = options.debounceMs ?? 100;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | null = null;
    const hint = (): void => {
      this.#stale = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        this.#refresh();
        // A file that is still half written is looked at again shortly (the next read retries as well).
        if (this.#problem) timer = setTimeout(() => { timer = null; this.#refresh(); }, 500);
      }, debounce);
      timer.unref?.();
    };
    try {
      watcher = fsWatch(dirname(this.path), { persistent: false }, (_event, name) => {
        if (name === null || name === undefined || String(name) === file) hint();
      });
      watcher.on("error", () => undefined);
    } catch {
      watcher = null;
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }

  getSecret(id: string): SecretEntry | undefined {
    return this.data.secrets.find((s) => s.id === id);
  }

  toString(): string {
    this.#refresh();
    return this.#doc.toString();
  }

  patchSecret(id: string, patch: { [K in keyof Patchable]?: Patchable[K] | null }): SecretEntry {
    const unknown = Object.keys(patch).filter((k) => !PATCHABLE_SECRET_KEYS.includes(k));
    if (unknown.length > 0) throw new InventoryError(`Feld nicht erlaubt: ${unknown.join(", ")}`);
    return this.#mutate(() => {
      const idx = this.#findSecretIndex(id);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
          if (key === "expires") this.#doc.setIn(["secrets", idx, key], null);
          else this.#doc.deleteIn(["secrets", idx, key]);
        } else this.#doc.setIn(["secrets", idx, key], value);
      }
    }, () => this.#findSecret(id)!);
  }

  /**
   * Setzt Parameter eines Eintrags: `set` ueberschreibt einzelne Schluessel, `remove` entfernt welche. Alle anderen
   * Schluessel (auch unbekannte) bleiben unveraendert. Die Pruefung gegen die Spezifikation macht der Aufrufer.
   */
  setSecretParams(id: string, set: Record<string, unknown>, remove: string[] = []): SecretEntry {
    return this.#mutate(() => {
      const idx = this.#findSecretIndex(id);
      for (const key of remove) this.#doc.deleteIn(["secrets", idx, "params", key]);
      for (const [key, value] of Object.entries(set)) this.#doc.setIn(["secrets", idx, "params", key], this.#doc.createNode(clean(value)));
    }, () => this.#findSecret(id)!);
  }

  /**
   * Wendet mehrere Aenderungen an Eintraegen auf einmal an (Namen, Stage, Anbieter, Parameter, Quelle). Alles oder nichts:
   * schlaegt die Validierung oder `verify` fehl, bleibt das Inventar unveraendert. Speichern ist Sache des Aufrufers.
   * Die Ids der Eintraege bleiben, sie werden hier nie geaendert.
   */
  applyEdits(edits: EntryEdit[], verify?: (next: Inventory) => void): void {
    const index = (kind: "secret" | "variable", id: string): number => {
      const idx = (kind === "secret" ? this.#data.secrets : this.#data.variables).findIndex((e) => e.id === id);
      if (idx < 0) throw new InventoryError(kind === "secret" ? `Secret nicht gefunden: ${id}` : `Variable nicht gefunden: ${id}`);
      return idx;
    };
    this.#mutate(() => {
      const targets = edits.map((e) => ({ edit: e, path: [e.kind === "secret" ? "secrets" : "variables", index(e.kind, e.id)] as (string | number)[] }));
      for (const { edit, path } of targets) {
        if (edit.name !== undefined) this.#doc.setIn([...path, "name"], edit.name);
        if (edit.stage !== undefined) this.#doc.setIn([...path, "stage"], edit.stage);
        if (edit.provider !== undefined) this.#doc.setIn([...path, "provider"], edit.provider);
        for (const [key, value] of Object.entries(edit.params ?? {})) this.#doc.setIn([...path, "params", key], this.#doc.createNode(clean(value)));
        if (edit.from !== undefined) this.#doc.setIn([...path, "from"], this.#doc.createNode(clean(edit.from)));
      }
    }, () => verify?.(this.#data));
  }

  /** Ersetzt die Standardwerte einer Integration; leer entfernt sie. */
  setIntegrationDefaults(connection: string, values: Record<string, unknown>): Record<string, unknown> {
    return this.#mutate(() => {
      if (Object.keys(values).length === 0) {
        // Ohne vorhandenen Abschnitt gibt es nichts zu entfernen (deleteIn wirft sonst).
        if (this.#doc.hasIn(["integrationDefaults", connection])) this.#doc.deleteIn(["integrationDefaults", connection]);
        if (this.#doc.hasIn(["integrationDefaults"]) && Object.keys((this.#doc.getIn(["integrationDefaults"]) as { toJSON(): object }).toJSON()).length === 0) this.#doc.deleteIn(["integrationDefaults"]);
      } else this.#doc.setIn(["integrationDefaults", connection], this.#doc.createNode(clean(values)));
    }, () => this.#data.integrationDefaults?.[connection] ?? {});
  }

  /** Setzt einen Zuordnungseintrag; (kind, repo, stage) ist der Schluessel, ein vorhandener Eintrag wird ersetzt. */
  setResourceMap(entry: ResourceMapEntry): ResourceMapEntry {
    const parsed = ResourceMapEntrySchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    const e = parsed.data;
    return this.#mutate(() => {
      const list = [...(this.#data.resourceMap ?? [])];
      const idx = list.findIndex((x) => sameMapKey(x, e));
      if (idx >= 0) list[idx] = e;
      else list.push(e);
      this.#doc.setIn(["resourceMap"], this.#doc.createNode(clean(list)));
    }, () => e);
  }

  /** Entfernt einen Zuordnungseintrag. Gibt zurueck, ob es ihn gab. */
  removeResourceMapEntry(key: { kind: string; repo: string; stage?: string | undefined }): boolean {
    return this.#mutate(() => {
      const list = this.#data.resourceMap ?? [];
      const next = list.filter((x) => !sameMapKey(x, key));
      if (next.length === list.length) return false;
      if (next.length === 0) this.#doc.deleteIn(["resourceMap"]);
      else this.#doc.setIn(["resourceMap"], this.#doc.createNode(clean(next)));
      return true;
    }, (removed) => removed);
  }

  addSecret(entry: z.input<typeof SecretSchema>): SecretEntry {
    const parsed = SecretSchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => {
      if (this.#findSecret(parsed.data.id)) throw new InventoryError(`id existiert schon: ${parsed.data.id}`);
      const places = this.#resolve(parsed.data.stage, parsed.data.places);
      this.#addNode(["secrets"], { ...entry, places });
    }, () => this.#findSecret(parsed.data.id)!);
  }

  /** Die wirksamen Stage-Definitionen (Standard, wenn das Inventar keine nennt). */
  get stages(): StageDef[] {
    return this.data.stages;
  }

  /** Ersetzt die Stage-Liste komplett. Unbekannte Stages in Secrets/Variablen/Vorlagen lehnt die Validierung ab. */
  setStages(defs: z.input<typeof StageDefSchema>[]): StageDef[] {
    const parsed = StageDefSchema.array().safeParse(defs);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => this.#doc.set("stages", this.#doc.createNode(clean(parsed.data))), () => this.#data.stages);
  }

  #resolve<P extends { scope: string; environment?: string | undefined }>(stage: string, places: P[]): P[] {
    try {
      return resolvePlaces(this.#data.stages, stage, places);
    } catch (err) {
      if (err instanceof StageError) throw new InventoryError(err.message);
      throw err;
    }
  }

  // Lookups inside mutations use the in-memory data directly: a refresh in the middle of a change must never swap the document.
  #findSecret(id: string): SecretEntry | undefined {
    return this.#data.secrets.find((s) => s.id === id);
  }

  #findSecretIndex(id: string): number {
    const idx = this.#data.secrets.findIndex((s) => s.id === id);
    if (idx < 0) throw new InventoryError(`Secret nicht gefunden: ${id}`);
    return idx;
  }

  #findVariable(id: string): VariableEntry | undefined {
    return this.#data.variables.find((v) => v.id === id);
  }

  #findVariableIndex(id: string): number {
    const idx = this.#data.variables.findIndex((v) => v.id === id);
    if (idx < 0) throw new InventoryError(`Variable nicht gefunden: ${id}`);
    return idx;
  }

  getVariable(id: string): VariableEntry | undefined {
    return this.data.variables.find((v) => v.id === id);
  }

  addVariable(entry: z.input<typeof VariableSchema>): VariableEntry {
    const parsed = VariableSchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => {
      if (this.#findVariable(parsed.data.id) || this.#findSecret(parsed.data.id)) throw new InventoryError(`id existiert schon: ${parsed.data.id}`);
      const places = this.#resolve(parsed.data.stage, parsed.data.places);
      this.#addNode(["variables"], { ...entry, places });
    }, () => this.#findVariable(parsed.data.id)!);
  }

  patchVariable(id: string, patch: { value?: string | null; description?: string | null; owner?: string | null; link?: string | null; tags?: string[] | null; from?: { connection: string; kind: string; resource: string; field: string } | null }): VariableEntry {
    return this.#mutate(() => {
      const idx = this.#findVariableIndex(id);
      if ("value" in patch) this.#doc.setIn(["variables", idx, "value"], patch.value ?? null);
      for (const key of ["description", "owner", "link", "tags", "from"] as const) {
        if (!(key in patch)) continue;
        const v = patch[key];
        if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === "") this.#doc.deleteIn(["variables", idx, key]);
        else this.#doc.setIn(["variables", idx, key], v);
      }
    }, () => this.#findVariable(id)!);
  }

  removeVariable(id: string): void {
    this.#mutate(() => this.#doc.deleteIn(["variables", this.#findVariableIndex(id)]), () => undefined);
  }

  addProvider(def: z.input<typeof ProviderDefSchema>): ProviderDef {
    const parsed = ProviderDefSchema.safeParse(def);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => {
      if (this.#data.providers.some((p) => p.id === parsed.data.id)) throw new InventoryError(`Anbieter existiert schon: ${parsed.data.id}`);
      this.#addNode(["providers"], def);
    }, () => parsed.data);
  }

  addEnvTemplate(template: z.input<typeof EnvTemplateSchema>): EnvTemplate {
    const parsed = EnvTemplateSchema.safeParse(template);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => {
      if (this.#data.envTemplates.some((t) => t.id === parsed.data.id)) throw new InventoryError(`Vorlage existiert schon: ${parsed.data.id}`);
      this.#addNode(["envTemplates"], template);
    }, () => parsed.data);
  }

  addEnvEntry(templateId: string, entry: z.input<typeof EnvEntrySchema>): EnvTemplate {
    const parsed = EnvEntrySchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => {
      const idx = this.#data.envTemplates.findIndex((t) => t.id === templateId);
      if (idx < 0) throw new InventoryError(`Vorlage nicht gefunden: ${templateId}`);
      if (this.#data.envTemplates[idx]!.entries.some((e) => e.key === parsed.data.key)) {
        throw new InventoryError(`Eintrag existiert schon: ${parsed.data.key}`);
      }
      this.#addNode(["envTemplates", idx, "entries"], entry);
    }, () => this.#data.envTemplates.find((t) => t.id === templateId)!);
  }

  /**
   * Benennt ein Repository im Inventar um: Ziele von Secrets und Variablen sowie Vorlagen. Liefert die Zahl der geaenderten
   * Eintraege (0 = der Name kommt nicht vor, nichts geschrieben). Speichern ist Sache des Aufrufers.
   */
  renameRepo(from: string, to: string): number {
    if (!to.trim() || to.includes("/")) throw new InventoryError("Der neue Repository-Name ist ungueltig.");
    if (from === to) return 0;
    return this.#mutate(() => {
      const edits: (string | number)[][] = [];
      const scan = (key: "secrets" | "variables"): void => {
        this.#data[key].forEach((e, i) => e.places.forEach((p, j) => { if (p.scope !== "cloudflare-worker" && p.repo === from) edits.push([key, i, "places", j, "repo"]); }));
      };
      scan("secrets");
      scan("variables");
      this.#data.envTemplates.forEach((t, i) => { if (t.repo === from) edits.push(["envTemplates", i, "repo"]); });
      for (const path of edits) this.#doc.setIn(path, to);
      return edits.length;
    }, (count) => count);
  }

  /**
   * Ersetzt Inhalt komplett (fuer den Team-Import). Nicht wiederholbar: Der Aufrufer hat den neuen Inhalt aus dem alten
   * Stand berechnet, ein Wiederholen auf einer geaenderten Datei wuerde fremde Aenderungen ueberschreiben. save() meldet
   * in dem Fall einen Konflikt.
   */
  replaceData(next: z.input<typeof InventorySchema>): void {
    const parsed = InventorySchema.safeParse(next);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    this.#mutate(() => {
      this.#doc.set("version", 1);
      this.#doc.set("thresholds", this.#doc.createNode(parsed.data.thresholds));
      this.#doc.set("stages", this.#doc.createNode(clean(parsed.data.stages)));
      this.#doc.set("secrets", this.#doc.createNode(clean(parsed.data.secrets)));
      this.#doc.set("variables", this.#doc.createNode(clean(parsed.data.variables)));
      this.#doc.set("envTemplates", this.#doc.createNode(clean(parsed.data.envTemplates)));
      this.#doc.set("providers", this.#doc.createNode(clean(parsed.data.providers)));
      if (parsed.data.resourceMap && parsed.data.resourceMap.length > 0) this.#doc.set("resourceMap", this.#doc.createNode(clean(parsed.data.resourceMap)));
      else this.#doc.delete("resourceMap");
    }, () => undefined, false);
  }

  /**
   * Schreibt atomar (eindeutige Temp-Datei im selben Ordner, fsync, rename; Modus 0600). Parallele save()-Aufrufe laufen
   * nacheinander. Ist die Datei seit dem Laden anders, wird sie frisch geladen und die Aenderungen werden darauf erneut
   * angewendet, nie ueberschrieben. Ohne Pfad passiert nichts, ohne eigene Aenderungen wird nichts geschrieben.
   */
  save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const run = async (): Promise<void> => {
      this.#saveRuns++;
      try {
        await withFileLock(`${path}.lock`, () => this.#writeLocked(path));
      } finally {
        this.#saveRuns--;
      }
    };
    const next = this.#saving.then(run, run);
    this.#saving = next.catch(() => undefined);
    return next;
  }

  async #writeLocked(path: string): Promise<void> {
    let lastInvalid = "";
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const disk = readText(path);
      if (disk !== null && sha256(disk) !== this.#baseHash) {
        // The file differs from what this store is based on: somebody else wrote it.
        if (this.#pending.length === 0 && !this.#unwritten) {
          this.#adopt(disk);
          this.#stat = statOf(path);
          this.#verifiedAt = Date.now();
          this.#emit();
          return;
        }
        try {
          this.#rebase(disk);
        } catch (err) {
          if (err instanceof InvalidDiskError) {
            // A half-written file: give the writer a moment and look again.
            lastInvalid = err.message;
            await sleep(50 * (attempt + 1));
            continue;
          }
          this.#discardPending();
          throw err;
        }
      } else if (this.#pending.length === 0 && !this.#unwritten) return;
      const count = this.#pending.length;
      const text = this.#doc.toString();
      const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        // Privat (0600): Die Datei kann Sollwerte, Ziele und Notizen enthalten.
        await writePrivateFile(tmp, text);
        const handle = await open(tmp, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Last look right before the rename: all writers of this store hold the lock, so this closes the race for them.
        const now = readText(path);
        if (now !== null && sha256(now) !== this.#baseHash && (this.#baseHash !== null || this.#pending.length > 0 || this.#unwritten)) {
          await rm(tmp, { force: true });
          continue;
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await syncDirectory(dirname(path));
      this.#baseHash = sha256(text);
      this.#stat = statOf(path);
      this.#verifiedAt = Date.now();
      this.#unwritten = false;
      this.#pending.splice(0, count);
      this.#problem = null;
      return;
    }
    this.#discardPending();
    throw new InventoryConflictError(lastInvalid || "Die Inventar-Datei wurde waehrend des Speicherns immer wieder von einem anderen Prozess geaendert. Nichts ueberschrieben, bitte neu laden und erneut versuchen.");
  }

  #addNode(path: (string | number)[], value: unknown): void {
    const node = this.#doc.createNode(clean(value));
    if (this.#doc.hasIn(path)) this.#doc.addIn(path, node);
    else this.#doc.setIn(path, this.#doc.createNode([clean(value)]));
  }

  /**
   * Applies a change to the document. `apply` does its lookups itself (never indices computed earlier) so that it can be
   * replayed on a freshly loaded document if the file changed before it was saved.
   */
  #mutate<A, T>(apply: () => A, result: (a: A) => T, replayable = true): T {
    this.#refresh();
    const before = this.#doc.toString();
    try {
      const a = apply();
      this.#validate();
      const r = result(a);
      if (this.#doc.toString() !== before) {
        this.#pending.push({ replayable, replay: () => { const x = apply(); this.#validate(); result(x); } });
        this.#version++;
      }
      return r;
    } catch (err) {
      this.#doc = parseDocument(before, { schema: "core" });
      this.#validate();
      throw err instanceof InventoryError ? err : new InventoryError(String((err as Error).message));
    }
  }

  /** Takes over the file on disk if it differs from the base. Cheap when nothing changed. */
  #refresh(): void {
    if (!this.path || this.#refreshing || this.#saveRuns > 0 || this.#unwritten) return;
    const now = Date.now();
    const st = statOf(this.path);
    if (!st) return;
    const unchanged = sameStat(st, this.#stat);
    if (this.#problem) {
      // The last attempt failed: retry when the file changed or after a short pause.
      if (sameStat(st, this.#invalidStat) && now - this.#invalidAt < INVALID_RETRY_MS && !this.#stale) return;
    } else if (unchanged && !this.#stale && now - this.#verifiedAt < REHASH_AFTER_MS) return;
    const text = readText(this.path);
    if (text === null) return;
    this.#stale = false;
    if (sha256(text) === this.#baseHash) {
      this.#stat = st;
      this.#verifiedAt = now;
      this.#problem = null;
      return;
    }
    this.#refreshing = true;
    try {
      if (this.#pending.length > 0) this.#rebase(text);
      else this.#adopt(text);
      this.#stat = st;
      this.#verifiedAt = now;
    } catch (err) {
      // Not valid yet (half written) or the unsaved change does not fit: keep the old state, look again later.
      this.#invalidStat = st;
      this.#invalidAt = now;
      this.#problem ??= { message: (err as Error).message, since: now };
      return;
    } finally {
      this.#refreshing = false;
    }
    this.#problem = null;
    this.#emit();
  }

  #emit(): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn();
      } catch {
        // A faulty listener must not break reads.
      }
    }
  }

  /** Replaces the document by the file content. Throws (and keeps the old state) if it is invalid. */
  #adopt(text: string): void {
    let built: { doc: Document; data: Inventory };
    try {
      built = buildDocument(text);
    } catch (err) {
      throw new InvalidDiskError(`Die Inventar-Datei auf der Platte ist ungueltig: ${(err as Error).message}`);
    }
    this.#doc = built.doc;
    this.#data = built.data;
    this.#baseHash = sha256(text);
    this.#version++;
    this.#pending = [];
  }

  /** Replaces the document by the file content and applies the unsaved changes again. Restores the old state on failure. */
  #rebase(text: string): void {
    let built: { doc: Document; data: Inventory };
    try {
      built = buildDocument(text);
    } catch (err) {
      throw new InvalidDiskError(`Die Inventar-Datei auf der Platte ist ungueltig: ${(err as Error).message}`);
    }
    const previous = { doc: this.#doc, data: this.#data };
    this.#doc = built.doc;
    this.#data = built.data;
    try {
      for (const change of this.#pending) {
        if (!change.replayable) throw new InventoryError("diese Aenderung ersetzt den ganzen Inhalt");
        change.replay();
      }
    } catch (err) {
      this.#doc = previous.doc;
      this.#data = previous.data;
      throw new InventoryConflictError(`Die Inventar-Datei wurde von einem anderen Prozess geaendert und deine Aenderung passt nicht mehr dazu (${(err as Error).message}). Nichts ueberschrieben, bitte neu laden und erneut versuchen.`);
    }
    this.#baseHash = sha256(text);
    this.#version++;
  }

  /** After a failed save the unsaved changes are dropped and the store follows the file again. */
  #discardPending(): void {
    this.#pending = [];
    this.#unwritten = false;
    const disk = readText(this.path!);
    if (disk === null) return;
    try {
      this.#adopt(disk);
      this.#stat = statOf(this.path!);
      this.#verifiedAt = Date.now();
      this.#emit();
    } catch {
      // Invalid on disk: the next read reports the problem.
    }
  }

  #validate(): void {
    const parsed = InventorySchema.safeParse(this.#doc.toJS());
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    this.#data = parsed.data;
  }
}

function buildDocument(text: string): { doc: Document; data: Inventory } {
  const doc = parseDocument(text, { schema: "core" });
  if (doc.errors.length > 0) throw new InventoryError(`Inventar ist kein gueltiges YAML: ${doc.errors[0]!.message}`);
  const parsed = InventorySchema.safeParse(doc.toJS());
  if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
  return { doc, data: parsed.data };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Best effort: makes the rename durable. Not available everywhere (Windows), never fatal. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignore
  }
}

/**
 * Advisory lock between writers (portal, CLI, scripts) via an exclusively created file. A lock older than
 * `LOCK_STALE_MS` belongs to a crashed process and is broken. Readers never lock.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = statOf(lockPath);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new InventoryConflictError("Ein anderer Prozess speichert gerade das Inventar. Bitte gleich noch einmal versuchen.");
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

const sameMapKey = (a: { kind: string; repo: string; stage?: string | undefined }, b: { kind: string; repo: string; stage?: string | undefined }): boolean => a.kind === b.kind && a.repo === b.repo && (a.stage ?? "") === (b.stage ?? "");

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("; ");
}
