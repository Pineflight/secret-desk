import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import {
  InventoryStore,
  STAGES,
  StageSchema,
  findings,
  importLegacyInventory,
  mergeTeamBundle,
  parseTeamBundle,
  type Stage,
} from "@secret-desk/core";
import { generateVapidKeys } from "@secret-desk/providers";
import {
  adoptVariableFromGitHub,
  addVariable,
  confirmIssuance,
  createRuntime,
  exportEnv,
  inspectVariableLive,
  listSecrets,
  listVariables,
  rejectIssuance,
  requestApplyVariable,
  requestIssuance,
  teamExport,
  updateVariable,
  type IssuanceView,
} from "@secret-desk/runtime";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

const HELP = `secret-desk - Tokens im Blick, Werte nie gespeichert

Aufruf: secret-desk <befehl> [optionen]

  check          Ablaufdaten pruefen (offline), Exit 1 bei abgelaufen oder in <= 7 Tagen
                   --inventory <datei> | --config <datei>   --json   --today JJJJ-MM-TT
  status         Alle Eintraege mit Status, optional live gegen GitHub
                   --config <datei>   --stage <s>   --repo <r>   --live
  renew <id>     Neuen Wert beim Anbieter erzeugen, pruefen, bestaetigen, dann in GitHub schreiben
                   --config <datei>   --dry-run   --yes (alle Pruefpunkte bestaetigen, nur wenn du sie geprueft hast)
  vars list      Variablen anzeigen                          --config <datei> [--stage <s>] [--repo <r>]
  vars status    Variable: Soll gegen Ist in GitHub          <id> --config <datei>
  vars set       Sollwert im Inventar aendern                <id> --value <wert> --config <datei> [--ack-public]
  vars apply     Sollwert in GitHub setzen                   <id> --config <datei> [--ack-public]
  vars adopt     Istwert aus GitHub als Sollwert uebernehmen <id> --config <datei>
  vars add       Variable anlegen                            --id <id> --name <NAME> --stage <s> --place repo[:env]... [--value <wert>] --config <datei>
  env export     Dev-.env erzeugen (Werte entstehen jetzt, werden nirgends gespeichert)
                   --config <datei> --repo <r> [--stage dev] [--template <id>] [--out <pfad>] [--overwrite] [--prompt KEY=WERT]...
  team export    Team-Konfiguration ohne Werte ausgeben     --config <datei> [--out <datei>]
  team import    Team-Konfiguration zusammenfuehren         <datei> --inventory <datei> [--replace]
  import-legacy  Altes Inventar (ai-interlink) umwandeln   <eingabe> <ausgabe> [--product repo=produkt]...
  vapid          Neues VAPID-Schluesselpaar ausgeben
`;

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "check":
        return await check(rest, io);
      case "status":
        return await status(rest, io);
      case "renew":
        return await renew(rest, io);
      case "vars":
        return await varsCmd(rest, io);
      case "env":
        return rest[0] === "export" ? await envExport(rest.slice(1), io) : usage(io);
      case "team":
        return rest[0] === "export" ? await teamExportCmd(rest.slice(1), io) : rest[0] === "import" ? await teamImportCmd(rest.slice(1), io) : usage(io);
      case "import-legacy":
        return await importLegacy(rest, io);
      case "vapid": {
        const keys = generateVapidKeys();
        io.out(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
        io.out(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        io.out(HELP);
        return 0;
      default:
        return usage(io);
    }
  } catch (err) {
    io.err(`Fehler: ${(err as Error).message}`);
    return 2;
  }
}

function usage(io: Io): number {
  io.err(HELP);
  return 2;
}

async function loadStore(values: { inventory?: string | undefined; config?: string | undefined }): Promise<InventoryStore> {
  if (values.inventory) return InventoryStore.open(values.inventory);
  if (values.config) return (await createRuntime(values.config)).inventory;
  throw new Error("--inventory <datei> oder --config <datei> angeben");
}

async function check(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { inventory: { type: "string" }, config: { type: "string" }, json: { type: "boolean" }, today: { type: "string" } } });
  const store = await loadStore(values);
  const today = values.today ? new Date(`${values.today}T12:00:00Z`) : new Date();
  const list = findings(store.data, today);
  if (values.json) io.out(JSON.stringify(list, null, 1));
  else {
    for (const f of list) io.out(`[${f.level}] ${f.text}`);
    io.out(`${store.data.secrets.length} Eintraege, ${list.length} Hinweise`);
  }
  return list.some((f) => f.level === "expired" || f.level === "due") ? 1 : 0;
}

