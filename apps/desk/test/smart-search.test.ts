import { describe, expect, it } from "vitest";
import { buildIndex, filterValues, type PaletteDoc } from "../src/lib/palette-index";
import { clearHistory, loadHistory, recordItem, recordQuery, setHistoryEnabled, type StorageLike } from "../src/lib/palette-history";
import { nextActive, nextGroupStart, trapTarget } from "../src/lib/palette-nav";
import { detectPlatform, isPaletteShortcut, isTouchDevice, shortcutLabel } from "../src/lib/platform-keys";
import { compact, didYouMean, editDistance, highlight, parseQuery, scoreTerm, search, suggestFilters, tokens, vocabularyOf, type SearchDoc } from "../src/lib/smart-search";
import { filterBySearch } from "../src/lib/page-search";

const doc = (id: string, name: string, extra: Partial<SearchDoc> & { description?: string; tags?: string[] } = {}): SearchDoc => ({
  id,
  kind: extra.kind ?? "secret",
  fields: [{ key: "name", text: name }, { key: "id", text: id }, ...(extra.tags ?? []).map((text) => ({ key: "tag" as const, text })), ...(extra.description ? [{ key: "description" as const, text: extra.description }] : [])],
  attrs: extra.attrs ?? {},
});
const ids = (docs: SearchDoc[], q: string) => search(docs, q).map((h) => h.doc.id);

describe("normalization", () => {
  it("separators, case and umlauts do not matter", () => {
    expect(compact("STRIPE_SECRET")).toBe(compact("stripe secret"));
    expect(compact("stripe-secret")).toBe("stripesecret");
    expect(compact("Über Größe")).toBe(compact("ueber groesse"));
    expect(tokens("stripeSecretKey")).toEqual(["stripe", "secret", "key"]);
  });
  it("edit distance has a cap", () => {
    expect(editDistance("stripe", "stripe")).toBe(0);
    expect(editDistance("strpe", "stripe")).toBe(1);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });
});

describe("matching and ranking", () => {
  const docs = [
    doc("stripe-secret-key", "STRIPE_SECRET_KEY", { tags: ["payments"], description: "Used by the checkout" }),
    doc("supabase-service-role", "SUPABASE_SERVICE_ROLE_KEY", { tags: ["db"] }),
    doc("site-url", "NEXT_PUBLIC_SITE_URL", { kind: "variable", tags: ["config"] }),
    doc("cloudflare-token", "CLOUDFLARE_API_TOKEN", { description: "stripe webhooks relay" }),
  ];
  it("STRIPE_SECRET = stripe secret = stripesecret", () => {
    for (const q of ["STRIPE_SECRET", "stripe secret", "stripesecret"]) expect(ids(docs, q)[0]).toBe("stripe-secret-key");
  });
  it("tolerates typos and partial words", () => {
    expect(ids(docs, "stirpe")).toContain("stripe-secret-key");
    expect(ids(docs, "strpe secrt")[0]).toBe("stripe-secret-key");
    expect(ids(docs, "supa")[0]).toBe("supabase-service-role");
    expect(ids(docs, "flare")[0]).toBe("cloudflare-token");
  });
  it("finds by initials", () => {
    expect(ids(docs, "ssk")[0]).toBe("stripe-secret-key");
    expect(ids(docs, "nps")[0]).toBe("site-url");
  });
  it("weights name over id over tags over description", () => {
    const d = [
      doc("a", "other", { description: "payments overview" }),
      doc("b", "other two", { tags: ["payments"] }),
      doc("payments", "third"),
      doc("c", "payments"),
    ];
    expect(ids(d, "payments")).toEqual(["c", "payments", "b", "a"]);
  });
  it("all words must match (AND) and nothing matches rubbish", () => {
    expect(ids(docs, "stripe key")).toEqual(["stripe-secret-key"]);
    expect(ids(docs, "stripe zzzqqq")).toEqual([]);
  });
  it("ties are broken by recency", () => {
    const d = [doc("one", "alpha token"), doc("two", "beta token")];
    const hits = search(d, "token", { recency: (x) => (x.id === "two" ? 5 : 0) });
    expect(hits.map((h) => h.doc.id)).toEqual(["two", "one"]);
  });
  it("scoreTerm orders exact > prefix > substring > typo", () => {
    const s = (t: string, x: string) => scoreTerm(t, x);
    expect(s("token", "token")).toBeGreaterThan(s("tok", "token"));
    expect(s("tok", "token")).toBeGreaterThan(s("oke", "token"));
    expect(s("tokne", "token")).toBeGreaterThan(0);
    expect(s("zzz", "token")).toBe(0);
  });
});

