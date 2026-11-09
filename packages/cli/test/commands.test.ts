import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake runtime: the command wiring (arguments, output text, exit codes) is under test, not the runtime itself.
const m = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  listSecrets: vi.fn(),
  listVariables: vi.fn(),
  inspectVariableLive: vi.fn(),
  updateVariable: vi.fn(),
  requestApplyVariable: vi.fn(),
  adoptVariableFromGitHub: vi.fn(),
  addVariable: vi.fn(),
  requestIssuance: vi.fn(),
  rejectIssuance: vi.fn(),
  confirmIssuance: vi.fn(),
  getNormalizationPlan: vi.fn(),
  applyNormalizationChanges: vi.fn(),
  teamExport: vi.fn(),
  teamSyncStatus: vi.fn(),
  checkTeamSync: vi.fn(),
  applyTeamSync: vi.fn(),
  planTeamPush: vi.fn(),
  pushTeamSync: vi.fn(),
  runDoctor: vi.fn(),
  exportEnv: vi.fn(),
  readAbout: vi.fn(),
  answers: [] as string[],
  questions: [] as string[],
}));

vi.mock("@secret-desk/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@secret-desk/runtime")>()),
  createRuntime: m.createRuntime,
  listSecrets: m.listSecrets,
  listVariables: m.listVariables,
  inspectVariableLive: m.inspectVariableLive,
  updateVariable: m.updateVariable,
  requestApplyVariable: m.requestApplyVariable,
  adoptVariableFromGitHub: m.adoptVariableFromGitHub,
  addVariable: m.addVariable,
  requestIssuance: m.requestIssuance,
  rejectIssuance: m.rejectIssuance,
  confirmIssuance: m.confirmIssuance,
  getNormalizationPlan: m.getNormalizationPlan,
  applyNormalizationChanges: m.applyNormalizationChanges,
  teamExport: m.teamExport,
  teamSyncStatus: m.teamSyncStatus,
  checkTeamSync: m.checkTeamSync,
  applyTeamSync: m.applyTeamSync,
  planTeamPush: m.planTeamPush,
  pushTeamSync: m.pushTeamSync,
  exportEnv: m.exportEnv,
  readAbout: m.readAbout,
}));

vi.mock("../src/doctor.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/doctor.js")>()), runDoctor: m.runDoctor }));

// Interactive answers come from a queue instead of stdin.
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      m.questions.push(q);
      return m.answers.shift() ?? "";
    },
    close: () => {},
  }),
}));

import { main, orderTemplatesByRefs } from "../src/index.js";

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const RT = { fake: "runtime" };

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
  m.answers.length = 0;
  m.questions.length = 0;
  m.createRuntime.mockResolvedValue(RT);
});
afterEach(() => vi.restoreAllMocks());

describe("help and dispatch", () => {
  it("prints the help for no command, help and --help", async () => {
    for (const argv of [[], ["help"], ["--help"]]) {
      const r = await run(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Aufruf: secret-desk <befehl>");
    }
  });

  it("an unknown command prints the help to stderr and exits 2", async () => {
    const r = await run("nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Aufruf: secret-desk");
  });

  it("unknown sub commands of env, team and inventory print the help and exit 2", async () => {
    for (const argv of [["env", "import"], ["team", "nope"], ["inventory", "nope"]]) {
      const r = await run(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain("Aufruf: secret-desk");
    }
  });

  it("vapid prints a fresh key pair", async () => {
    const r = await run("vapid");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^VAPID_PUBLIC_KEY=\S+\nVAPID_PRIVATE_KEY=\S+$/);
  });

  it("browser without a sub command prints its usage and exits 2", async () => {
    const r = await run("browser");
    expect(r.code).toBe(2);
    expect(r.err).toContain("browser doctor");
  });

  it("an error thrown by a command ends with exit 2 and a message", async () => {
    m.createRuntime.mockRejectedValue(new Error("config broken"));
    const r = await run("status", "--config", "c.yaml");
    expect(r).toMatchObject({ code: 2, err: "Fehler: config broken" });
  });
});

describe("default output", () => {
  it("without an Io it writes to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["help"])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Aufruf: secret-desk"));
    expect(await main(["nope"])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Aufruf: secret-desk"));
  });
});

describe("about", () => {
  const info = (over: Record<string, unknown>) => ({ name: "secret-desk", version: "1.2.3", createdBy: "Pineflight", license: "MIT", links: { source: "https://example.test/src" }, thirdParty: [{}, {}], ...over });
  it("names the build tag and the commit when known", async () => {
    m.readAbout.mockReturnValue(info({ buildTag: "v1.2.3", commit: "abc1234" }));
    expect((await run("about")).out.split("\n")[0]).toBe("secret-desk 1.2.3 (v1.2.3, abc1234)");
  });
  it("names only the build tag without a commit, and nothing without a tag", async () => {
    m.readAbout.mockReturnValue(info({ buildTag: "v1.2.3" }));
    expect((await run("about")).out.split("\n")[0]).toBe("secret-desk 1.2.3 (v1.2.3)");
    m.readAbout.mockReturnValue(info({}));
    const r = await run("about");
    expect(r.out.split("\n")[0]).toBe("secret-desk 1.2.3");
    expect(r.out).toContain("Drittlizenzen: 2 Komponenten");
  });
});

