import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionStore,
  EnvExportError,
  InventoryStore,
  ProviderRegistry,
  SecretValue,
  buildEnvFile,
  generateValue,
  parseEnvText,
  revokeIssuedTokens,
  runEnvCommand,
  supabaseStartCommand,
  writeEnvFile,
} from "../src/index.js";
import type { EnvTemplate, Provider } from "../src/index.js";

const tmp = (prefix = "env") => mkdtemp(join(tmpdir(), `sd-cov-${prefix}-`));
afterEach(() => vi.unstubAllEnvs());

describe("generateValue", () => {
  it("gives uuid, hex, base64 and base64url", () => {
    expect(generateValue("uuid", 0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateValue("hex", 8)).toMatch(/^[0-9a-f]{16}$/);
    expect(generateValue("base64url", 12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(generateValue("base64", 12)).toMatch(/^[A-Za-z0-9+/]{16}$/);
  });
});

describe("parseEnvText", () => {
  it("handles a comment as the last line, escapes in double quotes and unterminated quotes", () => {
    expect(parseEnvText("A=1\n# last comment").get("A")).toBe("1");
    expect([...parseEnvText("# only a comment")]).toEqual([]);
    expect(parseEnvText('A="line1\\nline2\\"x"\n').get("A")).toBe('line1\nline2"x');
    expect(parseEnvText('B="never closed').has("B")).toBe(false);
    expect(parseEnvText("B='never closed\nC=2\n").get("C")).toBe("2");
    expect(parseEnvText('B="never closed\n').has("B")).toBe(false);
  });
  it("an unquoted value on the last line (no newline), with and without a trailing comment", () => {
    expect(parseEnvText("A=plain").get("A")).toBe("plain");
    expect(parseEnvText("A=plain # comment").get("A")).toBe("plain");
    expect(parseEnvText("export A='quoted'").get("A")).toBe("quoted");
  });
});

describe("local stack helpers", () => {
  it("supabaseStartCommand uses yarn when there is a yarn.lock and a package.json without scripts", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "yarn.lock"), "");
    await writeFile(join(dir, "package.json"), "{}");
    expect(supabaseStartCommand(dir)).toBe("supabase start");
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", ".bin", "supabase"), "");
    expect(supabaseStartCommand(dir)).toBe("yarn exec supabase start");
  });

  it("runEnvCommand names a missing program", async () => {
    vi.stubEnv("PATH", await tmp("empty"));
    await expect(runEnvCommand("supabase-status", await tmp())).rejects.toThrow('Programm "supabase" nicht gefunden');
  });

  it.skipIf(process.platform === "win32")("runEnvCommand reports a command that times out without an exit code", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", ".bin", "supabase"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    await expect(runEnvCommand("supabase-status", dir, { timeoutMs: 100 })).rejects.toThrow("Exit-Code unbekannt");
  });

  it.skipIf(process.platform === "win32")("runEnvCommand parses the output of the repository's own binary", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", ".bin", "supabase"), "#!/bin/sh\necho API_URL=http://127.0.0.1:54321\n", { mode: 0o755 });
    expect((await runEnvCommand("supabase-status", dir)).get("API_URL")).toBe("http://127.0.0.1:54321");
  });
});

function world(yaml: string, provider?: Partial<Provider>) {
  const inventory = InventoryStore.fromText(`version: 1\n${yaml}`);
  const issue = vi.fn(async () => ({ value: new SecretValue("made-up-dev-token"), externalId: "ext-1" }));
  const revoke = vi.fn(async () => undefined);
  const registry = new ProviderRegistry().register({ id: "issuer", label: "Issuer", kind: "automatic", issue, revoke, ...provider });
  return { inventory, issue, revoke, deps: { inventory, providers: registry, connections: new ConnectionStore() } };
}
const SECRET = "  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: issuer, expiry: none }\n";
const tpl = (id: string, entries: string, stage = "dev") => `  - { id: ${id}, repo: ${id}, stage: ${stage}, entries: [${entries}] }\n`;
const template = (inventory: InventoryStore, id: string): EnvTemplate => inventory.data.envTemplates.find((t) => t.id === id)!;

