import { describe, expect, it } from "vitest";
import { buildCards, cardMatches, connectedKeyCount, earliestExpiry, groupByCategory, isInUse, legacyKeys, primaryKeys, showsLegacyHint, waysOf, type CardInput, type ConnectionRow, type FacadeRow, type ProviderRow, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";

const v = (id: string, label: string, category: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category, icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const catalog: VendorsResponse = {
  categories: ["code", "payments", "messaging", "print", "other"],
  vendors: [
    v("github", "GitHub", "code", { connections: ["github"], optionalConnections: ["github-app-key"], providers: ["github-fine-grained-token"], recipes: ["github-fine-grained-token"] }),
    v("stripe", "Stripe", "payments", { connectionPrefixes: ["stripe:"], legacyConnections: ["stripe", "stripe-test", "stripe-live"], providers: ["stripe-restricted-key"], recipes: ["stripe-restricted-key"] }),
    v("telegram", "Telegram", "messaging", { providers: ["telegram-bot"] }),
    v("peecho", "Peecho", "print", { signInPlanned: true }),
  ],
};
const conn = (id: string, vendor: string | null, role: ConnectionRow["role"], connected: boolean, daysLeft?: number): ConnectionRow => ({ id, label: id, vendor, role, connected, ...(daysLeft !== undefined ? { daysLeft } : {}) });
const prov = (id: string, vendor: string | null, extra: Partial<ProviderRow> = {}): ProviderRow => ({ id, label: id, kind: "manual", vendor, guide: { url: "https://example.test", steps: [] }, ...extra });
const stripeFacade: FacadeRow = { id: "stripe", label: "Stripe", available: true, connected: true, reason: null, connectionId: "stripe" };

const input: CardInput = {
  catalog,
  connections: [
    conn("github", "github", "primary", true, 40),
    conn("github-app-key", "github", "optional", false),
    conn("stripe", "stripe", "legacy", false),
    conn("stripe-test", "stripe", "legacy", true, 20),
    conn("stripe-live", "stripe", "legacy", false),
    conn("stripe:acct_1AbC:sandbox", "stripe", "primary", true, 3),
    conn("stripe:acct_1AbC:live", "stripe", "primary", true, 90),
  ],
  providers: [
    prov("github-fine-grained-token", "github"),
    prov("stripe-restricted-key", "stripe"),
    prov("telegram-bot", "telegram"),
    prov("stripe-restricted-key-browser", "stripe", { browser: true }),
    prov("random-hex", null, { kind: "automatic", guide: null }),
  ],
  recipes: [{ id: "github-fine-grained-token", label: "GitHub Fine-grained Token" }, { id: "stripe-restricted-key", label: "Stripe Restricted Key" }],
  facades: [stripeFacade],
  secrets: [{ vendor: "stripe" }, { vendor: "stripe" }, { vendor: "github" }, { vendor: null }],
  variables: [{ from: { connection: "stripe:acct_1AbC:live" } }, { from: { connection: "github" } }, { from: null }],
};
const card = (id: string, i: CardInput = input) => buildCards(i).find((c) => c.id === id)!;

describe("buildCards: one card per provider", () => {
  it("makes one card per catalog vendor, ordered by category and then by name", () => {
    expect(buildCards(input).map((c) => c.id)).toEqual(["github", "stripe", "telegram", "peecho"]);
  });
  it("folds github-app-key into the GitHub card as an optional key", () => {
    const gh = card("github");
    expect(gh.keys.map((k) => [k.id, k.role])).toEqual([["github", "primary"], ["github-app-key", "optional"]]);
    expect(buildCards(input).some((c) => c.id.includes("github-app-key"))).toBe(false);
  });
  it("puts the Stripe per-account keys first and the legacy connections last, as older connections", () => {
    const s = card("stripe");
    expect(primaryKeys(s).map((k) => k.id)).toEqual(["stripe:acct_1AbC:live", "stripe:acct_1AbC:sandbox"]);
    expect(legacyKeys(s).map((k) => k.id)).toEqual(["stripe", "stripe-live", "stripe-test"]);
    expect(s.keys.slice(-3).every((k) => k.role === "legacy")).toBe(true);
  });
  it("hints at replacing a legacy connection only while one is connected and a sign-in exists", () => {
    expect(showsLegacyHint(card("stripe"))).toBe(true);
    const noLegacy = { ...input, connections: input.connections.filter((c) => c.id !== "stripe-test") };
    expect(showsLegacyHint(card("stripe", noLegacy))).toBe(false);
    expect(showsLegacyHint(card("stripe", { ...input, facades: [] }))).toBe(false);
  });
  it("derives the expiry level per key", () => {
    expect(card("stripe").keys.find((k) => k.id === "stripe:acct_1AbC:sandbox")?.level).toBe("critical");
    expect(card("stripe").keys.find((k) => k.id === "stripe:acct_1AbC:live")?.level).toBe("ok");
    expect(card("github").keys.find((k) => k.id === "github-app-key")?.level).toBeNull();
  });
});

describe("buildCards: ways in", () => {
  it("shows the guided sign-in for a provider with a facade", () => {
    expect(card("stripe").signIn).toMatchObject({ state: "facade", available: true, facade: { id: "stripe" } });
  });
  it("shows recipes for a provider with a recipe but no facade", () => {
    const gh = card("github").signIn;
    expect(gh.state).toBe("recipe");
    expect(gh.recipes.map((r) => r.id)).toEqual(["github-fine-grained-token"]);
    expect(gh.available).toBe(true);
  });
  it("marks recipes as unavailable when none is loaded", () => {
    const off = card("github", { ...input, recipes: [] }).signIn;
    expect(off).toMatchObject({ state: "recipe", available: false });
  });
  it("shows 'recipe coming' for Peecho and no sign-in way for a provider with only an API", () => {
    expect(card("peecho").signIn.state).toBe("coming");
    expect(card("telegram").signIn.state).toBe("none");
    expect(waysOf(card("telegram"))).toEqual({ signIn: false, keys: false, byHand: true });
    expect(waysOf(card("stripe"))).toEqual({ signIn: true, keys: true, byHand: false });
  });
  it("folds manual definitions behind a loaded recipe into the sign-in, and leaves the rest by hand", () => {
    expect(card("stripe").byHand).toEqual([]);
    expect(card("github").byHand).toEqual([]);
    expect(card("telegram").byHand.map((p) => p.id)).toEqual(["telegram-bot"]);
    // With the recipe not loaded the manual guide is the only way left.
    expect(card("github", { ...input, recipes: [] }).byHand.map((p) => p.id)).toEqual(["github-fine-grained-token"]);
  });
  it("never lists browser providers or generators by hand", () => {
    expect(buildCards(input).flatMap((c) => c.byHand).map((p) => p.id)).toEqual(["telegram-bot"]);
  });
});

describe("buildCards: status and counts", () => {
  it("is connected when a key or the sign-in's keys are connected", () => {
    expect(card("github").status).toBe("connected");
    expect(card("stripe").status).toBe("connected");
    expect(card("telegram").status).toBe("none");
  });
  it("is connected through the facade even when the connection list lacks the key", () => {
    expect(card("stripe", { ...input, connections: [] }).status).toBe("connected");
    expect(card("stripe", { ...input, connections: [], facades: [{ ...stripeFacade, connected: false }] }).status).toBe("none");
  });
  it("shows 'sign-in active' for a checked sign-in without keys", () => {
    const base = { ...input, connections: [], facades: [{ ...stripeFacade, connected: false }] };
    expect(card("stripe", { ...base, signedIn: new Set(["stripe"]) }).status).toBe("signin");
    expect(card("stripe", { ...base, signedIn: new Set(["github"]) }).status).toBe("none");
  });
  it("counts entries by vendor (recipe entries included) and variables through their connection", () => {
    expect(card("stripe")).toMatchObject({ secrets: 2, variables: 1 });
    expect(card("github")).toMatchObject({ secrets: 1, variables: 1 });
    expect(card("telegram")).toMatchObject({ secrets: 0, variables: 0 });
  });
  it("shows on the page only providers that are set up or have entries attached", () => {
    expect(buildCards(input).filter(isInUse).map((c) => c.id)).toEqual(["github", "stripe"]);
    const attachedOnly = { ...input, connections: [], facades: [], secrets: [{ vendor: "telegram" }] };
    expect(buildCards(attachedOnly).filter(isInUse).map((c) => c.id)).toEqual(["telegram"]);
  });
});

describe("buildCards: providers the catalog does not know", () => {
  const extra: CardInput = {
    ...input,
    providers: [...input.providers, prov("acme-license", null, { label: "Acme license" })],
    connections: [...input.connections, conn("acme-gateway", null, "primary", true)],
  };
  it("adds a card in 'other' for a manual provider added by hand and for an unknown connection", () => {
    const cards = buildCards(extra);
    const custom = cards.filter((c) => c.custom);
    expect(custom.map((c) => [c.id, c.category]).sort()).toEqual([["connection:acme-gateway", "other"], ["provider:acme-license", "other"]]);
    expect(custom.find((c) => c.id === "provider:acme-license")?.byHand.map((p) => p.id)).toEqual(["acme-license"]);
    expect(custom.find((c) => c.id === "connection:acme-gateway")?.status).toBe("connected");
    expect(cards.at(-1)?.custom).toBe(true);
  });
});

describe("groupByCategory", () => {
  it("groups in catalog order and leaves out empty categories", () => {
    const groups = groupByCategory(buildCards(input), catalog.categories);
    expect(groups.map((g) => [g.category, g.cards.map((c) => c.id)])).toEqual([["code", ["github"]], ["payments", ["stripe"]], ["messaging", ["telegram"]], ["print", ["peecho"]]]);
  });
  it("puts a category the catalog does not list under other", () => {
    const stray = { ...buildCards(input)[0]!, category: "mystery" };
    expect(groupByCategory([stray], catalog.categories).map((g) => g.category)).toEqual(["other"]);
  });
});

describe("cardMatches", () => {
  const stripe = card("stripe");
  const extra = { purpose: "Webhooks and restricted keys per account and mode", category: "Payments and subscriptions" };
  it("matches name, category and purpose, case-insensitively", () => {
    expect(cardMatches(stripe, "STRIPE", extra)).toBe(true);
    expect(cardMatches(stripe, "payments", extra)).toBe(true);
    expect(cardMatches(stripe, "webhooks", extra)).toBe(true);
  });
  it("needs every word to match, in any order", () => {
    expect(cardMatches(stripe, "payments stripe", extra)).toBe(true);
    expect(cardMatches(stripe, "payments github", extra)).toBe(false);
  });
  it("matches everything for an empty needle and nothing for a stranger", () => {
    expect(cardMatches(stripe, "   ", extra)).toBe(true);
    expect(cardMatches(stripe, "zzz", extra)).toBe(false);
  });
  it("also finds a provider by a way in (a manual definition's name)", () => {
    expect(cardMatches(card("telegram"), "telegram-bot", { purpose: "", category: "" })).toBe(true);
  });
});

describe("earliestExpiry", () => {
  const cardWith = (rows: ConnectionRow[]) => buildCards({ catalog, connections: rows, providers: [], recipes: [], facades: [] }).find((c) => c.id === "stripe")!;
  it("picks the connected key that runs out first, with its end date", () => {
    const card = cardWith([
      { ...conn("stripe:acct_1AbC:sandbox", "stripe", "primary", true, 3), expires: "2026-11-06" },
      { ...conn("stripe:acct_1AbC:live", "stripe", "primary", true, 90), expires: "2027-02-01" },
      { ...conn("stripe-test", "stripe", "legacy", false, 1), expires: "2026-11-04" },
    ]);
    expect(earliestExpiry(card)).toEqual({ keyId: "stripe:acct_1AbC:sandbox", expires: "2026-11-06", daysLeft: 3, level: "critical" });
    expect(connectedKeyCount(card)).toBe(2);
  });
  it("says nothing when no connected key has a known end", () => {
    expect(earliestExpiry(cardWith([conn("stripe:acct_1AbC:live", "stripe", "primary", true)]))).toBeNull();
    expect(earliestExpiry(cardWith([conn("stripe:acct_1AbC:live", "stripe", "primary", false, 5)]))).toBeNull();
    expect(earliestExpiry(cardWith([]))).toBeNull();
  });
  it("reports an expired key as such", () => {
    expect(earliestExpiry(cardWith([conn("stripe:acct_1AbC:live", "stripe", "primary", true, -2)]))?.level).toBe("expired");
  });
});
