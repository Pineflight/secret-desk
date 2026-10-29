/**
 * Suchlogik fuer Befehlspalette und Listensuchen. Klein und ohne Abhaengigkeiten:
 * - Normalisierung: Gross/Kleinschreibung, Akzente und Umlaute (ae/oe/ue -> a/o/u), Trennzeichen egal (STRIPE_SECRET = stripe secret = stripesecret)
 * - Treffer: genau > Wortanfang > Teilstring > Initialen > Tippfehler (Editierabstand) > verstreute Buchstaben, gewichtet nach Feld (Name > Id > Tags > Beschreibung)
 * - Filter-Syntax: stage:staging repo:x tag:y art:variable besitzer:z status:fehlt
 * Es werden nur Metadaten uebergeben, nie Werte; das ist Sache des Aufrufers (palette-index.ts).
 */

export type FieldKey = "name" | "id" | "tag" | "title" | "owner" | "service" | "repo" | "stage" | "description" | "other";

/** Gewichte je Feld: Name > Id > Tags > Beschreibung. */
export const FIELD_WEIGHT: Record<FieldKey, number> = { name: 1, id: 0.85, tag: 0.7, title: 0.75, owner: 0.5, service: 0.5, repo: 0.55, stage: 0.5, description: 0.35, other: 0.3 };

export interface SearchField {
  key: FieldKey;
  text: string;
}

export interface SearchDoc {
  id: string;
  kind: string;
  fields: SearchField[];
  /** Werte fuer die Filter (stage, repo, tag, status, owner, provider), schon normalisiert nicht noetig. */
  attrs: Partial<Record<FilterKey, string[]>>;
}

export type FilterKey = "stage" | "repo" | "tag" | "kind" | "owner" | "status" | "provider";

const FILTER_ALIASES: Record<string, FilterKey> = {
  stage: "stage", repo: "repo", repository: "repo", tag: "tag", schlagwort: "tag", art: "kind", kind: "kind", type: "kind", typ: "kind",
  besitzer: "owner", owner: "owner", status: "status", provider: "provider", anbieter: "provider",
};
export const FILTER_KEYS: readonly string[] = ["stage", "repo", "tag", "art", "besitzer", "status", "provider"];