describe("revokeIssuedTokens", () => {
  it("names tokens that cannot be revoked: unknown secret, no id, no revoke at the provider, a refusing provider", async () => {
    const { deps } = world(`secrets:\n${SECRET}  - { id: manual-one, name: MANUAL_ONE, stage: dev, service: x, provider: manual, expiry: none }\n`, { revoke: async () => { throw new Error("no"); } });
    const failed = await revokeIssuedTokens([{ secretId: "gone" }, { secretId: "dev-token" }, { secretId: "manual-one", externalId: "e1" }, { secretId: "dev-token", externalId: "e2" }], deps);
    expect(failed).toEqual(["gone (ohne Kennung)", "dev-token (ohne Kennung)", "manual-one (e1)", "dev-token (e2)"]);
  });

  it("revokes through the provider with the provider configuration, and the global fetch by default", async () => {
    const { deps, revoke } = world(`secrets:\n${SECRET}`);
    expect(await revokeIssuedTokens([{ secretId: "dev-token", externalId: "e1" }], { ...deps, providerConfig: { grafana: { allowedHosts: [] } } })).toEqual([]);
    expect(revoke.mock.calls[0]![0]).toMatchObject({ externalId: "e1", providerConfig: { grafana: { allowedHosts: [] } }, fetch });
  });
});

