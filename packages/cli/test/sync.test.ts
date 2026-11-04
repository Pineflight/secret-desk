import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

const INVENTORY = `version: 1
variables:
  - { id: site-url, name: SITE_URL, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: region, name: REGION, stage: production, value: "eu", places: [{ repo: acme-web, scope: environment, environment: production }] }
  - { id: no-value, name: NO_VALUE, stage: staging, places: [{ repo: acme-web, scope: environment, environment: staging }] }
secrets:
  - { id: api-key, name: API_KEY, stage: production, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-web, scope: environment, environment: production }] }
`;

async function setup() {
  await sodium.ready;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url).replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify(u.includes("/variables") ? { variables: [] } : { secrets: [] }), { status: 200 });
      writes.push(`${method} ${u}`);
      return new Response(null, { status: method === "PATCH" ? 404 : 201 });
    }) as unknown as typeof fetch,
  );
  vi.stubEnv("SD_CLI_SYNC_TOKEN", "ghp_made_up_token_2");
  const dir = await mkdtemp(join(tmpdir(), "sd-cli-sync-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  const config = join(dir, "secret-desk.config.yaml");
  await writeFile(config, "inventory: ./inventory.yaml\nvault: { enabled: false }\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_SYNC_TOKEN } }\n");
  const out: string[] = [];
  const err: string[] = [];
  return { dir, config, out, err, writes, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("secret-desk sync --to-github", () => {
  it("--dry-run prints the plan grouped by repository, writes nothing, shows no value", async () => {
    const t = await setup();
    expect(await main(["sync", "--to-github", "--config", t.config, "--dry-run"], t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("acme-web");
    expect(text).toContain("[x] set");
    expect(text).toContain("SITE_URL");
    expect(text).toContain("(Produktion)");
    expect(text).toContain("kein Wert");
    expect(text).toContain("2 Variable(n) setzen, 0 Secret(s) schreiben, 2 uebersprungen");
    expect(text).toContain("Probelauf");
    expect(text).not.toContain("staging.example.com");
    expect(text).not.toContain("ghp_made_up_token_2");
    expect(t.writes).toEqual([]);
    expect(await readFile(join(t.dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });

  it("--yes writes the variables, reports progress and ends with 0", async () => {
    const t = await setup();
    expect(await main(["sync", "--to-github", "--config", t.config, "--yes"], t.io)).toBe(0);
    expect(t.writes.some((w) => w.includes("/staging/variables"))).toBe(true);
    expect(t.writes.some((w) => w.includes("/production/variables"))).toBe(true);
    expect(t.writes.some((w) => w.startsWith("DELETE"))).toBe(false);
    const text = t.out.join("\n");
    expect(text).toContain("Fortschritt: 2/2");
    expect(text).toContain("ok: 2 geschrieben.");
  });

  it("--repo limits the plan", async () => {
    const t = await setup();
    expect(await main(["sync", "--to-github", "--config", t.config, "--dry-run", "--repo", "other"], t.io)).toBe(0);
    expect(t.out.join("\n")).toContain("0 Variable(n) setzen");
  });

  it("without --to-github it is an error", async () => {
    const t = await setup();
    expect(await main(["sync", "--config", t.config], t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("--to-github");
  });
});
