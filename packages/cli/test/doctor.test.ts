import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { createRuntime } from "@secret-desk/runtime";
import { doctorExitCode, runDoctor } from "../src/doctor.js";

const INVENTORY = `version: 1
secrets:
  - id: trial-cloudflare
    name: SD_TRIAL_TOKEN
    stage: staging
    service: cloudflare
    provider: cloudflare-token
    params: { accountId: "0123456789abcdef0123456789abcdef", permissions: ["Account Settings Read"] }
    ttlDays: 7
    expiry: possible
    places:
      - { repo: sandbox, scope: environment, environment: staging }
  - id: trial-missing-provider
    name: SD_OTHER
    stage: shared
    service: x
    provider: gibt-es-nicht
    places:
      - { repo: gone, scope: repository }
`;

async function setup(env: Record<string, string>, goneStatus = 404) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/gone/")) return new Response(JSON.stringify({ message: "Not Found" }), { status: goneStatus });
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (u.includes("/user/tokens/verify")) return new Response(JSON.stringify({ result: { status: "active", expires_on: "2027-01-01T00:00:00Z" } }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-doc-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: Pineflight\n  auth: { type: pat, source: { type: env, name: GH_X } }\nconnections:\n  cloudflare: { type: env, name: CF_X }\n`);
  return createRuntime(join(dir, "c.yaml"), { env: env as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
}

describe("doctor", () => {
  it("meldet Probleme, ohne etwas zu schreiben, und nie einen Wert", async () => {
    const rt = await setup({ GH_X: "ghp_geheim_1", CF_X: "cf_geheim_2" });
    const f = await runDoctor(rt);
    const byId = (id: string) => f.find((x) => x.id === id)!;
    expect(byId("connection:github").status).toBe("ok");
    expect(byId("target:sandbox/env:staging").status).toBe("ok");
    expect(byId("target:gone/repo").status).toBe("fail");
    expect(byId("provider:trial-missing-provider").status).toBe("fail");
    expect(byId("cloudflare-token")).toMatchObject({ status: "ok", detail: "laeuft ab: 2027-01-01" });
    expect(doctorExitCode(f)).toBe(1);
    expect(JSON.stringify(f)).not.toMatch(/geheim/);
  });
  it("ohne GitHub-Verbindung ist das ein Fehler, ohne Cloudflare nur ein Hinweis", async () => {
    const f = await runDoctor(await setup({}));
    expect(f.find((x) => x.id === "connection:github")!.status).toBe("fail");
    expect(f.find((x) => x.id === "connection:cloudflare")!.status).toBe("warn");
    expect(f.find((x) => x.id === "targets")!.status).toBe("warn");
  });
  it("403 bekommt den Hinweis auf das fehlende Recht", async () => {
    const f = await runDoctor(await setup({ GH_X: "ghp_x" }, 403));
    expect(f.find((x) => x.id === "target:gone/repo")!.detail).toContain("Secrets: Read and write");
  });
});