describe("doctor", () => {
  it("requires --config", async () => {
    expect((await run("doctor")).err).toContain("doctor --config <datei>");
  });

  it("prints the findings, the details and exit 1 on a failure", async () => {
    m.runDoctor.mockResolvedValue([
      { id: "a", status: "ok", label: "Inventar gelesen" },
      { id: "b", status: "fail", label: "Verbindung github", detail: "nicht verbunden" },
    ]);
    const r = await run("doctor", "--config", "c.yaml");
    expect(m.runDoctor).toHaveBeenCalledWith(RT);
    expect(r.code).toBe(1);
    expect(r.out).toBe("[ok  ] Inventar gelesen\n[fail] Verbindung github  (nicht verbunden)\n1 Problem(e) beheben, dann erneut ausfuehren.");
  });

  it("is ready when nothing failed", async () => {
    m.runDoctor.mockResolvedValue([{ id: "a", status: "warn", label: "Hinweis" }]);
    const r = await run("doctor", "--config", "c.yaml");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Bereit fuer den Probelauf.");
  });
});

describe("check", () => {
  const inventory = (secrets: string) => `version: 1\nsecrets:\n${secrets}`;
  const secret = (id: string, expires: string) => `  - { id: ${id}, name: ${id.toUpperCase().replaceAll("-", "_")}, stage: production, service: x, provider: manual, expiry: possible, expires: "${expires}", places: [{ repo: web, scope: repository }] }\n`;
  async function file(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sd-cli-check-"));
    const path = join(dir, "inventory.yaml");
    await writeFile(path, text);
    return path;
  }

  it("needs --inventory or --config", async () => {
    expect((await run("check")).err).toContain("--inventory <datei> oder --config <datei> angeben");
  });

  it("lists findings and exits 1 for an expired secret", async () => {
    const path = await file(inventory(secret("old-key", "2026-01-01") + secret("fine-key", "2027-01-01")));
    const r = await run("check", "--inventory", path, "--today", "2026-03-01");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[expired] OLD_KEY (old-key) ist seit 59 Tagen abgelaufen");
    expect(r.out).toContain("2 Eintraege, 1 Hinweise");
  });

  it("exits 0 when nothing is due; --json prints the findings as JSON", async () => {
    const path = await file(inventory(secret("fine-key", "2027-01-01")));
    const text = await run("check", "--inventory", path, "--today", "2026-03-01");
    expect(text).toMatchObject({ code: 0, out: "1 Eintraege, 0 Hinweise" });
    const json = await run("check", "--inventory", path, "--today", "2026-03-01", "--json");
    expect(json).toMatchObject({ code: 0, out: "[]" });
  });

  it("uses the real date without --today and takes the inventory from --config", async () => {
    const path = await file(inventory(secret("old-key", "2020-01-01")));
    const { InventoryStore } = await import("@secret-desk/core");
    m.createRuntime.mockResolvedValue({ inventory: await InventoryStore.open(path) });
    const r = await run("check", "--config", "c.yaml");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[expired] OLD_KEY");
    expect(m.createRuntime).toHaveBeenCalledWith("c.yaml");
  });

  it("a due secret also exits 1", async () => {
    const path = await file(inventory(secret("due-key", "2026-03-05")));
    expect((await run("check", "--inventory", path, "--today", "2026-03-01")).code).toBe(1);
  });

  it("a soon-expiring secret above the first threshold exits 0", async () => {
    const path = await file(inventory(secret("soon-key", "2026-03-20")));
    const r = await run("check", "--inventory", path, "--today", "2026-03-01");
    expect(r.out).toContain("[soon]");
    expect(r.code).toBe(0);
  });
});

describe("status", () => {
  it("requires --config", async () => {
    expect((await run("status")).err).toContain("--config <datei> angeben");
  });

  it("lists every secret with status, days left, stage and provider", async () => {
    m.listSecrets.mockResolvedValue([
      { status: "ok", daysLeft: 40, stage: "production", id: "api-key", provider: "random-hex", automatic: true },
      { status: "no-date", daysLeft: null, stage: "dev", id: "manual-key", provider: "manual", automatic: false },
    ]);
    const r = await run("status", "--config", "c.yaml");
    expect(m.listSecrets).toHaveBeenCalledWith(RT, {});
    expect(r.code).toBe(0);
    expect(r.out).toBe("ok          40  production api-key  (random-hex, automatisch)\nno-date      -  dev        manual-key  (manual)\n2 Eintraege");
  });

  it("passes --stage, --repo and --live on", async () => {
    m.listSecrets.mockResolvedValue([]);
    const r = await run("status", "--config", "c.yaml", "--stage", "staging", "--repo", "web", "--live");
    expect(m.listSecrets).toHaveBeenCalledWith(RT, { stage: "staging", repo: "web", live: true });
    expect(r.out).toBe("0 Eintraege");
  });

  it("rejects an invalid stage", async () => {
    const r = await run("status", "--config", "c.yaml", "--stage", "Not A Stage!");
    expect(r.code).toBe(2);
    expect(m.listSecrets).not.toHaveBeenCalled();
  });
});

