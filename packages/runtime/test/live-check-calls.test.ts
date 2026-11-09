import { beforeEach, describe, expect, it, vi } from "vitest";

// The API part is exercised against mocks here, to pin down exactly which calls the live check makes.
const mocks = vi.hoisted(() => ({ listConnections: vi.fn(), checkConnection: vi.fn() }));
vi.mock("../src/agent-api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/agent-api.js")>()), listConnections: mocks.listConnections }));
vi.mock("../src/connection-check.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/connection-check.js")>()), checkConnection: mocks.checkConnection }));

import { runLiveCheck } from "../src/live-check.js";
import { setup } from "./helpers/live-check-world.js";

// Built from parts so the repository holds no token-shaped literal.
const SHAPED_VALUE = `glsa${"_"}MADEUPVALUE1234567890`;

beforeEach(() => {
  mocks.listConnections.mockReset();
  mocks.checkConnection.mockReset();
});

const item = (id: string, status: "pass" | "fail", detail?: string) => ({ id: "x", label: `Check of ${id}`, status, ...(detail !== undefined ? { detail } : {}) });

describe("live check: calls to the connection check", () => {
  it("asks only connected connections, never deep, never with targets", async () => {
    mocks.listConnections.mockResolvedValue([
      { id: "github", connected: true },
      { id: "openai", connected: true },
      { id: "resend", connected: false },
    ]);
    mocks.checkConnection.mockResolvedValue({ id: "x", ok: true, checks: [] });
    const { rt, log } = await setup();
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(mocks.checkConnection.mock.calls.map((c) => c[1])).toEqual(["github", "openai"]);
    for (const call of mocks.checkConnection.mock.calls) {
      expect(call[0]).toBe(rt);
      expect(call[2]).toEqual({ deep: false });
      expect(call).toHaveLength(3);
    }
    expect(report.connections).toEqual([{ id: "github", result: "ok" }, { id: "openai", result: "ok" }, { id: "resend", result: "not-connected" }]);
  });

  it("turns a failed check into its failing items (label and the checker's own detail), and a throw into a sanitized failure", async () => {
    mocks.listConnections.mockResolvedValue([{ id: "a", connected: true }, { id: "b", connected: true }, { id: "c", connected: true }]);
    mocks.checkConnection
      .mockResolvedValueOnce({ id: "a", ok: false, checks: [item("a", "pass"), item("a", "fail", "HTTP 401"), item("a2", "fail")] })
      .mockResolvedValueOnce({ id: "b", ok: false, checks: [] })
      .mockRejectedValueOnce(new Error(`request failed {"token":"${SHAPED_VALUE}"} with ${SHAPED_VALUE}`));
    const { rt, log, lines } = await setup();
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.connections[0]).toEqual({ id: "a", result: "failed", detail: "Check of a: HTTP 401; Check of a2" });
    expect(report.connections[1]).toEqual({ id: "b", result: "failed", detail: "" });
    expect(report.connections[2]!.result).toBe("failed");
    expect(JSON.stringify(report) + lines.join("\n")).not.toContain(SHAPED_VALUE);
    expect(report.connections[2]!.detail).toContain("***");
    expect(report.ok).toBe(false);
  });

  it("a connection list that cannot be read is one failed item, not a crash", async () => {
    mocks.listConnections.mockRejectedValue(new Error("vault unreadable"));
    const { rt, log } = await setup();
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.connections).toEqual([{ id: "connections", result: "failed", detail: "The list of connections could not be read: vault unreadable" }]);
    expect(report.ok).toBe(false);
    expect(mocks.checkConnection).not.toHaveBeenCalled();
  });
});
