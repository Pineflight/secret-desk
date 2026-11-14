import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceError, MemoryEvidenceStore, checkImage, safeId } from "../src/evidence.js";
import { FileEvidenceStore } from "../src/evidence-file-store.js";
import { evidenceStoreContract } from "../src/testing/evidence-store-contract.js";
import type { VerificationReport } from "../src/verification.js";

const framework = { describe, it, expect };
const PNG = new Uint8Array([1, 2, 3]);

// One suite (exported as `@secret-desk/core/testing`), two stores.
evidenceStoreContract(framework, "FileEvidenceStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sd-ev-contract-"));
  return { store: new FileEvidenceStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

evidenceStoreContract(framework, "MemoryEvidenceStore", () => ({ store: new MemoryEvidenceStore() }));

describe("shared validation", () => {
  it("safeId and checkImage", () => {
    expect(safeId("ok-1.2_x", "id")).toBe("ok-1.2_x");
    expect(() => safeId("con.", "id")).toThrow("Ungueltige id");
    expect(() => safeId("nul.txt", "id")).toThrow("Ungueltige id");
    expect(checkImage(PNG, "image/png")).toBe("png");
    expect(() => checkImage(PNG, "constructor")).toThrow(EvidenceError);
  });
});

describe("MemoryEvidenceStore", () => {
  it("returns null for an attachment that is listed in the report but has no stored image", async () => {
    const store = new MemoryEvidenceStore();
    await store.save({ id: "rep-1", secretId: "api-key", createdAt: "2026-03-01T10:00:00Z", attachments: [{ file: "anlage-1.png", mime: "image/png", addedAt: "2026-03-02T00:00:00Z" }] } as VerificationReport);
    expect(await store.readAttachment("api-key", "rep-1", "anlage-1.png")).toBeNull();
  });
});
