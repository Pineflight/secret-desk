import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { SyncLine, SyncPlan } from "@secret-desk/core";
import { createRuntime, planGitHubSync, runGitHubSync } from "@secret-desk/runtime";
import type { Io } from "./index.js";

const REASON: Record<string, string> = {
  missing: "fehlt in GitHub",
  different: "Wert weicht ab",
  overwrite: "wird ueberschrieben (GitHub ist nicht lesbar)",
  "github-newer": "wird ueberschrieben, GitHub wurde nach dem Inventar geaendert",
  "no-value": "kein Wert",
  "ignored-repo": "Repository wird ignoriert",
  unreadable: "Ziel nicht lesbar",
  "target-missing": "Ziel gibt es nicht (Environment anlegen)",
  "secret-like": "Wert sieht wie ein Geheimnis aus",
  "needs-ack": "Wert wirkt verdaechtig, einzeln mit vars apply --ack-public",
};

const line = (l: SyncLine, selected: boolean): string =>
  `  ${selected ? "[x]" : "[ ]"} ${l.action.padEnd(5)} ${l.kind === "secret" ? "Secret  " : "Variable"} ${l.name}  ${l.placeLabel}${l.production ? "  (Produktion)" : ""}  - ${REASON[l.reason] ?? l.reason}${l.renewable ? "; erneuern mit renew" : ""}`;

/** Prints the plan grouped by repository. Names, places and reasons only, never a value. */
export function printSyncPlan(plan: SyncPlan, selected: ReadonlySet<string>, io: Io): void {
  const repos = [...new Set(plan.lines.map((l) => l.repo))].sort();
  for (const repo of repos) {
    io.out(repo);
    for (const l of plan.lines.filter((x) => x.repo === repo)) io.out(line(l, selected.has(l.key)));
  }
  io.out(`${plan.counts.set} Variable(n) setzen, ${plan.counts.write} Secret(s) schreiben, ${plan.counts.skip} uebersprungen, ${plan.counts.unchanged} Variable(n) schon gleich.`);
}

/** `secret-desk sync --to-github [--dry-run] [--yes] [--repo <name>]`. Nothing is ever deleted in GitHub. */
export async function syncCmd(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, "to-github": { type: "boolean" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" }, repo: { type: "string" } } });
  if (!values.config || !values["to-github"]) throw new Error("sync --to-github --config <datei> [--dry-run] [--yes] [--repo <name>]");
  const rt = await createRuntime(values.config);
  const actor = { kind: "human", name: "cli" } as const;
  const plan = await planGitHubSync(rt, actor, values.repo ? { repo: values.repo } : {});
  const chosen = plan.lines.filter((l) => l.action !== "skip" && l.defaultOn);
  const selected = new Set(chosen.map((l) => l.key));
  printSyncPlan(plan, selected, io);
  const off = plan.lines.filter((l) => l.action !== "skip" && !l.defaultOn).length;
  if (off > 0) io.out(`${off} Zeile(n) bleiben aus, weil GitHub nach dem Inventar geaendert wurde.`);
  if (values["dry-run"]) {
    io.out("Probelauf: in GitHub wurde nichts geschrieben.");
    return 0;
  }
  if (chosen.length === 0) {
    io.out("Nichts zu schreiben.");
    return 0;
  }
  const production = chosen.some((l) => l.production);
  let confirmed = Boolean(values.yes);
  if (!confirmed) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      confirmed = (await rl.question(`${chosen.length} Aenderung(en) nach GitHub schreiben? [j/N] `)).trim().toLowerCase() === "j";
      if (confirmed && production) confirmed = (await rl.question("Ich weiss, dass dieser Wert die Produktion betrifft. [j/N] ")).trim().toLowerCase() === "j";
    } finally {
      rl.close();
    }
  }
  if (!confirmed) {
    io.out("Nicht bestaetigt. In GitHub wurde nichts geschrieben.");
    return 1;
  }
  const result = await runGitHubSync(rt, actor, {
    keys: chosen.map((l) => l.key),
    confirmProduction: production,
    ...(values.repo ? { repo: values.repo } : {}),
    onProgress: (d, total) => {
      io.out(`Fortschritt: ${d}/${total}`);
    },
  });
  for (const o of result.outcomes) io.out(`${o.outcome.padEnd(8)} ${o.name}  ${o.placeLabel}${o.error ? `  ${o.error}` : ""}`);
  io.out(result.failed === 0 ? `ok: ${result.ok} geschrieben.` : `${result.ok} geschrieben, ${result.failed} fehlgeschlagen.`);
  return result.failed === 0 ? 0 : 1;
}
