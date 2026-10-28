import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { writePrivateFile } from "./platform.js";
import { parseDocument, type Document } from "yaml";
import {
  VariableSchema,
  type VariableEntry,
  EnvEntrySchema,
  EnvTemplateSchema,
  InventorySchema,
  ProviderDefSchema,
  SecretSchema,
  type EnvTemplate,
  type Inventory,
  type ProviderDef,
  type SecretEntry,
} from "./types.js";
import { StageDefSchema, StageError, resolvePlaces, type StageDef } from "./stages.js";
import type { z } from "zod";

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

type Patchable = Pick<SecretEntry, "expires" | "rotatedAt" | "verifiedAt" | "verifiedBy" | "externalId" | "notes" | "ttlDays" | "expiry" | "title" | "description" | "owner" | "link" | "tags" | "product">;

/** Die einzigen Felder, die patchSecret setzt. Gleicht patch.ts (SecretHumanPatchSchema) ab; ein Test haelt beide gleich. */
export const PATCHABLE_SECRET_KEYS: readonly string[] = ["expires", "rotatedAt", "verifiedAt", "verifiedBy", "externalId", "notes", "ttlDays", "expiry", "title", "description", "owner", "link", "tags", "product"];

/**
 * Das Inventar als YAML-Datei. Nur Metadaten, nie Werte. Aenderungen gehen ueber das
 * YAML-Dokument, damit Kommentare und Reihenfolge erhalten bleiben.
 */
