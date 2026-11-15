import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, type Provider } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { nodeRuntimeHost } from "../src/host.js";
import { translateEn } from "../src/i18n-en.js";
import { createRuntime } from "../src/runtime.js";

// The same in-place secret in two templates of one run: the second export warns, the answer carries the sentence. Everything here is made up.
const INVENTORY = `version: 1
secrets:
  - { id: dev-issued, name: DEV_ISSUED, stage: dev, service: x, provider: made-up-issuer, expiry: none, externalId: same-id, places: [{ repo: acme-a, scope: repository }] }
envTemplates:
  - { id: tpl-a, repo: acme-a, stage: dev, file: .env.local, entries: [{ key: ISSUED, from: { type: issue, secret: dev-issued } }] }
  - { id: tpl-b, repo: acme-b, stage: dev, file: .env.local, entries: [{ key: ISSUED, from: { type: issue, secret: dev-issued } }] }
`;

describe("exportEnv: one run, two templates, the same in-place secret", () => {
  it("the second answer carries the warning, the first none", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-export-run-")));
    const projects = join(dir, "projects");
    await mkdir(projects);
    await writeFile(join(dir, "inventory.yaml"), INVENTORY);
    await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: {} }));
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
    const host = nodeRuntimeHost({ env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv });
    const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, host, bundledRecipes: null, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    let n = 0;
    rt.providers.register({ id: "made-up-issuer", label: "Made up issuer", kind: "automatic", replacesInPlace: true, issue: async () => ({ value: SecretValue.from(`made_up_value_${(n += 1)}_0123456789`), externalId: "same-id", replacedInPlace: true }) } as Provider);

    const human = { kind: "human", name: "alice" } as const;
    const runValues = new Map<string, string>();
    const first = await exportEnv(rt, human, { repo: "acme-a", path: join(projects, "a.env"), runValues });
    const second = await exportEnv(rt, human, { repo: "acme-b", path: join(projects, "b.env"), runValues });
    const SENTENCE = "Das Secret dev-issued wird in zwei Vorlagen desselben Laufs";
    expect((first as { warnings: string[] }).warnings.some((w) => w.startsWith(SENTENCE))).toBe(false);
    expect((second as { warnings: string[] }).warnings).toContain("Das Secret dev-issued wird in zwei Vorlagen desselben Laufs ausgestellt (tpl-a und tpl-b): der Anbieter ersetzt den Wert an Ort und Stelle, die Datei der ersten Vorlage haelt danach einen Wert, der nicht mehr gilt.");
    expect(n).toBe(2);
  });

  it("has an English catalogue entry", () => {
    expect(translateEn("Das Secret s wird in zwei Vorlagen desselben Laufs ausgestellt (a und b): der Anbieter ersetzt den Wert an Ort und Stelle, die Datei der ersten Vorlage haelt danach einen Wert, der nicht mehr gilt.")).toBe(
      "The secret s is issued in two templates of the same run (a and b): the provider replaces the value in place, so the file of the first template then holds a value that no longer works.",
    );
  });
});