describe("renew", () => {
  const issuance = (over: Record<string, unknown> = {}) => ({
    id: "iss-1",
    secretName: "API_KEY",
    stage: "production",
    provider: "random-hex",
    overall: "ok",
    expiresAt: "2026-03-01T10:45:00Z",
    report: {
      fingerprint: "ab:cd",
      checks: [
        { status: "ok", label: "Format", actual: "32 hex" },
        { status: "ok", label: "Laenge", detail: "passt" },
        { status: "ok", label: "Plain" },
      ],
      checklist: [
        { id: "c1", text: "Neuer Wert getestet" },
        { id: "c2", text: "Alter Wert nicht mehr genutzt" },
      ],
    },
    ...over,
  });
  const ready = (over: Record<string, unknown> = {}) => ({ status: "ready", issuance: issuance(over) });

  it("requires an id and --config", async () => {
    expect((await run("renew", "--config", "c.yaml")).err).toContain("renew <id> --config <datei>");
    expect((await run("renew", "api-key")).err).toContain("renew <id> --config <datei>");
  });

  it("--dry-run prints the plan", async () => {
    m.requestIssuance.mockResolvedValue({ status: "dry-run", plan: { provider: "random-hex", places: ["web/production", "web/repo"], revokesOld: true } });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--dry-run");
    expect(m.requestIssuance).toHaveBeenCalledWith(RT, { kind: "human", name: "cli" }, "api-key", { dryRun: true });
    expect(r).toMatchObject({ code: 0, out: "Plan: random-hex -> web/production, web/repo (alter Wert wird nach Bestaetigung widerrufen)" });
  });

  it("a plan that does not revoke the old value says nothing about it", async () => {
    m.requestIssuance.mockResolvedValue({ status: "dry-run", plan: { provider: "x", places: ["a"], revokesOld: false } });
    expect((await run("renew", "api-key", "--config", "c.yaml", "--dry-run")).out).toBe("Plan: x -> a");
    expect(m.requestIssuance).toHaveBeenCalledWith(RT, expect.anything(), "api-key", { dryRun: true });
  });

  it("a request that needs an approval prints the message", async () => {
    m.requestIssuance.mockResolvedValue({ status: "pending-approval", message: "Freigabe angefragt: ap-1" });
    const r = await run("renew", "api-key", "--config", "c.yaml");
    expect(m.requestIssuance).toHaveBeenCalledWith(RT, expect.anything(), "api-key", { dryRun: false });
    expect(r).toMatchObject({ code: 0, out: "Freigabe angefragt: ap-1" });
  });

  it("--yes ticks every checklist item and confirms; prints places and expiry", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.confirmIssuance.mockResolvedValue({ ok: true, expires: "2026-06-01", revokedOld: true, places: [{ outcome: "written", place: "web/production" }] });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--yes");
    expect(m.confirmIssuance).toHaveBeenCalledWith(RT, expect.anything(), "iss-1", { ticks: ["c1", "c2"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Pruefung iss-1 fuer API_KEY (production, random-hex)");
    expect(r.out).toContain("Ergebnis: ok, Fingerabdruck ab:cd, gueltig bis 10:45 UTC");
    expect(r.out).toContain("  [ok  ] Format (32 hex)");
    expect(r.out).toContain("  [ok  ] Laenge - passt");
    expect(r.out).toContain("  [ok  ] Plain\n");
    expect(r.out).toContain("written  web/production");
    expect(r.out).toContain("ok, laeuft ab: 2026-06-01, alter Wert widerrufen");
    expect(m.questions).toEqual([]);
  });

  it("a confirmed renewal without expiry and without revoking the old value", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.confirmIssuance.mockResolvedValue({ ok: true, expires: null, revokedOld: false, places: [] });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--yes");
    expect(r.out).toContain("ok, laeuft ab: nie");
    expect(r.out).not.toContain("widerrufen");
  });

  it("an incomplete write exits 1 and keeps the old value", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.confirmIssuance.mockResolvedValue({ ok: false, places: [{ outcome: "failed", place: "web/production" }] });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("nicht vollstaendig, alter Wert bleibt gueltig");
  });

  it("asks for each checklist item and confirms when every answer is j", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.confirmIssuance.mockResolvedValue({ ok: true, expires: "2026-06-01", revokedOld: false, places: [] });
    m.answers.push("j", " J ");
    const r = await run("renew", "api-key", "--config", "c.yaml");
    expect(m.questions).toEqual(["  Neuer Wert getestet [j/N] ", "  Alter Wert nicht mehr genutzt [j/N] "]);
    expect(m.confirmIssuance).toHaveBeenCalledWith(RT, expect.anything(), "iss-1", { ticks: ["c1", "c2"] });
    expect(r.out).toContain("Pruefpunkte, jeweils mit j bestaetigen:");
    expect(r.code).toBe(0);
  });

  it("discards the new value when a checklist item is not confirmed", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.rejectIssuance.mockResolvedValue({ revokedNew: true });
    m.answers.push("j", "n");
    const r = await run("renew", "api-key", "--config", "c.yaml");
    expect(m.rejectIssuance).toHaveBeenCalledWith(RT, expect.anything(), "iss-1", "Pruefpunkte nicht bestaetigt");
    expect(m.confirmIssuance).not.toHaveBeenCalled();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Verworfen (neuer Wert beim Anbieter geloescht). In GitHub wurde nichts geschrieben.");
  });

  it("discarding without a provider-side value says so without the revoke note", async () => {
    m.requestIssuance.mockResolvedValue(ready());
    m.rejectIssuance.mockResolvedValue({ revokedNew: false });
    const r = await run("renew", "api-key", "--config", "c.yaml");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Verworfen. In GitHub wurde nichts geschrieben.");
  });

  it("a failed automatic check is discarded even with --yes and exits 2", async () => {
    const failing = { status: "fail", label: "Token gueltig", detail: "401" };
    m.requestIssuance.mockResolvedValue(ready({ report: { fingerprint: "f", checks: [failing], checklist: [{ id: "c1", text: "x" }] } }));
    m.rejectIssuance.mockResolvedValue({ revokedNew: true });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--yes");
    expect(m.rejectIssuance).toHaveBeenCalledWith(RT, expect.anything(), "iss-1", "Automatische Pruefung fehlgeschlagen");
    expect(m.confirmIssuance).not.toHaveBeenCalled();
    expect(r.code).toBe(2);
    expect(r.out).toContain("Automatische Pruefung fehlgeschlagen, verworfen (neuer Wert beim Anbieter geloescht).");
  });

  it("a failed automatic check without a provider-side value", async () => {
    m.requestIssuance.mockResolvedValue(ready({ report: { fingerprint: "f", checks: [{ status: "fail", label: "x" }], checklist: [] } }));
    m.rejectIssuance.mockResolvedValue({ revokedNew: false });
    const r = await run("renew", "api-key", "--config", "c.yaml", "--yes");
    expect(r.out).toContain("Automatische Pruefung fehlgeschlagen, verworfen. In GitHub");
    expect(r.code).toBe(2);
  });
});

