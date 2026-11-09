import { describe, expect, it, vi } from "vitest";
import {
  ConnectionStore,
  InventoryStore,
  IssuanceError,
  NotConnectedError,
  ParamsInvalidError,
  PreflightError,
  ProviderRegistry,
  RotationError,
  SecretValue,
  commitIssuance,
  discardIssuance,
  prepareIssuance,
} from "../src/index.js";
import type { Check, PendingIssuance, Provider } from "../src/index.js";

const YAML = `version: 1
secrets:
  - { id: main, name: MAIN_KEY, stage: staging, service: x, provider: acme, expiry: possible, externalId: old-id, params: { companion: side }, places: [{ repo: web, scope: environment, environment: staging }, { repo: api, scope: repository }] }
  - { id: side, name: SIDE_KEY, stage: staging, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: environment, environment: staging }] }
  - { id: other-stage, name: OTHER_STAGE, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }] }
  - { id: nowhere, name: NOWHERE, stage: dev, service: x, provider: manual, expiry: none }
variables:
  - { id: pub, name: PUBLIC_VALUE, stage: staging, value: "https://a.example.com", places: [{ repo: web, scope: environment, environment: staging }] }
`;
const LONG = "made-up-long-value-0123456789";

interface World {
  deps: Parameters<typeof prepareIssuance>[1];
  inventory: InventoryStore;
  issue: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  github: Record<string, ReturnType<typeof vi.fn>>;
  evidenceSaves: unknown[];
}

function world(over: { provider?: Partial<Provider> | null; yaml?: string; github?: Record<string, unknown>; deps?: object } = {}): World {
  const issue = vi.fn(async () => ({ value: new SecretValue(LONG), externalId: "new-id", expiresAt: "2027-03-01T00:00:00Z" }));
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue: issue as never, revoke, ...over.provider };
  const github = {
    publicKey: vi.fn(async () => ({})),
    listSecrets: vi.fn(async () => [{ name: "MAIN_KEY", updatedAt: "2026-03-01T10:00:00Z" }, { name: "SIDE_KEY", updatedAt: "2026-03-01T10:00:00Z" }]),
    listVariables: vi.fn(async () => [{ name: "PUBLIC_VALUE", value: LONG, updatedAt: "2026-03-01T10:00:00Z" }]),
    putSecret: vi.fn(async () => "updated" as const),
    putVariable: vi.fn(async () => "updated" as const),
    ...over.github,
  } as Record<string, ReturnType<typeof vi.fn>>;
  const inventory = InventoryStore.fromText(over.yaml ?? YAML);
  const evidenceSaves: unknown[] = [];
  const deps = {
    inventory,
    github: github as never,
    providers: over.provider === null ? new ProviderRegistry() : new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    fetch: vi.fn() as never,
    now: () => new Date("2026-03-01T10:00:00Z"),
    evidence: { save: async (r: unknown) => void evidenceSaves.push(r) } as never,
    ...over.deps,
  };
  return { deps, inventory, issue, revoke, github, evidenceSaves };
}
const ticksOf = (p: PendingIssuance) => p.report.checklist.map((c) => c.id);
const checkOf = (p: PendingIssuance, id: string): Check | undefined => p.report.checks.find((c) => c.id === id);