export class InventoryStore {
  #doc: Document;
  #data!: Inventory;
  #saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly path: string | null,
    text: string,
  ) {
    this.#doc = parseDocument(text, { schema: "core" });
    this.#assertParsed();
    this.#validate();
  }

  static async open(path: string): Promise<InventoryStore> {
    return new InventoryStore(path, await readFile(path, "utf8"));
  }

  static fromText(text: string, path: string | null = null): InventoryStore {
    return new InventoryStore(path, text);
  }

  get data(): Inventory {
    return this.#data;
  }

  getSecret(id: string): SecretEntry | undefined {
    return this.#data.secrets.find((s) => s.id === id);
  }

  toString(): string {
    return this.#doc.toString();
  }

  patchSecret(id: string, patch: { [K in keyof Patchable]?: Patchable[K] | null }): SecretEntry {
    const idx = this.#data.secrets.findIndex((s) => s.id === id);
    if (idx < 0) throw new InventoryError(`Secret nicht gefunden: ${id}`);
    const unknown = Object.keys(patch).filter((k) => !PATCHABLE_SECRET_KEYS.includes(k));
    if (unknown.length > 0) throw new InventoryError(`Feld nicht erlaubt: ${unknown.join(", ")}`);
    return this.#mutate(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
          if (key === "expires") this.#doc.setIn(["secrets", idx, key], null);
          else this.#doc.deleteIn(["secrets", idx, key]);
        } else this.#doc.setIn(["secrets", idx, key], value);
      }
    }, () => this.getSecret(id)!);
  }

  addSecret(entry: z.input<typeof SecretSchema>): SecretEntry {
    const parsed = SecretSchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    if (this.getSecret(parsed.data.id)) throw new InventoryError(`id existiert schon: ${parsed.data.id}`);
    const places = this.#resolve(parsed.data.stage, parsed.data.places);
    return this.#mutate(() => this.#addNode(["secrets"], { ...entry, places }), () => this.getSecret(parsed.data.id)!);
  }

  /** Die wirksamen Stage-Definitionen (Standard, wenn das Inventar keine nennt). */
  get stages(): StageDef[] {
    return this.#data.stages;
  }

  /** Ersetzt die Stage-Liste komplett. Unbekannte Stages in Secrets/Variablen/Vorlagen lehnt die Validierung ab. */
  setStages(defs: z.input<typeof StageDefSchema>[]): StageDef[] {
    const parsed = StageDefSchema.array().safeParse(defs);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    return this.#mutate(() => this.#doc.set("stages", this.#doc.createNode(clean(parsed.data))), () => this.#data.stages);
  }

  #resolve<P extends { scope: "repository" | "environment" | "organization"; environment?: string | undefined }>(stage: string, places: P[]): P[] {
    try {
      return resolvePlaces(this.#data.stages, stage, places);
    } catch (err) {
      if (err instanceof StageError) throw new InventoryError(err.message);
      throw err;
    }
  }

  getVariable(id: string): VariableEntry | undefined {
    return this.#data.variables.find((v) => v.id === id);
  }

  addVariable(entry: z.input<typeof VariableSchema>): VariableEntry {
    const parsed = VariableSchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    if (this.getVariable(parsed.data.id) || this.getSecret(parsed.data.id)) throw new InventoryError(`id existiert schon: ${parsed.data.id}`);
    const places = this.#resolve(parsed.data.stage, parsed.data.places);
    return this.#mutate(() => this.#addNode(["variables"], { ...entry, places }), () => this.getVariable(parsed.data.id)!);
  }

  patchVariable(id: string, patch: { value?: string | null; description?: string | null; owner?: string | null; link?: string | null; tags?: string[] | null }): VariableEntry {
    const idx = this.#data.variables.findIndex((v) => v.id === id);
    if (idx < 0) throw new InventoryError(`Variable nicht gefunden: ${id}`);
    return this.#mutate(() => {
      if ("value" in patch) this.#doc.setIn(["variables", idx, "value"], patch.value ?? null);
      for (const key of ["description", "owner", "link", "tags"] as const) {
        if (!(key in patch)) continue;
        const v = patch[key];
        if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === "") this.#doc.deleteIn(["variables", idx, key]);
        else this.#doc.setIn(["variables", idx, key], v);
      }
    }, () => this.getVariable(id)!);
  }

  removeVariable(id: string): void {
    const idx = this.#data.variables.findIndex((v) => v.id === id);
    if (idx < 0) throw new InventoryError(`Variable nicht gefunden: ${id}`);
    this.#mutate(() => this.#doc.deleteIn(["variables", idx]), () => undefined);
  }

  addProvider(def: z.input<typeof ProviderDefSchema>): ProviderDef {
    const parsed = ProviderDefSchema.safeParse(def);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    if (this.#data.providers.some((p) => p.id === parsed.data.id)) throw new InventoryError(`Anbieter existiert schon: ${parsed.data.id}`);
    return this.#mutate(() => this.#addNode(["providers"], def), () => parsed.data);
  }

  addEnvTemplate(template: z.input<typeof EnvTemplateSchema>): EnvTemplate {
    const parsed = EnvTemplateSchema.safeParse(template);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    if (this.#data.envTemplates.some((t) => t.id === parsed.data.id)) throw new InventoryError(`Vorlage existiert schon: ${parsed.data.id}`);
    return this.#mutate(() => this.#addNode(["envTemplates"], template), () => parsed.data);
  }

  addEnvEntry(templateId: string, entry: z.input<typeof EnvEntrySchema>): EnvTemplate {
    const idx = this.#data.envTemplates.findIndex((t) => t.id === templateId);
    if (idx < 0) throw new InventoryError(`Vorlage nicht gefunden: ${templateId}`);
    const parsed = EnvEntrySchema.safeParse(entry);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    if (this.#data.envTemplates[idx]!.entries.some((e) => e.key === parsed.data.key)) {
      throw new InventoryError(`Eintrag existiert schon: ${parsed.data.key}`);
    }
    return this.#mutate(() => this.#addNode(["envTemplates", idx, "entries"], entry), () => this.#data.envTemplates[idx]!);
  }

  /**
   * Benennt ein Repository im Inventar um: Ziele von Secrets und Variablen sowie Vorlagen. Liefert die Zahl der geaenderten
   * Eintraege (0 = der Name kommt nicht vor, nichts geschrieben). Speichern ist Sache des Aufrufers.
   */
  renameRepo(from: string, to: string): number {
    if (!to.trim() || to.includes("/")) throw new InventoryError("Der neue Repository-Name ist ungueltig.");
    if (from === to) return 0;
    let changed = 0;
    const edits: (string | number)[][] = [];
    const scan = (key: "secrets" | "variables"): void => {
      this.#data[key].forEach((e, i) => e.places.forEach((p, j) => { if (p.repo === from) edits.push([key, i, "places", j, "repo"]); }));
    };
    scan("secrets");
    scan("variables");
    this.#data.envTemplates.forEach((t, i) => { if (t.repo === from) edits.push(["envTemplates", i, "repo"]); });
    if (edits.length === 0) return 0;
    this.#mutate(() => {
      for (const path of edits) this.#doc.setIn(path, to);
    }, () => undefined);
    changed = edits.length;
    return changed;
  }

  /** Ersetzt Inhalt komplett (fuer den Team-Import). */
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
    }, () => undefined);
  }

  /** Schreibt atomar (eindeutige Temp-Datei, dann rename). Parallele save()-Aufrufe laufen nacheinander. Ohne Pfad passiert nichts. */
  save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const run = async (): Promise<void> => {
      const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        // Privat (0600): Die Datei kann Sollwerte, Ziele und Notizen enthalten.
        await writePrivateFile(tmp, this.#doc.toString());
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    const next = this.#saving.then(run, run);
    this.#saving = next.catch(() => undefined);
    return next;
  }

  #addNode(path: (string | number)[], value: unknown): void {
    const node = this.#doc.createNode(clean(value));
    if (this.#doc.hasIn(path)) this.#doc.addIn(path, node);
    else this.#doc.setIn(path, this.#doc.createNode([clean(value)]));
  }

  #mutate<T>(apply: () => void, result: () => T): T {
    const before = this.#doc.toString();
    try {
      apply();
      this.#validate();
      return result();
    } catch (err) {
      this.#doc = parseDocument(before, { schema: "core" });
      this.#validate();
      throw err instanceof InventoryError ? err : new InventoryError(String((err as Error).message));
    }
  }

  #assertParsed(): void {
    if (this.#doc.errors.length > 0) {
      throw new InventoryError(`Inventar ist kein gueltiges YAML: ${this.#doc.errors[0]!.message}`);
    }
  }

  #validate(): void {
    const parsed = InventorySchema.safeParse(this.#doc.toJS());
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    this.#data = parsed.data;
  }
}

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("; ");
}
