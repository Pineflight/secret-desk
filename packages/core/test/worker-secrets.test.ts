import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { FileEvidenceStore } from "../src/evidence-file-store.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { buildSyncPlan, runSync, syncLineKey, type SecretValueSource } from "../src/github-sync.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, prepareIssuance } from "../src/issuance.js";
import { errorMatchesPlace, putPlaceSecret, snapshotPlaces } from "../src/place-io.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { rotateSecret, uploadEncrypted } from "../src/rotate.js";
import { SecretValue } from "../src/secret.js";
import { computeStatus, placeKey } from "../src/status.js";
import { PlaceSchema, isWorkerPlace, type WorkerPlace } from "../src/types.js";
import { WorkerSecretsClient, WorkerSecretsError } from "../src/worker-secrets.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "acme-portal-staging";
const VALUE = "made-up-worker-secret-value-4417";
// Assembled at run time so the repository secret scan does not match the made-up value.
const TOKEN = ["cf", "connection", "made", "up"].join("-");

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

/** A fake Cloudflare: one account with the Workers in `scripts`; `existing` are the secret names every Worker already holds. */
function fakeCloudflare(options: { existing?: string[]; scripts?: string[]; failStatus?: number } = {}) {
  const calls: Call[] = [];
  const scripts = options.scripts ?? [SCRIPT, "acme-portal"];
  const names = new Map(scripts.map((s) => [s, new Set(options.existing ?? [])]));
  const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }), { status: 404 });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const prefix = `/client/v4/accounts/${ACCOUNT}/workers/scripts`;
    if (options.failStatus) return new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }), { status: options.failStatus });
    if (u.pathname === prefix && method === "GET") return new Response(JSON.stringify({ success: true, result: scripts.map((id) => ({ id, modified_on: "2026-11-01T00:00:00Z" })) }), { status: 200 });
    const m = new RegExp(`^${prefix}/([^/]+)/secrets$`).exec(u.pathname);
    const set = m ? names.get(decodeURIComponent(m[1]!)) : undefined;
    if (!set) return notFound();
    if (method === "GET") return new Response(JSON.stringify({ success: true, result: [...set].map((name) => ({ name, type: "secret_text" })) }), { status: 200 });
    if (method === "PUT") {
      set.add((body as { name: string }).name);
      return new Response(JSON.stringify({ success: true, result: { name: (body as { name: string }).name, type: "secret_text" } }), { status: 200 });
    }
    return notFound();
  });
  const client = new WorkerSecretsClient({ auth: async () => new SecretValue(TOKEN), fetch: fetch as unknown as typeof globalThis.fetch });
  return { calls, client, fetch, names };
}

const place: WorkerPlace = { scope: "cloudflare-worker", accountId: ACCOUNT, script: SCRIPT };

