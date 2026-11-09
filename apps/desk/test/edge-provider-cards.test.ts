import { describe, expect, it } from "vitest";
import {
  buildCards, capabilityLabelKey, dialogHeading, expiryLine, hasSeveralConnections, missingKeys, producedRows, stripeAccounts,
  type CardInput, type ConnectionRow, type ProviderCard, type ProviderRow, type VendorInfo, type VendorsResponse,
} from "../src/lib/provider-cards";

const vendor = (id: string, label: string, category: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category, icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const conn = (id: string, v: string | null, role: ConnectionRow["role"], connected: boolean, extra: Partial<ConnectionRow> = {}): ConnectionRow => ({ id, label: id, vendor: v, role, connected, ...extra });
const catalog = (vendors: VendorInfo[], categories = ["code", "other"]): VendorsResponse => ({ categories, vendors });
const base = (c: VendorsResponse, over: Partial<CardInput> = {}): CardInput => ({ catalog: c, connections: [], providers: [], recipes: [], facades: [], ...over });
const key = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, connected: true, role: "primary" as const, daysLeft: null, expires: null, level: null, ...over });
const stub = (over: Record<string, unknown> = {}): ProviderCard => ({
  id: "x", label: "X", category: "other", icon: null, custom: false, status: "none", signIn: { state: "none", facade: null, recipes: [], available: false }, keys: [],
  byHand: [], prefixes: [], browser: null, worksWithoutBrowser: false, browserSignedIn: false, produces: [], secrets: 0, variables: 0, ...over,
}) as ProviderCard;

describe("producedRows", () => {
  it("orders equal counts by label", () => {
    const providers: ProviderRow[] = [
      { id: "p-b", label: "Beta", kind: "automatic", vendor: null, guide: null },
      { id: "p-a", label: "Alpha", kind: "automatic", vendor: null, guide: null },
    ];
    expect(producedRows([{ vendor: null, provider: "p-b" }, { vendor: null, provider: "p-a" }], providers).map((r) => r.label)).toEqual(["Alpha", "Beta"]);
  });
});

describe("buildCards edge cases", () => {
  it("synthesizes a guided sign-in for a facade vendor the list does not mention, available by default when a recipe exists", () => {
    const c = base(catalog([vendor("rc", "RC", "code", { facade: true, recipes: ["r1"] })]), { recipes: [{ id: "r1", label: "R1" }] });
    const card = buildCards(c)[0]!;
    expect(card.signIn.state).toBe("facade");
    expect(card.signIn.facade).toMatchObject({ id: "rc", available: true });
    const off = buildCards({ ...c, automationEnabled: false })[0]!;
    expect(off.signIn.facade).toMatchObject({ available: false });
  });
  it("puts vendors of unknown categories last and orders by name inside one category", () => {
    const c = catalog([vendor("z", "Zed", "unknown-cat"), vendor("b", "Beta", "code"), vendor("a", "Alpha", "code")]);
    expect(buildCards(base(c)).map((x) => x.id)).toEqual(["a", "b", "z"]);
    const reversed = catalog([vendor("a", "Alpha", "code"), vendor("z", "Zed", "unknown-cat"), vendor("y", "Why", "unknown-cat")]);
    expect(buildCards(base(reversed)).map((x) => x.id)).toEqual(["a", "y", "z"]);
  });
  it("puts custom cards after catalog cards of the same category", () => {
    const c = catalog([vendor("a", "Alpha", "other")]);
    const out = buildCards(base(c, { connections: [conn("loose", null, "primary", true)] }));
    expect(out.map((x) => x.id)).toEqual(["a", "connection:loose"]);
  });
  it("reads the earliest browser-managed expiry, also for entries without an id", () => {
    const c = catalog([vendor("v", "V", "code", { recipes: ["r1"] })]);
    const input = base(c, {
      recipes: [{ id: "r1", label: "R1", host: "h.example", canCheckSignIn: true }] as never,
      secrets: [
        { vendor: "v", browser: true, daysLeft: 30 },
        { vendor: "v", browser: true, daysLeft: 20, id: "s2", expires: "2026-12-01" },
        { vendor: "v", browser: true, daysLeft: null },
        { vendor: "v", browser: true, expiry: "none", daysLeft: 1 },
        { vendor: "v", browser: true, daysLeft: 50 },
      ],
    });
    expect(buildCards(input)[0]!.browser?.expiry).toMatchObject({ keyId: "s2", daysLeft: 20, level: "ok" });
    const onlyUnnamed = buildCards({ ...input, secrets: [{ vendor: "v", browser: true, daysLeft: 3 }] })[0]!;
    expect(onlyUnnamed.browser?.expiry).toMatchObject({ keyId: "", daysLeft: 3, level: "critical" });
  });
});

