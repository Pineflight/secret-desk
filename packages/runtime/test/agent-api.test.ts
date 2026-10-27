import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import {
  PolicyError,
  addManualProvider,
  addSecret,
  addVariable,
  attachEvidence,
  confirmIssuance,
  evidenceSvg,
  exportEnv,
  getIssuance,
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
  const live: Record<string, string> = { "/acme-docs/environments/staging/variables": "https://alt.example.com", "/acme-app/actions/variables": "proj_1" };
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
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
  return { rt, dir, calls };
}

const agent = { kind: "agent", name: "claude" } as const;
const human = { kind: "human", name: "alice" } as const;

describe("Uebersicht", () => {
  it("zaehlt Secrets, Variablen und offene Pruefungen, ohne Werte", async () => {
    const { rt } = await setup();
    const o = await overview(rt, new Date("2026-11-05T00:00:00Z"));
    expect(o).toMatchObject({ total: 3, variables: 2, pendingReviews: 0, pendingApprovals: 0 });
    expect((await listSecrets(rt, { status: "due" }, new Date("2026-11-05T00:00:00Z"))).map((s) => s.id)).toEqual(["cf-deploy-acme-app"]);
    expect(JSON.stringify(o)).not.toContain("ghp_x");
  });
});

describe("Ausstellen, Pruefen, Bestaetigen", () => {
  it("Mensch: Wert wird erzeugt und geprueft, GitHub bleibt unberuehrt bis zur Bestaetigung", async () => {
    const { rt, calls } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(r.issuance.report.checks.some((c) => c.id.startsWith("target:") && c.status === "pass")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{64}/);
    const ticks = r.issuance.report.checklist.map((c) => c.id);
    await expect(confirmIssuance(rt, agent, r.issuance.id, { ticks })).rejects.toThrow(PolicyError);
    const done = await confirmIssuance(rt, human, r.issuance.id, { ticks, note: "ok" });
    expect(done.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBe("alice");
    expect(rt.issuances.list()).toHaveLength(0);
    const evidence = await listEvidence(rt, "hmac-acme-app");
    expect(evidence[0]!.confirmation?.decision).toBe("confirmed");
    expect(await evidenceSvg(rt, "hmac-acme-app", evidence[0]!.id)).toContain("<svg");
  });
  it("Mensch kann ablehnen: nichts wird geschrieben", async () => {
    const { rt, calls } = await setup();
    const r = await requestIssuance(rt, human, "hmac-acme-app");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    await rejectIssuance(rt, human, r.issuance.id, "falsch");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    await expect(getIssuance(rt, r.issuance.id)).rejects.toThrow();
  });
  it("Agent in staging: Freigabe-Anfrage, nach der Freigabe wartet die Pruefung auf Bestaetigung", async () => {
    const { rt } = await setup();
    const r = await requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging", { reason: "neu" });
    expect(r.status).toBe("pending-approval");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    await expect(resolveApproval(rt, agent, r.approvalId, "approve")).rejects.toThrow(PolicyError);
    const denied = await requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging");
    expect(denied.status === "pending-approval" && denied.approvalId).toBe(r.approvalId);
  });
  it("Handeingabe: wird geprueft, der Wert steht in keinem Bericht, Anlage nur als Bild", async () => {
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

describe("Variablen", () => {
  it("vergleicht Soll und Ist, uebernimmt aus GitHub und lehnt Geheimnisse ab", async () => {
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
  it("Setzen: Mensch sofort, Agent in staging nur per Freigabe", async () => {
    const { rt, calls } = await setup();
    const a = await requestApplyVariable(rt, agent, "site-url-staging");
    expect(a.status).toBe("pending-approval");
    expect(calls.some((c) => c.startsWith("PATCH") || c.startsWith("POST"))).toBe(false);
    const h = await requestApplyVariable(rt, human, "site-url-staging");
    expect(h.status).toBe("applied");
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("/acme-docs/environments/staging/variables/NEXT_PUBLIC_SITE_URL"))).toBe(true);
  });
  it("neue Variable mit Pflichtziel", async () => {
    const { rt } = await setup();
    await expect(addVariable(rt, agent, { id: "x-y", name: "X_Y", places: [] })).rejects.toThrow();
    const v = await addVariable(rt, agent, { id: "print-env", name: "PRINT_ENV", stage: "staging", value: "sandbox", places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect(v.value).toBe("sandbox");
  });
});

describe("Beschreibungen und Suche", () => {
  it("findet Secrets und Variablen ueber Beschreibung und Schlagworte", async () => {
    const { rt } = await setup();
    await addSecret(rt, { id: "acme-key", name: "ACME_API_KEY", service: "acme-api", stage: "staging", description: "Druckauftraege senden", owner: "alice", tags: ["druck"], places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect((await listSecrets(rt, { q: "druckauftr" })).map((s) => s.id)).toEqual(["acme-key"]);
    expect((await listSecrets(rt, { tag: "druck" })).map((s) => s.id)).toEqual(["acme-key"]);
    expect((await listSecrets(rt, { q: "alice" })).map((s) => s.id)).toContain("acme-key");
    await updateVariable(rt, human, "site-url-staging", { description: "Basis-URL der Staging-Seite", tags: ["url"] });
    expect(listVariables(rt, { q: "basis-url" }).map((v) => v.id)).toEqual(["site-url-staging"]);
    expect(listVariables(rt, { tag: "url" })[0]).toMatchObject({ description: "Basis-URL der Staging-Seite", tags: ["url"], owner: null });
  });
});

describe("Dev-Env und Metadaten", () => {
  it("schreibt Datei 600 und gibt nur Schluessel zurueck", async () => {
    const { rt, dir } = await setup();
    const r = await exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, "app", ".env.local") });
    if (r.status !== "written") throw new Error("erwartet");
    expect(r.keys).toEqual(["SITE_URL", "RATE_LIMIT_SECRET"]);
    if (process.platform !== "win32") expect((await stat(r.path)).mode & 0o777).toBe(0o600); // Windows kennt keine POSIX-Modi
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{32}/);
  });
  it("Agenten: keine Stage ausser dev, keine Werte, keine fremden Ordner", async () => {
    const { rt, dir } = await setup();
    await expect(exportEnv(rt, agent, { repo: "acme-docs", stage: "staging", path: join(dir, "x") })).rejects.toThrow(PolicyError);
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: join(dir, "y"), prompts: { A: "b" } })).rejects.toThrow(PolicyError);
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: "/tmp/ausserhalb/.env" })).rejects.toThrow(/ausserhalb/);
  });
  it("meldet noetige Eingaben statt zu raten", async () => {
    const { rt, dir } = await setup();
    expect(await exportEnv(rt, human, { repo: "acme-docs-x", path: join(dir, "z") })).toMatchObject({ status: "needs-input", keys: ["STRIPE_SECRET_KEY"] });
  });
  it("pflegt Metadaten und Team-Datei", async () => {
    const { rt } = await setup();
    await addSecret(rt, { id: "resend-acme-docs-staging", name: "RESEND_API_KEY", service: "resend", stage: "staging", provider: "resend-api-key", places: [{ repo: "acme-docs", scope: "environment", environment: "staging" }] });
    await addManualProvider(rt, { id: "acme-api", label: "Acme API", url: "https://acme.example.com", steps: ["Dashboard oeffnen"] });
    expect(rt.providers.get("acme-api")?.kind).toBe("manual");
    expect(teamExport(rt)).toContain("resend-acme-docs-staging");
    expect(teamExport(rt)).toContain("site-url-staging");
    expect(await readFile(rt.inventory.path!, "utf8")).toContain("resend-acme-docs-staging");
  });
});
