import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import {
  PolicyError,
  addEnvTemplate,
  addManualProvider,
  addSecret,
  addVariable,
  attachEvidence,
  confirmIssuance,
  evidenceSvg,
  exportEnv,
  getIssuance,
  listIssuances,
  updateSecretMeta,
  listEvidence,
  listSecrets,
  listVariables,
  overview,
  rejectIssuance,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  submitManualValue,
  teamExport,
  updateVariable,
  inspectVariableLive,
  adoptVariableFromGitHub,
} from "../src/agent-api.js";
import { createRuntime } from "../src/runtime.js";

const INVENTORY = `version: 1
secrets:
  - id: stripe-webhook-acme-docs-staging
    name: STRIPE_WEBHOOK_SECRET
    stage: staging
    service: stripe
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    product: acme-app
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: cf-deploy-acme-app
    name: CLOUDFLARE_API_TOKEN
    stage: shared
    service: cloudflare
    provider: manual
    expiry: possible
    expires: "2026-11-10"
    places:
      - { repo: acme-app, scope: repository }
variables:
  - id: site-url-staging
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: acme-project
    name: ACME_PROJECT_ID
    stage: shared
    places:
      - { repo: acme-app, scope: repository }
envTemplates:
  - id: acme-docs-dev
    repo: acme-docs
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: RATE_LIMIT_SECRET, from: { type: generate, kind: hex, bytes: 16 } }
  - id: acme-docs-dev-prompt
    repo: acme-docs-x
    stage: dev
    entries:
      - { key: STRIPE_SECRET_KEY, from: { type: prompt } }
`;

