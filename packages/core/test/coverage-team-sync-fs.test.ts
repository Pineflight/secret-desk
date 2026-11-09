import { describe, expect, it, vi } from "vitest";

// Both the final rename and the clean-up of the temp file fail: the original error must still reach the caller.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rename: async () => {
    throw new Error("rename refused");
  },
  rm: async () => {
    throw new Error("rm refused");
  },
}));

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_STATE, writeTeamSyncState } from "../src/team-sync.js";

describe("writeTeamSyncState", () => {
  it("reports the write error even when the temp file cannot be removed either", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cov-syncfs-"));
    await expect(writeTeamSyncState(join(dir, "state.json"), EMPTY_STATE)).rejects.toThrow("rename refused");
  });
});
