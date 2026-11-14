import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire, like the portable-modules guard of the core: it catches the usual ways a runtime source file can reach the process
// environment, the home folder or a process by itself. Everything the runtime needs from the machine goes through the host
// capability (`RuntimeHost`, see host.ts); only the host module may touch the machine directly. The behavioural test in
// `host-capability.test.ts` (a runtime without a host, environment replaced by a recording proxy, starters mocked to throw) is
// the proof; this scan only keeps new code from walking around it.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HOST_MODULES = ["host.ts"];

async function sourceFiles(dir = SRC): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** What a source file may not contain unless it is a host module. Returns one finding per kind, empty when clean. */
export function hostFindings(source: string): string[] {
  const code = stripComments(source);
  const checks: [string, RegExp][] = [
    ["process.env", /\bprocess\s*\.\s*env\b/],
    ["process[...]", /\bprocess\s*\[/],
    ["process.binding / getBuiltinModule", /\bprocess\s*\.\s*(binding|_linkedBinding|dlopen|getBuiltinModule|mainModule)\b|\bgetBuiltinModule\b/],
    ["globalThis.process / global.process", /\b(globalThis|global)\s*(\.\s*process\b|\[)/],
    ["aliased process", /=\s*process\s*[;,)\n]/],
    ["Bun / Deno", /\b(Bun|Deno)\s*[.[]/],
    ["node:process", /["'](node:)?process["']/],
    ["node:os", /["'](node:)?os["']/],
    ["homedir", /\bhomedir\b/],
    ["node:module / createRequire", /["'](node:)?module["']|\bcreateRequire\b/],
    ["child_process", /["'](node:)?child_process["']/],
    ["execFile / spawn / fork", /\b(execFile|execFileSync|spawn|spawnSync|fork|execSync)\s*\(/],
    ["Worker / cluster", /["'](node:)?(worker_threads|cluster)["']/],
    // Names that belong to the host: they read the environment, look at the machine or start something.
    ["new SecretVault", /\bnew\s+SecretVault\b/],
    ["defaultKeySource", /\b(defaultKeySource|envKeySource|secretToolKeySource)\b/],
    ["PlaywrightDriver", /\bPlaywrightDriver\b/],
    ["findChrome / chromeInstallHint / chromeCandidates", /(?<![.\w])(findChrome|chromeInstallHint|chromeCandidates)\b/], // a member of the host (`host.findChrome(...)`) is the allowed way
  ];
  return checks.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/**
 * The other library packages are scanned with the same checks. A file there may reach the machine only when it is named here
 * with the exact findings it is allowed and a one-line reason. Nothing is allowed by a pattern: a new file, or a new kind of
 * finding in a listed file, fails the test until it is listed with a reason (or, better, goes through the host capability).
 * `providers` has no entry: it makes outbound requests through the injected `fetch` only.
 */
const PACKAGE_ALLOW_LIST: Record<string, { findings: string[]; reason: string }> = {
  "core/connections.ts": { findings: ["process.env", "child_process", "execFile / spawn / fork"], reason: "Node facade of the connection store: the local edition's default host (process environment, `op read`)." },
  "core/env-export.ts": { findings: ["process.env", "child_process", "execFile / spawn / fork"], reason: "Node implementation of the allow-listed template commands (`runEnvCommand`) and the git ignore check, reached only through the Node host." },
  "core/platform.ts": { findings: ["node:os", "homedir"], reason: "Operating-system helpers of the Node facades (`expandHome` defaults to the home folder of the process)." },
  "core/vault.ts": { findings: ["process.env", "node:os", "homedir", "child_process", "execFile / spawn / fork", "defaultKeySource"], reason: "Node vault: default vault file in the home folder and the OS key stores (Keychain, secret-tool, DPAPI); defines `defaultKeySource`." },
  "automation/cdp.ts": { findings: ["process.env"], reason: "`cdpEndpointFrom` defaults its `env` parameter to the process environment for the CLI; the runtime always passes its host's environment." },
  "automation/chrome.ts": { findings: ["process.env", "findChrome / chromeInstallHint / chromeCandidates"], reason: "Defines the local Chrome lookup (platform and environment defaults); the runtime reaches it only through the Node host." },
  "automation/playwright-driver.ts": { findings: ["node:os", "homedir", "PlaywrightDriver", "findChrome / chromeInstallHint / chromeCandidates"], reason: "Defines the local Playwright driver: default profile folder in the home folder and the Chrome lookup; the runtime reaches it only through the Node host." },
};
const SCANNED_PACKAGES = ["core", "automation", "providers"];

describe("the other library packages reach the machine only where they are named", () => {
  it("every finding in core, automation and providers is covered by a named allow-list entry", async () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const pkg of SCANNED_PACKAGES) {
      const root = fileURLToPath(new URL(`../../${pkg}/src/`, import.meta.url));
      const files = await sourceFiles(root);
      expect(files.length).toBeGreaterThan(5);
      for (const file of files) {
        const name = `${pkg}/${file.slice(root.length)}`;
        const allowed = PACKAGE_ALLOW_LIST[name];
        if (allowed) seen.add(name);
        for (const finding of hostFindings(await readFile(file, "utf8"))) {
          if (!allowed?.findings.includes(finding)) offenders.push(`${name}: ${finding}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // An entry that no longer matches a file, or allows a finding the file no longer has, is removed: the list stays narrow.
    expect([...seen].sort()).toEqual(Object.keys(PACKAGE_ALLOW_LIST).sort());
  });

  it("every allow-list entry is exact: it lists no finding the file does not have, and has a reason", async () => {
    for (const [name, entry] of Object.entries(PACKAGE_ALLOW_LIST)) {
      const [pkg, ...rest] = name.split("/");
      const text = await readFile(fileURLToPath(new URL(`../../${pkg}/src/${rest.join("/")}`, import.meta.url)), "utf8");
      expect(hostFindings(text).sort(), name).toEqual([...entry.findings].sort());
      expect(entry.reason.length, name).toBeGreaterThan(20);
      expect(entry.reason.includes("\n"), name).toBe(false);
    }
  });

  it("does not allow-list a file of the providers package or a pattern", () => {
    expect(Object.keys(PACKAGE_ALLOW_LIST).some((n) => n.startsWith("providers/"))).toBe(false);
    expect(Object.keys(PACKAGE_ALLOW_LIST).every((n) => /^[a-z]+\/[\w./-]+\.ts$/.test(n))).toBe(true);
  });
});

describe("the runtime reaches the machine only through the host module", () => {
  it("no source file outside the host modules reads the environment or the home folder, starts a process or uses a host-only name", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.slice(SRC.length);
      if (HOST_MODULES.includes(name)) continue;
      for (const finding of hostFindings(await readFile(file, "utf8"))) offenders.push(`${name}: ${finding}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the host module exists and is the one place that does it (so the guard is looking at the right file)", async () => {
    const host = await readFile(join(SRC, "host.ts"), "utf8");
    expect(hostFindings(host)).toEqual(expect.arrayContaining(["process.env", "child_process", "node:os", "homedir", "new SecretVault", "PlaywrightDriver", "findChrome / chromeInstallHint / chromeCandidates"]));
  });

  it("the scanner finds the usual spellings and ignores comments", () => {
    expect(hostFindings("const a = process.env.X;")).toEqual(["process.env"]);
    expect(hostFindings("const a = process . env['X'];")).toEqual(["process.env"]);
    expect(hostFindings("const a = process['env'];")).toEqual(["process[...]"]);
    expect(hostFindings("const a = process.binding('fs');")).toEqual(["process.binding / getBuiltinModule"]);
    expect(hostFindings("const a = process.getBuiltinModule('fs');")).toEqual(["process.binding / getBuiltinModule"]);
    expect(hostFindings("const a = globalThis.process;")).toEqual(["globalThis.process / global.process"]);
    expect(hostFindings("const a = globalThis['process'];")).toEqual(["globalThis.process / global.process", "node:process"]);
    expect(hostFindings("const p = process;\n")).toEqual(["aliased process"]);
    expect(hostFindings("const e = Bun.env; const d = Deno.env;")).toEqual(["Bun / Deno"]);
    expect(hostFindings('import { env } from "node:process";')).toEqual(["node:process"]);
    expect(hostFindings('import { homedir } from "node:os";')).toEqual(["node:os", "homedir"]);
    expect(hostFindings('import { createRequire } from "node:module";')).toEqual(["node:module / createRequire"]);
    expect(hostFindings('import { execFile } from "node:child_process";\nexecFile("git", []);')).toEqual(["child_process", "execFile / spawn / fork"]);
    expect(hostFindings('const m = await import("child_process");')).toEqual(["child_process"]);
    expect(hostFindings('import { Worker } from "node:worker_threads";')).toEqual(["Worker / cluster"]);
    expect(hostFindings("const v = new SecretVault({});")).toEqual(["new SecretVault"]);
    expect(hostFindings("const k = defaultKeySource(env);")).toEqual(["defaultKeySource"]);
    expect(hostFindings("new PlaywrightDriver({});")).toEqual(["PlaywrightDriver"]);
    expect(hostFindings("const p = findChrome(x); chromeInstallHint();")).toEqual(["findChrome / chromeInstallHint / chromeCandidates"]);
    expect(hostFindings("// process.env and child_process in a comment\n/* execFile( */\nconst ok = 1;")).toEqual([]);
    expect(hostFindings("const ok = rt.host?.env?.('X'); const p = processName; type V = SecretVault;")).toEqual([]);
  });

  it("the file filter covers the module and JSX spellings and skips declaration files", async () => {
    const names = (await sourceFiles()).map((f) => f.slice(SRC.length));
    expect(names).toContain("host.ts");
    expect(names.some((n) => n.endsWith(".d.ts"))).toBe(false);
  });
});