describe("filter syntax", () => {
  const docs = [
    doc("a", "ALPHA", { attrs: { stage: ["staging"], repo: ["wake-miles"], tag: ["config"], owner: ["niklaslurse"], status: ["missing", "fehlt"] } }),
    doc("b", "BETA", { kind: "variable", attrs: { stage: ["production"], repo: ["wake-miles"], tag: ["config"] } }),
    doc("c", "GAMMA", { attrs: { stage: ["staging"], repo: ["other"], owner: ["anna"] } }),
  ];
  it("parses filters and keeps unknown x:y as words", () => {
    expect(parseQuery("stage:staging foo")).toMatchObject({ terms: ["foo"], filters: [{ key: "stage", value: "staging" }] });
    expect(parseQuery("besitzer:anna art:variable").filters.map((f) => f.key)).toEqual(["owner", "kind"]);
    expect(parseQuery("http:x").terms).toEqual(["httpx"]);
    expect(parseQuery("stage:").filters).toEqual([]);
  });
  it("filters by stage, repo, tag, kind, owner, status", () => {
    expect(ids(docs, "stage:staging")).toEqual(expect.arrayContaining(["a", "c"]));
    expect(ids(docs, "stage:staging")).not.toContain("b");
    expect(ids(docs, "repo:wake-miles tag:config").sort()).toEqual(["a", "b"]);
    expect(ids(docs, "art:variable")).toEqual(["b"]);
    expect(ids(docs, "besitzer:niklaslurse")).toEqual(["a"]);
    expect(ids(docs, "status:fehlt")).toEqual(["a"]);
    expect(ids(docs, "status:missing")).toEqual(["a"]);
    expect(ids(docs, "stage:staging alpha")).toEqual(["a"]);
  });
  it("suggests keys and valid values while typing", () => {
    const ctx = { values: { stage: ["dev", "staging", "production"], status: ["fehlt", "missing"] } };
    expect(suggestFilters("sta", ctx).map((s) => s.label)).toContain("stage:");
    expect(suggestFilters("stage:st", ctx).map((s) => s.label)).toEqual(["stage:staging"]);
    expect(suggestFilters("foo stage:", ctx).map((s) => s.label)).toEqual(["stage:dev", "stage:staging", "stage:production"]);
    expect(suggestFilters("foo stage:st", ctx)[0]!.query).toBe("foo stage:staging ");
    expect(suggestFilters("x", ctx)).toEqual([]);
  });
});

describe("did you mean and highlight", () => {
  const docs = [doc("stripe", "STRIPE_SECRET_KEY"), doc("supabase", "SUPABASE_URL")];
  it("suggests a nearby word when nothing matches", () => {
    expect(ids(docs, "strpie")).toEqual(expect.arrayContaining(["stripe"])); // tolerant: found directly
    expect(didYouMean("stipre secrat", vocabularyOf(docs))).toBe("stripe secret");
    expect(didYouMean("stripe", vocabularyOf(docs))).toBeNull();
    expect(didYouMean("qqqqqq", vocabularyOf(docs))).toBeNull();
  });
  it("highlights matches across separators", () => {
    const seg = highlight("STRIPE_SECRET_KEY", ["stripesecret"]);
    expect(seg.filter((s) => s.hit).map((s) => s.text).join("")).toBe("STRIPE_SECRET");
    expect(highlight("Name", []).every((s) => !s.hit)).toBe(true);
    expect(highlight("Ünder", ["ue"]).some((s) => s.hit)).toBe(true);
  });
});