/** Ein Zeichen ohne Akzent, klein; ß -> ss, ä/ö/ü -> ae/oe/ue (wie die ASCII-Schreibweise, "über" = "ueber"). */
function foldChar(ch: string): string {
  const low = ch.toLowerCase();
  if (low === "\u00df") return "ss";
  if (low === "\u00e4") return "ae";
  if (low === "\u00f6") return "oe";
  if (low === "\u00fc") return "ue";
  return low.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Zusammengezogene Form: nur Buchstaben und Ziffern, normalisiert. */
export function compact(text: string): string {
  let out = "";
  for (const ch of text) {
    const f = foldChar(ch);
    for (const c of f) if (/[a-z0-9]/.test(c)) out += c;
  }
  return out;
}

/** Woerter eines Textes: an Trennzeichen und an Wortgrenzen camelCase/Ziffern getrennt, normalisiert. */
export function tokens(text: string): string[] {
  const spaced = text.replace(/([a-zß-ÿ])([A-Z])/g, "$1 $2");
  const out: string[] = [];
  let cur = "";
  for (const ch of spaced) {
    const f = foldChar(ch);
    if (/[a-z0-9]/.test(f)) cur += f;
    else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Editierabstand (Levenshtein mit Vertauschung benachbarter Zeichen) mit Obergrenze: bricht ab, sobald er sicher groesser als `max` ist. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

interface Prepared {
  c: string;
  toks: string[];
  initials: string;
}
const prepCache = new Map<string, Prepared>();
function prepare(text: string): Prepared {
  let p = prepCache.get(text);
  if (!p) {
    if (prepCache.size > 20_000) prepCache.clear();
    const toks = tokens(text);
    p = { c: compact(text), toks, initials: toks.map((t) => t[0]).join("") };
    prepCache.set(text, p);
  }
  return p;
}

const isSubsequence = (needle: string, hay: string): boolean => {
  let i = 0;
  for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
};

/**
 * Wie gut passt ein Suchwort (schon normalisiert, ohne Trennzeichen) auf einen Text? 0 = gar nicht, 1 = genau.
 * `fuzzy: false` lasst Tippfehler und verstreute Buchstaben aus (schnell, fuer den ersten Durchgang).
 */
export function scoreTerm(term: string, text: string, fuzzy = true): number {
  if (!term) return 0;
  const { c, toks, initials } = prepare(text);
  if (!c) return 0;
  if (c === term) return 1;
  if (toks.includes(term)) return 0.95;
  if (c.startsWith(term)) return 0.9;
  for (const t of toks) if (t.startsWith(term)) return 0.85;
  if (c.includes(term)) return 0.7;
  // Initialen: "sdr" -> Stripe Dev Runner
  if (term.length >= 2 && toks.length >= 2) {
    if (initials === term) return 0.65;
    if (initials.startsWith(term) || initials.includes(term)) return 0.55;
  }
  if (!fuzzy) return 0;
  // Tippfehler: gegen Woerter und Wortanfaenge (Teilwoerter mit Fehler)
  if (term.length >= 5) {
    const max = term.length >= 9 ? 2 : 1;
    let best = max + 1;
    for (const t of toks) {
      best = Math.min(best, editDistance(term, t, max));
      if (t.length > term.length) best = Math.min(best, editDistance(term, t.slice(0, term.length), max));
    }
    if (best <= max) return best === 0 ? 0.7 : 0.5 - (best - 1) * 0.1;
  }
  // verstreute Buchstaben (s-t-r-s -> stripe_secret), nur bei laengeren Woertern, schwach
  if (term.length >= 3 && isSubsequence(term, c)) return 0.25;
  return 0;
}

export interface ParsedQuery {
  terms: string[];
  /** Roh-Woerter (vor der Normalisierung), fuer "Meintest du". */
  rawTerms: string[];
  filters: { key: FilterKey; value: string }[];
}

/** Zerlegt "stage:staging stripe secret" in Filter und Suchwoerter. Unbekannte "x:y"-Woerter bleiben Suchwoerter. */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const rawTerms: string[] = [];
  const filters: ParsedQuery["filters"] = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([^:\s]+):(.*)$/.exec(word);
    const key = m ? FILTER_ALIASES[compact(m[1]!)] : undefined;
    if (m && key && compact(m[2]!) !== "") {
      filters.push({ key, value: m[2]! });
      continue;
    }
    if (m && key) continue; // "stage:" ohne Wert: noch nichts filtern
    const c = compact(word);
    if (c) {
      terms.push(c);
      rawTerms.push(word);
    }
  }
  return { terms, rawTerms, filters };
}

const filterMatches = (doc: SearchDoc, f: { key: FilterKey; value: string }): boolean => {
  const want = compact(f.value);
  const have = f.key === "kind" ? [doc.kind] : (doc.attrs[f.key] ?? []);
  return have.some((v) => compact(v).includes(want) && (f.key === "stage" || f.key === "kind" || f.key === "status" ? compact(v).startsWith(want) : true));
};

/** Unter diesem Wert (Punkte x Feldgewicht) gilt ein Wort als nicht getroffen: verstreute Buchstaben in langen Beschreibungen sind Rauschen. */
export const MIN_TERM_SCORE = 0.1;

export interface Hit<T extends SearchDoc = SearchDoc> {
  doc: T;
  score: number;
}

/**
 * Sucht und ordnet. Jedes Suchwort muss in mindestens einem Feld passen (UND). Punkte = Summe der besten Feldpunkte je Wort,
 * gewichtet nach Feld. Gleichstand: `recency` (hoeher = zuletzt benutzt), dann Name.
 */
export function search<T extends SearchDoc>(docs: readonly T[], query: string, options: { recency?: (doc: T) => number; limit?: number } = {}): Hit<T>[] {
  const q = parseQuery(query);
  const run = (fuzzy: boolean): Hit<T>[] => {
    const out: Hit<T>[] = [];
    for (const doc of docs) {
      if (!q.filters.every((f) => filterMatches(doc, f))) continue;
      let total = 0;
      let ok = true;
      for (const term of q.terms) {
        let best = 0;
        for (const f of doc.fields) {
          const sc = scoreTerm(term, f.text, fuzzy) * FIELD_WEIGHT[f.key];
          if (sc > best) best = sc;
        }
        if (best < MIN_TERM_SCORE) {
          ok = false;
          break;
        }
        total += best;
      }
      if (ok) out.push({ doc, score: q.terms.length === 0 ? 0 : total / q.terms.length });
    }
    return out;
  };
  // Erst schnell ohne Tippfehler-Toleranz; nur wenn das kaum Treffer bringt, wird tolerant gesucht (haelt jeden Tastendruck billig).
  let out = run(false);
  if (q.terms.length > 0 && out.length < FUZZY_BELOW) out = run(true);
  const rec = options.recency ?? (() => 0);
  out.sort((a, b) => b.score - a.score || rec(b.doc) - rec(a.doc) || (a.doc.fields[0]?.text ?? "").localeCompare(b.doc.fields[0]?.text ?? ""));
  return options.limit ? out.slice(0, options.limit) : out;
}

/** Weniger Treffer als das: zusaetzlich tolerant (Tippfehler, verstreute Buchstaben) suchen. */
const FUZZY_BELOW = 8;

// ------------------------------------------------------------------------------------------------ Hervorhebung

export interface Segment {
  text: string;
  hit: boolean;
}

/** Zerlegt einen Text in Teile, die Suchwoerter treffen (Teilstring oder Wortanfang, ohne Trennzeichen-Unterschiede). */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  if (terms.length === 0 || !text) return [{ text, hit: false }];
  // compact-String mit Rueckabbildung auf die Position im Original
  let c = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const x of foldChar(ch)) if (/[a-z0-9]/.test(x)) { c += x; map.push(i); }
    i += ch.length;
  }
  const mark = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = c.indexOf(term, from);
      if (at < 0) break;
      const start = map[at]!;
      const end = map[at + term.length - 1]! + 1;
      for (let k = start; k < end; k++) mark[k] = true;
      from = at + 1;
    }
  }
  const out: Segment[] = [];
  for (let k = 0; k < text.length; k++) {
    const last = out[out.length - 1];
    if (last && last.hit === mark[k]) last.text += text[k];
    else out.push({ text: text[k]!, hit: mark[k]! });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Vorschlaege

export interface SuggestContext {
  /** Gueltige Werte je Filter (stage -> [dev, staging], status -> [fehlt, ...]). */
  values: Partial<Record<FilterKey | "art", readonly string[]>>;
}

export interface Suggestion {
  /** Neuer Suchtext, wenn der Vorschlag gewaehlt wird. */
  query: string;
  label: string;
  kind: "filter-key" | "filter-value" | "did-you-mean";
}

/** Vorschlaege fuer das letzte Wort: "sta" -> "stage:", "stage:st" -> "stage:staging". */
export function suggestFilters(query: string, ctx: SuggestContext, limit = 6): Suggestion[] {
  const m = /(^|\s)(\S*)$/.exec(query);
  if (!m) return [];
  const last = m[2]!;
  const head = query.slice(0, query.length - last.length);
  const colon = last.indexOf(":");
  if (colon > 0) {
    const key = FILTER_ALIASES[compact(last.slice(0, colon))];
    if (!key) return [];
    const typed = compact(last.slice(colon + 1));
    const pool = ctx.values[key === "kind" ? "art" : key] ?? [];
    return pool
      .filter((v) => compact(v).startsWith(typed) && compact(v) !== typed)
      .slice(0, limit)
      .map((v) => ({ query: `${head}${last.slice(0, colon)}:${/\s/.test(v) ? `"${v}"` : v} `, label: `${last.slice(0, colon)}:${v}`, kind: "filter-value" as const }));
  }
  const typed = compact(last);
  if (typed.length < 2) return [];
  return FILTER_KEYS.filter((k) => k.startsWith(typed) && k !== typed).slice(0, limit).map((k) => ({ query: `${head}${k}:`, label: `${k}:`, kind: "filter-key" as const }));
}

/** "Meintest du ...": ersetzt jedes Suchwort ohne Treffer durch das aehnlichste bekannte Wort (Abstand <= 2). null = nichts Besseres. */
export function didYouMean(query: string, vocabulary: ReadonlySet<string>): string | null {
  const q = parseQuery(query);
  if (q.terms.length === 0) return null;
  const words = [...vocabulary];
  let changed = false;
  const fixed = q.rawTerms.map((raw, i) => {
    const term = q.terms[i]!;
    if (vocabulary.has(term) || words.some((w) => w.startsWith(term))) return raw;
    let best: string | null = null;
    let bestD = 3;
    for (const w of words) {
      const d = editDistance(term, w, 2);
      if (d < bestD || (d === bestD && best !== null && w.length < best.length)) {
        bestD = d;
        best = w;
      }
    }
    if (best && bestD <= 2 && term.length >= 3) {
      changed = true;
      return best;
    }
    return raw;
  });
  const filters = q.filters.map((f) => `${f.key}:${f.value}`);
  return changed ? [...filters, ...fixed].join(" ") : null;
}

/** Alle Woerter der Dokumente (fuer didYouMean). */
export function vocabularyOf(docs: readonly SearchDoc[]): Set<string> {
  const set = new Set<string>();
  for (const d of docs) for (const f of d.fields) if (f.key !== "description") for (const t of tokens(f.text)) if (t.length >= 3) set.add(t);
  return set;
}