describe("buildEnvFile checks before it issues anything", () => {
  const build = (yaml: string, id: string, extra: object = {}) => {
    const w = world(yaml);
    return { ...w, run: () => buildEnvFile(template(w.inventory, id), { ...w.deps, ...extra }) };
  };

  it("a variable entry needs a variable with a target value", async () => {
    await expect(build(`variables:\n  - { id: v1, name: V_ONE, stage: dev, places: [{ repo: web, scope: repository }] }\nenvTemplates:\n${tpl("t", "{ key: A, from: { type: variable, variable: v1 } }")}`, "t").run()).rejects.toThrow("Variable v1 hat keinen Sollwert");
  });
  it("a variable entry writes the target value", async () => {
    const r = await build(`variables:\n  - { id: v1, name: V_ONE, stage: dev, value: "http://localhost", places: [{ repo: web, scope: repository }] }\nenvTemplates:\n${tpl("t", "{ key: A, from: { type: variable, variable: v1 } }")}`, "t").run();
    expect(r.text).toContain("A=http://localhost");
  });
  it("an issue entry needs a known secret on an allowed stage with a provider that can issue", async () => {
    const t = (secret: string) => `secrets:\n${SECRET}envTemplates:\n${tpl("t", `{ key: A, from: { type: issue, secret: ${secret} } }`)}`;
    // The schema rejects an unknown secret, so that check is only reachable for a template edited in memory.
    const w = world(`secrets:\n${SECRET}`);
    const edited = { id: "t", repo: "t", stage: "dev", entries: [{ key: "A", from: { type: "issue", secret: "nope" } }] } as unknown as EnvTemplate;
    await expect(buildEnvFile(edited, w.deps)).rejects.toThrow("Unbekanntes Secret: nope");
    await expect(build(t("dev-token"), "t", { allowedIssueStages: ["staging"] }).run()).rejects.toThrow("Die Stage dev darf hier nicht ausgestellt werden");
    const manual = `secrets:\n  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: manual, expiry: none }\nenvTemplates:\n${tpl("t", "{ key: A, from: { type: issue, secret: dev-token } }")}`;
    await expect(build(manual, "t").run()).rejects.toThrow('kann keinen Dev-Wert erzeugen');
  });
  it("an issue entry on an allowed stage is issued, with the provider configuration and the global fetch", async () => {
    const b = build(`secrets:\n${SECRET}envTemplates:\n${tpl("t", "{ key: A, from: { type: issue, secret: dev-token } }")}`, "t", { allowedIssueStages: ["dev"], providerConfig: { grafana: { allowedHosts: [] } } });
    const r = await b.run();
    expect(r.issuedTokens).toEqual([{ secretId: "dev-token", externalId: "ext-1" }]);
    expect((b.issue.mock.calls[0] as unknown as [{ providerConfig: unknown; fetch: unknown }])[0]).toMatchObject({ providerConfig: { grafana: { allowedHosts: [] } }, fetch });
  });
  it("an issued token without an external id is recorded without one", async () => {
    const w = world(`secrets:\n${SECRET}envTemplates:\n${tpl("t", "{ key: A, from: { type: issue, secret: dev-token } }")}`, { issue: async () => ({ value: new SecretValue("v") }) });
    expect((await buildEnvFile(template(w.inventory, "t"), w.deps)).issuedTokens).toEqual([{ secretId: "dev-token" }]);
  });

  describe("ref entries", () => {
    const REF = `envTemplates:\n${tpl("src", "{ key: TOKEN, from: { type: default, value: abc } }")}${tpl("t", "{ key: A, from: { type: ref, template: src, key: TOKEN } }")}`;
    it("take the value an earlier template of the run produced", async () => {
      const w = world(REF);
      const runValues = new Map([["src:TOKEN", "from-run"]]);
      expect((await buildEnvFile(template(w.inventory, "t"), { ...w.deps, runValues })).text).toContain("A=from-run");
    });
    it("fail when the run knows the template but not the key", async () => {
      const w = world(REF);
      const runValues = new Map([["src:", ""]]);
      await expect(buildEnvFile(template(w.inventory, "t"), { ...w.deps, runValues })).rejects.toThrow("Kein Wert fuer TOKEN aus der Vorlage src");
    });
    it("read the file of the referenced template, once per template, when the run has no value", async () => {
      const w = world(`envTemplates:\n${tpl("src", "{ key: TOKEN, from: { type: default, value: abc } }")}${tpl("t", "{ key: A, from: { type: ref, template: src, key: TOKEN } }, { key: B, from: { type: ref, template: src, key: TOKEN } }")}`);
      const readTemplateFile = vi.fn(async () => "TOKEN=from-file\n");
      const r = await buildEnvFile(template(w.inventory, "t"), { ...w.deps, readTemplateFile });
      expect(r.text).toContain("A=from-file");
      expect(r.text).toContain("B=from-file");
      expect(readTemplateFile).toHaveBeenCalledTimes(1);
    });
    it("fail for a referenced template without a file, or without a way to read files, or an unknown template", async () => {
      const w = world(REF);
      await expect(buildEnvFile(template(w.inventory, "t"), { ...w.deps, readTemplateFile: async () => null })).rejects.toThrow("Kein Wert fuer TOKEN");
      await expect(buildEnvFile(template(w.inventory, "t"), w.deps)).rejects.toThrow("Kein Wert fuer TOKEN");
      // The schema rejects an unknown reference, so the check is only reachable for a template edited in memory.
      const edited = { id: "t", repo: "t", stage: "dev", entries: [{ key: "A", from: { type: "ref", template: "nowhere", key: "TOKEN" } }] } as unknown as EnvTemplate;
      await expect(buildEnvFile(edited, w.deps)).rejects.toThrow("unbekannte Vorlage nowhere");
    });
  });

  describe("command entries", () => {
    const CMD = (optional: boolean) => `envTemplates:\n${tpl("t", `{ key: A, from: { type: command, command: supabase-status, key: ANON_KEY${optional ? ", optional: true" : ""} } }`)}`;
    it("are written as a commented line without a runner; with a runner the value comes from its output", async () => {
      const w = world(CMD(false));
      const without = await buildEnvFile(template(w.inventory, "t"), w.deps);
      expect(without.text).toContain("# A= (filled by the CLI from supabase-status)");
      const withRunner = await buildEnvFile(template(w.inventory, "t"), { ...w.deps, runCommand: async () => new Map([["ANON_KEY", "made-up-anon"]]) });
      expect(withRunner.text).toContain("A=made-up-anon");
    });
    it("a required command that fails or lacks the key is an error; an optional one is skipped", async () => {
      const w = world(CMD(false));
      await expect(buildEnvFile(template(w.inventory, "t"), { ...w.deps, runCommand: async () => { throw new EnvExportError("stack down"); } })).rejects.toThrow("stack down");
      await expect(buildEnvFile(template(w.inventory, "t"), { ...w.deps, runCommand: async () => new Map() })).rejects.toThrow("liefert keinen Wert fuer ANON_KEY");
      const o = world(CMD(true));
      const failing = await buildEnvFile(template(o.inventory, "t"), { ...o.deps, runCommand: async () => { throw new Error("stack down"); } });
      expect(failing.text).toContain("# A= (optional, not reported by supabase-status)");
      expect(failing.skipped).toEqual(["A"]);
      const empty = await buildEnvFile(template(o.inventory, "t"), { ...o.deps, runCommand: async () => new Map([["ANON_KEY", ""]]) });
      expect(empty.skipped).toEqual(["A"]);
    });
    it("two entries share one run of the command", async () => {
      const w = world(`envTemplates:\n${tpl("t", "{ key: A, from: { type: command, command: supabase-status, key: ONE } }, { key: B, from: { type: command, command: supabase-status, key: TWO } }")}`);
      const runCommand = vi.fn(async () => new Map([["ONE", "1"], ["TWO", "2"]]));
      await buildEnvFile(template(w.inventory, "t"), { ...w.deps, runCommand });
      expect(runCommand).toHaveBeenCalledTimes(1);
    });
  });

});

