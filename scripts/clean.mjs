#!/usr/bin/env node
// Plattformneutrales Aufraeumen (statt `rm -rf`): loescht Build-Ausgaben in allen Paketen.
// Aufruf: pnpm clean            (dist, .next, coverage)
//         pnpm clean --deps     (zusaetzlich node_modules)
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withDeps = process.argv.includes("--deps");
const targets = ["dist", ".next", "coverage", ...(withDeps ? ["node_modules"] : [])];

const folders = [root];
for (const group of ["packages", "apps"]) {
  let names = [];
  try {
    names = readdirSync(join(root, group));
  } catch {
    continue;
  }
  for (const name of names) {
    const dir = join(root, group, name);
    if (statSync(dir).isDirectory()) folders.push(dir);
  }
}

let removed = 0;
for (const folder of folders) {
  for (const target of targets) {
    const path = join(folder, target);
    try {
      statSync(path);
    } catch {
      continue;
    }
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed += 1;
    console.log(`entfernt: ${path}`);
  }
}
console.log(removed === 0 ? "Nichts zu entfernen." : `${removed} Eintraege entfernt.`);
