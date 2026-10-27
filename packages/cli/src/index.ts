import { readFile, writeFile } from "node:fs/promises";
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
import { createRuntime, exportEnv, listSecrets, requestRotation, teamExport } from "@secret-desk/runtime";

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
  renew <id>     Wert beim Anbieter erneuern und in GitHub schreiben
                   --config <datei>   --dry-run
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

async function renew(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: "string" }, "dry-run": { type: "boolean" } } });
  const id = positionals[0];
  if (!id || !values.config) throw new Error("renew <id> --config <datei>");
  const rt = await createRuntime(values.config);
  const r = await requestRotation(rt, { kind: "human", name: "cli" }, id, { dryRun: Boolean(values["dry-run"]) });
  if (r.status === "dry-run") {
    io.out(`Plan: ${r.plan.provider} -> ${r.plan.places.join(", ")}${r.plan.revokesOld ? " (alter Wert wird widerrufen)" : ""}`);
    return 0;
  }
  if (r.status === "executed") {
    for (const p of r.places) io.out(`${p.outcome.padEnd(8)} ${p.place}`);
    io.out(r.ok ? `ok, laeuft ab: ${r.expires ?? "nie"}` : "nicht vollstaendig, alter Wert bleibt gueltig");
    return r.ok ? 0 : 1;
  }
  io.out(r.message);
  return 0;
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
  const body = stringify({ version: 1, thresholds: [30, 14, 7], secrets: r.secrets, envTemplates: [], providers: [] }, { lineWidth: 0 });
  await writeFile(output, `# Aus dem bisherigen Inventar umgewandelt. Nur Metadaten.\n${body}`, "utf8");
  io.out(`${r.secrets.length} Eintraege geschrieben, uebersprungen: ${r.skipped.variables} Variablen, ${r.skipped.nonGitHub} Nicht-GitHub-Stellen`);
  return 0;
}

export { STAGES };
