import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvExportError, InventoryError, ParamsInvalidError, SecretValue, SecretVault, StaleIssuanceError, type Provider } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PolicyError,
  addEnvEntry,
  addEnvTemplate,
  addSecret,
  addVariable,
  attachEvidence,
  confirmIssuance,
  exportEnv,
  getApproval,
  getEvidence,
  getIssuance,
  getSecret,
  getVariable,
  inspectVariableLive,
  listApprovals,
  listConnections,
  listSecrets,
  listVariables,
  listVendors,
  overview,
  preflightSecret,
  readAttachment,
  rejectIssuance,
  removeVariable,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  updateVariable,
} from "../src/agent-api.js";
import { createLocalRuntime, type RuntimeOptions } from "../src/runtime.js";
import { writeConnectionLabel } from "@secret-desk/core";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

let PUBLIC_KEY = "";
beforeAll(async () => {
  await sodium.ready;
  PUBLIC_KEY = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
});

/** A GitHub that accepts everything; `putStatus` makes writes fail. */
const fakeGitHub = (state: { putStatus: number }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: PUBLIC_KEY }), { status: 200 });
    if (method === "GET" && /\/(secrets|variables)/.test(u)) return new Response(JSON.stringify({ secrets: [], variables: [] }), { status: 200 });
    if (method === "PUT" || method === "POST" || method === "PATCH") return new Response(state.putStatus === 204 ? null : JSON.stringify({ message: "nope" }), { status: state.putStatus });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;
const WORKER_ACCOUNT = "0123456789abcdef0123456789abcdef";

const INVENTORY = `version: 1
providers:
  - { id: my-manual, label: My manual, url: "https://example.com/manual", steps: [Open it] }
secrets:
  - { id: dated-soon, name: DATED_SOON, stage: shared, product: acme, service: x, provider: random-hex, expiry: possible, expires: "2026-11-20", tags: [alpha], places: [{ repo: acme-app, scope: repository }] }
  - { id: dated-late, name: DATED_LATE, stage: shared, product: acme, service: x, provider: random-hex, expiry: possible, expires: "2027-05-01", places: [{ repo: acme-app, scope: repository }] }
  - { id: no-date-a, name: NO_DATE_A, stage: dev, service: x, provider: my-manual, expiry: possible, places: [{ repo: acme-docs, scope: repository }] }
  - { id: no-date-b, name: NO_DATE_B, stage: dev, service: x, provider: my-manual, expiry: possible, places: [{ scope: cloudflare-worker, accountId: ${WORKER_ACCOUNT}, script: worker-search }] }
  - { id: prod-secret, name: PROD_SECRET, stage: production, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-app, scope: environment }] }
  - { id: dev-issued, name: DEV_ISSUED, stage: dev, service: x, provider: made-up-issuer, expiry: none, places: [{ repo: acme-issue, scope: repository }] }
  - { id: dev-hex, name: DEV_HEX, stage: dev, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-app, scope: repository }] }
variables:
  - { id: v-dev, name: V_DEV, stage: dev, product: acme, value: "http://localhost", places: [{ repo: acme-app, scope: repository }] }
  - { id: v-staging, name: V_STAGING, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-docs, scope: environment }] }
  - { id: v-empty, name: V_EMPTY, stage: dev, places: [{ repo: acme-app, scope: repository }] }
  - { id: v-hex, name: V_HEX, stage: dev, value: "${"0123456789abcdef".repeat(4)}", places: [{ repo: acme-app, scope: repository }] }
  - { id: v-staging-hex, name: V_STAGING_HEX, stage: staging, value: "${"0123456789abcdef".repeat(4)}", places: [{ repo: acme-app, scope: repository }] }
envTemplates:
  - id: app-dev
    repo: acme-app
    stage: dev
    file: .env.local
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
  - id: other-dev
    repo: acme-other
    stage: dev
    file: .env.local
    entries:
      - { key: OTHER_KEY, from: { type: default, value: "x" } }
  - id: ref-dev
    repo: acme-ref
    stage: dev
    file: .env.local
    entries:
      - { key: REFERENCED, from: { type: ref, template: other-dev, key: OTHER_KEY } }
  - id: cmd-dev
    repo: acme-cmd
    stage: dev
    file: .env.local
    entries:
      - { key: LOCAL_URL, from: { type: command, command: supabase-status, key: API_URL, optional: true } }
  - id: escape-dev
    repo: acme-escape
    stage: dev
    file: ../escape.env
    entries:
      - { key: SITE_URL, from: { type: default, value: "x" } }
  - id: issue-dev
    repo: acme-issue
    stage: dev
    file: .env.local
    entries:
      - { key: ISSUED, from: { type: issue, secret: dev-issued } }
  - id: staging-tpl
    repo: acme-app
    stage: staging
    file: .env.local
    entries:
      - { key: SITE_URL, from: { type: default, value: "x" } }
`;

