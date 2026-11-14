import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createLocalRuntime: vi.fn(),
  planGitHubSync: vi.fn(),
  runGitHubSync: vi.fn(),
  answers: [] as string[],
  questions: [] as string[],
}));

vi.mock("@secret-desk/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@secret-desk/runtime")>()),
  createLocalRuntime: m.createLocalRuntime,
  planGitHubSync: m.planGitHubSync,
  runGitHubSync: m.runGitHubSync,
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      m.questions.push(q);
      return m.answers.shift() ?? "";
    },
    close: () => {},
  }),
}));

import { syncCmd } from "../src/sync.js";

const RT = { fake: "runtime" };
const counts = { set: 1, write: 0, skip: 0, unchanged: 0 };
const line = (over: Record<string, unknown> = {}) => ({
  key: "k1",
  repo: "web",
  action: "set",
  kind: "variable",
  name: "SITE_URL",
  placeLabel: "web/staging",
  production: false,
  reason: "missing",
  defaultOn: true,
  renewable: false,
  ...over,
});
const plan = (...lines: unknown[]) => m.planGitHubSync.mockResolvedValue({ lines, counts });

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await syncCmd(["--to-github", "--config", "c.yaml", ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  m.createLocalRuntime.mockReset().mockResolvedValue(RT);
  m.planGitHubSync.mockReset();
  m.runGitHubSync.mockReset();
  m.answers.length = 0;
  m.questions.length = 0;
});

describe("syncCmd plan output", () => {
  it("prints each repository with its lines; an unknown reason is shown as is; renewable secrets point to renew", async () => {
    plan(
      line({ key: "a", repo: "web", reason: "something-new" }),
      line({ key: "b", repo: "api", kind: "secret", action: "write", reason: "needs-ack", renewable: true, production: true }),
      line({ key: "c", repo: "api", action: "skip", reason: "no-value", defaultOn: false }),
    );
    const r = await run("--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("api\n  [x] write Secret   SITE_URL  web/staging  (Produktion)  - Wert wirkt verdaechtig, einzeln mit vars apply --ack-public; erneuern mit renew\n  [ ] skip  Variable SITE_URL  web/staging  - kein Wert\nweb\n  [x] set   Variable SITE_URL  web/staging  - something-new");
    expect(r.out).toContain("Probelauf: in GitHub wurde nichts geschrieben.");
  });

  it("mentions lines that stay off because GitHub is newer", async () => {
    plan(line({ key: "a", defaultOn: false, reason: "github-newer" }));
    const r = await run("--dry-run");
    expect(r.out).toContain("1 Zeile(n) bleiben aus, weil GitHub nach dem Inventar geaendert wurde.");
    expect(r.out).toContain("[ ] set");
  });

  it("passes --repo to the plan", async () => {
    plan();
    await run("--dry-run", "--repo", "web");
    expect(m.planGitHubSync).toHaveBeenCalledWith(RT, { kind: "human", name: "cli" }, { repo: "web" });
  });

  it("nothing selected: nothing to write", async () => {
    plan(line({ action: "skip", reason: "no-value" }));
    const r = await run();
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("Nichts zu schreiben.");
    expect(m.questions).toEqual([]);
  });
});

describe("syncCmd confirmation", () => {
  it("declining the first question writes nothing and exits 1", async () => {
    plan(line());
    m.answers.push("n");
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Nicht bestaetigt. In GitHub wurde nichts geschrieben.");
    expect(m.questions).toEqual(["1 Aenderung(en) nach GitHub schreiben? [j/N] "]);
    expect(m.runGitHubSync).not.toHaveBeenCalled();
  });

  it("production changes ask a second question; declining it writes nothing", async () => {
    plan(line({ production: true }));
    m.answers.push("j", "nein");
    const r = await run();
    expect(r.code).toBe(1);
    expect(m.questions).toHaveLength(2);
    expect(m.questions[1]).toContain("Produktion betrifft");
    expect(m.runGitHubSync).not.toHaveBeenCalled();
  });

  it("a non-production change needs only one j", async () => {
    plan(line());
    m.answers.push(" J ");
    m.runGitHubSync.mockResolvedValue({ outcomes: [{ outcome: "written", name: "SITE_URL", placeLabel: "web/staging" }], ok: 1, failed: 0 });
    const r = await run();
    expect(m.questions).toHaveLength(1);
    expect(m.runGitHubSync).toHaveBeenCalledWith(RT, expect.anything(), expect.objectContaining({ keys: ["k1"], confirmProduction: false }));
    expect(r).toMatchObject({ code: 0 });
  });

  it("both answers j confirm production", async () => {
    plan(line({ production: true }));
    m.answers.push("j", "j");
    m.runGitHubSync.mockResolvedValue({ outcomes: [], ok: 1, failed: 0 });
    await run("--repo", "web");
    expect(m.runGitHubSync).toHaveBeenCalledWith(RT, expect.anything(), expect.objectContaining({ confirmProduction: true, repo: "web" }));
  });

  it("forwards progress and reports failures with exit 1", async () => {
    plan(line());
    m.runGitHubSync.mockImplementation(async (_rt: unknown, _actor: unknown, opts: { onProgress: (d: number, t: number) => void }) => {
      opts.onProgress(1, 2);
      return {
        outcomes: [
          { outcome: "written", name: "A", placeLabel: "web/staging" },
          { outcome: "failed", name: "B", placeLabel: "web/staging", error: "HTTP 403" },
        ],
        ok: 1,
        failed: 1,
      };
    });
    const r = await run("--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Fortschritt: 1/2");
    expect(r.out).toContain("written  A  web/staging\nfailed   B  web/staging  HTTP 403");
    expect(r.out).toContain("1 geschrieben, 1 fehlgeschlagen.");
  });
});