describe("vars", () => {
  it("requires --config", async () => {
    expect((await run("vars", "list")).err).toContain("--config <datei> angeben");
  });

  it("an unknown sub command prints the help", async () => {
    const r = await run("vars", "nope", "--config", "c.yaml");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Aufruf: secret-desk");
  });

  it("list prints rows, with (unbekannt) for a missing target value, and honors filters", async () => {
    m.listVariables.mockReturnValue([
      { stage: "dev", id: "site-url", name: "SITE_URL", value: "http://localhost" },
      { stage: "dev", id: "region", name: "REGION", value: null },
    ]);
    const r = await run("vars", "list", "--config", "c.yaml", "--stage", "dev", "--repo", "web");
    expect(m.listVariables).toHaveBeenCalledWith(RT, { stage: "dev", repo: "web" });
    expect(r.out).toBe("dev        site-url  SITE_URL = http://localhost\ndev        region  REGION = (unbekannt)\n2 Variablen");
    m.listVariables.mockReturnValue([]);
    await run("vars", "list", "--config", "c.yaml");
    expect(m.listVariables).toHaveBeenLastCalledWith(RT, {});
  });

  it("status prints drift per place; exit 0 only when everything is in sync", async () => {
    m.inspectVariableLive.mockResolvedValue({ drift: [{ state: "in-sync", placeLabel: "web/repo", expected: "a", actual: "a" }] });
    const ok = await run("vars", "status", "site-url", "--config", "c.yaml");
    expect(ok).toMatchObject({ code: 0, out: "in-sync          web/repo  soll=a  ist=a" });
    m.inspectVariableLive.mockResolvedValue({ drift: [{ state: "missing", placeLabel: "web/env:staging", expected: null, actual: null }] });
    const bad = await run("vars", "status", "site-url", "--config", "c.yaml");
    expect(bad).toMatchObject({ code: 1, out: "missing          web/env:staging  soll=-  ist=-" });
    expect(m.inspectVariableLive).toHaveBeenCalledWith(RT, "site-url");
  });

  it("status, set, apply and adopt require an id", async () => {
    for (const sub of ["status", "apply", "adopt"]) {
      expect((await run("vars", sub, "--config", "c.yaml")).err, sub).toContain(`vars ${sub} <id>`);
    }
    expect((await run("vars", "set", "--config", "c.yaml", "--value", "x")).err).toContain("vars set <id> --value <wert>");
  });

  it("set needs a value (an empty value is allowed) and stores it", async () => {
    expect((await run("vars", "set", "site-url", "--config", "c.yaml")).err).toContain("vars set <id> --value <wert>");
    m.updateVariable.mockResolvedValue(undefined);
    const r = await run("vars", "set", "site-url", "--config", "c.yaml", "--value", "", "--ack-public");
    expect(m.updateVariable).toHaveBeenCalledWith(RT, { kind: "human", name: "cli" }, "site-url", { value: "" }, { acknowledgedPublic: true });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("Sollwert gespeichert (Inventar)");
  });

  it("apply prints the outcomes and exits 1 when one failed", async () => {
    m.requestApplyVariable.mockResolvedValue({ status: "applied", outcomes: [{ outcome: "updated", place: "web/repo" }, { outcome: "failed", place: "web/env:x", error: "403" }] });
    const r = await run("vars", "apply", "site-url", "--config", "c.yaml");
    expect(m.requestApplyVariable).toHaveBeenCalledWith(RT, expect.anything(), "site-url", { acknowledgedPublic: false });
    expect(r.code).toBe(1);
    expect(r.out).toBe("updated    web/repo\nfailed     web/env:x  403");
  });

  it("apply exits 0 when all outcomes are fine or when it only requested an approval", async () => {
    m.requestApplyVariable.mockResolvedValue({ status: "applied", outcomes: [{ outcome: "updated", place: "web/repo" }] });
    expect((await run("vars", "apply", "site-url", "--config", "c.yaml")).code).toBe(0);
    m.requestApplyVariable.mockResolvedValue({ status: "pending-approval" });
    const r = await run("vars", "apply", "site-url", "--config", "c.yaml");
    expect(r).toMatchObject({ code: 0, out: "" });
  });

  it("adopt prints the adopted value", async () => {
    m.adoptVariableFromGitHub.mockResolvedValue({ value: "eu" });
    const r = await run("vars", "adopt", "region", "--config", "c.yaml");
    expect(m.adoptVariableFromGitHub).toHaveBeenCalledWith(RT, expect.anything(), "region");
    expect(r.out).toBe("Sollwert uebernommen: eu");
  });

  it("add requires id, name, stage and a place", async () => {
    const base = ["vars", "add", "--config", "c.yaml"];
    const full = ["--id", "v1", "--name", "V_ONE", "--stage", "dev", "--place", "web"];
    const without = (flag: string) => {
      const i = full.indexOf(flag);
      return [...base, ...full.slice(0, i), ...full.slice(i + 2)];
    };
    for (const flag of ["--id", "--name", "--stage", "--place"]) {
      expect((await run(...without(flag))).err, flag).toContain("vars add --id --name --stage --place repo[:env]...");
    }
  });

  it("add builds repository and environment places and passes the value", async () => {
    m.addVariable.mockResolvedValue(undefined);
    const r = await run("vars", "add", "--config", "c.yaml", "--id", "v1", "--name", "V_ONE", "--stage", "staging", "--place", "web:staging", "--place", "api", "--value", "x");
    expect(m.addVariable).toHaveBeenCalledWith(RT, expect.anything(), { id: "v1", name: "V_ONE", stage: "staging", value: "x", places: [{ repo: "web", scope: "environment", environment: "staging" }, { repo: "api", scope: "repository" }] }, { acknowledgedPublic: false });
    expect(r).toMatchObject({ code: 0, out: "Variable angelegt." });
  });

  it("add without --value stores no value", async () => {
    m.addVariable.mockResolvedValue(undefined);
    await run("vars", "add", "--config", "c.yaml", "--id", "v1", "--name", "V_ONE", "--stage", "dev", "--place", "web");
    expect(m.addVariable.mock.calls[0]![2]).toMatchObject({ value: null });
  });
});

