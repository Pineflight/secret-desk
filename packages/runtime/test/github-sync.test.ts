import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretVault } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import { planGitHubSync, runGitHubSync, secretValueEntry, secretValueSource } from "../src/github-sync.js";
import { createRuntime } from "../src/runtime.js";

const human = { kind: "human", name: "tester" } as const;
const agent = { kind: "agent", name: "bot" } as const;

const INVENTORY = `version: 1
secrets:
  - id: stored-secret
    name: STORED_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: empty-secret
    name: EMPTY_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: other-repo-secret
    name: OTHER_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-other, scope: repository }
variables:
  - id: site-url
    name: SITE_URL
    stage: shared
    value: "https://acme.example"
    places:
      - { repo: acme-app, scope: repository }
`;

async function setup(withVault: boolean) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const written: { method: string; url: string; plain?: string }[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (method === "GET" && u.includes("/variables")) return new Response(JSON.stringify({ total_count: 0, variables: [] }), { status: 200 });
    if (method === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ total_count: 0, secrets: [] }), { status: 200 });
    const entry: { method: string; url: string; plain?: string } = { method, url: u };
    if (typeof init?.body === "string") {
      const enc = (JSON.parse(init.body) as { encrypted_value?: string }).encrypted_value;
      if (enc) entry.plain = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(enc, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
    }
    written.push(entry);
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-ghsync-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const vault = withVault ? new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => randomBytes(32) } }) : null;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  return { rt, vault, written };
}

describe("secret value source", () => {
  it("is absent without a vault", async () => {
    const { rt } = await setup(false);
    expect(secretValueSource(rt)).toBeUndefined();
  });

  it("reads metadata and values from the vault entry next to the connection tokens", async () => {
    const { rt, vault } = await setup(true);
    expect(secretValueEntry("abc")).toBe("abc#value");
    await vault!.set(secretValueEntry("stored-secret"), "made-up-stored-value");
    const src = secretValueSource(rt)!;
    expect(await src.info("missing")).toBeNull();
    expect(await src.info("stored-secret")).toMatchObject({ fingerprint: expect.any(String), savedAt: expect.any(String) });
    expect((await src.get("stored-secret"))?.reveal()).toBe("made-up-stored-value");
    expect(await src.get("missing")).toBeNull();
  });
});

describe("planGitHubSync", () => {
  it("without a vault no secret has a value; a repo filter narrows the plan; reads are open to agents", async () => {
    const { rt } = await setup(false);
    const plan = await planGitHubSync(rt, agent);
    expect(plan.lines.find((l) => l.entryId === "stored-secret")).toMatchObject({ action: "skip", reason: "no-value", renewable: true });
    expect(plan.lines.find((l) => l.entryId === "site-url")).toMatchObject({ action: "set", reason: "missing" });
    const narrowed = await planGitHubSync(rt, human, { repo: "acme-other" });
    expect(narrowed.lines.map((l) => l.entryId)).toEqual(["other-repo-secret"]);
  });

  it("a stored value makes the secret writable", async () => {
    const { rt, vault } = await setup(true);
    await vault!.set(secretValueEntry("stored-secret"), "made-up-stored-value");
    const plan = await planGitHubSync(rt, human);
    expect(plan.lines.find((l) => l.entryId === "stored-secret")).toMatchObject({ action: "write", reason: "missing" });
    expect(plan.lines.find((l) => l.entryId === "empty-secret")).toMatchObject({ action: "skip", reason: "no-value" });
  });
});

describe("runGitHubSync", () => {
  it("writes the selected lines with all options, progress included", async () => {
    const { rt, vault, written } = await setup(true);
    await vault!.set(secretValueEntry("stored-secret"), "made-up-stored-value");
    const plan = await planGitHubSync(rt, human, { repo: "acme-app" });
    const keys = plan.lines.filter((l) => l.action !== "skip").map((l) => l.key);
    expect(keys).toHaveLength(2);
    const progress: [number, number][] = [];
    const result = await runGitHubSync(rt, human, { keys, repo: "acme-app", confirmProduction: true, onProgress: (d, t) => progress.push([d, t]), sleep: async () => undefined, batchSize: 1 });
    expect(result.outcomes.filter((o) => o.outcome === "failed")).toEqual([]);
    expect(result.outcomes).toHaveLength(2);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(written.find((w) => w.plain)?.plain).toBe("made-up-stored-value");
    expect(written.some((w) => w.url.includes("/variables"))).toBe(true);
  });

  it("minimal request without a vault: only the variable can be written", async () => {
    const { rt, written } = await setup(false);
    const plan = await planGitHubSync(rt, human);
    const key = plan.lines.find((l) => l.entryId === "site-url")!.key;
    const result = await runGitHubSync(rt, human, { keys: [key] });
    expect(result.outcomes).toHaveLength(1);
    expect(written).toHaveLength(1);
  });

  it("agents may not write", async () => {
    const { rt } = await setup(false);
    await expect(runGitHubSync(rt, agent, { keys: ["x"] })).rejects.toThrow(PolicyError);
  });
});
