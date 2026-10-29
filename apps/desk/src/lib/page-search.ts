/** Seitensuche auf Secrets und Variablen: gleiche tolerante Suche wie die Befehlspalette (smart-search.ts), mehrere Woerter = UND. */
import { parseQuery, search, type FieldKey, type SearchDoc, type SearchField } from "./smart-search";

const STATUS_WORDS: Record<string, string[]> = { ok: ["ok", "in ordnung"], unknown: ["unknown", "unklar"], soon: ["soon", "bald"], "no-date": ["no-date", "kein datum"], due: ["due", "faellig"], missing: ["missing", "fehlt"], expired: ["expired", "abgelaufen"] };

interface Searchable {
  id: string;
  name: string;
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  product?: string | null;
  stage: string;
  /** Nur Secrets: Statusstufe (fuer status:fehlt). */
  status?: string | null;
  service?: string | null;
  provider?: string | null;
  tags?: string[];
  /** Nur Variablen: Sollwert. */
  value?: string | null;
  /** Nur Variablen: Quelle in einer Integration. */
  from?: { connection: string; kind: string; resource: string; field: string } | null;
  places: { repo: string; scope: string; environment?: string | undefined; name?: string | undefined }[];
}

/** Zerlegt die Anfrage in Woerter (klein geschrieben). */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Alle durchsuchten Felder eines Eintrags als Text. */
export function searchText(item: Searchable): string {
  const parts: (string | null | undefined)[] = [item.id, item.name, item.title, item.description, item.owner, item.product, item.stage, item.service, item.provider, item.value];
  if (item.from) parts.push(item.from.connection, item.from.kind, item.from.resource, item.from.field);
  for (const tag of item.tags ?? []) parts.push(tag);
  for (const p of item.places) parts.push(p.repo, p.scope, p.environment, p.name);
  return parts.filter((x): x is string => typeof x === "string" && x !== "").join("\n").toLowerCase();
}

const docCache = new WeakMap<object, SearchDoc>();
const f = (key: FieldKey, text: string | null | undefined): SearchField[] => (text ? [{ key, text }] : []);

/** Suchdokument eines Listeneintrags: dieselben Felder und Gewichte wie die Befehlspalette (Name > Id > Tags > Beschreibung). Der Sollwert zaehlt als Nebenfeld. */
function docOf(item: Searchable): SearchDoc {
  let d = docCache.get(item);
  if (!d) {
    const repos = [...new Set(item.places.map((p) => p.repo))];
    d = {
      id: item.id,
      kind: "item",
      fields: [...f("name", item.name), ...f("id", item.id), ...f("title", item.title), ...(item.tags ?? []).flatMap((x) => f("tag", x)), ...f("owner", item.owner), ...f("service", item.service), ...f("service", item.provider), ...f("service", item.product), ...repos.flatMap((r) => f("repo", r)), ...f("stage", item.stage), ...f("description", item.description), ...f("other", item.value), ...(item.from ? f("other", `${item.from.connection} ${item.from.kind} ${item.from.resource} ${item.from.field}`) : [])],
      attrs: { stage: [item.stage], repo: repos, tag: item.tags ?? [], owner: item.owner ? [item.owner] : [], provider: [item.provider, item.service].filter((x): x is string => !!x), ...(item.status ? { status: STATUS_WORDS[item.status] ?? [item.status] } : {}) },
    };
    docCache.set(item, d);
  }
  return d;
}

/** Filtert die Liste mit derselben Suche wie die Befehlspalette (tolerant, Filter-Syntax stage:... repo:...); leere Anfrage liefert sie unveraendert. Die Reihenfolge bestimmt die Seite. */
export function filterBySearch<T extends Searchable>(items: T[], query: string): T[] {
  if (query.trim() === "") return items;
  const parsed = parseQuery(query);
  if (parsed.terms.length === 0 && parsed.filters.length === 0) return items;
  const hits = new Set(search(items.map(docOf), query).map((h) => h.doc.id));
  return items.filter((item) => hits.has(item.id));
}

/** Suchwoerter fuer die Hervorhebung in der Liste. */
export function highlightTerms(query: string): string[] {
  return parseQuery(query).terms;
}

/** Ist das fokussierte Element ein Eingabefeld? Dann darf "/" nicht die Suche fokussieren. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