describe("WorkerSecretsClient", () => {
  it("writes with PUT .../secrets and the connection token, secret_text type", async () => {
    const cf = fakeCloudflare();
    const outcome = await cf.client.putSecret(place, "ANTHROPIC_API_KEY", new SecretValue(VALUE));
    expect(outcome).toBe("created");
    const put = cf.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe(`/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`);
    expect(put.body).toEqual({ name: "ANTHROPIC_API_KEY", text: VALUE, type: "secret_text" });
    expect(put.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("says updated for a name that exists already", async () => {
    const cf = fakeCloudflare({ existing: ["OPENAI_API_KEY"] });
    expect(await cf.client.putSecret(place, "OPENAI_API_KEY", new SecretValue(VALUE))).toBe("updated");
  });

  it("lists names only and never asks for a value", async () => {
    const cf = fakeCloudflare({ existing: ["A_KEY", "B_KEY"] });
    expect(await cf.client.listSecretNames(place)).toEqual(["A_KEY", "B_KEY"]);
    await cf.client.check(place);
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
    expect(cf.calls.some((c) => /secrets\/[A-Z_]+/.test(c.path))).toBe(false);
  });

  it("lists the Workers of the account", async () => {
    const cf = fakeCloudflare();
    expect(await cf.client.listScripts(ACCOUNT)).toEqual([{ name: SCRIPT }, { name: "acme-portal" }]);
  });

  it("fails with the status and a hint, without a value or the token in the message", async () => {
    for (const status of [401, 403, 404]) {
      const cf = fakeCloudflare({ failStatus: status });
      const err = await cf.client.putSecret(place, "ANTHROPIC_API_KEY", new SecretValue(VALUE)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkerSecretsError);
      const e = err as WorkerSecretsError;
      expect(e.status).toBe(status);
      expect(e.message).not.toContain(VALUE);
      expect(e.message).not.toContain(TOKEN);
      if (status !== 404) expect(e.message).toContain("Workers Scripts Write");
      else expect(e.message).toContain("Worker nicht gefunden");
    }
  });

  it("never copies upstream message text into the error; keeps status and numeric codes", async () => {
    const MARKER = "upstream-marker-text-8812";
    const answer = (status: number, body: string) =>
      new WorkerSecretsClient({ auth: async () => new SecretValue(TOKEN), fetch: (async () => new Response(body, { status, statusText: MARKER })) as unknown as typeof globalThis.fetch });
    const withMarker = JSON.stringify({ success: false, errors: [{ code: 10000, message: MARKER }, { code: "x", message: MARKER }, { message: MARKER }] });
    const expected: [number, RegExp][] = [
      [401, /Authentifizierung/],
      [403, /Keine Berechtigung/],
      [404, /Worker nicht gefunden/],
      [429, /Rate Limit/],
      [503, /Serverfehler/],
      [400, /abgelehnt/],
    ];
    for (const [status, text] of expected) {
      const e = (await answer(status, withMarker).putSecret(place, "NAME", new SecretValue(VALUE)).catch((x: unknown) => x)) as WorkerSecretsError;
      expect(e.status).toBe(status);
      expect(e.message).toMatch(text);
      expect(e.message).toContain(`-> ${status}:`);
      expect(e.message).toContain("Cloudflare-Code 10000");
      expect(e.message).not.toContain(MARKER);
      expect(e.message).not.toContain(VALUE);
      expect(e.message).not.toContain(TOKEN);
    }
    for (const body of ["not json", JSON.stringify({ success: false })]) {
      const e = (await answer(500, body).listSecretNames(place).catch((x: unknown) => x)) as WorkerSecretsError;
      expect(e.message).not.toContain("Cloudflare-Code");
      expect(e.message).not.toContain(MARKER);
    }
  });

  it("encodes the path pieces", async () => {
    const cf = fakeCloudflare();
    await cf.client.listSecretNames({ accountId: ACCOUNT, script: "a b" }).catch(() => undefined);
    expect(cf.calls[0]!.path).toContain("a%20b");
  });
});

describe("the Worker place shape", () => {
  it("accepts a Worker place next to GitHub places", () => {
    expect(PlaceSchema.safeParse({ scope: "cloudflare-worker", accountId: ACCOUNT, script: SCRIPT }).success).toBe(true);
    expect(PlaceSchema.safeParse({ repo: "acme-app", scope: "repository" }).success).toBe(true);
  });
  it("rejects a malformed account id, an empty or path-like script, and a GitHub place without repo", () => {
    expect(PlaceSchema.safeParse({ scope: "cloudflare-worker", accountId: "acme", script: SCRIPT }).success).toBe(false);
    expect(PlaceSchema.safeParse({ scope: "cloudflare-worker", accountId: ACCOUNT, script: "" }).success).toBe(false);
    expect(PlaceSchema.safeParse({ scope: "cloudflare-worker", accountId: ACCOUNT, script: "../x" }).success).toBe(false);
    expect(PlaceSchema.safeParse({ scope: "repository" }).success).toBe(false);
  });
  it("is allowed on a secret and refused on a variable (Worker variables are out of scope)", () => {
    const secret = `version: 1\nsecrets:\n  - { id: s1, name: ANTHROPIC_API_KEY, stage: staging, service: anthropic, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }\n`;
    const inv = InventoryStore.fromText(secret);
    expect(isWorkerPlace(inv.getSecret("s1")!.places[0]!)).toBe(true);
    const variable = `version: 1\nvariables:\n  - { id: v1, name: PUBLIC_URL, stage: staging, value: "https://x.example.com", places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }\n`;
    expect(() => InventoryStore.fromText(variable)).toThrow();
  });
  it("needs no environment resolution: a Worker place of a stage without environment is valid", () => {
    const yaml = `version: 1\nsecrets:\n  - { id: s1, name: ANTHROPIC_API_KEY, stage: dev, service: anthropic, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: acme-portal-dev }] }\n`;
    expect(InventoryStore.fromText(yaml).getSecret("s1")!.places).toHaveLength(1);
  });
});

describe("putPlaceSecret", () => {
  it("routes a Worker place to the Worker client and fails clearly without it", async () => {
    const cf = fakeCloudflare();
    const github = { putSecret: vi.fn(async () => "created" as const) };
    expect(await putPlaceSecret({ github, workers: cf.client, owner: "acme" }, place, "ANTHROPIC_API_KEY", new SecretValue(VALUE))).toBe("created");
    expect(github.putSecret).not.toHaveBeenCalled();
    await expect(putPlaceSecret({ github, owner: "acme" }, place, "ANTHROPIC_API_KEY", new SecretValue(VALUE))).rejects.toThrow(/cloudflare/);
  });
  it("routes a GitHub place to GitHub", async () => {
    const github = { putSecret: vi.fn(async () => "updated" as const) };
    const out = await putPlaceSecret({ github, owner: "acme" }, { repo: "acme-app", scope: "repository" }, "X_KEY", new SecretValue(VALUE));
    expect(out).toBe("updated");
    expect(github.putSecret).toHaveBeenCalledOnce();
  });
});

const YAML = `version: 1
secrets:
  - { id: anthropic-portal-staging, name: ANTHROPIC_API_KEY, stage: staging, service: anthropic, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }
  - { id: openai-portal-staging, name: OPENAI_API_KEY, stage: staging, service: openai, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }
  - { id: openai-portal-prod, name: OPENAI_API_KEY, stage: production, service: openai, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: acme-portal }] }
  - { id: openai-portal-gone, name: OPENAI_API_KEY, stage: shared, service: openai, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: acme-portal-gone }] }
`;

describe("live state and status", () => {
  it("keys a Worker place by account, script and name", () => {
    expect(placeKey("acme", place, "ANTHROPIC_API_KEY")).toBe(`cloudflare-worker/${ACCOUNT}/${SCRIPT}/ANTHROPIC_API_KEY`);
  });

  it("reads each Worker once and marks names present or missing", async () => {
    const cf = fakeCloudflare({ existing: ["ANTHROPIC_API_KEY"] });
    const inv = InventoryStore.fromText(YAML);
    const places = inv.data.secrets.filter((s) => s.stage === "staging").flatMap((s) => s.places);
    const { snapshot, errors } = await snapshotPlaces({ github: { listSecrets: vi.fn() }, workers: cf.client, owner: "acme" }, places);
    expect(errors).toEqual([]);
    expect(cf.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    const present = computeStatus(inv.getSecret("anthropic-portal-staging")!, new Date("2026-11-04T00:00:00Z"), { live: snapshot, owner: "acme" });
    const missing = computeStatus(inv.getSecret("openai-portal-staging")!, new Date("2026-11-04T00:00:00Z"), { live: snapshot, owner: "acme" });
    expect(present.status).not.toBe("missing");
    expect(missing.status).toBe("missing");
    expect(missing.missingPlaces).toHaveLength(1);
  });

  it("treats 404 as missing and 403 as an unreadable store, not as missing", async () => {
    const inv = InventoryStore.fromText(YAML);
    const places = inv.getSecret("openai-portal-staging")!.places;
    const forbidden = fakeCloudflare({ failStatus: 403 });
    const r = await snapshotPlaces({ github: { listSecrets: vi.fn() }, workers: forbidden.client, owner: "acme" }, places);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ scope: "cloudflare-worker", script: SCRIPT, status: 403 });
    expect(errorMatchesPlace(r.errors[0]!, places[0]!)).toBe(true);
    expect(errorMatchesPlace(r.errors[0]!, { scope: "cloudflare-worker", accountId: ACCOUNT, script: "other" })).toBe(false);
    const gone = fakeCloudflare({ failStatus: 404 });
    const g = await snapshotPlaces({ github: { listSecrets: vi.fn() }, workers: gone.client, owner: "acme" }, places);
    expect(g.errors).toEqual([]);
    expect(g.snapshot.size).toBe(0);
  });

  it("reports every Worker place as unreadable when there is no Cloudflare client", async () => {
    const inv = InventoryStore.fromText(YAML);
    const r = await snapshotPlaces({ github: { listSecrets: vi.fn() }, owner: "acme" }, inv.getSecret("openai-portal-staging")!.places);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/cloudflare/);
  });
});

function issuanceSetup() {
  const cf = fakeCloudflare();
  const provider: Provider = { id: "manual", label: "Manual", kind: "manual" };
  return mkdtemp(join(tmpdir(), "sd-ev-")).then((dir) => {
    const inventory = InventoryStore.fromText(YAML);
    const github = new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    const deps = { inventory, github, workers: cf.client, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore(), owner: "acme", now: () => new Date("2026-11-04T10:00:00Z"), evidence: new FileEvidenceStore(dir) };
    return { cf, deps, inventory };
  });
}

describe("issuance with a Worker place", () => {
  it("names the Worker secret in the review checklist and checks the Worker is reachable", async () => {
    const { deps } = await issuanceSetup();
    const p = await prepareIssuance("anthropic-portal-staging", deps, { manualValue: new SecretValue(VALUE) });
    expect(p.report.targets).toEqual([`Cloudflare Worker ${SCRIPT} (${ACCOUNT})`]);
    expect(p.report.checklist.map((c) => c.text)).toContain(`Das Secret ANTHROPIC_API_KEY wird als Worker-Secret auf dem Worker ${SCRIPT} (Konto ${ACCOUNT}) geschrieben.`);
    expect(p.report.checks.find((c) => c.id.startsWith("target:"))).toMatchObject({ status: "pass" });
    expect(JSON.stringify(p.report)).not.toContain(VALUE);
  });

  it("fails the target check when the Worker cannot be read", async () => {
    const { deps } = await issuanceSetup();
    const down = fakeCloudflare({ failStatus: 404 });
    const p = await prepareIssuance("anthropic-portal-staging", { ...deps, workers: down.client }, { manualValue: new SecretValue(VALUE) });
    expect(p.report.checks.find((c) => c.id.startsWith("target:"))).toMatchObject({ status: "fail" });
  });

  it("writes the Worker secret on confirm, verifies the name and keeps the value out of the evidence", async () => {
    const { deps, cf } = await issuanceSetup();
    const p = await prepareIssuance("anthropic-portal-staging", deps, { manualValue: new SecretValue(VALUE) });
    const ticks = p.report.checklist.map((c) => c.id);
    const r = await commitIssuance(p, deps, { by: "alice", ticks });
    expect(r.ok).toBe(true);
    expect(r.places[0]!.outcome).toBe("created");
    expect(cf.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(cf.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ name: "ANTHROPIC_API_KEY", text: VALUE });
    const written = p.report.checks.find((c) => c.id.startsWith("written:"))!;
    expect(written).toMatchObject({ status: "pass" });
    expect(JSON.stringify(p.report)).not.toContain(VALUE);
  });

  it("asks for the production confirmation for a Worker place of a production entry", async () => {
    const { deps } = await issuanceSetup();
    const p = await prepareIssuance("openai-portal-prod", deps, { manualValue: new SecretValue(VALUE) });
    expect(p.report.checklist.at(-1)!.text).toMatch(/Produktion/);
    await expect(commitIssuance(p, deps, { by: "alice", ticks: p.report.checklist.slice(0, -1).map((c) => c.id) })).rejects.toThrow(/Pruefpunkte/);
  });

  it("reports a Worker write failure per place and writes nothing else", async () => {
    const { deps } = await issuanceSetup();
    const down = fakeCloudflare({ failStatus: 403 });
    const p = await prepareIssuance("anthropic-portal-staging", { ...deps, workers: down.client }, { manualValue: new SecretValue(VALUE) });
    const r = await commitIssuance(p, { ...deps, workers: down.client }, { by: "alice", ticks: p.report.checklist.map((c) => c.id) }, { force: true });
    expect(r.ok).toBe(false);
    expect(r.places[0]).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });
});

describe("rotation with a Worker place", () => {
  it("writes the issued value to the Worker", async () => {
    const cf = fakeCloudflare();
    const inventory = InventoryStore.fromText(YAML.replace("provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: \"" + ACCOUNT + "\", script: " + SCRIPT, "provider: gen, expiry: none, places: [{ scope: cloudflare-worker, accountId: \"" + ACCOUNT + "\", script: " + SCRIPT));
    const gen: Provider = { id: "gen", label: "Gen", kind: "automatic", issue: async () => ({ value: new SecretValue(VALUE), expiresAt: null }) };
    const github = new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    const r = await rotateSecret("anthropic-portal-staging", { inventory, github, workers: cf.client, providers: new ProviderRegistry().register(gen), connections: new ConnectionStore(), owner: "acme", now: () => new Date("2026-11-04T10:00:00Z") });
    expect(r.ok).toBe(true);
    expect(r.places[0]).toMatchObject({ outcome: "created" });
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it("refuses the browser upload for a Worker place", async () => {
    const inventory = InventoryStore.fromText(YAML);
    const github = { putEncrypted: vi.fn() } as unknown as GitHubClient;
    const r = await uploadEncrypted("anthropic-portal-staging", [{ place, keyId: "k", encryptedValue: "x" }], { inventory, github, owner: "acme" });
    expect(r.ok).toBe(false);
    expect(r.places[0]!.error).toMatch(/Browser-Upload/);
    expect((github as unknown as { putEncrypted: ReturnType<typeof vi.fn> }).putEncrypted).not.toHaveBeenCalled();
  });
});

describe("sync plan and run for Worker secrets", () => {
  const stored = new Set(["anthropic-portal-staging", "openai-portal-staging", "openai-portal-prod", "openai-portal-gone"]);
  const values: SecretValueSource = {
    info: async (id) => (stored.has(id) ? { fingerprint: "abc123def456", savedAt: "2026-10-01T10:00:00Z" } : null),
    get: async (id) => (stored.has(id) ? new SecretValue(VALUE) : null),
  };
  const github = { listSecrets: vi.fn(async () => []), listVariables: vi.fn(async () => []) };

  it("plans write/missing for an absent name and write/overwrite for a present one, with no time-based warning", async () => {
    const cf = fakeCloudflare({ existing: ["ANTHROPIC_API_KEY"] });
    const inv = InventoryStore.fromText(YAML).data;
    const plan = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: inv, values });
    const byId = (id: string) => plan.lines.find((l) => l.entryId === id)!;
    expect(byId("anthropic-portal-staging")).toMatchObject({ action: "write", reason: "overwrite", defaultOn: true, kind: "secret" });
    expect(byId("openai-portal-staging")).toMatchObject({ action: "write", reason: "missing", defaultOn: true });
    expect(byId("anthropic-portal-staging").placeLabel).toBe(`worker:${SCRIPT}`);
    expect(byId("anthropic-portal-staging").repo).toBe(`worker:${SCRIPT}`);
    expect(byId("openai-portal-prod")).toMatchObject({ action: "write", reason: "missing", production: true });
    // This Worker does not exist (404): the target is missing, nothing to write there.
    expect(byId("openai-portal-gone")).toMatchObject({ action: "skip", reason: "target-missing" });
    expect(github.listSecrets).not.toHaveBeenCalled();
    expect(github.listVariables).not.toHaveBeenCalled();
  });

  it("lists a Worker place as unreadable when the token is refused", async () => {
    const cf = fakeCloudflare({ failStatus: 403 });
    const plan = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: InventoryStore.fromText(YAML).data, values });
    const line = plan.lines.find((l) => l.entryId === "anthropic-portal-staging")!;
    expect(line).toMatchObject({ action: "skip", reason: "unreadable" });
    expect(line.detail).toContain("Workers Scripts Write");
  });

  it("without a Cloudflare client every Worker line is unreadable", async () => {
    const plan = await buildSyncPlan({ github, owner: "acme", inventory: InventoryStore.fromText(YAML).data, values });
    expect(plan.lines.filter((l) => l.action === "skip" && l.reason === "unreadable")).toHaveLength(4);
  });

  it("limits the plan to a Worker with the repo filter, and not to GitHub repositories", async () => {
    const cf = fakeCloudflare({ existing: [] });
    const inv = InventoryStore.fromText(YAML).data;
    const only = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: inv, values, repo: `worker:${SCRIPT}` });
    expect(only.lines.map((l) => l.entryId).sort()).toEqual(["anthropic-portal-staging", "openai-portal-staging"]);
    const none = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: inv, values, repo: "acme-app" });
    expect(none.lines).toEqual([]);
  });

  it("runs the selected line against the Worker and demands the production confirmation for a production entry", async () => {
    const cf = fakeCloudflare({ existing: [] });
    const inv = InventoryStore.fromText(YAML).data;
    const plan = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: inv, values });
    const key = syncLineKey("secret", "openai-portal-staging", place);
    const result = await runSync({ github: { putSecret: vi.fn(), putVariable: vi.fn() }, workers: cf.client, owner: "acme", plan, inventory: inv, values }, { keys: [key] });
    expect(result.outcomes[0]).toMatchObject({ outcome: "created", kind: "secret" });
    expect(cf.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(VALUE);

    const prodPlace: WorkerPlace = { scope: "cloudflare-worker", accountId: ACCOUNT, script: "acme-portal" };
    await expect(runSync({ github: { putSecret: vi.fn(), putVariable: vi.fn() }, workers: cf.client, owner: "acme", plan, inventory: inv, values }, { keys: [syncLineKey("secret", "openai-portal-prod", prodPlace)] })).rejects.toThrow(/Produktion/);
  });

  it("fails a Worker line cleanly when there is no Cloudflare client", async () => {
    const inv = InventoryStore.fromText(YAML).data;
    const cf = fakeCloudflare({ existing: [] });
    const plan = await buildSyncPlan({ github, workers: cf.client, owner: "acme", inventory: inv, values });
    const key = syncLineKey("secret", "openai-portal-staging", place);
    const result = await runSync({ github: { putSecret: vi.fn(), putVariable: vi.fn() }, owner: "acme", plan, inventory: inv, values }, { keys: [key] });
    expect(result.outcomes[0]).toMatchObject({ outcome: "failed" });
    expect(result.outcomes[0]!.error).toMatch(/cloudflare/);
  });
});
