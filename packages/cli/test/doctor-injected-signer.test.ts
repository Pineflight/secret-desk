import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalRuntime } from "@secret-desk/runtime";
import { runDoctor } from "../src/doctor.js";

const INVENTORY = `version: 1
secrets:
  - id: app-secret
    name: APP_SECRET
    stage: staging
    service: x
    provider: manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
`;

async function setup(sign: boolean) {
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/app/installations?")) return json([{ id: 7, account: { login: "acme" } }]);
    if (u.includes("/access_tokens")) return json({ token: "made-up-installation-token", expires_at: "2099-01-01T00:00:00Z" }, 201);
    if (u.endsWith("/public-key")) return json({ key_id: "k", key: "made-up-public-key" });
    return json({});
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-doc-sign-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), 'inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: app, appId: "1", privateKey: { type: session } }\n');
  const signer = vi.fn(async () => "made-up-signature");
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, ...(sign ? { sign: signer } : {}) });
  return { rt, signer };
}

describe("doctor with a GitHub App", () => {
  it("counts an injected signer as a GitHub connection and checks the targets with it", async () => {
    const { rt, signer } = await setup(true);
    const findings = await runDoctor(rt);
    expect(findings.some((f) => f.id === "targets")).toBe(false);
    expect(findings.filter((f) => f.id.startsWith("target:")).map((f) => f.status)).toEqual(["ok"]);
    expect(signer).toHaveBeenCalled();
  });

  it("without a signer and without a stored key the targets are not checked", async () => {
    const { rt } = await setup(false);
    expect((await runDoctor(rt)).find((f) => f.id === "targets")).toMatchObject({ status: "warn" });
  });
});
