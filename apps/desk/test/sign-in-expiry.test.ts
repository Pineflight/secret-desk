import { describe, expect, it } from "vitest";
import { sessionHoursOf } from "../src/lib/browser-ready";
import { buildCards, type CardInput, type ConnectionRow, type FacadeRow, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";
import { DEFAULT_RENEWAL_WARN_DAYS, renewalWarnings, signInHref, signInParam, warningsById, type WarnableEntry } from "../src/lib/renewal-warning";
import { messages } from "../src/messages";

const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const v = (id: string, label: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category: "other", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const catalog: VendorsResponse = {
  categories: ["other"],
  vendors: [v("dataapi", "Data API", { recipes: ["dataapi-key"] }), v("aico", "AI Co", { connections: ["aico"], recipes: ["aico-key"] }), v("manual", "Manual Co", { providers: ["manual-key"] }), v("soon", "Soon Co", { signInPlanned: true })],
};
const recipes = [
  { id: "dataapi-key", label: "Data API key", host: "dash.dataapi.test", canCheckSignIn: true },
  { id: "aico-key", label: "AI Co key", host: "platform.aico.test", canCheckSignIn: true },
];
const aicoFacade: FacadeRow = { id: "aico", label: "AI Co", available: true, connected: false, reason: null, connectionId: "aico" };
const base = (extra: Partial<CardInput> = {}): CardInput => ({ catalog, connections: [], providers: [], recipes, facades: [aicoFacade], secrets: [], variables: [], now: NOW, signInFreshHours: 12, automationEnabled: true, ...extra });
const entry = (id: string, vendor: string | null, daysLeft: number | null, extra: Partial<WarnableEntry> = {}): WarnableEntry => ({ id, name: id.toUpperCase(), vendor, browser: true, expires: daysLeft === null ? null : `2026-11-${String(3 + daysLeft).padStart(2, "0")}`, daysLeft, ...extra });
const warn = (entries: WarnableEntry[], input: CardInput, days?: number) => renewalWarnings(entries, buildCards({ ...input, secrets: entries.map((e) => ({ vendor: e.vendor, browser: e.browser, id: e.id, daysLeft: e.daysLeft, expires: e.expires })) }), days);

describe("session lifetime on the provider card", () => {
  it("rounds the average to whole hours, at least 1, and averages over the hosts of the card", () => {
    expect(sessionHoursOf([{ host: "a.test", averageMinutes: 20 * 60 }], ["a.test"])).toBe(20);
    expect(sessionHoursOf([{ host: "a.test", averageMinutes: 10 }], ["a.test"])).toBe(1);
    expect(sessionHoursOf([{ host: "a.test", averageMinutes: 60 }, { host: "b.test", averageMinutes: 180 }], ["a.test", "b.test"])).toBe(2);
    expect(sessionHoursOf([{ host: "a.test", averageMinutes: 60 }], ["b.test"])).toBeNull();
    expect(sessionHoursOf([], ["a.test"])).toBeNull();
    expect(sessionHoursOf([{ host: "a.test", averageMinutes: Number.NaN }], ["a.test"])).toBeNull();
  });
  it("is on the browser part of the card only once a measurement exists for its host", () => {
    const find = (i: CardInput) => buildCards(i).find((c) => c.id === "dataapi")!.browser;
    expect(find(base())?.sessionHours).toBeNull();
    expect(find(base({ signInLifetimes: [{ host: "platform.aico.test", averageMinutes: 600 }] }))?.sessionHours).toBeNull();
    expect(find(base({ signInLifetimes: [{ host: "dash.dataapi.test", averageMinutes: 22 * 60 + 20 }] }))?.sessionHours).toBe(22);
  });
});

describe("renewal warnings", () => {
  const signedOut = { signInChecks: [{ host: "dash.dataapi.test", signedIn: false, checkedAt: ago(30) }] };
  it("warns for a recipe entry that is due soon while the browser is signed out", () => {
    const [w] = warn([entry("k1", "dataapi", 5)], base(signedOut));
    expect(w).toEqual({ secretId: "k1", title: "K1", vendorId: "dataapi", vendorLabel: "Data API", expires: "2026-11-08", daysLeft: 5, state: "signed-out" });
  });
  it("warns when the sign-in is unknown: never checked, or the answer is too old", () => {
    expect(warn([entry("k1", "dataapi", 5)], base())[0]?.state).toBe("unknown");
    expect(warn([entry("k1", "dataapi", 5)], base({ signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(13 * 60) }] }))[0]?.state).toBe("unknown");
  });
  it("does not warn while the browser is signed in", () => {
    expect(warn([entry("k1", "dataapi", 1)], base({ signInChecks: [{ host: "dash.dataapi.test", signedIn: true, checkedAt: ago(30) }] }))).toEqual([]);
  });
  it("uses the window: due within the days (inclusive), later is quiet, already expired still warns", () => {
    const at = (daysLeft: number, days?: number) => warn([entry("k1", "dataapi", daysLeft)], base(signedOut), days).length;
    expect(at(7)).toBe(1);
    expect(at(8)).toBe(0);
    expect(at(-2)).toBe(1);
    expect(at(14, 14)).toBe(1);
    expect(at(15, 14)).toBe(0);
    expect(DEFAULT_RENEWAL_WARN_DAYS).toBe(7);
  });
  it("is off with 0 days", () => {
    expect(warn([entry("k1", "dataapi", 1)], base(signedOut), 0)).toEqual([]);
  });
  it("skips entries that do not need a recipe, have no end date, or belong to no provider card", () => {
    const entries = [entry("manual-entry", "dataapi", 2, { browser: false }), entry("no-date", "dataapi", null), entry("no-vendor", null, 2), entry("unknown-vendor", "ghost", 2)];
    expect(warn(entries, base(signedOut))).toEqual([]);
  });
  it("skips providers that cannot sign in through the portal and cards with a connected API key", () => {
    expect(warn([entry("m", "manual", 2), entry("s", "soon", 2)], base(signedOut))).toEqual([]);
    const connected: ConnectionRow = { id: "aico", label: "aico", vendor: "aico", role: "primary", connected: true, daysLeft: 40 };
    expect(warn([entry("a", "aico", 2)], base({ connections: [connected], signInChecks: [{ host: "platform.aico.test", signedIn: false, checkedAt: ago(5) }] }))).toEqual([]);
  });
  it("does nothing when browser automation is off", () => {
    expect(warn([entry("k1", "dataapi", 2)], base({ ...signedOut, automationEnabled: false }))).toEqual([]);
  });
  it("lists the most urgent first and finds a warning by entry id", () => {
    const ws = warn([entry("late", "dataapi", 6), entry("soon", "dataapi", 1, { title: "Soon key" }), entry("also-late", "dataapi", 6)], base(signedOut));
    expect(ws.map((w) => w.secretId)).toEqual(["soon", "also-late", "late"]);
    expect(ws[0]?.title).toBe("Soon key");
    expect(warningsById(ws).get("late")?.daysLeft).toBe(6);
    expect(warningsById(ws).get("nope")).toBeUndefined();
  });
  it("carries no value: only ids, names, labels, a day and a state", () => {
    const [w] = warn([entry("k1", "dataapi", 2)], base(signedOut));
    expect(Object.keys(w!).sort()).toEqual(["daysLeft", "expires", "secretId", "state", "title", "vendorId", "vendorLabel"]);
  });
});

