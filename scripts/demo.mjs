#!/usr/bin/env node
// Startet das Portal im Demo-Modus (simuliertes GitHub, erfundene Daten) auf jedem System.
// Ersetzt `SECRET_DESK_DEMO=1 SECRET_DESK_CONFIG=... pnpm dev`, das in PowerShell und cmd so nicht laeuft.
// Voraussetzung: `pnpm build` ist gelaufen.
//
// Usage:
//   pnpm demo           plain demo; on the setup page you can pick the simulated repository acme/team-config from the lists.
//   pnpm demo --team    demo with team sync already set up (acme/team-config, read and push, pull request): "Sync now" shows a
//                       difference, "Create pull request" answers with a made-up pull request URL. SECRET_DESK_DEMO_TEAM=1 does the same.
// The example folder is copied to a temporary folder first, so applying a team sync or saving the setup never touches the repository.
// SECRET_DESK_CONFIG (an own configuration) skips the copy and the switch.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const team = process.argv.includes("--team") || process.env.SECRET_DESK_DEMO_TEAM === "1";

// `work` is only ever set from mkdtempSync below, so cleanup never removes anything the user supplied.
let work;
// Idempotent: runs from the error paths, the child's exit and the process exit.
const cleanup = () => {
  const dir = work;
  work = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanup);

let configPath = process.env.SECRET_DESK_CONFIG;
const ownCopy = !configPath;
let child;
try {
  if (ownCopy) {
    work = mkdtempSync(join(tmpdir(), "secret-desk-demo-"));
    cpSync(join(root, "examples", "demo"), work, { recursive: true });
    configPath = join(work, team ? "secret-desk.team.config.yaml" : "secret-desk.config.yaml");
  }
  const env = Object.assign({}, process.env, {
    NEXT_TELEMETRY_DISABLED: "1",
    SECRET_DESK_DEMO: "1",
    SECRET_DESK_NO_LAUNCH_SECRET: "1",
    SECRET_DESK_CONFIG: configPath,
    // Only the throw-away copy gets the seeded team sync state; an own configuration is never written next to.
    SECRET_DESK_DEMO_SEED: ownCopy ? "1" : "",
  });
  const args = ["--filter", "@secret-desk/desk", "run", "dev"];
  // pnpm ueber npm_execpath (eine .cjs-Datei, laeuft mit node) starten: ohne Shell, auch auf Windows. Fallback: pnpm im PATH.
  const pnpmJs = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined;
  child = pnpmJs
    ? spawn(process.execPath, [pnpmJs, ...args], { cwd: root, env, stdio: "inherit" })
    : spawn("pnpm", args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
} catch (err) {
  console.error(`demo could not start: ${err.message}`);
  cleanup();
  process.exit(1);
}

child.on("error", (err) => {
  console.error(`pnpm konnte nicht gestartet werden: ${err.message}`);
  cleanup();
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
