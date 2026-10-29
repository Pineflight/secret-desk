import { describe, expect, it } from "vitest";
import { integrationName, isDueSoon, summarize } from "../src/lib/integration-summary";

const sec = (connection: string | null, automatic: boolean, status: "ok" | "missing" | "invalid" | "none" = "ok", repos: string[] = []) => ({
  connection,
  automatic,
  params: { status, missing: status === "missing" ? ["accountId"] : [] },
  places: repos.map((repo) => ({ repo })),
});

describe("summarize", () => {
  const conns = [
    { id: "github", connected: true, daysLeft: 40 },
    { id: "cloudflare", connected: false },
    { id: "resend", connected: true, daysLeft: 5 },
    { id: "grafana", connected: false },
  ];
  const secrets = [sec("cloudflare", true, "missing", ["a"]), sec("cloudflare", true, "ok", ["a", "b"]), sec("resend", true, "ok", ["b"]), sec(null, false, "none", ["c"])];
  const vars = [{ from: { connection: "cloudflare" }, places: [{ repo: "d" }] }, { from: null, places: [] }];
  const s = summarize(conns, secrets, vars);

  it("keeps connected rows and unconnected rows with attached entries, hides empty unconnected ones", () => {
    expect(s.rows.map((r) => r.id)).toEqual(["resend", "github", "cloudflare"]);
  });
  it("counts secrets, automatic ones and variables per integration", () => {
    const cf = s.rows.find((r) => r.id === "cloudflare")!;
    expect(cf).toMatchObject({ connected: false, secrets: 2, autoSecrets: 2, variables: 1, level: null });
  });
  it("derives the expiry level only for connected rows", () => {
    expect(s.rows.find((r) => r.id === "resend")!.level).toBe("critical");
    expect(isDueSoon(s.rows.find((r) => r.id === "resend")!)).toBe(true);
    expect(isDueSoon(s.rows.find((r) => r.id === "github")!)).toBe(false);
  });
  it("counts automatic vs manual, distinct repositories and parameters", () => {
    expect(s.automatic).toBe(3);
    expect(s.manual).toBe(1);
    expect(s.repos).toBe(4);
    expect(s.paramsMissing).toBe(1);
    expect(s.paramsComplete).toBe(2);
  });
  it("copes with empty input", () => {
    expect(summarize([], [], [])).toEqual({ rows: [], automatic: 0, manual: 0, repos: 0, paramsComplete: 0, paramsMissing: 0 });
  });
  it("adds unknown connections found only on entries", () => {
    expect(summarize([], [sec("custom", false)], []).rows).toMatchObject([{ id: "custom", label: "custom", connected: false, secrets: 1, autoSecrets: 0 }]);
  });
});

describe("integrationName", () => {
  it("prefers label, then known name, then id", () => {
    expect(integrationName("x", "Mein X")).toBe("Mein X");
    expect(integrationName("supabase")).toBe("Supabase");
    expect(integrationName("zzz")).toBe("zzz");
  });
});