describe("inventory normalize", () => {
  const change = (over: Record<string, unknown>) => ({
    id: "c1",
    kind: "rename",
    before: [{ id: "s1", name: "OLD_NAME", stage: "staging", provider: "manual" }],
    after: [{ name: "NEW_NAME", stage: "production", provider: "random-hex" }],
    autoApplicable: true,
    needsWorkflowChange: false,
    missingParams: [],
    reasons: [{ text: "Stage-Wort im Namen" }],
    ...over,
  });
  const plan = (...changes: unknown[]) => m.getNormalizationPlan.mockReturnValue({ changes });

  it("requires --config", async () => {
    expect((await run("inventory", "normalize")).err).toContain("inventory normalize --config <datei>");
  });

  it("says so when there is nothing to normalize", async () => {
    plan();
    expect(await run("inventory", "normalize", "--config", "c.yaml")).toMatchObject({ code: 0, out: "Nichts zu vereinheitlichen." });
  });

  it("shows the plan grouped by kind with one line per change and never applies", async () => {
    plan(
      change({ id: "c-rename" }),
      change({ id: "c-provider", kind: "provider" }),
      change({ id: "c-source", kind: "source", after: [{ name: "X", source: { kind: "variable", field: "url", resource: "r1" } }] }),
      change({ id: "c-source2", kind: "source", after: [{ name: "X", source: { kind: "variable", field: "url" } }] }),
      change({ id: "c-stage", kind: "stage" }),
      change({ id: "c-merge", kind: "merge", before: [{ id: "a", name: "A" }, { id: "b", name: "B" }], after: [], autoApplicable: false }),
      change({ id: "c-manual", kind: "manual-only", after: [], autoApplicable: false, needsWorkflowChange: true, missingParams: ["accountId", "zone"] }),
    );
    const r = await run("inventory", "normalize", "--config", "c.yaml");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Umbenennen (1)\n  c-rename\n      OLD_NAME -> NEW_NAME\n      Stage-Wort im Namen");
    expect(r.out).toContain("      OLD_NAME: manual -> random-hex");
    expect(r.out).toContain("      OLD_NAME: variable.url\n");
    expect(r.out).toContain("      OLD_NAME: variable.url (Ressource waehlen)");
    expect(r.out).toContain("      OLD_NAME: staging -> production");
    expect(r.out).toContain("Zusammenfuehren (von Hand) (1)\n  c-merge\n      A (a) + B (b)\n      Stage-Wort im Namen  [nicht automatisch]");
    expect(r.out).toContain("      OLD_NAME\n      Stage-Wort im Namen  [nicht automatisch; Workflow anpassen; Parameter: accountId, zone]");
    expect(r.out).toContain("5 Aenderung(en) sind eindeutig. Anwenden mit --apply all");
    expect(m.applyNormalizationChanges).not.toHaveBeenCalled();
  });

  it("falls back to the plain name for kinds whose after entry is missing", async () => {
    plan(change({ kind: "rename", after: [] }), change({ id: "c2", kind: "stage", after: [] }), change({ id: "c3", kind: "provider", after: [] }), change({ id: "c4", kind: "source", after: [{ name: "X" }] }));
    const r = await run("inventory", "normalize", "--config", "c.yaml");
    expect(r.out.match(/^      OLD_NAME$/gm)).toHaveLength(4);
  });

  it("--apply all applies the unambiguous changes with --yes and reports missing parameters", async () => {
    plan(change({ id: "a" }), change({ id: "b", autoApplicable: false }));
    m.applyNormalizationChanges.mockResolvedValue({ applied: ["a"], needsParams: [{ secretId: "s1", missing: ["accountId"] }] });
    const r = await run("inventory", "normalize", "--config", "c.yaml", "--apply", "all", "--yes");
    expect(m.applyNormalizationChanges).toHaveBeenCalledWith(RT, { kind: "human", name: "cli" }, { changeIds: ["a"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 Aenderung(en) angewendet. GitHub wurde nicht angefasst.");
    expect(r.out).toContain("Parameter fehlen noch: s1 (accountId). Im Portal: Parameter vervollstaendigen.");
  });

  it("--apply with a list of ids applies exactly those", async () => {
    plan(change({ id: "a" }), change({ id: "b" }));
    m.applyNormalizationChanges.mockResolvedValue({ applied: ["b"], needsParams: [] });
    await run("inventory", "normalize", "--config", "c.yaml", "--apply", " b , ,", "--yes");
    expect(m.applyNormalizationChanges.mock.calls[0]![2]).toEqual({ changeIds: ["b"] });
  });

  it("nothing unambiguous to apply", async () => {
    plan(change({ autoApplicable: false }));
    const r = await run("inventory", "normalize", "--config", "c.yaml", "--apply", "all");
    expect(r).toMatchObject({ code: 0, out: "Nichts Eindeutiges anzuwenden." });
  });

  it("asks before applying; an answer other than j aborts without a change", async () => {
    plan(change({ id: "a" }));
    m.answers.push("n");
    const r = await run("inventory", "normalize", "--config", "c.yaml", "--apply", "a,unknown-id");
    expect(r.code).toBe(1);
    expect(r.out).toContain("2 Aenderung(en) am Inventar:");
    expect(r.out).toContain("OLD_NAME -> NEW_NAME");
    expect(r.out).toContain("Abgebrochen. Nichts geaendert.");
    expect(m.applyNormalizationChanges).not.toHaveBeenCalled();
  });

  it("asks before applying; j applies", async () => {
    plan(change({ id: "a" }));
    m.applyNormalizationChanges.mockResolvedValue({ applied: ["a"], needsParams: [] });
    m.answers.push("J");
    const r = await run("inventory", "normalize", "--config", "c.yaml", "--apply", "a");
    expect(r.code).toBe(0);
    expect(m.questions[0]).toContain("Anwenden? Nur das Inventar aendert sich");
    expect(m.applyNormalizationChanges).toHaveBeenCalled();
  });
});

describe("team", () => {
  const diff = { empty: false, sections: { secrets: { added: ["a"], changed: ["b"], removed: ["c"] }, variables: { added: [], changed: [], removed: [] } } };

  it("every sub command requires --config (import: a file and --inventory)", async () => {
    for (const sub of ["export", "status", "pull", "push"]) {
      expect((await run("team", sub)).err, sub).toContain(`team ${sub} --config <datei>`);
    }
    expect((await run("team", "import")).err).toContain("team import <datei> --inventory <datei>");
    expect((await run("team", "import", "bundle.yaml")).err).toContain("team import <datei> --inventory <datei>");
  });

  it("export prints the bundle", async () => {
    m.teamExport.mockReturnValue("version: 1\n");
    expect(await run("team", "export", "--config", "c.yaml")).toMatchObject({ code: 0, out: "version: 1\n" });
  });

  it("export --out writes the file", async () => {
    m.teamExport.mockReturnValue("version: 1\nteam: x\n");
    const out = join(await mkdtemp(join(tmpdir(), "sd-cli-team-")), "team.yaml");
    const r = await run("team", "export", "--config", "c.yaml", "--out", out);
    expect(r.out).toBe(`geschrieben: ${out}`);
    expect(await readFile(out, "utf8")).toBe("version: 1\nteam: x\n");
  });

  describe("import", () => {
    const BUNDLE = "version: 1\nsecrets:\n  - { id: shared-key, name: SHARED_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }] }\n";
    it("merges a bundle into an existing inventory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "sd-cli-team-"));
      await writeFile(join(dir, "bundle.yaml"), BUNDLE);
      await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
      const r = await run("team", "import", join(dir, "bundle.yaml"), "--inventory", join(dir, "inventory.yaml"));
      expect(r).toMatchObject({ code: 0, out: "1 hinzugefuegt, 0 uebersprungen" });
      expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("shared-key");
    });

    it("creates the inventory when it does not exist; --replace is accepted", async () => {
      const dir = await mkdtemp(join(tmpdir(), "sd-cli-team-"));
      await writeFile(join(dir, "bundle.yaml"), BUNDLE);
      const r = await run("team", "import", join(dir, "bundle.yaml"), "--inventory", join(dir, "new.yaml"), "--replace");
      expect(r.out).toBe("1 hinzugefuegt, 0 uebersprungen");
      expect(await readFile(join(dir, "new.yaml"), "utf8")).toContain("shared-key");
    });
  });

  it("status without a configured sync", async () => {
    m.teamSyncStatus.mockResolvedValue({ configured: false });
    expect((await run("team", "status", "--config", "c.yaml")).out).toBe("Team-Sync ist nicht eingerichtet.");
  });

  it("status of a configured sync, with and without a previous sync", async () => {
    const base = { configured: true, repo: "acme/team", path: "team.yaml", branch: "main", mode: "pull-request", connected: true };
    m.teamSyncStatus.mockResolvedValue({ ...base, lastSyncAt: "2026-03-01T10:00:00Z" });
    expect((await run("team", "status", "--config", "c.yaml")).out).toBe("Repository: acme/team (team.yaml, Zweig main), Modus pull-request, verbunden: ja, letzter Abgleich: 2026-03-01T10:00:00Z");
    m.teamSyncStatus.mockResolvedValue({ ...base, connected: false, lastSyncAt: null });
    expect((await run("team", "status", "--config", "c.yaml")).out).toContain("verbunden: nein, letzter Abgleich: nie");
  });

  describe("pull", () => {
    it("shows the state and the diff and stops without --apply", async () => {
      m.checkTeamSync.mockResolvedValue({ state: "behind", diff, remoteSha: "sha1" });
      const r = await run("team", "pull", "--config", "c.yaml");
      expect(r).toMatchObject({ code: 0, out: "Stand: behind\n  + secrets: a\n  ~ secrets: b\n  - secrets: c" });
      expect(m.applyTeamSync).not.toHaveBeenCalled();
    });

    it("works without a diff", async () => {
      m.checkTeamSync.mockResolvedValue({ state: "in-sync" });
      expect((await run("team", "pull", "--config", "c.yaml")).out).toBe("Stand: in-sync");
    });

    it("rejects an unknown --apply mode", async () => {
      m.checkTeamSync.mockResolvedValue({ state: "behind", remoteSha: "sha1" });
      expect((await run("team", "pull", "--config", "c.yaml", "--apply", "nope")).err).toContain("--apply: merge, replace oder keep-local");
    });

    it("fails when the repository has no team file", async () => {
      m.checkTeamSync.mockResolvedValue({ state: "no-remote" });
      const r = await run("team", "pull", "--config", "c.yaml", "--apply", "merge");
      expect(r).toMatchObject({ code: 2 });
      expect(r.err).toContain("Im Repository gibt es keine Team-Datei.");
    });

    it("applies with the remote sha and the chosen resolution", async () => {
      m.checkTeamSync.mockResolvedValue({ state: "behind", remoteSha: "sha1" });
      m.applyTeamSync.mockResolvedValue({ resolution: "replace", added: ["a", "b"], skipped: [] });
      const r = await run("team", "pull", "--config", "c.yaml", "--apply", "replace", "--confirm-replace");
      expect(m.applyTeamSync).toHaveBeenCalledWith(RT, { expectSha: "sha1", resolution: "replace", confirmReplace: true });
      expect(r.out).toContain("uebernommen (replace): 2 hinzugefuegt, 0 uebersprungen");
      m.applyTeamSync.mockResolvedValue({ resolution: "keep-local", added: [], skipped: ["x"] });
      await run("team", "pull", "--config", "c.yaml", "--apply", "keep-local");
      expect(m.applyTeamSync).toHaveBeenLastCalledWith(RT, { expectSha: "sha1", resolution: "keep-local", confirmReplace: false });
    });
  });

  describe("push", () => {
    const plan = (over: Record<string, unknown> = {}) => ({ targetBranch: "main", strategy: "direct", diff, localHash: "h1", remoteSha: "sha1", ...over });

    it("shows the plan and asks for --yes", async () => {
      m.planTeamPush.mockResolvedValue(plan());
      const r = await run("team", "push", "--config", "c.yaml");
      expect(r.code).toBe(0);
      expect(r.out).toBe("Ziel: main (direct)\n  + secrets: a\n  ~ secrets: b\n  - secrets: c\nMit --yes bestaetigen, um zu schieben.");
      expect(m.pushTeamSync).not.toHaveBeenCalled();
    });

    it("has nothing to push for an empty diff", async () => {
      m.planTeamPush.mockResolvedValue(plan({ diff: { empty: true, sections: {} } }));
      const r = await run("team", "push", "--config", "c.yaml", "--yes");
      expect(r.out).toBe("Ziel: main (direct)\nNichts zu schieben.");
      expect(m.pushTeamSync).not.toHaveBeenCalled();
    });

    it("pushes with --yes and prints the pull request URL when there is one", async () => {
      m.planTeamPush.mockResolvedValue(plan());
      m.pushTeamSync.mockResolvedValue({ pushed: true, pullRequest: { url: "https://github.test/pr/1" } });
      const r = await run("team", "push", "--config", "c.yaml", "--yes");
      expect(m.pushTeamSync).toHaveBeenCalledWith(RT, { confirm: true, expectLocalHash: "h1", expectRemoteSha: "sha1" });
      expect(r.out).toContain("geschoben: https://github.test/pr/1");
    });

    it("a direct push has no URL; a push that did nothing says so", async () => {
      m.planTeamPush.mockResolvedValue(plan());
      m.pushTeamSync.mockResolvedValue({ pushed: true });
      expect((await run("team", "push", "--config", "c.yaml", "--yes")).out).toMatch(/\ngeschoben$/);
      m.pushTeamSync.mockResolvedValue({ pushed: true, pullRequest: null });
      expect((await run("team", "push", "--config", "c.yaml", "--yes")).out).toMatch(/\ngeschoben$/);
      m.pushTeamSync.mockResolvedValue({ pushed: false });
      expect((await run("team", "push", "--config", "c.yaml", "--yes")).out).toMatch(/\nNichts zu schieben\.$/);
    });
  });
});

describe("orderTemplatesByRefs", () => {
  const t = (id: string, ...refs: (string | { type: string; template?: string })[]) => ({
    id,
    entries: refs.map((r) => ({ from: typeof r === "string" ? { type: "ref", template: r } : r })),
  });
  it("puts a template after the template it references", () => {
    expect(orderTemplatesByRefs([t("a", "b"), t("b")]).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("ignores refs to templates outside the run, non-ref entries and entries without a template", () => {
    const list = [t("a", "outside", { type: "generate" }, { type: "ref" }), t("b")];
    expect(orderTemplatesByRefs(list).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("survives a reference cycle", () => {
    expect(orderTemplatesByRefs([t("a", "b"), t("b", "a")]).map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
  it("lists each template once", () => {
    expect(orderTemplatesByRefs([t("a", "c"), t("b", "c"), t("c")]).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("env export (template mode)", () => {
  const tpl = (id: string, repo: string, stage = "dev", entries: unknown[] = []) => ({ id, repo, stage, entries });
  const fakeRuntime = (templates: unknown[], stages: unknown[] = [{ id: "dev", kind: "dev" }]) => ({ inventory: { stages, data: { envTemplates: templates } } });
  const written = (over: Record<string, unknown> = {}) => ({ status: "written", path: "/work/.env.local", keys: ["A", "B", "C"], skipped: [], warnings: [], ...over });
  const base = ["env", "export", "--from-template", "--config", "c.yaml"];

  afterEach(() => vi.unstubAllEnvs());

  it("needs --config and a repo or a template", async () => {
    expect((await run("env", "export", "--from-template", "--repo", "web")).err).toContain("env export --config <file>");
    expect((await run(...base)).err).toContain("env export --config <file>");
  });

  it("--out works with a single repository only", async () => {
    expect((await run(...base, "--repo", "a", "--repo", "b", "--out", "x")).err).toContain("--out works with a single --repo only.");
  });

  it("exports the dev template of the repository and never prints a value", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web"), tpl("web-staging", "web", "staging")]));
    m.exportEnv.mockResolvedValue(written());
    const r = await run(...base, "--repo", "web");
    expect(m.exportEnv).toHaveBeenCalledTimes(1);
    expect(m.exportEnv.mock.calls[0]![2]).toMatchObject({ repo: "web", stage: "dev", template: "web-dev", overwrite: false, prompts: {}, runCommands: true, fallbackDir: process.cwd() });
    expect(m.exportEnv.mock.calls[0]![2]).not.toHaveProperty("path");
    expect(r).toMatchObject({ code: 0, out: "written: /work/.env.local (3 of 3 keys set, mode 600)" });
  });

  it("the stage of the first dev stage of the inventory is used, 'dev' when there is none, --stage wins", async () => {
    m.exportEnv.mockResolvedValue(written());
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-local", "web", "local")], [{ id: "prod", kind: "live" }, { id: "local", kind: "dev" }]));
    expect((await run(...base, "--repo", "web")).code).toBe(0);
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web", "dev")], []));
    expect((await run(...base, "--repo", "web")).code).toBe(0);
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-staging", "web", "staging")]));
    expect((await run(...base, "--repo", "web", "--stage", "staging")).code).toBe(0);
    expect(m.exportEnv.mock.calls.map((c) => c[2].stage)).toEqual(["local", "dev", "staging"]);
  });

  it("--template picks a template by id; --out, --overwrite and --no-commands are passed on", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web"), tpl("api-dev", "api")]));
    m.exportEnv.mockResolvedValue(written());
    await run(...base, "--template", "api-dev", "--out", "out/.env", "--overwrite", "--no-commands");
    expect(m.exportEnv.mock.calls[0]![2]).toMatchObject({ repo: "api", template: "api-dev", path: "out/.env", overwrite: true, runCommands: false });
  });

  it("reports a missing template by id and a repository without a dev template", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web")]));
    const byId = await run(...base, "--template", "nope");
    expect(byId).toMatchObject({ code: 1 });
    expect(byId.err).toBe("Error: no dev template for nope.");
    const byRepo = await run(...base, "--repo", "web", "--repo", "api");
    expect(byRepo).toMatchObject({ code: 1 });
    expect(byRepo.err).toBe("Error: no dev template for api.");
    expect(m.exportEnv).not.toHaveBeenCalled();
  });

  it("collects prompt values from --prompt and SECRET_DESK_PROMPT_<KEY>; malformed or empty ones are ignored", async () => {
    vi.stubEnv("SECRET_DESK_PROMPT_FROM_ENV", "env-value");
    vi.stubEnv("SECRET_DESK_PROMPT_EMPTY", "");
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web")]));
    m.exportEnv.mockResolvedValue(written());
    await run(...base, "--repo", "web", "--prompt", "KEY=a=b", "--prompt", "noequals", "--prompt", "=novalue", "--prompt", "EMPTY_OK=");
    expect(m.exportEnv.mock.calls[0]![2].prompts).toEqual({ KEY: "a=b", EMPTY_OK: "", FROM_ENV: "env-value" });
  });

  it("an entry that needs input is reported on stderr and the exit code is 1; the other repositories still run", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("a-dev", "a"), tpl("b-dev", "b")]));
    m.exportEnv.mockResolvedValueOnce({ status: "needs-input", keys: ["STRIPE_KEY", "MAPS_KEY"] }).mockResolvedValueOnce(written());
    const r = await run(...base, "--repo", "a", "--repo", "b");
    expect(r.code).toBe(1);
    expect(r.err).toBe("a: input required for STRIPE_KEY, MAPS_KEY. Pass --prompt KEY=VALUE or SECRET_DESK_PROMPT_<KEY>, or mark the entry optional.");
    expect(r.out).toContain("written: /work/.env.local");
  });

  it("lists keys left empty and warnings (translated)", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web")]));
    m.exportEnv.mockResolvedValue(written({ keys: ["A", "B", "C"], skipped: ["B"], warnings: ["Datei ist nicht in .gitignore"] }));
    const r = await run(...base, "--repo", "web");
    expect(r.out).toBe("written: /work/.env.local (2 of 3 keys set, mode 600)\n  left empty: B");
    expect(r.err).toMatch(/^  warning: .+/);
    expect(r.code).toBe(0);
  });

  it("orders templates so that a referenced template runs first and shares its values", async () => {
    const ref = { key: "TOKEN", from: { type: "ref", template: "b-dev", key: "T" } };
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("a-dev", "a", "dev", [ref]), tpl("b-dev", "b")]));
    m.exportEnv.mockResolvedValue(written());
    await run(...base, "--repo", "a", "--repo", "b");
    expect(m.exportEnv.mock.calls.map((c) => c[2].template)).toEqual(["b-dev", "a-dev"]);
    expect(m.exportEnv.mock.calls[0]![2].runValues).toBe(m.exportEnv.mock.calls[1]![2].runValues);
  });

  it("an error from the runtime is translated and ends with exit 2", async () => {
    m.createRuntime.mockResolvedValue(fakeRuntime([tpl("web-dev", "web")]));
    m.exportEnv.mockRejectedValue(new Error("boom"));
    const r = await run(...base, "--repo", "web");
    expect(r).toMatchObject({ code: 2 });
    expect(r.err).toContain("Error: ");
    expect(r.err).toContain("boom");
  });
});