async function setup(agentStages: string[] = ["dev"]) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const calls: string[] = [];
  /** Klartext aller in GitHub geschriebenen Secrets (aus dem verschluesselten PUT-Body zurueckgerechnet): die bekannten Werte fuer Leak-Pruefungen. */
  const written: string[] = [];
  const live: Record<string, string> = { "/acme-docs/environments/staging/variables": "https://alt.example.com", "/acme-app/actions/variables": "proj_1" };
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    if (method === "PUT" && typeof init?.body === "string") {
      const enc = (JSON.parse(init.body) as { encrypted_value?: string }).encrypted_value;
      if (enc) written.push(sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(enc, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)));
    }
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (method === "GET" && u.includes("/variables")) {
      const key = Object.keys(live).find((k) => u.includes(k));
      const names: Record<string, string> = { "/acme-docs/environments/staging/variables": "NEXT_PUBLIC_SITE_URL", "/acme-app/actions/variables": "ACME_PROJECT_ID" };
      return new Response(JSON.stringify({ variables: key ? [{ name: names[key], value: live[key], created_at: "c", updated_at: "u" }] : [] }), { status: 200 });
    }
    if (method === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ secrets: [{ name: "ARTIFACT_HMAC_SECRET", created_at: "c", updated_at: new Date().toISOString() }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-rt-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml
github:
  owner: acme
  auth: { type: pat, source: { type: env, name: GH_TEST } }
policy:
  agentStages: [${agentStages.join(", ")}]
  envRoots: [${JSON.stringify(dir)}]
`,
  );
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock });
  return { rt, dir, calls, written };
}

const agent = { kind: "agent", name: "claude" } as const;
const human = { kind: "human", name: "alice" } as const;

describe("overview", () => {
  it("counts secrets, variables and open reviews, without values", async () => {
    const { rt } = await setup();
    const o = await overview(rt, new Date("2026-11-05T00:00:00Z"));
    expect(o).toMatchObject({ total: 3, variables: 2, pendingReviews: 0, pendingApprovals: 0 });
    expect((await listSecrets(rt, { status: "due" }, new Date("2026-11-05T00:00:00Z"))).map((s) => s.id)).toEqual(["cf-deploy-acme-app"]);
    expect(JSON.stringify(o)).not.toContain("ghp_x");
  });
});

describe("issue, review, confirm", () => {
  it("human: value is created and checked, GitHub stays untouched until confirmation", async () => {
    const { rt, calls, written } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(r.issuance.report.checks.some((c) => c.id.startsWith("target:") && c.status === "pass")).toBe(true);
    const beforeConfirm = JSON.stringify(r);
    const ticks = r.issuance.report.checklist.map((c) => c.id);
    await expect(confirmIssuance(rt, agent, r.issuance.id, { ticks })).rejects.toThrow(PolicyError);
    const done = await confirmIssuance(rt, human, r.issuance.id, { ticks, note: "ok" });
    // Der geschriebene Wert ist jetzt bekannt (aus dem PUT): er darf in keiner Antwort stehen, weder vorher noch nachher.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(beforeConfirm).not.toContain(written[0]!);
    expect(JSON.stringify(done)).not.toContain(written[0]!);
    expect(done.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBe("alice");
    expect(rt.issuances.list()).toHaveLength(0);
    const evidence = await listEvidence(rt, "hmac-acme-app");
    expect(evidence[0]!.confirmation?.decision).toBe("confirmed");
    expect(await evidenceSvg(rt, "hmac-acme-app", evidence[0]!.id)).toContain("<svg");
  });
  it("human can reject: nothing is written", async () => {
    const { rt, calls } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    await rejectIssuance(rt, human, r.issuance.id, "falsch");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    await expect(getIssuance(rt, r.issuance.id)).rejects.toThrow();
  });
  it("agent in staging: approval request, after approval the review waits for confirmation", async () => {
    const { rt } = await setup();
    const r = await requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging", { reason: "neu" });
    expect(r.status).toBe("pending-approval");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    await expect(resolveApproval(rt, agent, r.approvalId, "approve")).rejects.toThrow(PolicyError);
    const denied = await requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging");
    expect(denied.status === "pending-approval" && denied.approvalId).toBe(r.approvalId);
  });
  it("manual input: is checked, the value is in no report, attachment only as image", async () => {
    const { rt } = await setup();
    const issuance = await submitManualValue(rt, human, "cf-deploy-acme-app", "cf_handeingabe_token_123456");
    expect(JSON.stringify(issuance)).not.toContain("handeingabe");
    await attachEvidence(rt, human, "cf-deploy-acme-app", issuance.id, new Uint8Array([137, 80, 78, 71]), "image/png", "Dashboard");
    await expect(attachEvidence(rt, agent, "cf-deploy-acme-app", issuance.id, new Uint8Array([1]), "image/png")).rejects.toThrow(PolicyError);
    await expect(submitManualValue(rt, agent, "cf-deploy-acme-app", "x")).rejects.toThrow(PolicyError);
    const stored = await listEvidence(rt, "cf-deploy-acme-app");
    expect(stored[0]!.attachments).toHaveLength(1);
  });
});

describe("variables", () => {
  it("compares target and actual, adopts from GitHub and rejects secrets", async () => {
    const { rt } = await setup();
    const check = await inspectVariableLive(rt, "site-url-staging");
    expect(check.drift[0]!.state).toBe("different");
    const adopted = await adoptVariableFromGitHub(rt, human, "acme-project");
    expect(adopted.value).toBe("proj_1");
    await expect(updateVariable(rt, human, "site-url-staging", { value: "sk_live_" + "a".repeat(24) })).rejects.toThrow(/Stripe/);
    await expect(updateVariable(rt, agent, "site-url-staging", { value: "aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF3hJ5" }, { acknowledgedPublic: true })).rejects.toThrow(/acknowledgedPublic/);
    await updateVariable(rt, human, "site-url-staging", { value: "https://neu.example.com" });
    expect(await readFile(rt.inventory.path!, "utf8")).toContain("https://neu.example.com");
  });
  it("set: human immediately, agent in staging only via approval", async () => {
    const { rt, calls } = await setup();
    const a = await requestApplyVariable(rt, agent, "site-url-staging");
    expect(a.status).toBe("pending-approval");
    expect(calls.some((c) => c.startsWith("PATCH") || c.startsWith("POST"))).toBe(false);
    const h = await requestApplyVariable(rt, human, "site-url-staging");
    expect(h.status).toBe("applied");
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("/acme-docs/environments/staging/variables/NEXT_PUBLIC_SITE_URL"))).toBe(true);
  });
  it("new variable with required target", async () => {
    const { rt } = await setup();
    await expect(addVariable(rt, agent, { id: "x-y", name: "X_Y", places: [] })).rejects.toThrow();
    const v = await addVariable(rt, agent, { id: "print-env", name: "PRINT_ENV", stage: "staging", value: "sandbox", places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect(v.value).toBe("sandbox");
  });
});

describe("descriptions and search", () => {
  it("finds secrets and variables via description and tags", async () => {
    const { rt } = await setup();
    await addSecret(rt, human, { id: "acme-key", name: "ACME_API_KEY", service: "acme-api", stage: "staging", description: "Druckauftraege senden", owner: "alice", tags: ["druck"], places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect((await listSecrets(rt, { q: "druckauftr" })).map((s) => s.id)).toEqual(["acme-key"]);
    expect((await listSecrets(rt, { tag: "druck" })).map((s) => s.id)).toEqual(["acme-key"]);
    expect((await listSecrets(rt, { q: "alice" })).map((s) => s.id)).toContain("acme-key");
    await updateVariable(rt, human, "site-url-staging", { description: "Basis-URL der Staging-Seite", tags: ["url"] });
    expect(listVariables(rt, { q: "basis-url" }).map((v) => v.id)).toEqual(["site-url-staging"]);
    expect(listVariables(rt, { tag: "url" })[0]).toMatchObject({ description: "Basis-URL der Staging-Seite", tags: ["url"], owner: null });
  });
});

describe("dev env and metadata", () => {
  it("writes file 600 and returns keys only", async () => {
    const { rt, dir } = await setup();
    const r = await exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, "app", ".env.local") });
    if (r.status !== "written") throw new Error("erwartet");
    expect(r.keys).toEqual(["SITE_URL", "RATE_LIMIT_SECRET"]);
    if (process.platform !== "win32") expect((await stat(r.path)).mode & 0o777).toBe(0o600); // Windows kennt keine POSIX-Modi
    const fileText = await readFile(r.path, "utf8");
    const secretValue = /^RATE_LIMIT_SECRET=(.+)$/m.exec(fileText)?.[1];
    expect(secretValue).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(r)).not.toContain(secretValue!);
  });
  it("agents: no stage except dev, no values, no foreign folders", async () => {
    const { rt, dir } = await setup();
    await expect(exportEnv(rt, agent, { repo: "acme-docs", stage: "staging", path: join(dir, "x") })).rejects.toThrow(PolicyError);
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, "y"), prompts: { A: "b" } })).rejects.toThrow(PolicyError);
    const outside = await mkdtemp(join(tmpdir(), "sd-ausserhalb-"));
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(outside, ".env") })).rejects.toThrow(/ausserhalb/);
  });
  it("reports needed inputs instead of guessing", async () => {
    const { rt, dir } = await setup();
    expect(await exportEnv(rt, human, { repo: "acme-docs-x", path: join(dir, "z") })).toMatchObject({ status: "needs-input", keys: ["STRIPE_SECRET_KEY"] });
  });
  it("maintains metadata and team file", async () => {
    const { rt } = await setup();
    await addSecret(rt, human, { id: "resend-acme-docs-staging", name: "RESEND_API_KEY", service: "resend", stage: "staging", provider: "resend-api-key", params: { permission: "full_access" }, places: [{ repo: "acme-docs", scope: "environment", environment: "staging" }] });
    await addManualProvider(rt, human, { id: "acme-api", label: "Acme API", url: "https://acme.example.com", steps: ["Dashboard oeffnen"] });
    expect(rt.providers.get("acme-api")?.kind).toBe("manual");
    expect(teamExport(rt)).toContain("resend-acme-docs-staging");
    expect(teamExport(rt)).toContain("site-url-staging");
    expect(await readFile(rt.inventory.path!, "utf8")).toContain("resend-acme-docs-staging");
  });
});

const PLACE = [{ repo: "acme-app", scope: "repository" as const }];

describe("F2: agents do not change security-relevant fields", () => {
  it("PATCH with stage/places/provider/params/stamp/identifier: rejected, inventory unchanged", async () => {
    const { rt } = await setup();
    const before = JSON.stringify(rt.inventory.getSecret("cf-deploy-acme-app"));
    for (const bad of [{ stage: "dev" }, { places: [{ repo: "evil", scope: "repository" }] }, { provider: "manual" }, { params: { baseUrl: "https://evil.example" } }, { expires: "2099-01-01" }, { rotatedAt: "2026-11-01" }, { verifiedAt: "2026-11-01" }, { verifiedBy: "alice" }, { externalId: "x" }, { ttlDays: 3650 }, { expiry: "none" }]) {
      await expect(updateSecretMeta(rt, agent, "cf-deploy-acme-app", bad), JSON.stringify(bad)).rejects.toThrow(/Feld nicht erlaubt/);
    }
    expect(JSON.stringify(rt.inventory.getSecret("cf-deploy-acme-app"))).toBe(before);
    // Auch ein erlaubtes Feld neben einem verbotenen aendert nichts.
    await expect(updateSecretMeta(rt, agent, "cf-deploy-acme-app", { title: "neu", stage: "dev" })).rejects.toThrow(/stage/);
    expect(rt.inventory.getSecret("cf-deploy-acme-app")!.title).toBeUndefined();
  });
  it("agent may change metadata, human expiry and stamp as well, but not the stage either", async () => {
    const { rt } = await setup();
    expect(await updateSecretMeta(rt, agent, "cf-deploy-acme-app", { title: "Deploy", description: "wofuer", owner: "alice", tags: ["x"], notes: "n", product: "acme" })).toMatchObject({ title: "Deploy", owner: "alice", product: "acme" });
    expect(await updateSecretMeta(rt, human, "cf-deploy-acme-app", { expires: "2027-03-03" })).toMatchObject({ expires: "2027-03-03" });
    await expect(updateSecretMeta(rt, human, "cf-deploy-acme-app", { stage: "dev" })).rejects.toThrow(/Feld nicht erlaubt: stage/);
  });
  it("creation by agents: dev only, known providers, no addresses, no stamps", async () => {
    const { rt } = await setup();
    const ok = { id: "agent-dev", name: "AGENT_DEV", service: "x", stage: "dev" };
    await expect(addSecret(rt, agent, { ...ok, id: "a-staging", stage: "staging", places: [{ repo: "acme-docs", scope: "environment", environment: "staging" }] })).rejects.toThrow(PolicyError);
    await expect(addSecret(rt, agent, { ...ok, id: "a-default", stage: undefined, places: PLACE })).rejects.toThrow(PolicyError);
    for (const extra of [{ expires: "2030-01-01" }, { externalId: "x" }, { verifiedAt: "2026-01-01" }, { verifiedBy: "alice" }, { rotatedAt: "2026-01-01" }]) {
      await expect(addSecret(rt, agent, { ...ok, id: "a-stamp", ...extra })).rejects.toThrow(/Feld nicht erlaubt/);
    }
    await expect(addSecret(rt, agent, { ...ok, id: "a-prov", provider: "gibt-es-nicht" })).rejects.toThrow(/Unbekannter Anbieter/);
    await expect(addSecret(rt, agent, { ...ok, id: "a-url", provider: "grafana-service-account-token", params: { baseUrl: "https://evil.example", serviceAccountId: 1 } })).rejects.toThrow(PolicyError);
    await expect(addSecret(rt, agent, { ...ok, id: "a-url2", params: { URL: "https://evil.example" } })).rejects.toThrow(PolicyError);
    expect(rt.inventory.getSecret("a-url")).toBeUndefined();
    expect(await addSecret(rt, agent, ok)).toMatchObject({ id: "agent-dev", stage: "dev" });
  });
  it("variables: agent creation strict; templates dev only and .env files only; new provider replaces no existing one", async () => {
    const { rt } = await setup();
    await expect(addVariable(rt, agent, { id: "v-x", name: "V_X", stage: "dev", places: PLACE, evil: 1 } as never)).rejects.toThrow(/Feld nicht erlaubt: evil/);
    const tpl = (extra: Record<string, unknown>) => ({ id: "t-x", repo: "acme-docs", stage: "dev", entries: [{ key: "A", from: { type: "default", value: "x" } }], ...extra });
    for (const file of [".envrc", ".npmrc", "Makefile", "deploy.sh", "../.bashrc"]) await expect(addEnvTemplate(rt, agent, tpl({ file }) as never), file).rejects.toThrow(PolicyError);
    await expect(addEnvTemplate(rt, agent, tpl({ stage: "staging" }) as never)).rejects.toThrow(PolicyError);
    await expect(addEnvTemplate(rt, agent, tpl({ entries: [{ key: "A", from: { type: "issue", secret: "cf-deploy-acme-app" } }] }) as never)).rejects.toThrow(PolicyError);
    await expect(addEnvTemplate(rt, agent, tpl({ entries: [{ key: "A", description: "x\nB=1", from: { type: "default", value: "x" } }] }) as never)).rejects.toThrow(/Zeile/);
    expect((await addEnvTemplate(rt, agent, tpl({ file: "apps/web/.env.local" }) as never)).id).toBe("t-x");
    await expect(addManualProvider(rt, agent, { id: "random-hex", label: "Fake", url: "https://example.com", steps: [] })).rejects.toThrow(/existiert schon/);
    await expect(addManualProvider(rt, agent, { id: "phish", label: "P", url: "javascript:alert(1)", steps: [] })).rejects.toThrow(/http/);
    expect(rt.providers.get("random-hex")!.kind).toBe("automatic");
  });
});

describe("F5: .env export by agents", () => {
  it(".env / .env.* only, never overwrite", async () => {
    const { rt, dir } = await setup();
    for (const name of [".envrc", ".npmrc", "Makefile", "setup.sh", ".env.sh", "env", ".bashrc"]) {
      await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, name) }), name).rejects.toThrow(PolicyError);
      await expect(stat(join(dir, name))).rejects.toThrow();
    }
    expect((await exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, ".env") })).status).toBe("written");
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, ".env"), overwrite: true })).rejects.toThrow(/Mensch/);
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, ".env") })).rejects.toThrow(/existiert schon/);
    expect((await exportEnv(rt, human, { repo: "acme-docs", path: join(dir, ".env"), overwrite: true })).status).toBe("written");
  });
  it("an agent does not issue issue sources from stages other than dev", async () => {
    const { rt, dir } = await setup();
    await addEnvTemplate(rt, human, { id: "docs-issue", repo: "acme-docs", stage: "dev", entries: [{ key: "TOK", from: { type: "issue", secret: "hmac-acme-app" } }] });
    await expect(exportEnv(rt, agent, { repo: "acme-docs", template: "docs-issue", path: join(dir, ".env.issue") })).rejects.toThrow(/nicht ausgestellt/);
  });
});

describe("F3: approval is bound to the content", () => {
  it("target value changed after the request: approval discarded, nothing set", async () => {
    const { rt, calls } = await setup();
    const r = await requestApplyVariable(rt, agent, "site-url-staging");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    const a = rt.approvals.get(r.approvalId)!;
    expect(a.snapshot).toMatchObject({ value: "https://staging.example.com", variable: "site-url-staging" });
    await updateVariable(rt, agent, "site-url-staging", { value: "https://evil.example.com" });
    const done = await resolveApproval(rt, human, r.approvalId, "approve");
    expect(done.state).toBe("stale");
    expect(done.result).toBe("Der Eintrag hat sich seit der Anfrage geaendert, Freigabe verworfen.");
    expect(calls.some((c) => c.startsWith("PATCH") || c.startsWith("POST") || c.startsWith("PUT"))).toBe(false);
  });
  it("targets of the variable changed: also discarded; unchanged is approved", async () => {
    const { rt, calls } = await setup();
    const r = await requestApplyVariable(rt, agent, "site-url-staging");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    rt.inventory.getVariable("site-url-staging")!.places = [{ repo: "evil", scope: "repository" }];
    expect((await resolveApproval(rt, human, r.approvalId, "approve")).state).toBe("stale");
    const { rt: rt2, calls: calls2 } = await setup();
    const r2 = await requestApplyVariable(rt2, agent, "site-url-staging");
    if (r2.status !== "pending-approval") throw new Error("erwartet");
    expect((await resolveApproval(rt2, human, r2.approvalId, "approve")).state).toBe("approved");
    expect(calls2.some((c) => c.startsWith("PATCH") && c.includes("/acme-docs/environments/staging/variables"))).toBe(true);
    expect(calls.some((c) => c.includes("evil"))).toBe(false);
  });
  it("issue request: targets/provider/parameters changed -> discarded, no review is created", async () => {
    for (const change of [(s: SecretLike) => (s.places = [{ repo: "evil", scope: "repository" }]), (s: SecretLike) => (s.params = { baseUrl: "https://evil.example" }), (s: SecretLike) => (s.provider = "random-hex")]) {
      const { rt } = await setup();
      const r = await requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging");
      if (r.status !== "pending-approval") throw new Error("erwartet");
      change(rt.inventory.getSecret("stripe-webhook-acme-docs-staging") as unknown as SecretLike);
      expect((await resolveApproval(rt, human, r.approvalId, "approve")).state).toBe("stale");
      expect(rt.issuances.list()).toHaveLength(0);
    }
  });
  it("new request with different content displaces the old open one", async () => {
    const { rt } = await setup();
    const a = await requestApplyVariable(rt, agent, "site-url-staging");
    await updateVariable(rt, agent, "site-url-staging", { value: "https://zwei.example.com" });
    const b = await requestApplyVariable(rt, agent, "site-url-staging");
    if (a.status !== "pending-approval" || b.status !== "pending-approval") throw new Error("erwartet");
    expect(b.approvalId).not.toBe(a.approvalId);
    expect(rt.approvals.get(a.approvalId)!.state).toBe("stale");
    expect(rt.approvals.get(b.approvalId)!.snapshot).toMatchObject({ value: "https://zwei.example.com" });
  });
  it("a completed request cannot be approved again", async () => {
    const { rt } = await setup();
    const r = await requestApplyVariable(rt, agent, "site-url-staging");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    await resolveApproval(rt, human, r.approvalId, "deny");
    await expect(resolveApproval(rt, human, r.approvalId, "approve")).rejects.toThrow(PolicyError);
  });
});

type SecretLike = { places: unknown; params: unknown; provider: string };

describe("F2b/M7: confirmation and read access", () => {
  it("retargeted targets between review and confirmation: nothing written, review removed", async () => {
    const { rt, calls } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    rt.inventory.getSecret("hmac-acme-app")!.places = [{ repo: "evil", scope: "repository" }] as never;
    await expect(confirmIssuance(rt, human, r.issuance.id, { ticks: r.issuance.report.checklist.map((c) => c.id) })).rejects.toThrow("Eintrag wurde seit der Pruefung geaendert, bitte neu erzeugen");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(rt.issuances.list()).toHaveLength(0);
  });
  it("reading (listIssuances/getIssuance) discards and revokes nothing; a new issuance cleans up", async () => {
    const { rt } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    rt.issuances.get(r.issuance.id)!.expiresAt = "2000-01-01T00:00:00.000Z";
    expect(await listIssuances(rt)).toEqual([]);
    await expect(getIssuance(rt, r.issuance.id)).rejects.toThrow(PolicyError);
    expect(rt.issuances.list()).toHaveLength(1);
    await requestIssuance(rt, human, "hmac-acme-app");
    expect(rt.issuances.get(r.issuance.id)).toBeUndefined();
  });
});

describe("H3: approval is atomic", () => {
  async function pendingIssue() {
    const ctx = await setup(["dev"]);
    const r = await requestIssuance(ctx.rt, agent, "hmac-acme-app");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    return { ...ctx, id: r.approvalId };
  }
  it("approve twice: second throws, only one review", async () => {
    const { rt, id } = await pendingIssue();
    expect((await resolveApproval(rt, human, id, "approve")).state).toBe("approved");
    await expect(resolveApproval(rt, human, id, "approve")).rejects.toThrow(PolicyError);
    expect(rt.issuances.list()).toHaveLength(1);
  });
  it("Promise.all([approve, approve]): exactly one issuance", async () => {
    const { rt, id } = await pendingIssue();
    const res = await Promise.allSettled([resolveApproval(rt, human, id, "approve"), resolveApproval(rt, human, id, "approve")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PolicyError);
    expect(rt.issuances.list()).toHaveLength(1);
    expect(rt.approvals.get(id)!.state).toBe("approved");
  });
  it("approve after deny throws; deny path sets denied without work", async () => {
    const { rt, id } = await pendingIssue();
    expect((await resolveApproval(rt, human, id, "deny")).state).toBe("denied");
    await expect(resolveApproval(rt, human, id, "approve")).rejects.toThrow(PolicyError);
    expect(rt.issuances.list()).toHaveLength(0);
  });
  it("target error on variable apply: state failed, no raw error", async () => {
    const { rt, id } = await (async () => {
      const ctx = await setup(["dev"]);
      const r = await requestApplyVariable(ctx.rt, agent, "site-url-staging");
      if (r.status !== "pending-approval") throw new Error("erwartet");
      (ctx.rt as unknown as { github: unknown }).github = { ...(ctx.rt.github as object), setVariable: async () => { throw new Error("boom"); } };
      return { rt: ctx.rt, id: r.approvalId };
    })();
    const done = await resolveApproval(rt, human, id, "approve");
    expect(["failed", "approved"]).toContain(done.state);
    if (done.state === "approved") throw new Error("Zielfehler muss failed ergeben");
    expect(rt.approvals.get(id)!.state).toBe("failed");
  });
});
