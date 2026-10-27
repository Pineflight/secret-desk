import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { addManualProvider, addSecret, exportEnv, listSecrets, overview, PolicyError, requestRotation, resolveApproval, teamExport } from "../src/agent-api.js";

const INVENTORY = `version: 1
secrets:
  - id: stripe-webhook-leitfaden-staging
    name: STRIPE_WEBHOOK_SECRET
    stage: staging
    service: stripe
    provider: manual
    expiry: none
    places:
      - { repo: leitfaden, scope: environment, environment: staging }
  - id: cf-deploy-wakemiles
    name: CLOUDFLARE_API_TOKEN
    stage: shared
    product: wakemiles
    service: cloudflare
    provider: random-hex
    expiry: possible
    expires: "2026-11-10"
    ttlDays: 90
    places:
      - { repo: wake-miles, scope: repository }
envTemplates:
  - id: leitfaden-dev
    repo: leitfaden
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: RATE_LIMIT_GEHEIMNIS, from: { type: generate, kind: hex, bytes: 16 } }
  - id: leitfaden-dev-prompt
    repo: leitfaden-x
    stage: dev
    entries:
      - { key: STRIPE_SECRET_KEY, from: { type: prompt } }
`;

async function setup(agentStages: string[] = ["dev"]) {
  const dir = await mkdtemp(join(tmpdir(), "sd-rt-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml
github:
  owner: Pineflight
  auth: { type: pat, source: { type: env, name: GH_TEST } }
policy:
  agentStages: [${agentStages.join(", ")}]
  envRoots: ["${dir}"]
`,
  );
  const fetchMock = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { env: { GH_TEST: "ghp_x" }, fetch: fetchMock });
  return { rt, dir };
}

describe("agent-api", () => {
  it("liefert Uebersicht und Listen nur mit Metadaten", async () => {
    const { rt } = await setup();
    const o = await overview(rt, new Date("2026-11-05T00:00:00Z"));
    expect(o.total).toBe(2);
    expect(o.byStage.staging).toBe(1);
    const due = await listSecrets(rt, { status: "due" }, new Date("2026-11-05T00:00:00Z"));
    expect(due.map((d) => d.id)).toEqual(["cf-deploy-wakemiles"]);
    expect(JSON.stringify(o)).not.toMatch(/ghp_x/);
  });
  it("Agenten bekommen fuer staging eine Freigabe-Anfrage statt Ausfuehrung", async () => {
    const { rt } = await setup();
    const r = await requestRotation(rt, { kind: "agent", name: "claude" }, "stripe-webhook-leitfaden-staging", { reason: "Webhook neu" });
    expect(r.status).toBe("pending-approval");
    expect(rt.approvals.list("pending")).toHaveLength(1);
    const again = await requestRotation(rt, { kind: "agent", name: "claude" }, "stripe-webhook-leitfaden-staging");
    expect(again.status === "pending-approval" && again.approvalId).toBe(rt.approvals.list()[0]!.id);
  });
  it("nur ein Mensch darf freigeben", async () => {
    const { rt } = await setup();
    const r = await requestRotation(rt, { kind: "agent", name: "claude" }, "stripe-webhook-leitfaden-staging");
    if (r.status !== "pending-approval") throw new Error("erwartet");
    await expect(resolveApproval(rt, { kind: "agent", name: "claude" }, r.approvalId, "approve")).rejects.toThrow(PolicyError);
    const denied = await resolveApproval(rt, { kind: "human", name: "niklas" }, r.approvalId, "deny");
    expect(denied.state).toBe("denied");
  });
  it("Dry-Run zeigt den Plan ohne Wirkung", async () => {
    const { rt } = await setup();
    const r = await requestRotation(rt, { kind: "agent", name: "claude" }, "cf-deploy-wakemiles", { dryRun: true });
    expect(r.status).toBe("dry-run");
  });
  it("Dev-Env: schreibt Datei 600 und gibt nur Schluessel zurueck", async () => {
    const { rt, dir } = await setup();
    const r = await exportEnv(rt, { kind: "agent", name: "claude" }, { repo: "leitfaden", path: join(dir, "app", ".env.local") });
    if (r.status !== "written") throw new Error("erwartet");
    expect(r.keys).toEqual(["SITE_URL", "RATE_LIMIT_GEHEIMNIS"]);
    expect((await stat(r.path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{32}/);
    expect(await readFile(r.path, "utf8")).toMatch(/RATE_LIMIT_GEHEIMNIS=[0-9a-f]{32}/);
  });
  it("Agenten duerfen weder staging-Env noch Werte uebergeben noch ausserhalb der Wurzeln schreiben", async () => {
    const { rt, dir } = await setup();
    await expect(exportEnv(rt, { kind: "agent", name: "c" }, { repo: "leitfaden", stage: "staging", path: join(dir, "x") })).rejects.toThrow(PolicyError);
    await expect(exportEnv(rt, { kind: "agent", name: "c" }, { repo: "leitfaden", path: join(dir, "y"), prompts: { A: "b" } })).rejects.toThrow(PolicyError);
    await expect(exportEnv(rt, { kind: "agent", name: "c" }, { repo: "leitfaden", path: "/tmp/ausserhalb/.env" })).rejects.toThrow(/ausserhalb/);
  });
  it("meldet noetige Eingaben statt zu raten", async () => {
    const { rt, dir } = await setup();
    const r = await exportEnv(rt, { kind: "human", name: "n" }, { repo: "leitfaden-x", path: join(dir, "z") });
    expect(r).toMatchObject({ status: "needs-input", keys: ["STRIPE_SECRET_KEY"] });
  });
  it("pflegt Metadaten: neues Secret, eigener Anbieter, Team-Datei", async () => {
    const { rt } = await setup();
    await addSecret(rt, { id: "resend-leitfaden-staging", name: "RESEND_API_KEY", service: "resend", stage: "staging", provider: "resend-api-key", places: [{ repo: "leitfaden", scope: "environment", environment: "staging" }] });
    await addManualProvider(rt, { id: "peecho", label: "Peecho", url: "https://www.peecho.com", steps: ["Dashboard oeffnen"] });
    expect(rt.providers.get("peecho")?.kind).toBe("manual");
    expect(teamExport(rt)).toContain("resend-leitfaden-staging");
    expect(await readFile(rt.inventory.path!, "utf8")).toContain("resend-leitfaden-staging");
  });
});