async function status(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, stage: { type: "string" }, repo: { type: "string" }, live: { type: "boolean" } } });
  if (!values.config) throw new Error("--config <datei> angeben");
  const rt = await createRuntime(values.config);
  const stage = values.stage ? StageSchema.parse(values.stage) : undefined;
  const rows = await listSecrets(rt, { ...(stage ? { stage } : {}), ...(values.repo ? { repo: values.repo } : {}), ...(values.live ? { live: true } : {}) });
  for (const r of rows) {
    io.out(`${r.status.padEnd(8)} ${String(r.daysLeft ?? "-").padStart(5)}  ${r.stage.padEnd(10)} ${r.id}  (${r.provider}${r.automatic ? ", automatisch" : ""})`);
  }
  io.out(`${rows.length} Eintraege`);
  return 0;
}

function printIssuance(i: IssuanceView, io: Io): void {
  io.out(`Pruefung ${i.id} fuer ${i.secretName} (${i.stage}, ${i.provider})`);
  io.out(`Ergebnis: ${i.overall}, Fingerabdruck ${i.report.fingerprint}, gueltig bis ${i.expiresAt.slice(11, 16)} UTC`);
  for (const c of i.report.checks) io.out(`  [${c.status.padEnd(4)}] ${c.label}${c.actual ? ` (${c.actual})` : ""}${c.detail ? ` - ${c.detail}` : ""}`);
}

async function renew(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" } } });
  const id = positionals[0];
  if (!id || !values.config) throw new Error("renew <id> --config <datei>");
  const rt = await createRuntime(values.config);
  const actor = { kind: "human", name: "cli" } as const;
  const r = await requestIssuance(rt, actor, id, { dryRun: Boolean(values["dry-run"]) });
  if (r.status === "dry-run") {
    io.out(`Plan: ${r.plan.provider} -> ${r.plan.places.join(", ")}${r.plan.revokesOld ? " (alter Wert wird nach Bestaetigung widerrufen)" : ""}`);
    return 0;
  }
  if (r.status === "pending-approval") {
    io.out(r.message);
    return 0;
  }
  printIssuance(r.issuance, io);
  const ticks: string[] = [];
  if (values.yes) ticks.push(...r.issuance.report.checklist.map((c) => c.id));
  else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      io.out("Pruefpunkte, jeweils mit j bestaetigen:");
      for (const c of r.issuance.report.checklist) if ((await rl.question(`  ${c.text} [j/N] `)).trim().toLowerCase() === "j") ticks.push(c.id);
    } finally {
      rl.close();
    }
  }
  if (ticks.length < r.issuance.report.checklist.length) {
    const rej = await rejectIssuance(rt, actor, r.issuance.id, "Pruefpunkte nicht bestaetigt");
    io.out(`Verworfen${rej.revokedNew ? " (neuer Wert beim Anbieter geloescht)" : ""}. In GitHub wurde nichts geschrieben.`);
    return 1;
  }
  const done = await confirmIssuance(rt, actor, r.issuance.id, { ticks });
  for (const p of done.places) io.out(`${p.outcome.padEnd(8)} ${p.place}`);
  io.out(done.ok ? `ok, laeuft ab: ${done.expires ?? "nie"}${done.revokedOld ? ", alter Wert widerrufen" : ""}` : "nicht vollstaendig, alter Wert bleibt gueltig");
  return done.ok ? 0 : 1;
}

async function varsCmd(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, stage: { type: "string" }, repo: { type: "string" }, value: { type: "string" }, "ack-public": { type: "boolean" }, id: { type: "string" }, name: { type: "string" }, place: { type: "string", multiple: true } },
  });
  if (!values.config) throw new Error("--config <datei> angeben");
  const rt = await createRuntime(values.config);
  const actor = { kind: "human", name: "cli" } as const;
  const ack = { acknowledgedPublic: Boolean(values["ack-public"]) };
  const id = positionals[0];
  switch (sub) {
    case "list": {
      const stage = values.stage ? StageSchema.parse(values.stage) : undefined;
      const rows = listVariables(rt, { ...(stage ? { stage } : {}), ...(values.repo ? { repo: values.repo } : {}) });
      for (const v of rows) io.out(`${v.stage.padEnd(10)} ${v.id}  ${v.name} = ${v.value ?? "(unbekannt)"}`);
      io.out(`${rows.length} Variablen`);
      return 0;
    }
    case "status": {
      if (!id) throw new Error("vars status <id>");
      const { drift } = await inspectVariableLive(rt, id);
      for (const d of drift) io.out(`${d.state.padEnd(16)} ${d.placeLabel}  soll=${d.expected ?? "-"}  ist=${d.actual ?? "-"}`);
      return drift.every((d) => d.state === "in-sync") ? 0 : 1;
    }
    case "set": {
      if (!id || values.value === undefined) throw new Error("vars set <id> --value <wert>");
      await updateVariable(rt, actor, id, { value: values.value }, ack);
      io.out("Sollwert gespeichert (Inventar). Mit `vars apply` nach GitHub setzen.");
      return 0;
    }
    case "apply": {
      if (!id) throw new Error("vars apply <id>");
      const r = await requestApplyVariable(rt, actor, id, ack);
      if (r.status === "applied") for (const o of r.outcomes) io.out(`${o.outcome.padEnd(10)} ${o.place}${o.error ? `  ${o.error}` : ""}`);
      return r.status === "applied" && r.outcomes.some((o) => o.outcome === "failed") ? 1 : 0;
    }
    case "adopt": {
      if (!id) throw new Error("vars adopt <id>");
      const v = await adoptVariableFromGitHub(rt, actor, id);
      io.out(`Sollwert uebernommen: ${v.value}`);
      return 0;
    }
    case "add": {
      if (!values.id || !values.name || !values.stage || !(values.place?.length ?? 0)) throw new Error("vars add --id --name --stage --place repo[:env]...");
      const places = (values.place ?? []).map((p) => {
        const [repo, environment] = p.split(":");
        return environment ? { repo: repo!, scope: "environment" as const, environment } : { repo: repo!, scope: "repository" as const };
      });
      await addVariable(rt, actor, { id: values.id, name: values.name, stage: StageSchema.parse(values.stage), value: values.value ?? null, places }, ack);
      io.out("Variable angelegt.");
      return 0;
    }
    default:
      return usage(io);
  }
}

