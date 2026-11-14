import { describe, expect, it } from "vitest";
import { SecretValue, discardIssuance } from "../src/index.js";
import type { IssuanceDeps, PendingIssuance } from "../src/index.js";

// A review the queue could not keep is discarded with its own reason: the report must not say that the time ran out.
describe("discardIssuance with the reason unkept", () => {
  it("writes its own note into the report", async () => {
    const pending = {
      id: "r1",
      secretId: "s",
      value: new SecretValue("made-up-value-0123456789"),
      companions: [],
      report: { id: "r1", secretId: "s", kind: "manual", provider: "manual", checks: [] },
    } as unknown as PendingIssuance;
    const deps = { now: () => new Date("2026-11-14T10:00:00Z") } as unknown as IssuanceDeps;
    const result = await discardIssuance(pending, deps, { by: "system", why: "unkept" });
    expect(result).toEqual({ revokedNew: false });
    expect(pending.report.confirmation).toMatchObject({ decision: "rejected", note: "Pruefung konnte nicht gespeichert werden" });
  });
});
