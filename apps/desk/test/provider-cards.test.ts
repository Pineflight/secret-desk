import { describe, expect, it } from "vitest";
import { messages } from "../src/messages";
import { CONNECTION_PURPOSES, browserNote, buildCards, cardMatches, connectedKeyCount, connectionPurposeKey, detailKeys, dialogHeading, earliestExpiry, managedExpiry, groupByCategory, isInUse, legacyKeys, primaryKeys, showsLegacyHint, waysOf, type CardInput, type ConnectionRow, type FacadeRow, type ProviderRow, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";

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

describe("card status for browser-only providers", () => {
  const NOW = new Date("2026-11-03T12:00:00Z");
  const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const cat: VendorsResponse = {
    categories: ["data", "print", "ai", "other"],
    vendors: [
      v("dataapi", "Data API", "data", { recipes: ["dataapi-key"], providers: [] }),
      v("printco", "Print Co", "print", { recipes: ["printco-readonly"] }),
      v("aico", "AI Co", "ai", { connections: ["aico"], providers: ["aico"], recipes: ["aico-admin-key"] }),
      v("nobrowser", "No Browser", "other", { providers: ["nb-manual"] }),
    ],
  };
  const recipes = [
    { id: "dataapi-key", label: "Data API Key", host: "dash.dataapi.test", canCheckSignIn: false },
    { id: "printco-readonly", label: "Print Co", host: "app.printco.test", canCheckSignIn: true },
    { id: "aico-admin-key", label: "AI Co admin", host: "platform.aico.test", canCheckSignIn: true },
  ];
  const base = (extra: Partial<CardInput> = {}): CardInput => ({ catalog: cat, connections: [], providers: [], recipes, facades: [], secrets: [], variables: [], now: NOW, signInFreshHours: 12, automationEnabled: true, ...extra });
  const managed = (vendor: string, id: string, daysLeft: number | null, expires: string | null = null) => ({ vendor, browser: true, id, daysLeft, expires });
  const one = (id: string, i: CardInput) => buildCards(i).find((c) => c.id === id)!;

  it("is ready when the recipe host was seen signed in recently, with the age", () => {
    const c = one("dataapi", base({ signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(180) }] }));
    expect(c.status).toBe("ready");
    expect(c.browser?.readiness).toMatchObject({ state: "ready", ageMinutes: 180 });
    expect(isInUse(c)).toBe(true);
  });
  it("needs sign-in when the fresh answer is no", () => {
    expect(one("printco", base({ signInChecks: [{ host: "app.printco.test", signedIn: false, checkedAt: ago(5) }] })).status).toBe("signout");
  });
  it("is unknown (not red, not 'not set up') when the answer is too old and the browser manages entries", () => {
    const c = one("dataapi", base({ signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(13 * 60) }], secrets: [managed("dataapi", "k1", 40)] }));
    expect(c.status).toBe("unknown");
    expect(c.browser?.readiness).toMatchObject({ state: "unknown", stale: true });
    expect(isInUse(c)).toBe(true);
  });
  it("is unknown when never checked but the browser manages entries", () => {
    expect(one("dataapi", base({ secrets: [managed("dataapi", "k1", 40)] })).status).toBe("unknown");
  });
  it("is 'not set up' only without any usable sign-in answer and without managed entries", () => {
    expect(one("dataapi", base()).status).toBe("none");
    expect(one("dataapi", base({ signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(13 * 60) }] })).status).toBe("none");
    expect(isInUse(one("dataapi", base()))).toBe(false);
  });
  it("is 'not set up' when browser automation is off, whatever was remembered", () => {
    const c = one("dataapi", base({ automationEnabled: false, signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(1) }], secrets: [managed("dataapi", "k1", 40)] }));
    expect(c.status).toBe("none");
    expect(c.browser).toBeNull();
  });
  it("is 'not set up' when the recipe is not loaded", () => {
    const c = one("dataapi", base({ recipes: [], signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(1) }] }));
    expect(c.status).toBe("none");
  });
  it("a freshly checked host of another vendor does not count", () => {
    expect(one("dataapi", base({ signInChecks: [{ host: "app.printco.test", signedIn: true, checkedAt: ago(1) }] })).status).toBe("none");
  });
  it("counts the entries the browser manages and shows the earliest expiry among them", () => {
    const c = one("dataapi", base({ secrets: [managed("dataapi", "k1", 40, "2026-12-13"), managed("dataapi", "k2", 12, "2026-11-15"), managed("dataapi", "k3", null), { vendor: "dataapi", browser: false, id: "k4", daysLeft: 2 }, managed("printco", "k5", 1)] }));
    expect(c.browser?.secrets).toBe(3);
    expect(c.browser?.expiry).toMatchObject({ keyId: "k2", daysLeft: 12, level: "soon", expires: "2026-11-15" });
    expect(managedExpiry(c)).toBe(c.browser!.expiry);
    expect(one("dataapi", base({ secrets: [managed("dataapi", "k1", null)] })).browser?.expiry).toBeNull();
  });
  it("an API connection wins over the browser state and the card says it works without the browser", () => {
    const c = one("aico", base({ connections: [conn("aico", "aico", "primary", true, 30)], facades: [{ id: "aico", label: "AI Co", available: true, connected: true, reason: null, connectionId: "aico" }], signInChecks: [{ host: "platform.aico.test", signedIn: false, checkedAt: ago(1) }] }));
    expect(c.status).toBe("connected");
    expect(c.worksWithoutBrowser).toBe(true);
    expect(browserNote(c)).toEqual({ key: "providers.card.worksWithoutBrowser", age: null });
    expect(managedExpiry(c)).toMatchObject({ keyId: "aico" });
  });
  it("a facade provider without a connection is judged by the browser like any other", () => {
    const f: FacadeRow = { id: "aico", label: "AI Co", available: true, connected: false, reason: null, connectionId: "aico" };
    const c = one("aico", base({ facades: [f], signInChecks: [{ host: "platform.aico.test", signedIn: true, checkedAt: ago(2) }] }));
    expect(c.status).toBe("ready");
    expect(c.worksWithoutBrowser).toBe(false);
    expect(c.signIn.checkRecipe).toBeNull();
  });
  it("offers the recipe check only for a recipe with a guided sign-in and no facade", () => {
    expect(one("dataapi", base()).signIn.checkRecipe).toBeNull();
    expect(one("printco", base()).signIn.checkRecipe).toBe("printco-readonly");
  });
  it("describes the browser in one line: fresh yes, fresh no, old answer, never checked", () => {
    const status = (checks: CardInput["signInChecks"], secrets = [managed("dataapi", "k", 40)]) => browserNote(one("dataapi", base({ signInChecks: checks ?? [], secrets })));
    expect(status([{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(180) }])).toEqual({ key: "providers.card.browserReadyChecked", age: { unit: "hours", count: 3 } });
    expect(status([{ host: "dash.dataapi.test", signedIn: false, checkedAt: ago(30) }])).toEqual({ key: "providers.card.browserSignedOutChecked", age: { unit: "minutes", count: 30 } });
    expect(status([{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(14 * 60) }])).toEqual({ key: "providers.card.browserUnknownChecked", age: { unit: "hours", count: 14 } });
    expect(status([])).toEqual({ key: "providers.card.browserUnknownNever", age: null });
    expect(browserNote(one("nobrowser", base()))).toBeNull();
  });
  it("uses the configured age and the default of 12 hours", () => {
    const checks = [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(5 * 60) }];
    expect(one("dataapi", base({ signInChecks: checks, signInFreshHours: 4 })).browser?.readiness.state).toBe("unknown");
    expect(one("dataapi", base({ signInChecks: checks, signInFreshHours: 6 })).browser?.readiness.state).toBe("ready");
    const noAge = base({ signInChecks: checks });
    delete noAge.signInFreshHours;
    expect(one("dataapi", noAge).browser?.readiness.state).toBe("ready");
  });
  it("a check from this page session still counts when the server remembers nothing", () => {
    expect(one("dataapi", base({ signedIn: new Set(["dataapi"]) })).status).toBe("signin");
  });
});

