/**
 * Index der Befehlspalette: nur Metadaten, nie Werte. Baut aus den bereits ladbaren Listen (Secrets, Variablen, Repositories, Stages,
 * Verbindungen, Anbieter) sowie Seiten und Aktionen des Portals durchsuchbare Dokumente. Nicht aufgenommen werden:
 * Sollwerte von Variablen, Notizen, Links, lokale Ordnerpfade, Tokens, das Startgeheimnis.
 */
import type { SearchDoc, SearchField } from "./smart-search";

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

export interface PaletteDoc extends SearchDoc {
  title: string;
  subtitle: string;
  href: string;
  icon: string;
  /** Statusmarke (Text schon uebersetzt). */
  badge?: { text: string; tone: Tone };
  /** Fuer "Zuletzt geoeffnet": stabile Kennung ueber Sitzungen hinweg. */
  recentId: string;
}

export interface SecretLike { id: string; name: string; title?: string | null; description?: string | null; owner?: string | null; tags?: string[]; product?: string | null; stage: string; service?: string | null; provider?: string | null; status: string; places: { repo: string }[] }
export interface VariableLike { id: string; name: string; description?: string | null; owner?: string | null; tags?: string[]; product?: string | null; stage: string; places: { repo: string }[] }
export interface RepoLike { name: string; secrets: number; variables: number }
export interface StageLike { id: string; label?: string; kind: string }
export interface ConnectionLike { id: string; label: string; connected: boolean }
export interface ProviderLike { id: string; label: string; connection?: string | null }