interface SetupOpts {
  inventory?: string;
  config?: string;
  runtime?: RuntimeOptions;
  links?: Record<string, string>;
  roots?: boolean;
  putStatus?: number;
}

async function setup(opts: SetupOpts = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-agent-gaps-")));
  const projects = join(dir, "projects");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? INVENTORY);
  await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: opts.links ?? {} }));
  const roots = opts.roots === false ? "" : `policy:\n  envRoots: [${JSON.stringify(projects)}]\n`;
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${opts.config ?? ""}${roots}`);
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null, fetch: fakeGitHub({ putStatus: opts.putStatus ?? 204 }), ...(opts.runtime ?? {}) });
  return { rt, dir, projects };
}

describe("listing and searching secrets", () => {
  it("filters by stage, repository, product, provider and free text, and sorts dated before undated", async () => {
    const { rt } = await setup();
    const now = new Date("2026-11-09T00:00:00Z");
    expect((await listSecrets(rt, { stage: "dev" }, now)).map((s) => s.id).sort()).toEqual(["dev-hex", "dev-issued", "no-date-a", "no-date-b"]);
    expect((await listSecrets(rt, { repo: "acme-docs" }, now)).map((s) => s.id)).toEqual(["no-date-a"]);
    expect((await listSecrets(rt, { product: "acme" }, now)).map((s) => s.id).sort()).toEqual(["dated-late", "dated-soon"]);
    expect((await listSecrets(rt, { provider: "my-manual" }, now)).map((s) => s.id).sort()).toEqual(["no-date-a", "no-date-b"]);
    expect((await listSecrets(rt, { q: "WORKER-SEARCH" }, now)).map((s) => s.id)).toEqual(["no-date-b"]);
    expect((await listSecrets(rt, { q: "acme-docs" }, now)).map((s) => s.id)).toEqual(["no-date-a"]);
    expect((await listSecrets(rt, { tag: "alpha" }, now)).map((s) => s.id)).toEqual(["dated-soon"]);
    const sorted = (await listSecrets(rt, { stage: "shared" }, now)).map((s) => s.id);
    expect(sorted).toEqual(["dated-soon", "dated-late"]);
    const mixed = (await listSecrets(rt, {}, now)).map((s) => s.daysLeft);
    expect(mixed.slice(0, 2).every((d) => d !== null)).toBe(true);
    expect(mixed.at(-1)).toBeNull();
  });

  it("getSecret and the overview count per stage", async () => {
    const { rt } = await setup();
    expect(() => getSecret(rt, "nope")).toThrow(/Secret nicht gefunden: nope/);
    expect(getSecret(rt, "dev-hex").provider).toBe("random-hex");
    const o = await overview(rt, new Date("2026-11-09T00:00:00Z"));
    expect(o.byStage).toEqual({ dev: 4, staging: 0, production: 1, shared: 2 });
  });

  it("lists the vendors with a flag for a guided sign-in", () => {
    const v = listVendors();
    expect(v.vendors.length).toBeGreaterThan(0);
    expect(v.vendors.find((x) => x.id === "revenuecat")?.facade).toBe(true);
    expect(v.vendors.some((x) => x.facade === false)).toBe(true);
    expect(v.categories.length).toBeGreaterThan(0);
  });
});

describe("connections", () => {
  it("shows the Stripe account name, remembers when a vault saved a key, and counts the days left", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-agent-vault-"));
    const key = randomBytes(32);
    const vault = new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => key } });
    const { rt } = await setup({ runtime: { vault } });
    await vault.set("stripe:acct_1AbCdEfGhIjKl:live", "made_up_stripe_key_value", "2026-12-01");
    await vault.set("stripe:acct_1NoNameNoNameXX:sandbox", "made_up_other_key_value", null);
    await writeConnectionLabel(rt.connections, "stripe:acct_1AbCdEfGhIjKl:live", "Acme Inc");
    const list = await listConnections(rt);
    const named = list.find((c) => c.id === "stripe:acct_1AbCdEfGhIjKl:live")!;
    expect(named).toMatchObject({ connected: true, source: "vault", label: "Stripe Acme Inc (Live)", canRemember: true });
    expect(named.savedAt).toMatch(/^\d{4}-/);
    expect(named.daysLeft).not.toBeNull();
    const unnamed = list.find((c) => c.id === "stripe:acct_1NoNameNoNameXX:sandbox")!;
    expect(unnamed.label).toBe("Stripe acct_1NoNameNoNameXX (Sandbox)");
    expect(unnamed.daysLeft).toBeNull();
    expect(list.find((c) => c.id === "github")).toMatchObject({ vendor: expect.anything(), role: expect.any(String) });
  });

  it("a vault that cannot describe an entry does not break the list", async () => {
    const seen = new Map<string, number>();
    const fake = {
      get: async () => SecretValue.from("made_up_value"),
      // The first look (connection status) works, the second one (saved time) fails.
      info: async (id: string) => {
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n > 1) throw new Error("vault unreadable");
        return { id, savedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp" };
      },
      list: async () => [],
      has: async () => true,
      set: async () => undefined,
      delete: async () => undefined,
    };
    const { rt } = await setup({ runtime: { vault: fake as never } });
    const list = await listConnections(rt);
    expect(list.find((c) => c.id === "github")).toMatchObject({ source: "vault", savedAt: null });
  });

  it("a connection that belongs to no vendor is a primary one without a vendor", async () => {
    const { rt } = await setup();
    rt.providers.register({ id: "made-up-provider", label: "Made up", kind: "manual", connection: "made-up-conn" });
    expect((await listConnections(rt)).find((c) => c.id === "made-up-conn")).toMatchObject({ vendor: null, role: "primary" });
  });

  it("without a token of its own, team sync is shown as connected through GitHub, with the expiry of that token", async () => {
    const { rt } = await setup({ config: "teamSync:\n  repo: acme/team-config\n" });
    rt.connections.session.set("github", "made_up_github_token", "2027-01-01");
    const list = await listConnections(rt);
    expect(list.find((c) => c.id === "team-sync")).toMatchObject({ connected: true, source: "github", expires: "2027-01-01" });
    const bare = await setup({ config: "teamSync:\n  repo: acme/team-config\n" });
    bare.rt.connections.session.set("github", "made_up_github_token");
    expect((await listConnections(bare.rt)).find((c) => c.id === "team-sync")).toMatchObject({ connected: true, source: "github" });
    expect((await listConnections(bare.rt)).find((c) => c.id === "team-sync")).not.toHaveProperty("expires");
  });

  it("the Grafana link follows the integration default, else the base address of an entry", async () => {
    const withDefault = await setup({ inventory: "version: 1\nsecrets: []\nvariables: []\nintegrationDefaults:\n  grafana:\n    baseUrl: https://acme.grafana.net\n" });
    expect((await listConnections(withDefault.rt)).find((c) => c.id === "grafana")?.openUrl).toBe("https://acme.grafana.net/org/serviceaccounts");
    const inv = `version: 1