describe("sign-in link from a warning", () => {
  it("opens the portal's sign-in dialog on the Integrations page, never the browser viewer", () => {
    expect(signInHref("dataapi")).toBe("/connections?signin=dataapi");
    expect(signInHref("a b/c")).toBe("/connections?signin=a%20b%2Fc");
    expect(signInHref("dataapi")).not.toMatch(/vnc|viewer|http/);
  });
  it("accepts only a plain provider id from the address", () => {
    expect(signInParam("stripe")).toBe("stripe");
    expect(signInParam("aws-s3")).toBe("aws-s3");
    for (const bad of [null, undefined, "", "../x", "A", "a b", "https://evil.test", "-x"]) expect(signInParam(bad)).toBeNull();
  });
});

describe("texts", () => {
  it("exist in German and English", () => {
    for (const key of ["renewal.title", "providers.card.sessionLasts", "connections.sessionsTitle", "connections.sessionsHint", "connections.sessionsHintOff", "connections.sessionsNone", "connections.sessionIn", "connections.sessionOut", "connections.sessionChecked", "connections.sessionLasts", "connections.sessionLastsNone", "renewal.hint", "renewal.line", "renewal.badge", "renewal.badgeUnknown", "renewal.signIn", "renewal.signInAt"]) {
      for (const l of ["de", "en"] as const) expect(key in messages[l] || `${key}.other` in messages[l], `${l} ${key}`).toBe(true);
    }
  });
});
