import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "race" as "race" | "fail", key: "" }));

// First use of a key file: another process creates it between our read and our exclusive write, or the write fails for good.
vi.mock("../src/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/platform.js")>();
  return {
    ...actual,
    writePrivateFile: async (file: string, data: string | Uint8Array, platform?: never, flag?: string) => {
      if (flag !== "wx") return actual.writePrivateFile(file, data, platform);
      if (state.mode === "fail") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await actual.writePrivateFile(file, `${state.key}\n`, platform);
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
  };
});

import { fileKeySource } from "../src/vault.js";

describe("fileKeySource first use", () => {
  it("takes the key another process wrote first", async () => {
    state.mode = "race";
    state.key = randomBytes(32).toString("base64");
    const file = join(await mkdtemp(join(tmpdir(), "sd-cov-race-")), "key");
    expect((await fileKeySource(file).key()).toString("base64")).toBe(state.key);
  });

  it("passes on a write error that is not a race", async () => {
    state.mode = "fail";
    const file = join(await mkdtemp(join(tmpdir(), "sd-cov-race-")), "key");
    await expect(fileKeySource(file).key()).rejects.toThrow("disk full");
  });
});
