import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire, like the portable-modules guard of the core: it catches the usual ways a runtime source file can reach the process
// environment or start a process by itself. Everything the runtime needs from the machine goes through the host capability
// (`RuntimeHost`, see host.ts); only the host module may touch the process directly.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HOST_MODULES = ["host.ts"];

async function sourceFiles(dir = SRC): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** What a source file may not contain unless it is a host module. Returns one finding per match, empty when clean. */
export function hostFindings(source: string): string[] {
  const code = stripComments(source);
  const checks: [string, RegExp][] = [
    ["process.env", /\bprocess\s*\.\s*env\b/],
    ["process[...]", /\bprocess\s*\[/],
    ["globalThis.process / global.process", /\b(globalThis|global)\s*(\.\s*process\b|\[)/],
    ["destructured process", /=\s*process\s*[;,)\n]/],
    ["node:process", /["'](node:)?process["']/],
    ["child_process", /["'](node:)?child_process["']/],
    ["execFile / spawn / fork", /\b(execFile|execFileSync|spawn|spawnSync|fork|execSync)\s*\(/],
    ["Worker / cluster", /["'](node:)?(worker_threads|cluster)["']/],
  ];
  return checks.filter(([, re]) => re.test(code)).map(([name]) => name);
}

describe("the runtime reaches the machine only through the host module", () => {
  it("no source file outside the host modules reads the process environment or starts a process", async () => {
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
    expect(hostFindings(host)).toEqual(expect.arrayContaining(["process.env", "child_process"]));
  });

  it("the scanner finds the usual spellings and ignores comments", () => {
    expect(hostFindings("const a = process.env.X;")).toEqual(["process.env"]);
    expect(hostFindings("const a = process . env['X'];")).toEqual(["process.env"]);
    expect(hostFindings("const a = process['env'];")).toEqual(["process[...]"]);
    expect(hostFindings("const a = globalThis.process;")).toEqual(["globalThis.process / global.process"]);
    expect(hostFindings("const a = globalThis['process'];")).toEqual(["globalThis.process / global.process", "node:process"]);
    expect(hostFindings("const p = process;\n")).toEqual(["destructured process"]);
    expect(hostFindings('import { env } from "node:process";')).toEqual(["node:process"]);
    expect(hostFindings('import { execFile } from "node:child_process";\nexecFile("git", []);')).toEqual(["child_process", "execFile / spawn / fork"]);
    expect(hostFindings('const m = await import("child_process");')).toEqual(["child_process"]);
    expect(hostFindings('import { Worker } from "node:worker_threads";')).toEqual(["Worker / cluster"]);
    expect(hostFindings("// process.env and child_process in a comment\n/* execFile( */\nconst ok = 1;")).toEqual([]);
    expect(hostFindings("const ok = rt.host?.env?.('X'); const p = processName;")).toEqual([]);
  });
});
