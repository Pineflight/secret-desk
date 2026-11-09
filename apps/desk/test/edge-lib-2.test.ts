import { describe, expect, it } from "vitest";
import { observeOnce } from "../src/lib/in-view";
import { summarize } from "../src/lib/integration-summary";
import { parseLaunchInput } from "../src/lib/launch";
import { filterBySearch, highlightTerms, isTypingTarget, searchText } from "../src/lib/page-search";
import { clearHistory, loadHistory, recordItem, recordQuery, setHistoryEnabled } from "../src/lib/palette-history";
import { buildIndex, filterValues } from "../src/lib/palette-index";
import { nextActive } from "../src/lib/palette-nav";
import { rowsToPlaces } from "../src/lib/places";
import { detectPlatform, isTouchDevice, shortcutLabel } from "../src/lib/platform-keys";
import { prefillRow, readPrefill, withoutPrefill } from "../src/lib/prefill";

describe("in-view without IntersectionObserver", () => {
  it("reports seen at once and returns a no-op stop function", () => {
    let seen = 0;
    const stop = observeOnce({} as Element, () => seen++);
    expect(seen).toBe(1);
    expect(stop()).toBeUndefined();
  });
});

describe("integration summary ordering", () => {
  it("orders equal rows by label and ignores places without a repo", () => {
    const out = summarize(
      [{ id: "b-id", connected: true, label: "Bravo" }, { id: "a-id", connected: true, label: "Alpha" }],
      [{ connection: null, automatic: false, params: { status: "none", missing: [] }, places: [{ scope: "cloudflare-worker" }, { repo: "r" }] }],
      [],
    );
    expect(out.rows.map((r) => r.label)).toEqual(["Alpha", "Bravo"]);
    expect(out.repos).toBe(1);
  });
});

describe("launch input", () => {
  it("rejects a launch parameter that is empty or missing its value", () => {
    expect(parseLaunchInput("http://127.0.0.1:4747/?launch=")).toBeNull();
    expect(parseLaunchInput("http://127.0.0.1:4747/?launch=%20")).toBeNull();
  });
  it("rejects an address that mentions launch= without such a parameter", () => {
    expect(parseLaunchInput("http://127.0.0.1:4747/?other_launch=0123456789abcdef0123")).toBeNull();
  });
  it("rejects an address the URL parser cannot read", () => {
    expect(parseLaunchInput("http://[::1/?launch=0123456789abcdef0123")).toBeNull();
  });
});

describe("page search", () => {
  const item = (over: Record<string, unknown> = {}) => ({ id: "i1", name: "ONE", stage: "staging", places: [], ...over }) as unknown as { id: string; name: string; stage: string; places: [] };
  it("searches source and tags of a variable", () => {
    const text = searchText(item({ from: { connection: "cf", kind: "k", resource: "res", field: "fld" }, tags: ["pay"] }));
    expect(text).toContain("res");
    expect(text).toContain("pay");
    expect(searchText(item())).toBe("i1\none\nstaging");
  });
  it("keeps everything for a query without terms or filters", () => {
    const items = [item(), item({ id: "i2" })];
    expect(filterBySearch(items, "stage:")).toBe(items);
    expect(filterBySearch(items, "   ")).toBe(items);
  });
  it("filters by owner and status words and handles missing tags", () => {
    const a = item({ id: "a", owner: "ann", status: "due", stage: "prod" });
    const b = item({ id: "b", status: "custom-state", stage: "prod" });
    expect(filterBySearch([a, b], "owner:ann").map((i) => i.id)).toEqual(["a"]);
    expect(filterBySearch([a, b], "status:faellig").map((i) => i.id)).toEqual(["a"]);
    expect(filterBySearch([a, b], "status:custom").map((i) => i.id)).toEqual(["b"]);
  });
  it("finds items whose places have no repo", () => {
    const worker = item({ id: "w", name: "WORKER_KEY", places: [{ scope: "cloudflare-worker", script: "edge" }] });
    expect(filterBySearch([worker, item()], "worker_key").map((i) => i.id)).toEqual(["w"]);
  });
  it("returns the highlight words of a query", () => {
    expect(highlightTerms("Foo stage:prod bar")).toEqual(["foo", "bar"]);
  });
  it("detects typing targets", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
});

describe("palette history without storage or with broken data", () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
  };
  it("does nothing without a storage", () => {
    expect(() => {
      recordItem(undefined, "a");
      recordQuery(undefined, "query");
      clearHistory(undefined);
      setHistoryEnabled(undefined, true);
    }).not.toThrow();
    expect(loadHistory(undefined)).toEqual({ items: [], queries: [], enabled: false });
  });
  it("treats stored values that are not a list as empty", () => {
    const s = store();
    const keys = [...s.data.keys()];
    expect(keys).toEqual([]);
    recordItem(s, "a");
    const itemsKey = [...s.data.keys()][0]!;
    s.setItem(itemsKey, '{"not":"a list"}');
    expect(loadHistory(s).items).toEqual([]);
  });
});