async function envExport(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string" }, repo: { type: "string" }, stage: { type: "string" }, template: { type: "string" }, out: { type: "string" }, overwrite: { type: "boolean" }, prompt: { type: "string", multiple: true } },
  });
  if (!values.config || !values.repo) throw new Error("env export --config <datei> --repo <repo>");
  const rt = await createRuntime(values.config);
  const prompts: Record<string, string> = {};
  for (const p of values.prompt ?? []) {
    const i = p.indexOf("=");
    if (i > 0) prompts[p.slice(0, i)] = p.slice(i + 1);
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("SECRET_DESK_PROMPT_") && v) prompts[k.slice("SECRET_DESK_PROMPT_".length)] = v;
  const stage: Stage = values.stage ? StageSchema.parse(values.stage) : "dev";
  const r = await exportEnv(rt, { kind: "human", name: "cli" }, {
    repo: values.repo,
    stage,
    ...(values.template ? { template: values.template } : {}),
    path: values.out ?? ".env.local",
    overwrite: Boolean(values.overwrite),
    prompts,
  });
  if (r.status === "needs-input") {
    io.err(`${r.message}\nFehlend: ${r.keys.join(", ")}`);
    return 1;
  }
  io.out(`geschrieben: ${r.path} (${r.keys.length} Schluessel, Modus 600)`);
  for (const w of r.warnings) io.err(`Hinweis: ${w}`);
  return 0;
}

async function teamExportCmd(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, out: { type: "string" } } });
  if (!values.config) throw new Error("team export --config <datei>");
  const text = teamExport(await createRuntime(values.config));
  if (values.out) {
    await writeFile(values.out, text, "utf8");
    io.out(`geschrieben: ${values.out}`);
  } else io.out(text);
  return 0;
}

async function teamImportCmd(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { inventory: { type: "string" }, replace: { type: "boolean" } } });
  const file = positionals[0];
  if (!file || !values.inventory) throw new Error("team import <datei> --inventory <datei>");
  let store: InventoryStore;
  try {
    store = await InventoryStore.open(values.inventory);
  } catch {
    store = InventoryStore.fromText("version: 1\nsecrets: []\n", values.inventory);
  }
  const bundle = parseTeamBundle(await readFile(file, "utf8"));
  const r = mergeTeamBundle(store, bundle, values.replace ? "replace" : "merge");
  await store.save();
  io.out(`${r.added.length} hinzugefuegt, ${r.skipped.length} uebersprungen`);
  return 0;
}

async function importLegacy(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { product: { type: "string", multiple: true } } });
  const [input, output] = positionals;
  if (!input || !output) throw new Error("import-legacy <eingabe> <ausgabe>");
  const map = new Map<string, string>();
  for (const p of values.product ?? []) {
    const [repo, product] = p.split("=");
    if (repo && product) map.set(repo, product);
  }
  const r = importLegacyInventory(await readFile(input, "utf8"), { productOf: (repo) => map.get(repo) });
  const body = stringify({ version: 1, thresholds: [30, 14, 7], secrets: r.secrets, variables: r.variables, envTemplates: [], providers: [] }, { lineWidth: 0 });
  await writeFile(output, `# Aus dem bisherigen Inventar umgewandelt. Nur Metadaten.\n${body}`, "utf8");
  io.out(`${r.secrets.length} Secrets und ${r.variables.length} Variablen geschrieben, uebersprungen: ${r.skipped.nonGitHub} Nicht-GitHub-Stellen (Worker, Supabase, lokal)`);
  return 0;
}

export { STAGES };