describe("list search uses the same logic", () => {
  const items = [
    { id: "stripe-secret", name: "STRIPE_SECRET", stage: "staging", status: "missing", places: [{ repo: "app", scope: "repository" }], tags: ["payments"] },
    { id: "site-url", name: "SITE_URL", stage: "production", places: [{ repo: "web", scope: "repository" }], tags: [] },
  ];
  it("typo, separators and filters work in lists; empty query returns the list unchanged", () => {
    expect(filterBySearch(items, "").length).toBe(2);
    expect(filterBySearch(items, "stripesecret").map((i) => i.id)).toEqual(["stripe-secret"]);
    expect(filterBySearch(items, "strpe").map((i) => i.id)).toEqual(["stripe-secret"]);
    expect(filterBySearch(items, "stage:production").map((i) => i.id)).toEqual(["site-url"]);
    expect(filterBySearch(items, "status:fehlt").map((i) => i.id)).toEqual(["stripe-secret"]);
    expect(filterBySearch(items, "repo:web").map((i) => i.id)).toEqual(["site-url"]);
  });
});

describe("index: metadata only", () => {
  const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${JSON.stringify(v)}` : k);
  const VALUE = "https://value-must-not-be-indexed.example";
  const TOKEN = "token_value_not_in_index";
  const docs = buildIndex({
    secrets: [{ id: "s1", name: "S_ONE", stage: "staging", status: "expired", places: [{ repo: "app" }], owner: "anna", tags: ["x"], description: "d", notes: TOKEN, link: TOKEN } as never],
    variables: [{ id: "v1", name: "V_ONE", stage: "dev", places: [{ repo: "app" }], value: VALUE } as never],
    repos: [{ name: "app", secrets: 1, variables: 1, link: { path: "/Users/x/private/app" } } as never],
    stages: [{ id: "dev", kind: "dev" }],
    connections: [{ id: "github", label: "GitHub", connected: true }],
    providers: [{ id: "random-hex", label: "Random hex" }],
    t,
  });
  it("contains no variable value, note, link, token or local path", () => {
    const all = JSON.stringify(docs);
    for (const bad of [VALUE, TOKEN, "/Users/x/private", "launch"]) expect(all).not.toContain(bad);
    expect(search(docs, "value-must-not-be-indexed")).toEqual([]);
  });
  it("covers secrets, variables, repos, stages, connections, providers, pages and actions", () => {
    expect(new Set(docs.map((d) => d.kind))).toEqual(new Set(["secret", "variable", "repo", "stage", "connection", "provider", "page", "action"]));
    expect(docs.find((d) => d.id === "secret:s1")!.badge).toMatchObject({ tone: "danger" });
    const find = (q: string) => search(docs as PaletteDoc[], q).map((h) => h.doc.id);
    expect(find("zum vergleich")[0]).toBe("action:run-compare");
    expect(find("integration hinzufuegen")[0]).toBe("action:add-connection");
    expect(find("dev env erzeugen")).toContain("action:dev-env");
    expect(find("team sync")).toContain("action:team-sync");
  });
  it("actions only open pages (no side effects)", () => {
    for (const d of docs.filter((x) => x.kind === "action")) expect(d.href.startsWith("/")).toBe(true);
  });
  it("filter values come from the index", () => {
    const v = filterValues(docs);
    expect(v["stage"]).toEqual(expect.arrayContaining(["staging", "dev"]));
    expect(v["status"]).toEqual(expect.arrayContaining(["expired", "abgelaufen"]));
    expect(v["art"]).toContain("variable");
  });
});

describe("platform detection", () => {
  it("mac, ios and others", () => {
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "iPhone" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });
  it("labels and shortcut", () => {
    expect(shortcutLabel("mac", "de")).toBe("⌘K");
    expect(shortcutLabel("other", "de")).toBe("Strg K");
    expect(shortcutLabel("other", "en")).toBe("Ctrl K");
    const e = (o: object) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    expect(isPaletteShortcut(e({ metaKey: true }), "mac")).toBe(true);
    expect(isPaletteShortcut(e({ ctrlKey: true }), "mac")).toBe(false);
    expect(isPaletteShortcut(e({ ctrlKey: true }), "other")).toBe(true);
    expect(isPaletteShortcut(e({ metaKey: true }), "other")).toBe(false);
    expect(isPaletteShortcut(e({ ctrlKey: true, shiftKey: true }), "other")).toBe(false);
    expect(isPaletteShortcut(e({ ctrlKey: true, key: "j" }), "other")).toBe(false);
  });
  it("touch detection", () => {
    expect(isTouchDevice({ maxTouchPoints: 5, platform: "Linux armv8l" }, undefined)).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 0, platform: "Win32" }, undefined)).toBe(false);
    expect(isTouchDevice({ platform: "Win32" }, true)).toBe(true);
    expect(isTouchDevice({ platform: "MacIntel" }, false)).toBe(false);
  });
});

describe("keyboard navigation", () => {
  it("arrow keys, home and end stay in range; other keys are not navigation", () => {
    expect(nextActive(0, 5, "ArrowDown")).toBe(1);
    expect(nextActive(4, 5, "ArrowDown")).toBe(4);
    expect(nextActive(0, 5, "ArrowUp")).toBe(0);
    expect(nextActive(3, 5, "Home")).toBe(0);
    expect(nextActive(0, 5, "End")).toBe(4);
    expect(nextActive(0, 5, "a")).toBeNull();
    expect(nextActive(0, 0, "Enter")).toBeNull();
  });
  it("Tab jumps to the next group and wraps", () => {
    expect(nextGroupStart(0, [3, 2, 4])).toBe(3);
    expect(nextGroupStart(4, [3, 2, 4])).toBe(5);
    expect(nextGroupStart(7, [3, 2, 4])).toBe(0);
    expect(nextGroupStart(0, [])).toBe(0);
  });
  it("focus trap wraps at both ends", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
    expect(trapTarget(3, 1, false)).toBeNull();
    expect(trapTarget(0, 0, false)).toBeNull();
    expect(trapTarget(3, -1, true)).toBe(2);
  });
});

describe("history (local, search terms only)", () => {
  const mem = (): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  it("records, dedupes, limits and clears", () => {
    const s = mem();
    for (let i = 0; i < 12; i++) recordItem(s, `secret:${i}`);
    recordItem(s, "secret:5");
    recordQuery(s, "stripe");
    recordQuery(s, "x");
    const h = loadHistory(s);
    expect(h.items[0]).toBe("secret:5");
    expect(h.items).toHaveLength(8);
    expect(h.queries).toEqual(["stripe"]);
    clearHistory(s);
    expect(loadHistory(s)).toMatchObject({ items: [], queries: [], enabled: true });
  });
  it("can be switched off and then stores nothing", () => {
    const s = mem();
    recordQuery(s, "stripe");
    setHistoryEnabled(s, false);
    recordQuery(s, "again");
    recordItem(s, "secret:1");
    expect(loadHistory(s)).toEqual({ items: [], queries: [], enabled: false });
    setHistoryEnabled(s, true);
    recordQuery(s, "again");
    expect(loadHistory(s).queries).toEqual(["again"]);
  });
  it("survives blocked storage", () => {
    const broken: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => { recordQuery(broken, "stripe"); recordItem(broken, "x"); clearHistory(broken); }).not.toThrow();
    expect(loadHistory(broken).items).toEqual([]);
    expect(loadHistory(undefined).enabled).toBe(false);
  });
  it("stores only ids and queries, never indexed values", () => {
    const s = mem();
    recordItem(s, "secret:s1");
    recordQuery(s, "stripe");
    expect([...s.data.values()].join(" ")).not.toMatch(/http|token|value/i);
  });
});

describe("performance", () => {
  it("ranks 1000 entries in well under 16 ms per keystroke (median)", () => {
    const words = ["stripe", "supabase", "cloudflare", "resend", "grafana", "github", "token", "secret", "key", "webhook", "service", "role", "public", "site", "url"];
    const docs: SearchDoc[] = Array.from({ length: 1000 }, (_, i) => {
      const name = [0, 1, 2].map((k) => words[(i * (k + 3) + k) % words.length]!.toUpperCase()).join("_") + `_${i}`;
      return doc(`id-${i}`, name, { tags: [words[i % words.length]!, "config"], description: `Used by ${words[(i + 5) % words.length]} in staging for the ${words[(i + 7) % words.length]} flow of the application`, attrs: { stage: ["staging"], repo: [`repo-${i % 20}`] } });
    });
    const queries = ["s", "st", "str", "stri", "strip", "stripe sec", "stripe secr", "supabase url", "sdr", "stage:staging key", "repo:repo-3 token", "strpe secrt"];
    const times: number[] = [];
    for (let rep = 0; rep < 5; rep++) for (const q of queries) {
      const t0 = performance.now();
      search(docs, q, { limit: 50 });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const worst = times[times.length - 1]!;
    console.log(`search 1000 docs: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
    expect(median).toBeLessThan(16);
  });
});
