import { describe, expect, it } from "vitest";
import { repoNames } from "../src/lib/browse";
import { placeText } from "../src/lib/format";
import { searchText } from "../src/lib/page-search";
import { defaultAccountId, emptyPlaceRow, rowsToPlaces } from "../src/lib/places";
import { prefillRow } from "../src/lib/prefill";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const worker = (over: Partial<ReturnType<typeof emptyPlaceRow>> = {}) => ({ ...emptyPlaceRow(), scope: "cloudflare-worker" as const, accountId: ACCOUNT, script: "acme-portal-staging", ...over });

describe("rowsToPlaces: Worker rows", () => {
  it("turns a Worker row into a Worker place, next to a GitHub row", () => {
    const r = rowsToPlaces([worker({ accountId: ` ${ACCOUNT} `, script: " acme-portal-staging " }), { repo: "acme-app", scope: "repository", environment: "" }]);
    expect(r.error).toBeNull();
    expect(r.places).toEqual([{ scope: "cloudflare-worker", accountId: ACCOUNT, script: "acme-portal-staging" }, { repo: "acme-app", scope: "repository" }]);
  });
  it("drops an empty Worker row", () => {
    expect(rowsToPlaces([worker({ accountId: "", script: "" })])).toEqual({ places: [], error: null });
  });
  it("names what is missing or malformed", () => {
    expect(rowsToPlaces([worker({ accountId: "" })]).error).toMatch(/Konto/);
    expect(rowsToPlaces([worker({ accountId: "acc1" })]).error).toMatch(/32/);
    expect(rowsToPlaces([worker({ script: "" })]).error).toMatch(/Worker-Name/);
    expect(rowsToPlaces([worker({ script: "../etc" })]).error).toMatch(/\.\.\/etc/);
  });
  it("a Worker row ignores a leftover repository or environment text", () => {
    expect(rowsToPlaces([worker({ repo: "leftover", environment: "x" })]).places).toEqual([{ scope: "cloudflare-worker", accountId: ACCOUNT, script: "acme-portal-staging" }]);
  });
});

describe("defaultAccountId", () => {
  const res = (defaults: Record<string, unknown>, options: string[] | null) => ({ defaults, resources: { "cloudflare.account": options ? { status: "ok", options: options.map((value) => ({ value })) } : { status: "not-connected", options: [] } } });
  it("takes the integration default first", () => expect(defaultAccountId(res({ accountId: ACCOUNT }, ["x", "y"]))).toBe(ACCOUNT));
  it("else the only account the token sees", () => expect(defaultAccountId(res({}, ["only"]))).toBe("only"));
  it("else nothing: no guess between several accounts or without a connection", () => {
    expect(defaultAccountId(res({}, ["a", "b"]))).toBe("");
    expect(defaultAccountId(res({}, null))).toBe("");
    expect(defaultAccountId(undefined)).toBe("");
  });
});

describe("views of a Worker place", () => {
  const place = { scope: "cloudflare-worker", accountId: ACCOUNT, script: "acme-portal-staging" };
  it("shows the Worker name and the kind", () => expect(placeText(place)).toBe("acme-portal-staging / Cloudflare Worker"));
  it("has no repository: repoNames skips it", () => expect(repoNames([place, { repo: "acme-app", scope: "repository" }] as never)).toEqual(["acme-app"]));
  it("is found by script name and account in the page search", () => {
    const item: Parameters<typeof searchText>[0] = { id: "s1", name: "ANTHROPIC_API_KEY", stage: "staging", places: [place] };
    expect(searchText(item)).toContain("acme-portal-staging");
    expect(searchText(item)).toContain(ACCOUNT);
  });
  it("the prefill row stays a GitHub row", () => expect(prefillRow([], { name: "X", repo: "acme-app", stage: "", id: "", description: "" }).scope).toBe("repository"));
});
