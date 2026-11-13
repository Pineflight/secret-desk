import { copyFile, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./platform.js";
import { VaultUnavailableError, type VaultDocument, type VaultStore } from "./vault-core.js";

/** Vault document in a JSON file (private modes, temp file + rename). */
export class FileVaultStore implements VaultStore {
  readonly #file: string;
  #backup: string | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  get label(): string {
    return this.#file;
  }

  /** Nur eine fehlende Datei ist ein leerer Tresor. Alles andere wirft; eine kaputte Datei wird vorher als `.corrupt-<zeit>` gesichert. */
  async read(): Promise<VaultDocument> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw new VaultUnavailableError(`Die Tresordatei ${this.#file} ist nicht lesbar. Sie wird nicht ueberschrieben.`);
    }
    let parsed: VaultDocument | null = null;
    try {
      const doc = JSON.parse(text) as VaultDocument;
      if (doc && doc.version === 1 && typeof doc.entries === "object" && doc.entries !== null && !Array.isArray(doc.entries)) parsed = doc;
    } catch {
      /* unten behandelt */
    }
    if (parsed) return parsed;
    // Kopie, nicht Verschieben: die Originaldatei bleibt, jeder weitere Zugriff scheitert weiter, bis ein Mensch entscheidet.
    this.#backup ??= `${this.#file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(this.#file, this.#backup).catch(() => undefined);
    throw new VaultUnavailableError(`Die Tresordatei ${this.#file} ist beschaedigt oder hat ein unbekanntes Format. Eine Kopie liegt als ${this.#backup}; nichts wurde ueberschrieben.`);
  }

  async write(doc: VaultDocument): Promise<void> {
    await ensurePrivateDir(dirname(this.#file));
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await writePrivateFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, this.#file);
  }
}