describe("palette index edge cases", () => {
  const t = (k: string) => k;
  const base = { stages: [], repos: [], providers: [], connections: [], t };
  it("builds docs for entries with unusual statuses, no tags and an owner", () => {
    const docs = buildIndex({
      ...base,
      secrets: [{ id: "s1", name: "S_ONE", stage: "prod", status: "weird", places: [] }],
      variables: [{ id: "v1", name: "V_ONE", stage: "prod", places: [], owner: "ann", tags: ["pay"] }, { id: "v2", name: "V_TWO", stage: "prod", places: [] }],
      connections: [{ id: "cf", label: "Cloudflare", connected: false }],
    } as never);
    const secret = docs.find((d) => d.id === "secret:s1")!;
    expect(secret.badge).toEqual({ text: "common.status.weird", tone: "muted" });
    expect(secret.attrs.status).toEqual(["weird"]);
    expect(secret.attrs.tag).toEqual([]);
    expect(docs.find((d) => d.id === "variable:v1")!.attrs).toMatchObject({ owner: ["ann"], tag: ["pay"] });
    expect(docs.find((d) => d.id === "variable:v2")!.attrs).toMatchObject({ owner: [], tag: [] });
    expect(docs.find((d) => d.id === "connection:cf")!.badge).toEqual({ text: "palette.notConnected", tone: "warn" });
  });
  it("lists only plain lowercase words as status filter values", () => {
    const docs = [{ attrs: { status: ["ok", "In Ordnung", "no-date"] }, kind: "secret" }] as never;
    expect(filterValues(docs)["status"]).toEqual(["ok"]);
  });
});

describe("palette navigation", () => {
  it("jumps to the first row for arrow keys on an empty list and ignores other keys", () => {
    expect(nextActive(0, 0, "ArrowDown")).toBe(0);
    expect(nextActive(0, 0, "a")).toBeNull();
  });
});

describe("places without optional fields", () => {
  it("treats a worker row without account id and script as empty", () => {
    expect(rowsToPlaces([{ repo: "", scope: "cloudflare-worker", environment: "" }])).toEqual({ places: [], error: null });
  });
});

describe("platform keys", () => {
  it("falls back to other for an empty navigator and no touch without data", () => {
    expect(detectPlatform({})).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
    expect(isTouchDevice(undefined, undefined)).toBe(false);
    expect(isTouchDevice({}, undefined)).toBe(false);
    expect(isTouchDevice({ maxTouchPoints: 5 }, undefined)).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 5, platform: "MacIntel" }, undefined)).toBe(false);
    expect(isTouchDevice({}, false)).toBe(false);
  });
  it("labels the shortcut per platform and language", () => {
    expect(shortcutLabel("mac", "en")).toBe("⌘K");
    expect(shortcutLabel("other", "de")).toBe("Strg K");
    expect(shortcutLabel("other", "en")).toBe("Ctrl K");
  });
});

describe("prefill", () => {
  it("reads a prefill only when a name is present and defaults the rest", () => {
    expect(readPrefill(new URLSearchParams())).toBeNull();
    expect(readPrefill(new URLSearchParams("pf_name=A"))).toEqual({ name: "A", repo: "", stage: "", id: "", description: "" });
    expect(readPrefill(new URLSearchParams("pf_name=A&pf_repo=r&pf_stage=s&pf_id=i&pf_desc=d"))).toEqual({ name: "A", repo: "r", stage: "s", id: "i", description: "d" });
  });
  it("removes the new marker and every prefill key but keeps other parameters", () => {
    const out = withoutPrefill(new URLSearchParams("new=secret&neu=1&pf_name=A&pf_repo=r&pf_stage=s&pf_id=i&pf_desc=d&q=keep"));
    expect(out.toString()).toBe("q=keep");
  });
  it("targets the environment only for a stage that has one", () => {
    const defs = [{ id: "prod", label: "Prod", kind: "live", environment: "production" }, { id: "dev", label: "Dev", kind: "dev", environment: null }] as never;
    const p = { name: "A", repo: "r", stage: "prod", id: "", description: "" };
    expect(prefillRow(defs, p)).toMatchObject({ scope: "environment" });
    expect(prefillRow(defs, { ...p, stage: "dev" })).toMatchObject({ scope: "repository" });
    expect(prefillRow(defs, { ...p, stage: "" })).toMatchObject({ scope: "repository" });
  });
});
