import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";

const NOTES = "made-up-notes-value-52";
const INVENTORY = `version: 1
secrets:
  - id: cf-access
    name: CF_ACCESS_CLIENT_ID
    stage: production
    service: cloudflare
    expiry: none
    notes: ${NOTES}
    places: [{ repo: web, scope: environment, environment: production }]
  - id: revenuecat
    name: REVENUECAT_API_KEY
    stage: production
    service: revenuecat
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
variables:
  - id: v-url
    name: SUPABASE_URL
    stage: production
    value: "https://abcdefghijklmnopqrst.supabase.co"
    places: [{ repo: web, scope: environment, environment: production }]
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-cli-normalize-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  const config = join(dir, "secret-desk.config.yaml");
  await writeFile(config, "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_TEST_NO_SUCH_VAR } }\n");
  const out: string[] = [];
  const err: string[] = [];
  return { dir, config, out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("inventory normalize", () => {
  it("prints the plan grouped by kind, names only, and writes nothing", async () => {
    const t = await setup();
    expect(await main(["inventory", "normalize", "--config", t.config], t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("Umbenennen (1)");
    expect(text).toContain("CF_ACCESS_CLIENT_ID -> CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(text).toContain("Workflow anpassen");
    expect(text).toContain("Bleibt von Hand (2)");
    expect(text).toContain("Automatisch beziehen");
    expect(text).not.toContain(NOTES);
    expect(text).not.toContain("abcdefghijklmnopqrst.supabase.co");
    expect(await readFile(join(t.dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });

  it("--apply all --yes applies the unambiguous changes", async () => {
    const t = await setup();
    expect(await main(["inventory", "normalize", "--config", t.config, "--apply", "all", "--yes"], t.io)).toBe(0);
    const file = await readFile(join(t.dir, "inventory.yaml"), "utf8");
    expect(file).toContain("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(file).toContain("kind: supabase.project");
    expect(file).toContain("REVENUECAT_API_KEY");
    expect(t.out.join("\n")).toContain("GitHub wurde nicht angefasst");
    expect(t.out.join("\n")).not.toContain(NOTES);
    expect(t.err).toEqual([]);
  });

  it("--apply with an id applies only that change; an unknown id is an error and changes nothing", async () => {
    const t = await setup();
    expect(await main(["inventory", "normalize", "--config", t.config, "--apply", "rename:secret:nope", "--yes"], t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("Unbekannte Aenderung");
    expect(await readFile(join(t.dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
    expect(await main(["inventory", "normalize", "--config", t.config, "--apply", "rename:secret:cf-access", "--yes"], t.io)).toBe(0);
    const file = await readFile(join(t.dir, "inventory.yaml"), "utf8");
    expect(file).toContain("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(file).not.toContain("kind: supabase.project");
  });

  it("needs --config and a known subcommand", async () => {
    const t = await setup();
    expect(await main(["inventory", "normalize"], t.io)).toBe(2);
    expect(await main(["inventory"], t.io)).toBe(2);
  });
});
