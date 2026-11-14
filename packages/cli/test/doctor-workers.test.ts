import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalRuntime } from "@secret-desk/runtime";
import { runDoctor } from "../src/doctor.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const INVENTORY = `version: 1
secrets:
  - { id: anthropic-portal-staging, name: ANTHROPIC_API_KEY, stage: staging, service: anthropic, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: acme-portal-staging }] }
  - { id: openai-portal-staging, name: OPENAI_API_KEY, stage: staging, service: openai, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACCOUNT}", script: acme-portal-missing }] }
`;

async function setup(env: Record<string, string>) {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/workers/scripts/acme-portal-missing/")) return new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }), { status: 404 });
    if (u.includes("/workers/scripts/acme-portal-staging/secrets")) return new Response(JSON.stringify({ success: true, result: [{ name: "ANTHROPIC_API_KEY", type: "secret_text" }] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-doc-workers-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_X } }\nconnections:\n  cloudflare: { type: env, name: CF_X }\n`);
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: env as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  return { rt, calls };
}

describe("doctor: Cloudflare Worker secret places", () => {
  it("checks each Worker by its secret names, reads only, and flags a missing Worker", async () => {
    const { rt, calls } = await setup({ GH_X: "gh-made-up", CF_X: "cf-made-up" });
    const f = await runDoctor(rt);
    const byId = (id: string) => f.find((x) => x.id === id)!;
    expect(byId("connection:cloudflare").status).toBe("ok");
    expect(byId("target:worker:acme-portal-staging").status).toBe("ok");
    expect(byId("target:worker:acme-portal-missing")).toMatchObject({ status: "fail" });
    expect(byId("target:worker:acme-portal-missing").detail).toContain("Worker nicht gefunden");
    expect(calls.filter((c) => c.startsWith("GET ") === false && c.includes("workers"))).toEqual([]);
    expect(JSON.stringify(f)).not.toContain("cf-made-up");
  });
  it("without a Cloudflare connection the Worker targets are only a hint", async () => {
    const { rt, calls } = await setup({ GH_X: "gh-made-up" });
    const f = await runDoctor(rt);
    expect(f.find((x) => x.id === "connection:cloudflare")!.status).toBe("warn");
    expect(f.find((x) => x.id === "worker-targets")!.status).toBe("warn");
    expect(calls.some((c) => c.includes("workers"))).toBe(false);
  });
});