describe("buildEnvFile failure after a token was issued", () => {
  const TWO = "{ key: A, from: { type: issue, secret: dev-token } }, { key: B, from: { type: issue, secret: dev-token } }";
  const failSecond = (w: ReturnType<typeof world>, error: unknown) => w.issue.mockResolvedValueOnce({ value: new SecretValue("first"), externalId: "ext-1" }).mockRejectedValueOnce(error);

  it("revokes what was issued; what cannot be revoked is appended to the error", async () => {
    const w = world(`secrets:\n${SECRET}envTemplates:\n${tpl("t", TWO)}`, { revoke: async () => { throw new Error("no"); } });
    failSecond(w, new Error("provider down"));
    await expect(buildEnvFile(template(w.inventory, "t"), w.deps)).rejects.toThrow(/provider down Nicht widerrufen \(beim Anbieter von Hand entfernen\): dev-token \(ext-1\)\./);
  });

  it("revokes quietly when everything can be revoked", async () => {
    const w = world(`secrets:\n${SECRET}envTemplates:\n${tpl("t", TWO)}`);
    failSecond(w, new Error("provider down"));
    const err = await buildEnvFile(template(w.inventory, "t"), w.deps).catch((e: Error) => e);
    expect((err as Error).message).toBe("provider down");
    expect(w.revoke).toHaveBeenCalledTimes(1);
  });

  it("passes on a thrown value that is not an Error", async () => {
    const w = world(`secrets:\n${SECRET}envTemplates:\n${tpl("t", TWO)}`, { revoke: async () => { throw new Error("no"); } });
    failSecond(w, "plain");
    await expect(buildEnvFile(template(w.inventory, "t"), w.deps)).rejects.toBe("plain");
  });
});

describe("writeEnvFile", () => {
  it.skipIf(process.platform === "win32")("reports whether Git ignores the file: ignored, not ignored, not a repository", async () => {
    const repo = await tmp("repo");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, ".gitignore"), ".env.ignored\n");
    expect((await writeEnvFile(join(repo, ".env.ignored"), "A=1\n")).gitIgnored).toBe(true);
    expect((await writeEnvFile(join(repo, ".env.visible"), "A=1\n")).gitIgnored).toBe(false);
    expect((await writeEnvFile(join(await tmp("plain"), ".env"), "A=1\n")).gitIgnored).toBeNull();
  });

  it("an empty list of allowed roots means no restriction; a target outside the roots is refused", async () => {
    const dir = await tmp();
    await writeEnvFile(join(dir, ".env"), "A=1\n", { allowedRoots: [] });
    await expect(writeEnvFile(join(dir, ".env.two"), "A=1\n", { allowedRoots: [await tmp("other")] })).rejects.toThrow("ausserhalb der erlaubten Ordner");
    await expect(writeEnvFile(join(dir, ".env"), "A=2\n")).rejects.toThrow("Datei existiert schon");
    await writeEnvFile(join(dir, ".env"), "A=2\n", { overwrite: true, allowedRoots: [dir] });
  });
});