describe("connection lines", () => {
  const prefixed = (keys: ReturnType<typeof key>[]) => stub({ id: "stripe", label: "Stripe", prefixes: ["stripe:"], keys });
  it("derives account and mode from the id and keeps other connected keys as they are", () => {
    const card = prefixed([
      key("stripe:acct_solo", { label: "stripe:acct_solo" }),
      key("stripe:acct_1:weird", { label: "Stripe Acme (weird)" }),
      key("stripe:acct_1:live", { label: "Stripe Acme (live)" }),
      key("stripe:acct_1:test", { label: "Stripe Acme (test)" }),
      key("github-app-key", { label: "App", role: "optional" }),
      key("stripe:acct_1", { label: "Stripe Acme" }),
      key("stripe:acct_2", { label: "Stripe Acme" }),
    ]);
    const blocks = stripeAccounts(card);
    expect(blocks.map((b) => b.accountId)).toEqual(["acct_solo", "acct_1", "acct_2"]);
    const acme = blocks.find((b) => b.accountId === "acct_1")!;
    expect(acme.account).toBe("Acme");
    expect(acme.modes.sandbox?.id).toBe("stripe:acct_1:test");
    expect(acme.modes.live?.id).toBe("stripe:acct_1:live");
    expect(acme.other.map((l) => l.id)).toEqual(["stripe:acct_1:weird", "stripe:acct_1"]);
    expect(blocks.find((b) => b.accountId === "acct_solo")!.account).toBe("acct_solo");
  });
});

describe("expiryLine", () => {
  const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}|${v["date"]}` : k);
  const NOW = new Date("2026-11-04T10:00:00Z");
  it("says nothing for a card without keys and without browser entries", () => {
    expect(expiryLine({ keys: [], browser: null }, t, NOW)).toBeNull();
  });
  it("derives the date from the days left when the key has no date", () => {
    const line = expiryLine({ keys: [key("k", { daysLeft: 10, level: "soon", expires: null })], browser: null }, t, NOW);
    expect(line).toEqual({ text: "providers.card.expiryWarn|14.11.2026", level: "soon" });
  });
  it("distinguishes never-expiring keys from unknown expiry", () => {
    expect(expiryLine({ keys: [key("k", { expires: null })], browser: null }, t, NOW)?.text).toBe("providers.card.neverExpires");
    expect(expiryLine({ keys: [key("k", { expires: "2027-01-01" })], browser: null }, t, NOW)?.text).toBe("providers.card.expiryUnknown");
    expect(expiryLine({ keys: [key("k", { expires: undefined })], browser: null }, t, NOW)?.text).toBe("providers.card.expiryUnknown");
  });
  it("reports browser values that never expire", () => {
    const browser = { readiness: { state: "ready" }, secrets: 2, expiry: null, neverExpires: true, sessionHours: null, hostLines: [] } as never;
    expect(expiryLine({ keys: [], browser }, t, NOW)).toEqual({ text: "providers.card.browserNeverExpires", level: null });
  });
});

describe("dialog heading and capabilities", () => {
  it("keeps the vendor heading for an unknown connection and names it when the card has several", () => {
    const one = stub({ label: "Acme", keys: [key("mystery", { label: "Mystery key" })] });
    expect(dialogHeading(one, { kind: "key", id: "mystery" })).toMatchObject({ title: "Acme", titleKey: null });
    expect(dialogHeading(one, { kind: "key", id: "absent" })).toMatchObject({ title: "Acme" });
    const several = stub({ label: "Acme", keys: [key("mystery", { label: "Mystery key" }), key("other")] });
    expect(hasSeveralConnections(several)).toBe(true);
    expect(dialogHeading(several, { kind: "key", id: "mystery" })).toMatchObject({ title: "Mystery key", titleKey: null });
    expect(dialogHeading(several, { kind: "key", id: "absent" })).toMatchObject({ title: "Acme" });
    expect(dialogHeading(one, { kind: "signin" })).toMatchObject({ title: "Acme", titleKey: null });
  });
  it("names the capability of a card that needs a sign-in or has an unknown state", () => {
    expect(capabilityLabelKey(stub({ status: "signout" }))).toBe("providers.status.signout");
    expect(capabilityLabelKey(stub({ status: "unknown" }))).toBe("providers.status.unknown");
    expect(capabilityLabelKey(stub({ status: "none" }))).toBe("providers.status.none");
  });
  it("reports nothing missing on an unused card without a guided sign-in", () => {
    expect(missingKeys(stub({ status: "none", keys: [key("grafana", { connected: false })] }))).toEqual([]);
  });
});
