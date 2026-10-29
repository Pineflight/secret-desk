/** Seitensuche auf Secrets und Variablen: Teilwoerter, Gross-/Kleinschreibung egal, mehrere Woerter = UND. */

interface Searchable {
  id: string;
  name: string;
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  product?: string | null;
  stage: string;
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

/** Filtert die Liste; leere Anfrage liefert sie unveraendert. */
export function filterBySearch<T extends Searchable>(items: T[], query: string): T[] {
  const words = searchWords(query);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const text = searchText(item);
    return words.every((w) => text.includes(w));
  });
}

/** Ist das fokussierte Element ein Eingabefeld? Dann darf "/" nicht die Suche fokussieren. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