describe("prepareIssuance: refusals", () => {
  it("unknown secret, stage not allowed, no places", async () => {
    const w = world();
    await expect(prepareIssuance("nope", w.deps)).rejects.toThrow(new IssuanceError("Secret nicht gefunden: nope"));
    await expect(prepareIssuance("main", w.deps, { allowedStages: ["dev"] })).rejects.toThrow(RotationError);
    await expect(prepareIssuance("nowhere", w.deps)).rejects.toThrow("kein Ziel");
  });
  it("a provider that cannot issue; incomplete parameters; failing preflight", async () => {
    await expect(prepareIssuance("main", world({ provider: null }).deps)).rejects.toThrow('kann nicht automatisch erzeugen');
    await expect(prepareIssuance("main", world({ provider: { issue: undefined } }).deps)).rejects.toThrow("kann nicht automatisch erzeugen");
    const params = [{ key: "project", label: "Project", labelEn: "Project", type: "string" as const, required: true, help: "", helpEn: "" }];
    await expect(prepareIssuance("main", world({ provider: { params } }).deps)).rejects.toBeInstanceOf(ParamsInvalidError);
    const failing = world({ provider: { preflight: async () => ({ resource: null, findings: [{ id: "x", level: "fail", label: "Wrong account" }] }) } });
    await expect(prepareIssuance("main", failing.deps)).rejects.toBeInstanceOf(PreflightError);
    expect(failing.issue).not.toHaveBeenCalled();
  });
  it("a missing connection is the usual error when issuing", async () => {
    const w = world({ provider: { preflight: async () => { throw new NotConnectedError("acme", "connect it"); } } });
    await expect(prepareIssuance("main", w.deps)).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe("prepareIssuance: preflight findings", () => {
  it("shows the resource and warnings, with and without detail; ok findings stay out", async () => {
    const w = world({ provider: { preflight: async () => ({ resource: "Project p1", findings: [{ id: "a", level: "warn", label: "Close to limit", detail: "90%" }, { id: "b", level: "warn", label: "Old plan" }, { id: "c", level: "ok", label: "fine" }] }) } });
    const p = await prepareIssuance("main", w.deps);
    expect(checkOf(p, "preflight-resource")).toMatchObject({ status: "pass", actual: "Project p1" });
    expect(checkOf(p, "preflight:a")).toMatchObject({ status: "warn", detail: "90%" });
    expect(checkOf(p, "preflight:b")).not.toHaveProperty("detail");
    expect(checkOf(p, "preflight:c")).toBeUndefined();
  });
  it("no resource and only ok findings add nothing", async () => {
    const w = world({ provider: { preflight: async () => ({ resource: null, findings: [{ id: "c", level: "ok", label: "fine" }] }) } });
    const p = await prepareIssuance("main", w.deps);
    expect(p.report.checks.filter((c) => c.id.startsWith("preflight"))).toEqual([]);
  });
});

describe("prepareIssuance: companions", () => {
  const withCompanion = (extra: Partial<Provider> = {}) => world({ provider: { companionParams: ["companion"], ...extra } });

  it("a companion on another stage or without places is refused before anything is created", async () => {
    const otherStage = world({ provider: { companionParams: ["companion"] }, yaml: YAML.replace("companion: side", "companion: other-stage") });
    await expect(prepareIssuance("main", otherStage.deps)).rejects.toThrow("liegt in einer anderen Stage (shared)");
    // Only a dev entry may have no places, so the main entry lives on the dev stage here.
    const noPlaces = world({ provider: { companionParams: ["companion"] }, yaml: YAML.replace("id: main, name: MAIN_KEY, stage: staging", "id: main, name: MAIN_KEY, stage: dev").replace("companion: side", "companion: nowhere").replace("environment: staging }, { repo: api", "environment: staging }, { repo: api") });
    await expect(prepareIssuance("main", noPlaces.deps)).rejects.toThrow("hat kein Ziel");
    expect(otherStage.issue).not.toHaveBeenCalled();
  });

  it("a companion value for an entry nobody named undoes what was created; a failing revoke does not hide the error", async () => {
    const w = withCompanion({ issue: (async () => ({ value: new SecretValue(LONG), externalId: "new-id", companions: [{ entryId: "other-stage", value: new SecretValue("x") }] })) as never });
    await expect(prepareIssuance("main", w.deps)).rejects.toThrow("nicht benannten Eintrag");
    expect(w.revoke).toHaveBeenCalledTimes(1);
    const failing = withCompanion({ issue: (async () => ({ value: new SecretValue(LONG), externalId: "new-id", companions: [{ entryId: "other-stage", value: new SecretValue("x") }] })) as never, revoke: async () => { throw new Error("no"); } });
    await expect(prepareIssuance("main", failing.deps)).rejects.toThrow("nicht benannten Eintrag");
  });

  it("nothing is revoked when the provider rotated in place or cannot revoke", async () => {
    const same = withCompanion({ issue: (async () => ({ value: new SecretValue(LONG), externalId: "old-id", companions: [{ entryId: "other-stage", value: new SecretValue("x") }] })) as never });
    await expect(prepareIssuance("main", same.deps)).rejects.toThrow(IssuanceError);
    expect(same.revoke).not.toHaveBeenCalled();
    const noRevoke = withCompanion({ revoke: undefined, issue: (async () => ({ value: new SecretValue(LONG), externalId: "new-id", companions: [{ entryId: "other-stage", value: new SecretValue("x") }] })) as never });
    await expect(prepareIssuance("main", noRevoke.deps)).rejects.toThrow(IssuanceError);
  });

  it("an unreachable companion target (secret and variable) is a failed check", async () => {
    const issued = { value: new SecretValue(LONG), externalId: "new-id", companions: [{ entryId: "side", value: new SecretValue("c1") }] };
    const secretCase = withCompanion({ issue: (async () => issued) as never });
    secretCase.github.publicKey!.mockImplementation(async (t: { repo: string; environment?: string }) => {
      if (t.environment === "staging" && t.repo === "web") throw new Error("no access");
      return {};
    });
    const p = await prepareIssuance("main", secretCase.deps);
    expect(p.report.checks.find((c) => c.id.startsWith("companion-target:side"))).toMatchObject({ status: "fail", detail: "no access" });

    const variableCase = world({ provider: { companionParams: ["companion"], issue: (async () => ({ value: new SecretValue(LONG), companions: [{ entryId: "pub", kind: "variable", value: new SecretValue("public") }] })) as never }, yaml: YAML.replace("companion: side", "companion: pub") });
    variableCase.github.listVariables!.mockRejectedValue(new Error("no variable access"));
    const q = await prepareIssuance("main", variableCase.deps);
    expect(q.report.checks.find((c) => c.id.startsWith("companion-target:pub"))).toMatchObject({ status: "fail", detail: "no variable access" });
    expect(q.report.companions![0]).toMatchObject({ kind: "variable", entryId: "pub" });
  });
});

describe("prepareIssuance: checks and report", () => {
  it("a short value warns; a provider that cannot verify is a warning; verify results are added", async () => {
    const w = world({ provider: { issue: (async () => ({ value: new SecretValue("short") })) as never, verify: async () => { throw new Error("verify down"); } } });
    const p = await prepareIssuance("main", w.deps);
    expect(checkOf(p, "value-shape")).toMatchObject({ status: "warn", actual: "5 Zeichen" });
    expect(checkOf(p, "provider-verify")).toMatchObject({ status: "warn", detail: "verify down" });
    expect(p.report).not.toHaveProperty("externalId");
    const ok = world({ provider: { verify: async () => [{ id: "active", label: "Active", status: "pass" }] } });
    expect(checkOf(await prepareIssuance("main", ok.deps), "active")).toMatchObject({ status: "pass" });
  });

  it("an unknown expiry: warned for a required date, noted for a possible one, 'none' for no expiry; the time to live is used", async () => {
    const noExpiry = { issue: (async () => ({ value: new SecretValue(LONG) })) as never };
    const required = world({ provider: noExpiry, yaml: YAML.replace("expiry: possible, externalId: old-id", "expiry: required") });
    expect(checkOf(await prepareIssuance("main", required.deps), "expiry-known")).toMatchObject({ status: "warn" });
    const possible = world({ provider: noExpiry });
    expect(checkOf(await prepareIssuance("main", possible.deps), "expiry-unknown")).toMatchObject({ status: "warn" });
    const ttl = world({ provider: noExpiry, yaml: YAML.replace("expiry: possible, externalId: old-id", "expiry: possible, ttlDays: 10") });
    const p = await prepareIssuance("main", ttl.deps);
    expect(p.newExpires).toBe("2026-03-11");
    expect(checkOf(p, "expiry")).toMatchObject({ actual: "2026-03-11" });
    const none = world({ yaml: YAML.replace("expiry: possible, externalId: old-id", "expiry: none") });
    expect(checkOf(await prepareIssuance("main", none.deps), "expiry")).toMatchObject({ actual: "kein Ablauf" });
  });

  it("uses the real clock, the global fetch and the provider configuration when asked; a manual value needs no provider", async () => {
    const w = world({ deps: { providerConfig: { grafana: { allowedHosts: [] } } } });
    const { now: _now, fetch: _fetch, ...rest } = w.deps as Record<string, unknown>;
    void _now;
    void _fetch;
    const p = await prepareIssuance("main", rest as never);
    expect(p.createdAt).toMatch(/^\d{4}-/);
    expect((w.issue.mock.calls[0] as unknown as [{ fetch: unknown; providerConfig: unknown }])[0]).toMatchObject({ fetch, providerConfig: { grafana: { allowedHosts: [] } } });
    const manual = world({ provider: null });
    const m = await prepareIssuance("main", manual.deps, { manualValue: new SecretValue(LONG), ttlMinutes: 1 });
    expect(m.report.kind).toBe("manual");
    expect(Date.parse(m.expiresAt) - Date.parse(m.createdAt)).toBe(60_000);
  });

  it("a checklist for a Worker place and for production names them", async () => {
    const acc = "0123456789abcdef0123456789abcdef";
    const yaml = `version: 1\nsecrets:\n  - { id: main, name: MAIN_KEY, stage: production, service: x, provider: acme, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${acc}", script: portal, name: WORKER_KEY }] }\n`;
    const w = world({ yaml });
    const p = await prepareIssuance("main", { ...w.deps, workers: { check: async () => undefined } as never });
    expect(p.report.checklist.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringContaining("WORKER_KEY wird als Worker-Secret auf dem Worker portal"), "Ich weiss, dass dieser Wert die Produktion betrifft."]));
  });
});

describe("commitIssuance", () => {
  const ready = async (over: Parameters<typeof world>[0] = {}) => {
    const w = world(over);
    const pending = await prepareIssuance("main", w.deps);
    return { ...w, pending };
  };

  it("fails for a secret that vanished from the inventory", async () => {
    const w = await ready();
    const empty = InventoryStore.fromText("version: 1\n");
    await expect(commitIssuance(w.pending, { ...w.deps, inventory: empty }, { by: "me", ticks: ticksOf(w.pending) })).rejects.toThrow("Secret nicht gefunden: main");
  });

  it("a verification that cannot be done is a warning, not a failure", async () => {
    const w = await ready();
    w.github.listSecrets!.mockRejectedValue(new Error("rate limited"));
    const r = await commitIssuance(w.pending, w.deps, { by: "me", ticks: ticksOf(w.pending) });
    expect(r.ok).toBe(true);
    expect(w.pending.report.checks.filter((c) => c.id.startsWith("written:") && c.status === "warn" && c.detail === "rate limited")).toHaveLength(2);
  });

  it("revokes the old value with the provider configuration, and the real clock by default", async () => {
    const w = await ready({ deps: { providerConfig: { grafana: { allowedHosts: [] } } } });
    const { now: _now, ...rest } = w.deps as Record<string, unknown>;
    void _now;
    const pending = await prepareIssuance("main", w.deps);
    // Created with the fixed clock, confirmed with the real one: the request is long expired by now.
    await expect(commitIssuance(pending, rest as never, { by: "me", ticks: ticksOf(pending) })).rejects.toThrow("abgelaufen");
    const r = await commitIssuance(w.pending, w.deps, { by: "me", ticks: ticksOf(w.pending) });
    expect(r.revokedOld).toBe(true);
    expect(w.revoke.mock.calls[0]![0]).toMatchObject({ externalId: "old-id", providerConfig: { grafana: { allowedHosts: [] } } });
  });

  it("an inventory that cannot be saved still reports success and what to do", async () => {
    const w = await ready();
    vi.spyOn(w.inventory, "save").mockRejectedValue(new Error("disk full"));
    const r = await commitIssuance(w.pending, w.deps, { by: "me", ticks: ticksOf(w.pending) });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining(["Der alte Token ist bereits widerrufen, aber das Inventar wurde nicht gespeichert.", "Neue Kennung beim Anbieter: new-id", "Grund: disk full", "Inventar von Hand nachtragen."]));
  });

  it("without a revoke and an external id the warnings say so", async () => {
    const w = await ready({ provider: { revoke: undefined, issue: (async () => ({ value: new SecretValue(LONG) })) as never } });
    vi.spyOn(w.inventory, "save").mockRejectedValue(new Error("disk full"));
    const r = await commitIssuance(w.pending, w.deps, { by: "me", ticks: ticksOf(w.pending) });
    expect(r.revokedOld).toBe(false);
    expect(r.warnings).toEqual(expect.arrayContaining(["Der neue Wert ist in allen Zielen geschrieben, aber das Inventar wurde nicht gespeichert.", "Neue Kennung beim Anbieter: unbekannt"]));
  });
});

describe("discardIssuance", () => {
  it("looks the secret up in the inventory when the request carries no copy, and survives an unknown provider", async () => {
    const w = world();
    const pending = await prepareIssuance("main", w.deps);
    const bare = { ...pending, issuedSecret: undefined } as unknown as PendingIssuance;
    expect((await discardIssuance(bare, w.deps, { by: "me", why: "rejected" })).revokedNew).toBe(true);
    const unknown = world({ provider: null });
    const noProvider = { ...pending, issuedSecret: undefined } as unknown as PendingIssuance;
    expect((await discardIssuance(noProvider, unknown.deps, { by: "me", why: "rejected" })).revokedNew).toBe(false);
    const gone = { ...pending, issuedSecret: undefined, secretId: "vanished" } as unknown as PendingIssuance;
    expect((await discardIssuance(gone, w.deps, { by: "me", why: "rejected" })).revokedNew).toBe(false);
  });

  it("revokes with the provider configuration and explains the reason; a token that stays is flagged", async () => {
    const w = world({ deps: { providerConfig: { grafana: { allowedHosts: [] } } } });
    const pending = await prepareIssuance("main", w.deps);
    await discardIssuance(pending, w.deps, { by: "me", why: "expired" });
    expect(w.revoke.mock.calls[0]![0]).toMatchObject({ providerConfig: { grafana: { allowedHosts: [] } } });
    expect(pending.report.confirmation!.note).toBe("Zeit abgelaufen");

    const rejected = await prepareIssuance("main", w.deps);
    await discardIssuance(rejected, w.deps, { by: "me", why: "rejected", note: "wrong scope" });
    expect(rejected.report.confirmation!.note).toBe("Abgelehnt: wrong scope");

    const stuck = world({ provider: { revoke: async () => { throw new Error("no"); } } });
    const p = await prepareIssuance("main", stuck.deps);
    await discardIssuance(p, stuck.deps, { by: "me", why: "stale" });
    expect(p.report.confirmation!.note).toBe("Eintrag seit der Pruefung geaendert (neuer Wert beim Anbieter NICHT widerrufen)");
  });

  it("uses the real clock by default", async () => {
    const w = world();
    const pending = await prepareIssuance("main", w.deps);
    const { now: _now, ...rest } = w.deps as Record<string, unknown>;
    void _now;
    await discardIssuance(pending, rest as never, { by: "me", why: "rejected" });
    expect(pending.report.confirmation!.at).not.toBe("2026-03-01T10:00:00.000Z");
  });
});
