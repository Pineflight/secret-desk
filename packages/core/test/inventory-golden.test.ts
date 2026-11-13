import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InventoryStore } from "../src/inventory.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Unusual ordering (templates before secrets, version last) and comments in several places.
const BEFORE = `# Top comment stays on top
envTemplates:
  # template comment
  - id: web-dev
    repo: web
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } } # inline comment
thresholds: [ 30, 14, 7 ]
secrets:
  # first secret
  - id: alpha-token
    name: ALPHA_TOKEN
    stage: dev
    service: intern
    provider: manual
    expiry: none # never expires
    places:
      - { repo: web, scope: repository }

  # second secret, after a blank line
  - id: beta-token
    name: BETA_TOKEN
    stage: dev
    service: intern
    provider: manual
    expiry: none
    places:
      - { repo: web, scope: repository }
version: 1 # last on purpose
`;

describe("the stored text after a change (golden)", () => {
  it("keeps comments, order and blank lines and only adds the changed field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-golden-"));
    dirs.push(dir);
    const file = join(dir, "inventory.yaml");
    await writeFile(file, BEFORE);
    const store = await InventoryStore.open(file);
    store.patchSecret("beta-token", { notes: "checked by hand" });
    await store.save();
    const expected = BEFORE.replace("    expiry: none\n    places:\n      - { repo: web, scope: repository }\nversion:", "    expiry: none\n    places:\n      - { repo: web, scope: repository }\n    notes: checked by hand\nversion:");
    expect(expected).not.toBe(BEFORE);
    expect(await readFile(file, "utf8")).toBe(expected);
  });

  it("an unchanged store writes nothing and leaves the bytes as they were", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-golden-"));
    dirs.push(dir);
    const file = join(dir, "inventory.yaml");
    await writeFile(file, BEFORE);
    const store = await InventoryStore.open(file);
    await store.save();
    expect(await readFile(file, "utf8")).toBe(BEFORE);
    expect(store.toString()).toBe(BEFORE);
  });
});
