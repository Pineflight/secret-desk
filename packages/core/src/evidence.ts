import { isReservedWindowsName } from "./reserved-names.js";
import type { Attachment, VerificationReport } from "./verification.js";

/**
 * Evidence contract: verification reports and their attachments (screenshots). Only metadata and images the user adds.
 * This module must not import Node built-ins, so it can run in any standards runtime. A guard test enforces that.
 * `FileEvidenceStore` (evidence-file-store.ts) is the folder-based implementation, `MemoryEvidenceStore` the in-memory one.
 */
export interface EvidenceStore {
  save(report: VerificationReport): Promise<void>;
  get(secretId: string, reportId: string): Promise<VerificationReport | null>;
  list(secretId: string): Promise<VerificationReport[]>;
  /** Haengt ein Bild an einen Bericht. Nur PNG, JPEG, WebP bis 5 MB, damit nichts Ausfuehrbares abgelegt wird. */
  attach(secretId: string, reportId: string, bytes: Uint8Array, mime: string, note?: string, now?: Date): Promise<Attachment>;
  readAttachment(secretId: string, reportId: string, file: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

// A Map has no inherited keys ("constructor", "__proto__" ...) and is not exported, so importers cannot extend it.
const ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
export const MAX_BYTES = 5 * 1024 * 1024;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One id rule for every store: no path tricks, no trailing dot, no reserved Windows device names (so data moves between systems). */
export function safeId(part: string, what: string): string {
  if (!SAFE.test(part) || part.includes("..") || part.endsWith(".") || isReservedWindowsName(part)) throw new EvidenceError(`Ungueltige ${what}`);
  return part;
}

/** Validates an attachment image and returns its file extension. */
export function checkImage(bytes: Uint8Array, mime: string): string {
  const ext = ALLOWED_MIME.get(mime);
  if (typeof ext !== "string") throw new EvidenceError("Nur PNG, JPEG oder WebP erlaubt");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new EvidenceError("Bild leer oder groesser als 5 MB");
  return ext;
}

interface StoredReport {
  report: VerificationReport;
  /** Attachment bytes by file name, kept next to the report so both belong together. */
  blobs: Map<string, Uint8Array>;
}

/** In-memory evidence store (tests, reference implementation). Same errors, naming and ordering as the file store. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly #entries = new Map<string, StoredReport>();

  static #key(secretId: string, reportId: string): string {
    return `${safeId(secretId, "secretId")}/${safeId(reportId, "reportId")}`;
  }

  async save(report: VerificationReport): Promise<void> {
    const key = MemoryEvidenceStore.#key(report.secretId, report.id);
    this.#entries.set(key, { report: structuredClone(report), blobs: this.#entries.get(key)?.blobs ?? new Map() });
  }

  async get(secretId: string, reportId: string): Promise<VerificationReport | null> {
    const found = this.#entries.get(MemoryEvidenceStore.#key(secretId, reportId));
    return found ? structuredClone(found.report) : null;
  }

  async list(secretId: string): Promise<VerificationReport[]> {
    let prefix: string;
    try {
      prefix = `${safeId(secretId, "secretId")}/`;
    } catch {
      return []; // same as the file store, which treats an unreadable folder as no reports
    }
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, stored]) => structuredClone(stored.report))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async attach(secretId: string, reportId: string, bytes: Uint8Array, mime: string, note?: string, now = new Date()): Promise<Attachment> {
    const ext = checkImage(bytes, mime);
    const stored = this.#entries.get(MemoryEvidenceStore.#key(secretId, reportId));
    if (!stored) throw new EvidenceError("Bericht nicht gefunden");
    const file = `anlage-${stored.report.attachments.length + 1}.${ext}`;
    const attachment: Attachment = { file, mime, addedAt: now.toISOString(), ...(note ? { note } : {}) };
    stored.report.attachments.push(attachment);
    stored.blobs.set(file, new Uint8Array(bytes));
    return { ...attachment };
  }

  /** Null when the report or the attachment is unknown, or when only the metadata exists (a report saved with an attachment entry but no image). */
  async readAttachment(secretId: string, reportId: string, file: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const stored = this.#entries.get(MemoryEvidenceStore.#key(secretId, reportId));
    if (!stored) return null;
    const att = stored.report.attachments.find((a) => a.file === file);
    if (!att) return null;
    safeId(file, "Datei");
    const bytes = stored.blobs.get(file);
    return bytes ? { bytes: new Uint8Array(bytes), mime: att.mime } : null;
  }
}
