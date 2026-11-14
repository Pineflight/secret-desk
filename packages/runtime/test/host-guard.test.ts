import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire, like the portable-modules guard of the core: it catches the usual ways a runtime source file can reach the process
// environment, the home folder or a process by itself. Everything the runtime needs from the machine goes through the host
// capability (`RuntimeHost`, see host.ts); only the host module may touch the machine directly. The behavioural test in
// `host-capability.test.ts` (a runtime without a host, environment replaced by a recording proxy, starters mocked to throw) is
// the proof; this scan only keeps new code from walking around it. It is a tripwire against accidental reach, not a sandbox: it
// reads text, so it cannot see a name built at run time, a regular expression literal that looks like a comment opener, or what
// a called function does. A determined caller defeats it; the behavioural test is what shows that nothing is reached.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// `host-core.ts` is the interface of the host without any Node API: it names host members (`findChrome`, `gitCheckIgnored`) that the
// scanner would flag, although a name in a type declaration reaches nothing. `portable-modules.test.ts` guards that file instead
// (no Node built-in, no `process`, no `Buffer`), as part of the portable entry.
const HOST_MODULES = ["host.ts", "host-core.ts"];

async function sourceFiles(dir = SRC): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Removes comments but keeps string and template contents (the specifier checks need them). A small scanner that tracks quote
 * state, so a comment opener inside a string (`"/*"`, `"//"`) neither starts a comment nor hides the code after it. A quote
 * inside a regular expression literal is not understood; single and double quoted strings end at a line break, so such a
 * misreading cannot carry over more than one line.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " "); // keep line breaks, so line-based patterns still see the right lines
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The checks: a name per kind of reach and the pattern that finds it (applied to the text without comments). */
const CHECKS: [string, RegExp][] = (() => {
  const checks: [string, RegExp][] = [
    ["process.env", /\bprocess\s*\.\s*env\b/],
    ["process[...]", /\bprocess\s*\[/],
    ["process.binding / getBuiltinModule", /\bprocess\s*\.\s*(binding|_linkedBinding|dlopen|getBuiltinModule|mainModule)\b|\bgetBuiltinModule\b/],
    ["globalThis.process / global.process", /\b(globalThis|global)\s*(\.\s*process\b|\[)/],
    ["aliased process", /=\s*process\s*[;,)\n]/],
    ["Bun / Deno", /\b(Bun|Deno)\s*[.[]/],
    ["node:process", /["'`](node:)?process["'`]/],
    ["node:os", /["'`](node:)?os["'`]/],
    ["homedir", /\bhomedir\b/],
    ["node:module / createRequire", /["'`](node:)?module["'`]|\bcreateRequire\b/],
    ["child_process", /["'`](node:)?child_process["'`]/],
    ["execFile / spawn / fork", /\b(execFile|execFileSync|spawn|spawnSync|fork|execSync)\s*\(/],
    ["Worker / cluster", /["'`](node:)?(worker_threads|cluster)["'`]/],
    // Names that belong to the host: they read the environment, look at the machine or start something.
    ["new SecretVault", /\bnew\s+SecretVault\b/],
    ["defaultKeySource", /\b(defaultKeySource|envKeySource|secretToolKeySource)\b/],
    ["PlaywrightDriver", /\bPlaywrightDriver\b/],
    ["findChrome / chromeInstallHint / chromeCandidates", /(?<![.\w])(findChrome|chromeInstallHint|chromeCandidates)\b/], // a member of the host (`host.findChrome(...)`) is the allowed way
  ];
  return checks.map(([name, re]) => [name, new RegExp(re.source, "g")] as [string, RegExp]);
})();

/** How often each kind of reach occurs in a source text (comments excluded). Only kinds that occur are listed. */
export function hostFindingCounts(source: string): Record<string, number> {
  const code = stripComments(source);
  const counts: Record<string, number> = {};
  for (const [name, re] of CHECKS) {
    const n = [...code.matchAll(re)].length;
    if (n > 0) counts[name] = n;
  }
  return counts;
}

/** What a source file may not contain unless it is a host module. Returns one finding per kind, empty when clean. */
export function hostFindings(source: string): string[] {
  return Object.keys(hostFindingCounts(source));
}

/**
 * The other library packages are scanned with the same checks. A file there may reach the machine only when it is named here
 * with the exact number of occurrences of each kind of reach it is allowed and a one-line reason. Nothing is allowed by a
 * pattern: a new file, a new kind of finding or one more occurrence in a listed file fails the test until the entry is changed
 * deliberately (or, better, the new code goes through the host capability).
 * `providers` has no entry: it makes outbound requests through the injected `fetch` only.
 */
const PACKAGE_ALLOW_LIST: Record<string, { counts: Record<string, number>; reason: string }> = {
  "core/connections.ts": { counts: { "process.env": 1, child_process: 1, "execFile / spawn / fork": 1 }, reason: "Node facade of the connection store: the local edition's default host (process environment, `op read`)." },
  "core/env-export.ts": { counts: { "process.env": 1, child_process: 1, "execFile / spawn / fork": 2 }, reason: "Node implementation of the allow-listed template commands (`runEnvCommand`) and the git ignore check, reached only through the Node host." },
  "core/platform.ts": { counts: { "node:os": 1, homedir: 2 }, reason: "Operating-system helpers of the Node facades (`expandHome` defaults to the home folder of the process)." },
  "core/vault.ts": { counts: { "process.env": 3, "node:os": 1, homedir: 2, child_process: 1, "execFile / spawn / fork": 1, defaultKeySource: 7 }, reason: "Node vault: default vault file in the home folder and the OS key stores (Keychain, secret-tool, DPAPI); defines `defaultKeySource`." },
  "automation/cdp.ts": { counts: { "process.env": 1 }, reason: "`cdpEndpointFrom` defaults its `env` parameter to the process environment for the CLI; the runtime always passes its host's environment." },
  "automation/chrome.ts": { counts: { "process.env": 1, "findChrome / chromeInstallHint / chromeCandidates": 4 }, reason: "Defines the local Chrome lookup (platform and environment defaults); the runtime reaches it only through the Node host." },
  "automation/playwright-driver.ts": { counts: { "node:os": 1, homedir: 2, PlaywrightDriver: 1, "findChrome / chromeInstallHint / chromeCandidates": 2 }, reason: "Defines the local Playwright driver: default profile folder in the home folder and the Chrome lookup; the runtime reaches it only through the Node host." },
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
        for (const [finding, count] of Object.entries(hostFindingCounts(await readFile(file, "utf8")))) {
          const allowedCount = allowed?.counts[finding] ?? 0;
          if (count > allowedCount) offenders.push(`${name}: ${finding} x${count} (allowed ${allowedCount})`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // An entry that no longer matches a file, or allows a finding the file no longer has, is removed: the list stays narrow.
    expect([...seen].sort()).toEqual(Object.keys(PACKAGE_ALLOW_LIST).sort());
  });

  it("every allow-list entry is exact: the counts match the file, no more and no fewer, and it has a reason", async () => {
    for (const [name, entry] of Object.entries(PACKAGE_ALLOW_LIST)) {
      const [pkg, ...rest] = name.split("/");
      const text = await readFile(fileURLToPath(new URL(`../../${pkg}/src/${rest.join("/")}`, import.meta.url)), "utf8");
      expect(hostFindingCounts(text), name).toEqual(entry.counts);
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
    expect(hostFindings("const ok = 1; // process.env at the end of a line\n")).toEqual([]);
  });

  it("a comment opener inside a string does not hide the code after it", () => {
    expect(hostFindings('const a = "/*"; const b = process.env.X; const c = "*/";')).toEqual(["process.env"]);
    expect(hostFindings("const a = '//'; const b = process.env.X;")).toEqual(["process.env"]);
    expect(hostFindings("const a = `/*`;\nconst b = process.env.X;\nconst c = `*/`;")).toEqual(["process.env"]);
    expect(hostFindings('const a = "a\\"/*"; const b = process.env.X;')).toEqual(["process.env"]);
    // A real comment after a string is still a comment, and a string inside a comment is not scanned as a string.
    expect(hostFindings('const a = "x"; // process.env "\nconst b = 1;')).toEqual([]);
    expect(hostFindings("/* it's a comment */ const b = process.env.X;")).toEqual(["process.env"]);
    expect(hostFindings("/* open and never closed process.env")).toEqual([]);
    // An unterminated quote ends at the line break.
    expect(hostFindings("const a = 'broken;\nconst b = process.env.X;")).toEqual(["process.env"]);
  });

  it("finds specifiers written as template literals and counts every occurrence", () => {
    expect(hostFindings("const m = await import(`node:os`);")).toEqual(["node:os"]);
    expect(hostFindings("const m = await import(`child_process`);")).toEqual(["child_process"]);
    expect(hostFindings("const m = await import(`node:module`);")).toEqual(["node:module / createRequire"]);
    expect(hostFindings("const m = await import(`node:worker_threads`);")).toEqual(["Worker / cluster"]);
    expect(hostFindings("const m = await import(`node:process`);")).toEqual(["node:process"]);
    expect(hostFindingCounts("const a = process.env.A; const b = process.env.B;\n// process.env.C\nconst c = process.env.D;")).toEqual({ "process.env": 3 });
    expect(hostFindingCounts("const ok = 1;")).toEqual({});
    expect(hostFindings("const ok = rt.host?.env?.('X'); const p = processName; type V = SecretVault;")).toEqual([]);
  });

  it("the file filter covers the module and JSX spellings and skips declaration files", async () => {
    const names = (await sourceFiles()).map((f) => f.slice(SRC.length));
    expect(names).toContain("host.ts");
    expect(names.some((n) => n.endsWith(".d.ts"))).toBe(false);
  });
});
