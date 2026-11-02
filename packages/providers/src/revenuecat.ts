import type { DiscoveredOption, DiscoverContext, ParamSpec, Provider } from "@secret-desk/core";
import { asList, getJson, str, unknownKind } from "./discover.js";
import { ProviderError, seg } from "./http.js";
import { isRecord } from "./checks.js";

const API = "https://api.revenuecat.com/v2";
const ID = "revenuecat-secret-key";
/** Safety stop for pagination: 20 pages of up to 100 items. */
const MAX_PAGES = 20;

type Ctx = Pick<DiscoverContext, "connections" | "fetch">;

/**
 * Lists every item of a RevenueCat v2 list endpoint (forward pagination: `starting_after` = id of the last item; `next_page`
 * is only used as the "there is more" signal, its URL is never followed). The page size is clamped by RevenueCat to 1-100.
 */
async function listAll(ctx: Ctx, path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `limit=100${after ? `&starting_after=${seg(after)}` : ""}`;
    const json = await getJson<unknown>(ID, ctx, "revenuecat", `${API}${path}?${query}`);
    const items = asList(json, "items");
    out.push(...items);
    const more = isRecord(json) && typeof json["next_page"] === "string" && json["next_page"] !== "";
    const last = items.length > 0 ? str(items[items.length - 1]!["id"]) : undefined;
    if (!more || !last) return out;
    after = last;
  }
  return out;
}

interface App {
  id: string;
  name: string;
  type: string;
  projectId: string;
  projectName: string;
}

async function listProjects(ctx: Ctx): Promise<{ id: string; name: string }[]> {
  return (await listAll(ctx, "/projects")).flatMap((p) => {
    const id = str(p["id"]);
    return id ? [{ id, name: str(p["name"]) ?? id }] : [];
  });
}

/** Apps of one project, or of every project when none is named (several projects, no integration default). */
async function listApps(ctx: Ctx, projectId: string | undefined): Promise<App[]> {
  const projects = projectId ? [{ id: projectId, name: projectId }] : await listProjects(ctx);
  const out: App[] = [];
  for (const p of projects) {
    for (const a of await listAll(ctx, `/projects/${seg(p.id)}/apps`)) {
      const id = str(a["id"]);
      if (id) out.push({ id, name: str(a["name"]) ?? id, type: str(a["type"]) ?? "unknown", projectId: p.id, projectName: p.name });
    }
  }
  return out;
}

const projectParam = (params: Record<string, unknown>): string | undefined => (typeof params["projectId"] === "string" && params["projectId"].trim() ? params["projectId"].trim() : undefined);

const specs: ParamSpec[] = [
  {
    key: "projectId",
    label: "RevenueCat-Projekt",
    labelEn: "RevenueCat project",
    type: "string",
    required: false,
    help: "Projekt, aus dem Apps und oeffentliche SDK-Schluessel gelesen werden. Ohne Angabe werden die Apps aller Projekte der Verbindung gelistet.",
    helpEn: "Project that apps and public SDK keys are read from. Without it, the apps of every project of the connection are listed.",
    discover: "revenuecat.project",
    integrationDefault: true,
  },
];

async function discoverRevenueCat(kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  switch (kind) {
    case "revenuecat.project":
      return (await listProjects(ctx)).map((p) => ({ value: p.id, label: p.name, detail: p.id }));
    case "revenuecat.app":
    case "revenuecat.publicApiKey":
      return (await listApps(ctx, projectParam(ctx.params))).map((a) => ({ value: a.id, label: `${a.name} (${a.type})`, detail: `${a.id}, ${a.projectName}` }));
    default:
      return unknownKind(kind);
  }
}

/**
 * The public SDK key of an app for one environment. Only entries of the public key list with a matching `environment` are
 * considered; if several exist, the newest (`created_at`) wins.
 */
async function publicKey(ctx: Ctx, projectId: string, appId: string, environment: "production" | "sandbox"): Promise<string> {
  const keys = (await listAll(ctx, `/projects/${seg(projectId)}/apps/${seg(appId)}/public_api_keys`)).filter((k) => k["environment"] === environment && str(k["key"]));
  if (keys.length === 0) throw new ProviderError("revenuecat", null, `Kein oeffentlicher ${environment}-Schluessel fuer die App ${appId} gefunden`);
  const created = (k: Record<string, unknown>): number => (typeof k["created_at"] === "number" ? k["created_at"] : 0);
  const newest = keys.reduce((a, b) => (created(b) > created(a) ? b : a));
  return str(newest["key"])!;
}

/** Reads one allowed field of a RevenueCat source (core/variable-sources.ts). Public values and identifiers only. */
export async function readRevenueCatField(kind: string, field: string, option: DiscoveredOption, ctx: Ctx & { params?: Record<string, unknown> }): Promise<string> {
  const id = String(option.value);
  switch (`${kind}:${field}`) {
    case "revenuecat.project:id":
    case "revenuecat.app:id":
      return id;
    case "revenuecat.project:name":
      return option.label;
    case "revenuecat.app:name":
    case "revenuecat.app:type":
    case "revenuecat.publicApiKey:production":
    case "revenuecat.publicApiKey:sandbox": {
      const app = (await listApps(ctx, projectParam(ctx.params ?? {}))).find((a) => a.id === id);
      if (!app) throw new ProviderError("revenuecat", null, `Die App ${id} gibt es im Projekt nicht`);
      if (field === "name") return app.name;
      if (field === "type") return app.type;
      return publicKey(ctx, app.projectId, app.id, field === "sandbox" ? "sandbox" : "production");
    }
    default:
      throw new ProviderError(kind, null, `Feld nicht erlaubt: ${field}`);
  }
}

/**
 * Secret key (v2) of RevenueCat. RevenueCat has no API that creates keys, so the value stays manual; the provider carries the
 * connection (Project configuration: Read only) that discovers projects, apps and public SDK keys for variables.
 */
export const revenueCatProvider: Provider = {
  id: ID,
  label: "RevenueCat Secret Key (v2)",
  kind: "manual",
  connection: "revenuecat",
  guide: {
    url: "https://app.revenuecat.com",
    steps: [
      "Im RevenueCat-Dashboard das Projekt oeffnen, dann Project settings, API keys.",
      "\"+ New secret API key\" waehlen, Version v2 und nur die Rechte setzen, die der Dienst braucht.",
      "Schluessel kopieren (er beginnt mit sk_) und im Portal einfuegen.",
      "Alten Schluessel im Dashboard widerrufen.",
    ],
  },
  params: specs,
  discover: discoverRevenueCat,
  discoverKinds: ["revenuecat.app", "revenuecat.publicApiKey"],
  reviewChecklist: (secret) => [
    `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
    "Version v2 mit den kleinsten noetigen Rechten",
    "Der Schluessel gehoert zum richtigen Projekt",
  ],
};

export const revenueCatProviders: Provider[] = [revenueCatProvider];