describe("detailKeys: the keys section of the integration dialog", () => {
  const grafana = catalog.vendors.concat([v("grafana", "Grafana Cloud", "payments", { connections: ["grafana"], optionalConnections: ["grafana-cloud"], providers: ["grafana-service-account-token"], recipes: ["grafana-cloud-access-policy"] })]);
  const cat = { ...catalog, vendors: grafana };
  const gFacade: FacadeRow = { id: "grafana", label: "Grafana Cloud", available: true, connected: false, reason: null, connectionId: "grafana-cloud" };
  const build = (connections: ConnectionRow[], facades: FacadeRow[]) => buildCards({ catalog: cat, connections, providers: [], recipes: [{ id: "grafana-cloud-access-policy", label: "Grafana Cloud access policy token" }], facades }).find((c) => c.id === "grafana")!;

  it("lists both Grafana connections: the stack token is pasted, the Cloud token comes from the sign-in", () => {
    const c = build([conn("grafana", "grafana", "primary", false), conn("grafana-cloud", "grafana", "optional", false)], [gFacade]);
    expect(c.signIn.state).toBe("facade");
    expect(detailKeys(c).map((k) => [k.id, k.action])).toEqual([["grafana", "paste"], ["grafana-cloud", "signin"]]);
  });
  it("a connected Cloud token has no button of its own (the sign-in section reconnects it); the stack token stays editable", () => {
    const c = build([conn("grafana", "grafana", "primary", true, 40), conn("grafana-cloud", "grafana", "optional", true, 80)], [{ ...gFacade, connected: true }]);
    expect(detailKeys(c).map((k) => [k.id, k.action])).toEqual([["grafana", "paste"], ["grafana-cloud", "none"]]);
  });
  it("without a facade every key can be set up by pasting", () => {
    const c = build([conn("grafana", "grafana", "primary", false), conn("grafana-cloud", "grafana", "optional", false)], []);
    expect(detailKeys(c).map((k) => [k.id, k.action])).toEqual([["grafana", "paste"], ["grafana-cloud", "paste"]]);
  });
  it("keeps the old behavior of a single-key facade (only connected keys, no buttons) and of Stripe (per-account keys managed by the sign-in)", () => {
    expect(detailKeys(card("stripe")).map((k) => [k.id, k.action])).toEqual([["stripe:acct_1AbC:live", "none"], ["stripe:acct_1AbC:sandbox", "none"], ["stripe-test", "none"]]);
    const one = buildCards({ catalog: { ...catalog, vendors: [v("aico", "AI Co", "code", { connections: ["aico"] })] }, connections: [conn("aico", "aico", "primary", false)], providers: [], recipes: [], facades: [{ id: "aico", label: "AI Co", available: true, connected: false, reason: null, connectionId: "aico" }] })[0]!;
    expect(detailKeys(one)).toEqual([]);
  });
});

