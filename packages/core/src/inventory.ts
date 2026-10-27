import { readFile, rename, writeFile } from "node:fs/promises";
import { parseDocument, type Document } from "yaml";
import {
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
import type { z } from "zod";

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

type Patchable = Pick<SecretEntry, "expires" | "rotatedAt" | "externalId" | "notes" | "ttlDays" | "expiry" | "title">;

/**
 * Das Inventar als YAML-Datei. Nur Metadaten, nie Werte. Aenderungen gehen ueber das
 * YAML-Dokument, damit Kommentare und Reihenfolge erhalten bleiben.
 */
export class InventoryStore {
  #doc: Document;
  #data!: Inventory;

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

  patchSecret(id: string, patch: Partial<Patchable>): SecretEntry {
    const idx = this.#data.secrets.findIndex((s) => s.id === id);
    if (idx < 0) throw new InventoryError(`Secret nicht gefunden: ${id}`);
    return this.#mutate(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) {
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
    return this.#mutate(() => this.#addNode(["secrets"], entry), () => this.getSecret(parsed.data.id)!);
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

  /** Ersetzt Inhalt komplett (fuer den Team-Import). */
  replaceData(next: z.input<typeof InventorySchema>): void {
    const parsed = InventorySchema.safeParse(next);
    if (!parsed.success) throw new InventoryError(formatIssues(parsed.error));
    this.#mutate(() => {
      this.#doc.set("version", 1);
      this.#doc.set("thresholds", this.#doc.createNode(parsed.data.thresholds));
      this.#doc.set("secrets", this.#doc.createNode(clean(parsed.data.secrets)));
      this.#doc.set("envTemplates", this.#doc.createNode(clean(parsed.data.envTemplates)));
      this.#doc.set("providers", this.#doc.createNode(clean(parsed.data.providers)));
    }, () => undefined);
  }

  /** Schreibt atomar (Temp-Datei, dann rename). Ohne Pfad passiert nichts. */
  async save(): Promise<void> {
    if (!this.path) return;
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, this.#doc.toString(), { encoding: "utf8", mode: 0o644 });
    await rename(tmp, this.path);
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
