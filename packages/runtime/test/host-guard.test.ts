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