secrets:
  - { id: graf, name: GRAF, stage: shared, service: grafana, provider: grafana-service-account-token, expiry: none, params: { baseUrl: "https://entry.grafana.net", serviceAccountId: 1 }, places: [{ repo: acme-app, scope: repository }] }
variables: []
`;
    const fromEntry = await setup({ inventory: inv });
    expect((await listConnections(fromEntry.rt)).find((c) => c.id === "grafana")?.openUrl).toBe("https://entry.grafana.net/org/serviceaccounts");
    const none = await setup({ inventory: "version: 1\nsecrets: []\nvariables: []\n" });
    expect((await listConnections(none.rt)).find((c) => c.id === "grafana")?.openUrl).not.toContain("serviceaccounts");
  });
});

describe("creating and preflighting secrets", () => {
  it("parameters are checked at creation; a non-object params counts as none", async () => {
    const { rt } = await setup();
    const base = { id: "graf-new", name: "GRAF_NEW", stage: "shared", service: "grafana", provider: "grafana-service-account-token", expiry: "none", places: [{ repo: "acme-app", scope: "repository" }] };
    await expect(addSecret(rt, human, base)).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(addSecret(rt, human, { ...base, params: ["not", "an", "object"] })).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(addSecret(rt, human, { ...base, params: null })).rejects.toBeInstanceOf(ParamsInvalidError);
  });

  it("preflightSecret: unknown entry, and an entry whose provider has no preflight", async () => {
    const { rt } = await setup();
    expect(() => preflightSecret(rt, "nope")).toThrow(/Secret nicht gefunden/);
    expect(await preflightSecret(rt, "dev-hex")).toMatchObject({ status: "skipped", skippedReason: "none" });
  });
});

describe("env templates for agents", () => {
  it("an agent may not take a secret of a stage it may not use into a template", async () => {
    const { rt } = await setup();
    const tpl = { id: "agent-tpl", repo: "acme-app", stage: "dev" as const, entries: [{ key: "FROM_PROD", from: { type: "issue" as const, secret: "prod-secret" } }] };
    await expect(addEnvTemplate(rt, agent, tpl)).rejects.toThrow(/kein Secret aus Stage production/);
    await expect(addEnvTemplate(rt, agent, { ...tpl, entries: [{ key: "FROM_DEV", from: { type: "issue" as const, secret: "dev-hex" } }] })).resolves.toMatchObject({ id: "agent-tpl" });
  });

  it("entries are added by humans; an agent needs an existing template in an allowed stage and a harmless entry", async () => {
    const { rt } = await setup();
    const entry = { key: "NEW_KEY", from: { type: "default" as const, value: "v" } };
    await expect(addEnvEntry(rt, agent, "nope", entry)).rejects.toThrow(/Vorlage nicht gefunden: nope/);
    await expect(addEnvEntry(rt, agent, "staging-tpl", entry)).rejects.toBeInstanceOf(PolicyError);
    const updated = await addEnvEntry(rt, agent, "app-dev", entry);
    expect(updated.entries.map((e) => e.key)).toContain("NEW_KEY");
    const byHuman = await addEnvEntry(rt, human, "app-dev", { key: "HUMAN_KEY", from: { type: "default", value: "v" } });
    expect(byHuman.entries.map((e) => e.key)).toContain("HUMAN_KEY");
  });
});

describe("issuing", () => {
  it("unknown entry; dry run gives humans the preflight and agents only the plan", async () => {
    const { rt } = await setup();
    await expect(requestIssuance(rt, human, "nope")).rejects.toThrow(/Secret nicht gefunden/);
    const byHuman = await requestIssuance(rt, human, "dev-hex", { dryRun: true });
    expect(byHuman).toMatchObject({ status: "dry-run", preflight: { status: "skipped" } });
    const byAgent = await requestIssuance(rt, agent, "dev-hex", { dryRun: true });
    expect(byAgent.status).toBe("dry-run");
    expect(byAgent).not.toHaveProperty("preflight");
  });

  it("a pending issuance can be read, expires, is refused when unknown and can be rejected with a note", async () => {
    const { rt } = await setup();
    await expect(getIssuance(rt, "nope")).rejects.toThrow(/Pruefung nicht gefunden/);
    const r = await requestIssuance(rt, human, "dev-hex");
    if (r.status !== "awaiting-review") throw new Error("expected a review");
    expect(await getIssuance(rt, r.issuance.id)).toMatchObject({ id: r.issuance.id, secretId: "dev-hex" });
    const pending = rt.issuances.get(r.issuance.id)!;
    pending.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(getIssuance(rt, r.issuance.id)).rejects.toThrow(/abgelaufen/);
    pending.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await expect(rejectIssuance(rt, human, "nope")).rejects.toThrow(/Pruefung nicht gefunden/);
    await expect(rejectIssuance(rt, agent, r.issuance.id)).rejects.toThrow(PolicyError);
    const res = await rejectIssuance(rt, human, r.issuance.id, "not needed");
    expect(res).toHaveProperty("revokedNew");
    const again = await requestIssuance(rt, human, "dev-hex");
    if (again.status !== "awaiting-review") throw new Error("expected a review");
    expect(await rejectIssuance(rt, human, again.issuance.id)).toHaveProperty("revokedNew");
  });

  it("confirm: unknown id; a refused confirmation keeps the review; a stale one is dropped; other errors pass on", async () => {
    const { rt } = await setup({ putStatus: 500 });
    await expect(confirmIssuance(rt, human, "nope", { ticks: [] })).rejects.toThrow(/Pruefung nicht gefunden/);
    const r = await requestIssuance(rt, human, "dev-hex");
    if (r.status !== "awaiting-review") throw new Error("expected a review");
    const refused = await confirmIssuance(rt, human, r.issuance.id, { ticks: r.issuance.report.checklist.map((c) => c.id) });
    expect(refused.ok).toBe(false);
    expect(rt.issuances.get(r.issuance.id)).toBeDefined();
    const pending = rt.issuances.get(r.issuance.id)!;
    // The entry changed after the review: the issuance is stale and gone for good.
    rt.inventory.patchSecret("dev-hex", { notes: "changed" } as never);
    rt.inventory.setSecretParams("dev-hex", { extra: 1 }, []);
    await expect(confirmIssuance(rt, human, r.issuance.id, { ticks: pending.report.checks.map((c) => c.id), force: true })).rejects.toBeInstanceOf(StaleIssuanceError);
    expect(rt.issuances.get(r.issuance.id)).toBeUndefined();
    const other = await requestIssuance(rt, human, "dev-hex");
    if (other.status !== "awaiting-review") throw new Error("expected a review");
    rt.issuances.get(other.issuance.id)!.issuedSecret = undefined as never;
    await expect(confirmIssuance(rt, human, other.issuance.id, { ticks: [] })).rejects.toThrow();
    expect(rt.issuances.get(other.issuance.id)).toBeDefined();
  });

  it("evidence: an unknown report is refused, an attachment can be read back", async () => {
    const { rt } = await setup();
    await expect(getEvidence(rt, "dev-hex", "nope")).rejects.toThrow(/Bericht nicht gefunden/);
    const r = await requestIssuance(rt, human, "dev-hex");
    if (r.status !== "awaiting-review") throw new Error("expected a review");
    await confirmIssuance(rt, human, r.issuance.id, { ticks: r.issuance.report.checks.map((c) => c.id) }).catch(() => undefined);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const attached = await attachEvidence(rt, human, "dev-hex", r.issuance.report.id, png, "image/png", "n");
    const file = (attached as { file?: string; name?: string }).file ?? (attached as { name: string }).name;
    expect(file).toBeTruthy();
    expect(await readAttachment(rt, "dev-hex", r.issuance.report.id, file!)).toBeTruthy();
  });
});

describe("variables", () => {
  it("lists and filters by stage, repository and product", async () => {
    const { rt } = await setup();
    expect(listVariables(rt, { stage: "dev" }).map((v) => v.id).sort()).toEqual(["v-dev", "v-empty", "v-hex"]);
    expect(listVariables(rt, { stage: "staging" }).map((v) => v.id).sort()).toEqual(["v-staging", "v-staging-hex"]);
    expect(listVariables(rt, { repo: "acme-docs" }).map((v) => v.id)).toEqual(["v-staging"]);
    expect(listVariables(rt, { product: "acme" }).map((v) => v.id)).toEqual(["v-dev"]);
    expect(listVariables(rt, { q: "staging.example" }).map((v) => v.id)).toEqual(["v-staging"]);
    expect(getVariable(rt, "v-dev")).toMatchObject({ id: "v-dev", from: null });
    expect(() => getVariable(rt, "nope")).toThrow(/Variable nicht gefunden: nope/);
    await expect(inspectVariableLive(rt, "nope")).rejects.toThrow(/Variable nicht gefunden/);
  });

  it("creating without a value skips the secret check; an agent's input must fit its schema", async () => {
    const { rt } = await setup();
    const created = await addVariable(rt, human, { id: "v-new", name: "V_NEW", stage: "dev", places: [{ repo: "acme-app", scope: "repository" }] } as never);
    expect(created.value).toBeNull();
    await expect(addVariable(rt, agent, { id: "v-bad", name: "V_BAD", stage: "dev", bogus: 1, places: [{ repo: "acme-app", scope: "repository" }] } as never)).rejects.toThrow(/Feld nicht erlaubt/);
  });

  it("updating: unknown id; a value that looks like a secret needs the human's acknowledgement", async () => {
    const { rt } = await setup();
    await expect(updateVariable(rt, human, "nope", { value: "x" })).rejects.toThrow(/Variable nicht gefunden/);
    const hex = "fedcba9876543210".repeat(4);
    await expect(updateVariable(rt, agent, "v-dev", { value: hex }, { acknowledgedPublic: true })).rejects.toThrow(/acknowledgedPublic/);
    expect((await updateVariable(rt, human, "v-dev", { value: hex }, { acknowledgedPublic: true })).value).toBe(hex);
    expect((await updateVariable(rt, human, "v-dev", { description: "text only" })).description).toBe("text only");
  });

  it("removing is for humans", async () => {
    const { rt } = await setup();
    await expect(removeVariable(rt, agent, "v-dev")).rejects.toThrow(PolicyError);
    await removeVariable(rt, human, "v-dev");
    expect(listVariables(rt).some((v) => v.id === "v-dev")).toBe(false);
    await expect(requestApplyVariable(rt, human, "v-dev")).rejects.toThrow(/Variable nicht gefunden/);
  });
});

describe("approvals", () => {
  it("lists and reads them; unknown ones are refused", async () => {
    const { rt } = await setup();
    expect(listApprovals(rt)).toEqual([]);
    expect(() => getApproval(rt, "nope")).toThrow(PolicyError);
    await expect(resolveApproval(rt, human, "nope", "approve")).rejects.toThrow(/Anfrage nicht gefunden/);
    const r = await requestIssuance(rt, agent, "prod-secret");
    if (r.status !== "pending-approval") throw new Error("expected an approval");
    expect(getApproval(rt, r.approvalId)).toMatchObject({ state: "pending" });
    expect(listApprovals(rt)).toHaveLength(1);
  });

  it("an approval of a variable whose entry vanished is dropped as stale", async () => {
    const { rt } = await setup();
    const r = await requestApplyVariable(rt, agent, "v-staging");
    if (r.status !== "pending-approval") throw new Error("expected an approval");
    rt.inventory.removeVariable("v-staging");
    expect(await resolveApproval(rt, human, r.approvalId, "approve")).toMatchObject({ state: "stale" });
  });

  it("an approved issuance that fails is recorded as failed, with the reason shortened; a non-Error becomes a generic text", async () => {
    const { rt } = await setup();
    const failing: Provider = { id: "failing-provider", label: "Failing", kind: "automatic", issue: async () => Promise.reject(new Error("provider refused ".repeat(30))) };
    rt.providers.register(failing);
    rt.inventory.getSecret("prod-secret")!.provider = "failing-provider";
    const r = await requestIssuance(rt, agent, "prod-secret");
    if (r.status !== "pending-approval") throw new Error("expected an approval");
    const done = await resolveApproval(rt, human, r.approvalId, "approve");
    expect(done.state).toBe("failed");
    expect(done.result!.length).toBeLessThanOrEqual(200);
    const odd: Provider = { id: "odd-provider", label: "Odd", kind: "automatic", issue: async () => Promise.reject("plain text") };
    rt.providers.register(odd);
    const second = await setup();
    second.rt.providers.register(odd);
    second.rt.inventory.getSecret("prod-secret")!.provider = "odd-provider";
    const r2 = await requestIssuance(second.rt, agent, "prod-secret");
    if (r2.status !== "pending-approval") throw new Error("expected an approval");
    expect((await resolveApproval(second.rt, human, r2.approvalId, "approve")).result).toBe("Fehler");
  });

  it("an approved variable that GitHub would refuse is recorded as failed with the reason", async () => {
    const { rt } = await setup();
    const r = await requestApplyVariable(rt, agent, "v-staging-hex");
    if (r.status !== "pending-approval") throw new Error("expected an approval");
    const done = await resolveApproval(rt, human, r.approvalId, "approve");
    expect(done).toMatchObject({ state: "failed", result: expect.stringContaining("acknowledgedPublic") });
  });
});

describe("env files", () => {
  it("the default stage falls back to dev when no stage has that kind", async () => {
    const { rt } = await setup({ inventory: "version: 1\nstages:\n  - { id: prod, kind: live }\nsecrets: []\nvariables: []\n" });
    await expect(exportEnv(rt, human, { repo: "acme-app" })).rejects.toThrow(/Keine Vorlage fuer acme-app \(dev\)/);
  });

  it("agents: only allowed stages of the chosen template, and only with configured roots", async () => {
    const { rt } = await setup();
    await expect(exportEnv(rt, agent, { repo: "acme-app", template: "staging-tpl" })).rejects.toThrow(/keine \.env erzeugen/);
    const noRoots = await setup({ roots: false });
    await expect(exportEnv(noRoots.rt, agent, { repo: "acme-app" })).rejects.toThrow(/envRoots ist leer/);
  });

  it("agents choosing a template of another stage than the requested one are refused", async () => {
    const { rt } = await setup();
    await expect(exportEnv(rt, agent, { repo: "acme-app", stage: "dev", template: "staging-tpl" })).rejects.toThrow(/keine \.env erzeugen/);
  });

  it("a human without a link may use the fallback folder; a template file that leaves the folder is refused", async () => {
    const { rt, dir } = await setup();
    const out = join(dir, "projects", "fallback");
    await mkdir(out);
    const written = await exportEnv(rt, human, { repo: "acme-app", fallbackDir: out });
    expect(written).toMatchObject({ status: "written", keys: ["SITE_URL"] });
    await expect(exportEnv(rt, human, { repo: "acme-escape", fallbackDir: out })).rejects.toThrow(/aus dem verknuepften Ordner hinaus/);
    await expect(exportEnv(rt, human, { repo: "acme-app", fallbackDir: out, overwrite: false })).rejects.toThrow(EnvExportError);
  });

  it("an agent cannot use the fallback folder", async () => {
    const { rt, dir } = await setup();
    await expect(exportEnv(rt, agent, { repo: "acme-app", fallbackDir: join(dir, "x") })).rejects.toThrow(/Kein Pfad angegeben/);
  });

  describe("references to another template's file", () => {
    async function withLinks(otherFile: (folder: string) => Promise<void>, link = true) {
      const base = await setup();
      const other = join(base.projects, "other");
      const ref = join(base.projects, "ref");
      await mkdir(other);
      await mkdir(ref);
      await otherFile(other);
      await writeFile(join(base.dir, "links.json"), JSON.stringify({ version: 1, links: { ...(link ? { "acme-other": other } : {}), "acme-ref": ref } }));
      return { ...base, ref };
    }

    it("reads the value from the file the other template produced", async () => {
      const { rt, ref } = await withLinks(async (folder) => writeFile(join(folder, ".env.local"), "OTHER_KEY=from-file\n"));
      const r = await exportEnv(rt, human, { repo: "acme-ref" });
      expect(r).toMatchObject({ status: "written", keys: ["REFERENCED"] });
      expect(await (await import("node:fs/promises")).readFile(join(ref, ".env.local"), "utf8")).toContain("REFERENCED=from-file");
    });

    it("ignores the other file when the other repository is not linked", async () => {
      const { rt } = await withLinks(async () => undefined, false);
      await expect(exportEnv(rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert fuer OTHER_KEY/);
    });

    it("ignores a file that is a directory, too big, a link out of the folder, or missing", async () => {
      const asDir = await withLinks(async (folder) => mkdir(join(folder, ".env.local")));
      await expect(exportEnv(asDir.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
      const big = await withLinks(async (folder) => writeFile(join(folder, ".env.local"), `OTHER_KEY=x\n${"#".repeat(1024 * 1024)}\n`));
      await expect(exportEnv(big.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
      const outside = await mkdtemp(join(tmpdir(), "sd-agent-outside-"));
      await writeFile(join(outside, "secret.env"), "OTHER_KEY=leaked\n");
      const linked = await withLinks(async (folder) => symlink(join(outside, "secret.env"), join(folder, ".env.local")));
      await expect(exportEnv(linked.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
      const missing = await withLinks(async () => undefined);
      await expect(exportEnv(missing.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
    });

    it("a template whose own file would leave the other folder is not read", async () => {
      const base = await withLinks(async () => undefined);
      const original = base.rt.inventory.data.envTemplates.find((t) => t.id === "other-dev")!;
      (original as { file: string }).file = "../outside.env";
      await expect(exportEnv(base.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
    });
  });

  it.skipIf(process.getuid?.() === 0)("a referenced file that cannot be read is ignored", async () => {
    const { chmod } = await import("node:fs/promises");
    const base = await setup();
    const other = join(base.projects, "other");
    const ref = join(base.projects, "ref");
    await mkdir(other);
    await mkdir(ref);
    await writeFile(join(other, ".env.local"), "OTHER_KEY=hidden\n");
    await chmod(join(other, ".env.local"), 0o000);
    await writeFile(join(base.dir, "links.json"), JSON.stringify({ version: 1, links: { "acme-other": other, "acme-ref": ref } }));
    try {
      await expect(exportEnv(base.rt, human, { repo: "acme-ref" })).rejects.toThrow(/Kein Wert/);
    } finally {
      await chmod(join(other, ".env.local"), 0o600);
    }
  });

  it("issued dev tokens that cannot be revoked after a failed write are named in the error", async () => {
    const { rt, projects, dir } = await setup();
    rt.providers.register({
      id: "made-up-issuer",
      label: "Made up issuer",
      kind: "automatic",
      issue: async () => ({ value: SecretValue.from("made_up_issued_value"), externalId: "ext-1" }),
      revoke: async () => Promise.reject(new Error("revoke refused")),
    } as Provider);
    const folder = join(projects, "issue");
    await mkdir(folder);
    await writeFile(join(folder, ".env.local"), "EXISTING=1\n");
    await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: { "acme-issue": folder } }));
    await expect(exportEnv(rt, human, { repo: "acme-issue" })).rejects.toThrow(/Nicht widerrufen \(beim Anbieter von Hand entfernen\): dev-issued \(ext-1\)/);
  });

  it("prompts, run values and local commands are only passed on for humans", async () => {
    const { rt, projects } = await setup();
    const cmd = join(projects, "cmd");
    await mkdir(cmd);
    await writeFile(join(rt.configPath, "..", "links.json"), JSON.stringify({ version: 1, links: { "acme-cmd": cmd } }));
    const empty = await mkdtemp(join(tmpdir(), "sd-agent-path-"));
    vi.stubEnv("PATH", empty);
    const r = await exportEnv(rt, human, { repo: "acme-cmd", runCommands: true, runValues: new Map(), prompts: {} });
    expect(r.status).toBe("written");
    const asAgent = await exportEnv(rt, agent, { repo: "acme-cmd", runCommands: true, runValues: new Map(), path: join(cmd, ".env.agent") });
    expect(asAgent.status).toBe("written");
  });
});
