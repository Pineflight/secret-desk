#!/usr/bin/env node
// Startet das Portal im Demo-Modus (simuliertes GitHub, erfundene Daten) auf jedem System.
// Ersetzt `SECRET_DESK_DEMO=1 SECRET_DESK_CONFIG=... pnpm dev`, das in PowerShell und cmd so nicht laeuft.
// Voraussetzung: `pnpm build` ist gelaufen.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  SECRET_DESK_DEMO: "1",
  SECRET_DESK_CONFIG: process.env.SECRET_DESK_CONFIG ?? join(root, "examples", "demo", "secret-desk.config.yaml"),
};
const args = ["--filter", "@secret-desk/desk", "run", "dev"];

// pnpm ueber npm_execpath (eine .cjs-Datei, laeuft mit node) starten: ohne Shell, auch auf Windows. Fallback: pnpm im PATH.
const pnpmJs = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined;
const child = pnpmJs
  ? spawn(process.execPath, [pnpmJs, ...args], { cwd: root, env, stdio: "inherit" })
  : spawn("pnpm", args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });

child.on("error", (err) => {
  console.error(`pnpm konnte nicht gestartet werden: ${err.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
