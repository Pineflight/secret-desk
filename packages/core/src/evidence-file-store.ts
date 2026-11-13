import { readFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EvidenceError, checkImage, safeId, type EvidenceStore } from "./evidence.js";
import { ensurePrivateDir, writePrivateFile } from "./platform.js";
import type { Attachment, VerificationReport } from "./verification.js";

// Auch auf Windows gueltig: keine reservierten Geraetenamen (con, nul.txt ...), kein Punkt am Ende (see safeId).
const safe = safeId;

/**
 * Pruefberichte und Anlagen (Screenshots) auf der Platte. Nur Metadaten und Bilder, die der Nutzer selbst
 * hinzufuegt. Der Ordner gehoert nicht ins Git (steht in .gitignore).
 */
export class FileEvidenceStore implements EvidenceStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async save(report: VerificationReport): Promise<void> {
    const folder = join(this.dir, safe(report.secretId, "secretId"));
    await ensurePrivateDir(folder);
    const file = join(folder, `${safe(report.id, "reportId")}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    await writePrivateFile(tmp, JSON.stringify(report, null, 2));
    await rename(tmp, file);
  }

  async get(secretId: string, reportId: string): Promise<VerificationReport | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, safe(secretId, "secretId"), `${safe(reportId, "reportId")}.json`), "utf8")) as VerificationReport;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(secretId: string): Promise<VerificationReport[]> {
    let files: string[];
    try {
      files = await readdir(join(this.dir, safe(secretId, "secretId")));
    } catch {
      return [];
    }
    const reports = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => this.get(secretId, f.slice(0, -5))));
    return reports.filter((r): r is VerificationReport => r !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Haengt ein Bild an einen Bericht. Nur PNG, JPEG, WebP bis 5 MB, damit nichts Ausfuehrbares abgelegt wird. */
  async attach(secretId: string, reportId: string, bytes: Uint8Array, mime: string, note?: string, now = new Date()): Promise<Attachment> {
    const ext = checkImage(bytes, mime);
    const report = await this.get(secretId, reportId);
    if (!report) throw new EvidenceError("Bericht nicht gefunden");
    const folder = join(this.dir, safe(secretId, "secretId"), safe(reportId, "reportId"));
    await ensurePrivateDir(folder);
    const file = `anlage-${report.attachments.length + 1}.${ext}`;
    await writePrivateFile(join(folder, file), bytes);
    const attachment: Attachment = { file, mime, addedAt: now.toISOString(), ...(note ? { note } : {}) };
    report.attachments.push(attachment);
    await this.save(report);
    return attachment;
  }

  async readAttachment(secretId: string, reportId: string, file: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const report = await this.get(secretId, reportId);
    const att = report?.attachments.find((a) => a.file === file);
    if (!att) return null;
    return { bytes: await readFile(join(this.dir, safe(secretId, "secretId"), safe(reportId, "reportId"), safe(file, "Datei"))), mime: att.mime };
  }
}
