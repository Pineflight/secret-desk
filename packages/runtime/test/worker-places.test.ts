import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConnection, confirmIssuance, listSecrets, listWorkerTargets, listWriteTargets, planGitHubSync, submitManualValue } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "acme-portal-staging";
const VALUE = "made-up-worker-secret-value-9021";
// Assembled at run time so the repository secret scan does not match the made-up value.
const CF_TOKEN = ["cf", "connection", "made", "up"].join("-");
const human = { kind: "human", name: "alice" } as const;

const INVENTORY = `version: 1
secrets:
  - { id: anthropic-portal-staging, name: ANTHROPIC_API_KEY, stage: staging, service: anthropic, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }
  - { id: openai-portal-staging, name: OPENAI_API_KEY, stage: staging, service: openai, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: ${SCRIPT} }] }
  - { id: gh-secret, name: GH_SECRET, stage: staging, service: x, provider: manual, expiry: none, places: [{ repo: acme-docs, scope: environment, environment: staging }] }
`;

async function setup(opts: { workerStatus?: number } = {}) {
  const calls: { method: string; url: string; auth: string | null; body: string | undefined }[] = [];
  const present = new Set(["ANTHROPIC_API_KEY"]);
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, auth: new Headers(init?.headers).get("authorization"), body: init?.body as string | undefined });
    if (u.includes("/user/tokens/verify")) return new Response(JSON.stringify({ success: true, result: { status: "active" } }), { status: 200 });
    if (u.includes(`/workers/scripts/${SCRIPT}/secrets`)) {
      if (opts.workerStatus) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "denied" }] }), { status: opts.workerStatus });
      if (method === "PUT") {
        present.add((JSON.parse(String(init?.body)) as { name: string }).name);
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [...present].map((name) => ({ name, type: "secret_text" })) }), { status: 200 });
    }
    if (u.includes("/actions/secrets") || u.includes("/environments/")) return new Response(JSON.stringify({ secrets: [{ name: "GH_SECRET", created_at: "c", updated_at: "2026-11-01T00:00:00Z" }], variables: [] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-worker-places-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\n`);
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  rt.connections.session.set("github", "gh-token-made-up", null);
  rt.connections.session.set("cloudflare", CF_TOKEN, null);
  return { rt, calls, present };
}

describe("Worker places in the runtime", () => {
  it("the GitHub write targets leave Worker places out; the Worker targets list them once", async () => {
    const { rt } = await setup();
    expect(listWriteTargets(rt).map((t) => t.id)).toEqual(["environment:acme-docs/staging"]);
    expect(listWorkerTargets(rt)).toEqual([{ scope: "cloudflare-worker", accountId: ACCOUNT, script: SCRIPT, live: false }]);
  });

  it("the cloudflare connection check reads each Worker's secret names and never writes", async () => {
    const { rt, calls } = await setup();
    const r = await checkConnection(rt, "cloudflare", {}, new Date("2026-11-04T00:00:00Z"));
    const item = r.checks.find((c) => c.id === `worker:${SCRIPT}`)!;
    expect(item.status).toBe("pass");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(CF_TOKEN);
  });

  it("fails the connection check for a Worker the token cannot read, with the permission hint", async () => {
    const { rt } = await setup({ workerStatus: 403 });
    const r = await checkConnection(rt, "cloudflare", {}, new Date("2026-11-04T00:00:00Z"));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === `worker:${SCRIPT}`)!.detail).toContain("Workers Scripts Write");
    expect(JSON.stringify(r)).not.toContain(CF_TOKEN);
  });

  it("status --live: present or missing by name, and an unreadable Worker is reported instead of missing", async () => {
    const { rt } = await setup();
    const live = await listSecrets(rt, { live: true }, new Date("2026-11-04T00:00:00Z"));
    const byId = Object.fromEntries(live.map((s) => [s.id, s]));
    expect(byId["anthropic-portal-staging"]!.status).not.toBe("missing");
    expect(byId["openai-portal-staging"]!.status).toBe("missing");
    const blocked = await setup({ workerStatus: 403 });
    const unreadable = await listSecrets(blocked.rt, { live: true }, new Date("2026-11-04T00:00:00Z"));
    const one = unreadable.find((s) => s.id === "openai-portal-staging")!;
    expect(one.status).not.toBe("missing");
    expect(one.liveErrors?.[0]).toContain("Cloudflare GET");
    expect(JSON.stringify(unreadable)).not.toContain(CF_TOKEN);
  });

  it("the Worker is written with the cloudflare connection token after the human confirms", async () => {
    const { rt, calls, present } = await setup();
    const issuance = await submitManualValue(rt, human, "openai-portal-staging", VALUE);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(issuance.report.checklist.some((c) => c.text.includes(`Worker ${SCRIPT}`))).toBe(true);
    const done = await confirmIssuance(rt, human, issuance.id, { ticks: issuance.report.checklist.map((c) => c.id) });
    expect(done.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.auth).toBe(`Bearer ${CF_TOKEN}`);
    expect(JSON.parse(put.body!)).toEqual({ name: "OPENAI_API_KEY", text: VALUE, type: "secret_text" });
    expect(present.has("OPENAI_API_KEY")).toBe(true);
    expect(JSON.stringify(done)).not.toContain(VALUE);
    expect(JSON.stringify(issuance)).not.toContain(VALUE);
  });

  it("the sync plan includes the Worker secrets as secret lines only", async () => {
    const { rt } = await setup();
    const plan = await planGitHubSync(rt, human);
    const lines = plan.lines.filter((l) => l.place.scope === "cloudflare-worker");
    expect(lines.map((l) => [l.entryId, l.kind, l.reason])).toEqual([
      ["anthropic-portal-staging", "secret", "no-value"],
      ["openai-portal-staging", "secret", "no-value"],
    ]);
    expect(JSON.stringify(plan)).not.toContain(CF_TOKEN);
  });
});