describe("dialogHeading: the integration dialog names the connection it is about", () => {
  const cat = { ...catalog, vendors: catalog.vendors.concat([v("grafana", "Grafana Cloud", "payments", { connections: ["grafana"], optionalConnections: ["grafana-cloud"], providers: ["grafana-service-account-token"], recipes: ["grafana-cloud-access-policy"] })]) };
  const gFacade: FacadeRow = { id: "grafana", label: "Grafana Cloud", available: true, connected: false, reason: null, connectionId: "grafana-cloud" };
  const labelled = (id: string, label: string, role: ConnectionRow["role"]): ConnectionRow => ({ ...conn(id, "grafana", role, false), label });
  const grafana = (connections: ConnectionRow[]) => buildCards({ catalog: cat, connections, providers: [], recipes: [{ id: "grafana-cloud-access-policy", label: "Grafana Cloud access policy token" }], facades: [gFacade] }).find((c) => c.id === "grafana")!;
  const both = grafana([labelled("grafana", "Grafana Cloud", "primary"), labelled("grafana-cloud", "Grafana Cloud (Konto)", "optional")]);

  it("titles the Grafana account sign-in with the account connection and its purpose, not the vendor's stack purpose", () => {
    expect(dialogHeading(both, { kind: "signin" })).toEqual({ title: "Grafana Cloud (Konto)", purposeKey: "connectionPurpose.grafanaCloud" });
  });
  it("titles a pasted key with its own connection", () => {
    expect(dialogHeading(both, { kind: "key", id: "grafana" })).toEqual({ title: "Grafana Cloud", purposeKey: "connectionPurpose.grafana" });
  });
  it("keeps the vendor header on the overview and on a by-hand provider", () => {
    expect(dialogHeading(both, null)).toEqual({ title: "Grafana Cloud", purposeKey: null });
    expect(dialogHeading(both, { kind: "hand", id: "grafana-service-account-token" })).toEqual({ title: "Grafana Cloud", purposeKey: null });
  });
  it("keeps the vendor header for a vendor with a single connection", () => {
    const one = grafana([labelled("grafana-cloud", "Grafana Cloud (Konto)", "optional")]);
    expect(dialogHeading(one, { kind: "signin" })).toEqual({ title: "Grafana Cloud", purposeKey: null });
    expect(dialogHeading(one, { kind: "key", id: "grafana-cloud" })).toEqual({ title: "Grafana Cloud", purposeKey: null });
  });
  it("keeps the vendor header for a sign-in that picks its connection itself (Stripe per account and mode)", () => {
    const stripe = card("stripe");
    expect(dialogHeading(stripe, { kind: "signin" })).toEqual({ title: "Stripe", purposeKey: null });
    expect(dialogHeading(stripe, { kind: "key", id: "stripe:acct_1AbC:live" })).toEqual({ title: "stripe:acct_1AbC:live", purposeKey: null });
  });
  it("falls back to the vendor header when the connection is unknown to the card", () => {
    expect(dialogHeading(both, { kind: "key", id: "elsewhere" })).toEqual({ title: "Grafana Cloud", purposeKey: null });
  });
  it("has a purpose line in both languages for every listed connection, and none for others", () => {
    for (const key of Object.values(CONNECTION_PURPOSES)) {
      expect(messages.de[key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
    expect(connectionPurposeKey("grafana-cloud")).toBe("connectionPurpose.grafanaCloud");
    expect(connectionPurposeKey("stripe:acct_1AbC:live")).toBeNull();
  });
});
