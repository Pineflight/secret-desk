import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime, exportEnvContent } from "../src/index.js";

const INVENTORY = `version: 1
secrets:
  - { id: none-dev, name: NONE_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: maybe-dev, name: MAYBE_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: ref-dev, name: REF_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: cmd-dev, name: CMD_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: dup-dev, name: DUP_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
variables:
  - { id: v-empty, name: EMPTY_VAR, stage: dev, places: [{ repo: acme-docs, scope: repository }] }
envTemplates:
  - id: acme-app-dev-a
    repo: acme-app
    stage: dev
    entries:
      - { key: NONE_KEY, from: { type: variable, variable: v-empty } }
      - { key: MAYBE_KEY, from: { type: prompt, optional: true } }
      - { key: REF_KEY, from: { type: ref, template: other-template, key: OTHER } }
      - { key: CMD_KEY, from: { type: command, command: supabase-status, key: API_URL } }
      - { key: DUP_KEY, from: { type: default, value: first } }
  - id: acme-app-dev-b
    repo: acme-app
    stage: dev
    entries:
      - { key: DUP_KEY, from: { type: default, value: second } }
      - { key: OTHER, from: { type: default, value: other } }
  - id: other-template
    repo: acme-docs
    stage: dev
    entries:
      - { key: OTHER, from: { type: default, value: x } }
`;

describe("exportEnvContent: template sources without a value", () => {
  it("explains why a dev secret has no value for every source type, and the first template wins a shared key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-gaps-"));
    await writeFile(join(dir, "inventory.yaml"), INVENTORY);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "x" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
    const r = exportEnvContent(rt, { kind: "human", name: "alice" }, { repo: "acme-app", stage: "dev", include: "all", now: new Date("2026-11-05T10:00:00Z") });
    const reason = (name: string) => r.missing.find((m) => m.name === name)?.reason;
    expect(reason("NONE_KEY")).toBe("variable v-empty has no target value");
    expect(reason("MAYBE_KEY")).toBe("optional, needs a value from a human");
    expect(reason("REF_KEY")).toBe("value of OTHER in template other-template, filled by the template export");
    expect(reason("CMD_KEY")).toBe("read from supabase-status by the CLI template export on the developer machine");
    expect(r.content).toContain("DUP_KEY=first");
    expect(r.content).not.toContain("second");
  });
});
