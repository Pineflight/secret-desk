import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceError, MemoryEvidenceStore, checkImage, safeId, type EvidenceStore } from "../src/evidence.js";
import { FileEvidenceStore } from "../src/evidence-file-store.js";
import type { VerificationReport } from "../src/verification.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const factories: Array<[string, () => Promise<EvidenceStore>]> = [
  [
    "FileEvidenceStore",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sd-ev-contract-"));
      dirs.push(dir);
      return new FileEvidenceStore(dir);
    },
  ],
  ["MemoryEvidenceStore", async () => new MemoryEvidenceStore()],
];

const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({ id: "rep-1", secretId: "api-key", createdAt: "2026-03-01T10:00:00Z", attachments: [], ...over }) as VerificationReport;
const PNG = new Uint8Array([1, 2, 3]);
const BAD_IDS = ["", "..", "a..b", "a/b", ".hidden", "trailing.", "nul", "CON", "com1", "lpt²", "nul.txt", "con.tar.gz"];

/** Asserts the error class and the exact message. */
async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EvidenceError);
  expect((err as EvidenceError).message).toBe(message);
}

describe.each(factories)("evidence store contract: %s", (_name, make) => {
  it("lists nothing for an unknown secret and returns null for an unknown report", async () => {
    const store = await make();
    expect(await store.list("unknown-secret")).toEqual([]);
    await store.save(report());
    expect(await store.get("api-key", "missing")).toBeNull();
    expect(await store.get("other-secret", "rep-1")).toBeNull();
  });

  it("saves and returns copies, newest first", async () => {
    const store = await make();
    await store.save(report({ id: "old", createdAt: "2026-01-01T00:00:00Z" }));
    await store.save(report({ id: "new", createdAt: "2026-02-01T00:00:00Z" }));
    await store.save(report({ id: "foreign", secretId: "api-key-2" }));
    expect((await store.list("api-key")).map((r) => r.id)).toEqual(["new", "old"]);
    const got = (await store.get("api-key", "new"))!;
    got.createdAt = "changed";
    expect((await store.get("api-key", "new"))!.createdAt).toBe("2026-02-01T00:00:00Z");
  });

  it("rejects unsafe ids in every method with the same error", async () => {
    const store = await make();
    await store.save(report());
    for (const bad of BAD_IDS) {
      await rejectsWith(store.save(report({ secretId: bad })), "Ungueltige secretId");
      await rejectsWith(store.save(report({ id: bad })), "Ungueltige reportId");
      await rejectsWith(store.get(bad, "rep-1"), "Ungueltige secretId");
      await rejectsWith(store.get("api-key", bad), "Ungueltige reportId");
      await rejectsWith(store.attach(bad, "rep-1", PNG, "image/png"), "Ungueltige secretId");
      await rejectsWith(store.attach("api-key", bad, PNG, "image/png"), "Ungueltige reportId");
      await rejectsWith(store.readAttachment(bad, "rep-1", "anlage-1.png"), "Ungueltige secretId");
      await rejectsWith(store.readAttachment("api-key", bad, "anlage-1.png"), "Ungueltige reportId");
      expect(await store.list(bad)).toEqual([]);
    }
  });

  it("attach: refuses a missing report, a wrong type and a bad size", async () => {
    const store = await make();
    await rejectsWith(store.attach("api-key", "nope", PNG, "image/png"), "Bericht nicht gefunden");
    await store.save(report());
    await rejectsWith(store.attach("api-key", "rep-1", PNG, "text/html"), "Nur PNG, JPEG oder WebP erlaubt");
    await rejectsWith(store.attach("api-key", "rep-1", new Uint8Array(0), "image/png"), "Bild leer oder groesser als 5 MB");
    await rejectsWith(store.attach("api-key", "rep-1", new Uint8Array(5 * 1024 * 1024 + 1), "image/png"), "Bild leer oder groesser als 5 MB");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "image/svg+xml", ""])("attach: refuses the MIME type %j", async (mime) => {
    const store = await make();
    await store.save(report());
    await rejectsWith(store.attach("api-key", "rep-1", PNG, mime), "Nur PNG, JPEG oder WebP erlaubt");
    expect((await store.get("api-key", "rep-1"))!.attachments).toEqual([]);
  });

  it("attach: numbers the files, keeps notes optional and returns the bytes", async () => {
    const store = await make();
    await store.save(report());
    const first = await store.attach("api-key", "rep-1", PNG, "image/png", "Screenshot", new Date("2026-03-02T00:00:00Z"));
    const second = await store.attach("api-key", "rep-1", PNG, "image/jpeg");
    const third = await store.attach("api-key", "rep-1", PNG, "image/webp");
    expect(first).toEqual({ file: "anlage-1.png", mime: "image/png", addedAt: "2026-03-02T00:00:00.000Z", note: "Screenshot" });
    expect(second.file).toBe("anlage-2.jpg");
    expect(second).not.toHaveProperty("note");
    expect(third.file).toBe("anlage-3.webp");
    expect((await store.get("api-key", "rep-1"))!.attachments).toHaveLength(3);
    const read = await store.readAttachment("api-key", "rep-1", "anlage-1.png");
    expect(read!.mime).toBe("image/png");
    expect([...read!.bytes]).toEqual([1, 2, 3]);
  });

  it("readAttachment: null for an unknown report or file, error for an unsafe file name", async () => {
    const store = await make();
    await store.save(
      report({
        attachments: [
          { file: "bad..name.png", mime: "image/png", addedAt: "2026-03-02T00:00:00Z" },
          { file: "nul.png", mime: "image/png", addedAt: "2026-03-02T00:00:00Z" },
        ],
      }),
    );
    expect(await store.readAttachment("api-key", "rep-1", "anlage-9.png")).toBeNull();
    expect(await store.readAttachment("api-key", "nope", "anlage-1.png")).toBeNull();
    await rejectsWith(store.readAttachment("api-key", "rep-1", "bad..name.png"), "Ungueltige Datei");
    await rejectsWith(store.readAttachment("api-key", "rep-1", "nul.png"), "Ungueltige Datei");
  });

  it("stored state cannot be changed through returned or passed-in values", async () => {
    const store = await make();
    await store.save(report());
    const input = new Uint8Array([1, 2, 3]);
    await store.attach("api-key", "rep-1", input, "image/png");
    input[0] = 99;
    const listed = await store.list("api-key");
    listed.pop();
    listed.push(report({ id: "injected" }));
    const read = (await store.readAttachment("api-key", "rep-1", "anlage-1.png"))!;
    read.bytes[1] = 99;
    expect((await store.list("api-key")).map((r) => r.id)).toEqual(["rep-1"]);
    expect([...(await store.readAttachment("api-key", "rep-1", "anlage-1.png"))!.bytes]).toEqual([1, 2, 3]);
  });

  it("save keeps the images of an existing report", async () => {
    const store = await make();
    await store.save(report());
    await store.attach("api-key", "rep-1", PNG, "image/png");
    await store.save((await store.get("api-key", "rep-1"))!);
    expect([...(await store.readAttachment("api-key", "rep-1", "anlage-1.png"))!.bytes]).toEqual([1, 2, 3]);
  });
});

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
    await store.save(report({ attachments: [{ file: "anlage-1.png", mime: "image/png", addedAt: "2026-03-02T00:00:00Z" }] }));
    expect(await store.readAttachment("api-key", "rep-1", "anlage-1.png")).toBeNull();
  });
});