export interface IndexInput {
  secrets: readonly SecretLike[];
  variables: readonly VariableLike[];
  repos: readonly RepoLike[];
  stages: readonly StageLike[];
  connections: readonly ConnectionLike[];
  providers: readonly ProviderLike[];
  /** Uebersetzung (Schluessel, Werte) wie useT(). */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Statuswoerter fuer den Filter status:... in beiden Sprachen. */
const STATUS_WORDS: Record<string, string[]> = {
  ok: ["ok", "in ordnung"],
  unknown: ["unknown", "unklar"],
  soon: ["soon", "bald", "laeuft bald ab"],
  "no-date": ["no-date", "kein datum", "datum fehlt"],
  due: ["due", "faellig"],
  missing: ["missing", "fehlt"],
  expired: ["expired", "abgelaufen"],
};
const STATUS_TONE: Record<string, Tone> = { ok: "ok", unknown: "muted", soon: "warn", "no-date": "warn", due: "warn", missing: "danger", expired: "danger" };

const f = (key: SearchField["key"], text: string | null | undefined): SearchField[] => (text ? [{ key, text }] : []);
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** Seiten und Aktionen: Aktionen oeffnen nur die Seite/den Dialog, fuehren nie etwas mit Nebenwirkung aus. */
const PAGES: { id: string; href: string; icon: string; label: string; keywords: string; kind: "page" | "action" }[] = [
  { id: "overview", href: "/", icon: "grid", label: "common.nav.overview", keywords: "dashboard home start overview", kind: "page" },
  { id: "secrets", href: "/secrets", icon: "key", label: "common.nav.secrets", keywords: "geheimnisse tokens keys", kind: "page" },
  { id: "variables", href: "/variables", icon: "sliders", label: "common.nav.variables", keywords: "variablen vars config", kind: "page" },
  { id: "compare", href: "/compare", icon: "compare", label: "palette.page.compare", keywords: "vergleich vergleichen compare stages parity", kind: "page" },
  { id: "repos", href: "/repos", icon: "folder", label: "common.nav.repos", keywords: "repositories repos github", kind: "page" },
  { id: "reviews", href: "/reviews", icon: "shield", label: "common.nav.reviews", keywords: "pruefen reviews pruefung", kind: "page" },
  { id: "approvals", href: "/approvals", icon: "inbox", label: "common.nav.approvals", keywords: "freigaben approvals", kind: "page" },
  { id: "dev", href: "/dev", icon: "terminal", label: "common.nav.dev", keywords: "dev env umgebung entwicklung", kind: "page" },
  { id: "connections", href: "/connections", icon: "plug", label: "common.nav.integrations", keywords: "integrationen verbindungen connections tokens anbieter", kind: "page" },
  { id: "team", href: "/team", icon: "users", label: "common.nav.team", keywords: "team export import sync github repo", kind: "page" },
  { id: "settings", href: "/settings", icon: "wrench", label: "common.nav.settings", keywords: "einstellungen settings stages policy", kind: "page" },
  { id: "new-secret", href: "/secrets?new=1", icon: "plus", label: "palette.action.newSecret", keywords: "neu anlegen erstellen add create secret eintrag", kind: "action" },
  { id: "new-variable", href: "/variables?new=1", icon: "plus", label: "palette.action.newVariable", keywords: "neu anlegen erstellen add create variable", kind: "action" },
  { id: "add-connection", href: "/connections", icon: "plug", label: "palette.action.addConnection", keywords: "integration hinzufuegen verbinden connect add token", kind: "action" },
  { id: "dev-env", href: "/dev", icon: "terminal", label: "palette.action.devEnv", keywords: "dev env erzeugen exportieren export generate", kind: "action" },
  { id: "team-sync", href: "/team", icon: "users", label: "palette.action.teamSync", keywords: "team sync synchronisieren github repository", kind: "action" },
  { id: "run-compare", href: "/compare", icon: "compare", label: "palette.action.runCompare", keywords: "zum vergleich go compare abgleich", kind: "action" },
];

export function buildIndex(input: IndexInput): PaletteDoc[] {
  const { t } = input;
  const docs: PaletteDoc[] = [];
  const stageLabel = new Map(input.stages.map((s) => [s.id, s.label ?? s.id]));
  const statusText = (s: string) => t(`common.status.${s}`);

  for (const s of input.secrets) {
    const repos = uniq(s.places.map((p) => p.repo));
    docs.push({
      id: `secret:${s.id}`, recentId: `secret:${s.id}`, kind: "secret", title: s.name, subtitle: [repos.join(", "), stageLabel.get(s.stage) ?? s.stage].filter(Boolean).join(" · "), href: `/secrets/${encodeURIComponent(s.id)}`, icon: "key",
      badge: s.status === "ok" ? undefined : { text: statusText(s.status), tone: STATUS_TONE[s.status] ?? "muted" },
      fields: [...f("name", s.name), ...f("id", s.id), ...f("title", s.title), ...(s.tags ?? []).flatMap((x) => f("tag", x)), ...f("owner", s.owner), ...f("service", s.service), ...f("service", s.provider), ...f("service", s.product), ...repos.flatMap((r) => f("repo", r)), ...f("stage", s.stage), ...f("description", s.description)],
      attrs: { stage: [s.stage], repo: repos, tag: s.tags ?? [], owner: s.owner ? [s.owner] : [], status: STATUS_WORDS[s.status] ?? [s.status], provider: [s.provider, s.service].filter((x): x is string => !!x) },
    });
  }
  for (const v of input.variables) {
    const repos = uniq(v.places.map((p) => p.repo));
    docs.push({
      id: `variable:${v.id}`, recentId: `variable:${v.id}`, kind: "variable", title: v.name, subtitle: [repos.join(", "), stageLabel.get(v.stage) ?? v.stage].filter(Boolean).join(" · "), href: `/variables?q=${encodeURIComponent(v.id)}`, icon: "sliders",
      fields: [...f("name", v.name), ...f("id", v.id), ...(v.tags ?? []).flatMap((x) => f("tag", x)), ...f("owner", v.owner), ...f("service", v.product), ...repos.flatMap((r) => f("repo", r)), ...f("stage", v.stage), ...f("description", v.description)],
      attrs: { stage: [v.stage], repo: repos, tag: v.tags ?? [], owner: v.owner ? [v.owner] : [] },
    });
  }
  for (const r of input.repos) {
    docs.push({ id: `repo:${r.name}`, recentId: `repo:${r.name}`, kind: "repo", title: r.name, subtitle: t("palette.repoCounts", { secrets: r.secrets, variables: r.variables }), href: `/secrets?repo=${encodeURIComponent(r.name)}`, icon: "folder", fields: f("name", r.name), attrs: { repo: [r.name] } });
  }
  for (const s of input.stages) {
    docs.push({ id: `stage:${s.id}`, recentId: `stage:${s.id}`, kind: "stage", title: s.label ?? s.id, subtitle: t("palette.stageKind", { kind: s.kind }), href: "/settings", icon: "grid", fields: [...f("name", s.label ?? s.id), ...f("id", s.id)], attrs: { stage: [s.id] } });
  }
  for (const c of input.connections) {
    docs.push({ id: `connection:${c.id}`, recentId: `connection:${c.id}`, kind: "connection", title: c.label, subtitle: c.connected ? t("palette.connected") : t("palette.notConnected"), href: "/connections", icon: "plug", badge: c.connected ? undefined : { text: t("palette.notConnected"), tone: "warn" }, fields: [...f("name", c.label), ...f("id", c.id)], attrs: { provider: [c.id] } });
  }
  for (const p of input.providers) {
    docs.push({ id: `provider:${p.id}`, recentId: `provider:${p.id}`, kind: "provider", title: p.label, subtitle: p.id, href: `/secrets?provider=${encodeURIComponent(p.id)}`, icon: "bolt", fields: [...f("name", p.label), ...f("id", p.id)], attrs: { provider: [p.id] } });
  }
  for (const p of PAGES) {
    const title = t(p.label);
    docs.push({ id: `${p.kind}:${p.id}`, recentId: `${p.kind}:${p.id}`, kind: p.kind, title, subtitle: p.kind === "action" ? t("palette.opensPage") : t("palette.page"), href: p.href, icon: p.icon, fields: [...f("name", title), ...f("other", p.keywords)], attrs: {} });
  }
  return docs;
}

/** Gueltige Filterwerte aus dem Index (fuer die Vorschlaege). */
export function filterValues(docs: readonly PaletteDoc[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = { stage: new Set(), repo: new Set(), tag: new Set(), owner: new Set(), status: new Set(), provider: new Set(), art: new Set() };
  for (const d of docs) {
    for (const key of ["stage", "repo", "tag", "owner", "provider"] as const) for (const v of d.attrs[key] ?? []) out[key]!.add(v);
    for (const v of d.attrs.status ?? []) if (/^[a-z]+$/.test(v)) out["status"]!.add(v);
    out["art"]!.add(d.kind);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}
