import { describe, expect, it } from "vitest";
import { buildCards, hostLineNote, type CardInput, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";
import { renewalWarnings, type WarnableEntry } from "../src/lib/renewal-warning";
import { checkBodyOf, checkHostsOf, checkIdOf, checkPathOf, signInStatus, signedInIds, splitCheckId, outcomeOf } from "../src/lib/sign-in-check";
import { messages } from "../src/messages";
import { translate } from "../src/lib/i18n";

const NOW = new Date("2026-11-04T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const v = (id: string, label: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category: "other", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const catalog: VendorsResponse = { categories: ["other"], vendors: [v("printco", "Print Co", { recipes: ["printco-keys"] }), v("single", "Single Co", { recipes: ["single-key"] })] };
const recipes = [
  { id: "printco-keys", label: "Print Co keys", host: "app.printco.test", hostBy: "portal", hosts: [{ value: "live", host: "app.printco.test" }, { value: "test", host: "sandbox.printco.test" }], canCheckSignIn: true },
  { id: "single-key", label: "Single key", host: "dash.single.test", hostBy: null, hosts: [], canCheckSignIn: true },
];
const base = (extra: Partial<CardInput> = {}): CardInput => ({ catalog, connections: [], providers: [], recipes, facades: [], secrets: [], variables: [], now: NOW, signInFreshHours: 12, automationEnabled: true, ...extra });
const printco = (i: CardInput) => buildCards(i).find((c) => c.id === "printco")!;
const t = (key: string, vars?: Record<string, string | number>): string => translate(key, vars, "en");

describe("provider card: one sign-in line per portal", () => {
  it("has a line for each host, each with its own answer", () => {
    const c = printco(base({ signInChecks: [{ host: "app.printco.test", signedIn: true, checkedAt: ago(120) }, { host: "sandbox.printco.test", signedIn: false, checkedAt: ago(10) }] }));
    expect(c.browser?.hostLines.map((l) => [l.value, l.host, l.readiness.state])).toEqual([["live", "app.printco.test", "ready"], ["test", "sandbox.printco.test", "signed-out"]]);
    expect(c.browser?.hostLines[0]?.readiness.ageMinutes).toBe(120);
  });

  it("says never checked for a portal without any answer", () => {
    const c = printco(base({ signInChecks: [{ host: "app.printco.test", signedIn: true, checkedAt: ago(5) }] }));
    expect(c.browser?.hostLines[1]?.readiness).toMatchObject({ state: "unknown", checkedAt: null });
  });

  it("counts an old answer as unknown, per portal", () => {
    const c = printco(base({ signInChecks: [{ host: "sandbox.printco.test", signedIn: true, checkedAt: ago(13 * 60) }] }));
    expect(c.browser?.hostLines[1]?.readiness).toMatchObject({ state: "unknown", stale: true });
  });

  it("measures the session lifetime per portal", () => {
    const c = printco(base({ signInLifetimes: [{ host: "sandbox.printco.test", averageMinutes: 5 * 60 }] }));
    expect(c.browser?.hostLines.map((l) => l.sessionHours)).toEqual([null, 5]);
  });

  it("has no lines for a recipe with one host, and its state comes from that host", () => {
    const c = buildCards(base({ signInChecks: [{ host: "dash.single.test", signedIn: true, checkedAt: ago(5) }] })).find((x) => x.id === "single")!;
    expect(c.browser?.hostLines).toEqual([]);
    expect(c.browser?.readiness.state).toBe("ready");
    expect(c.signIn.checkHosts).toEqual([]);
  });

  it("looks at every host of the card for the card status (a sign-in at the test portal counts)", () => {
    const c = printco(base({ signInChecks: [{ host: "sandbox.printco.test", signedIn: true, checkedAt: ago(5) }] }));
    expect(c.browser?.readiness).toMatchObject({ state: "ready" });
  });

  it("offers the portals of the checkable recipe", () => {
    expect(printco(base()).signIn.checkHosts).toEqual([{ value: "live", host: "app.printco.test" }, { value: "test", host: "sandbox.printco.test" }]);
  });
});

describe("the text of a portal line", () => {
  const line = (over: Partial<Parameters<typeof hostLineNote>[0]["readiness"]>) => hostLineNote({ readiness: { state: "unknown", checkedAt: null, ageMinutes: null, stale: false, ...over } });
  it("names the provider and the portal", () => {
    expect(t("providers.card.hostReady", { name: "Print Co", portal: "live", when: "2 hours ago" })).toBe("Print Co live: signed in · checked 2 hours ago");
    expect(t("providers.card.hostSignedOut", { name: "Print Co", portal: "test" })).toBe("Print Co test: sign-in needed");
  });
  it("picks the sentence from the readiness", () => {
    expect(line({ state: "ready", checkedAt: "x", ageMinutes: 120 })).toEqual({ key: "providers.card.hostReady", age: { unit: "hours", count: 2 } });
    expect(line({ state: "signed-out", checkedAt: "x", ageMinutes: 3 })).toEqual({ key: "providers.card.hostSignedOut", age: null });
    expect(line({})).toEqual({ key: "providers.card.hostUnknownNever", age: null });
    expect(line({ state: "unknown", checkedAt: "x", ageMinutes: 900, stale: true }).key).toBe("providers.card.hostUnknownChecked");
  });
  it("exists in German and English", () => {
    for (const k of ["hostReady", "hostSignedOut", "hostUnknownChecked", "hostUnknownNever", "hostWaiting", "hostChecking"]) {
      expect(messages.de[`providers.card.${k}`], k).toBeTruthy();
      expect(messages.en[`providers.card.${k}`], k).toBeTruthy();
    }
    for (const k of ["hostYes", "hostNo", "hostCheck", "hostFailed"]) {
      expect(messages.de[`providers.signIn.${k}`], k).toBeTruthy();
      expect(messages.en[`providers.signIn.${k}`], k).toBeTruthy();
    }
  });
});

describe("check sign-in per portal", () => {
  const card = () => printco(base());
  it("keys a check by provider and host, and splits it again", () => {
    expect(checkIdOf("printco", "sandbox.printco.test")).toBe("printco#sandbox.printco.test");
    expect(checkIdOf("printco")).toBe("printco");
    expect(splitCheckId("printco#sandbox.printco.test")).toEqual({ cardId: "printco", host: "sandbox.printco.test" });
    expect(splitCheckId("printco")).toEqual({ cardId: "printco", host: null });
  });
  it("sends the host in the request body, none for a provider with one portal", () => {
    expect(checkBodyOf("sandbox.printco.test")).toEqual({ host: "sandbox.printco.test" });
    expect(checkBodyOf(null)).toBeUndefined();
    expect(checkPathOf(card())).toBe("recipes/printco-keys/check");
    expect(checkHostsOf(card()).map((h) => h.host)).toEqual(["app.printco.test", "sandbox.printco.test"]);
    expect(checkHostsOf(buildCards(base()).find((c) => c.id === "single")!)).toEqual([]);
  });
  it("leaves the card-level state to the lines, and counts one signed-in portal as signed in", () => {
    expect(signInStatus(card(), undefined, undefined)).toBeNull();
    expect(signInStatus(buildCards(base()).find((c) => c.id === "single")!, undefined, undefined)).toBe("unchecked");
    const yes = outcomeOf({ signedIn: true, checkedAt: "x" });
    const no = outcomeOf({ signedIn: false, checkedAt: "x" });
    expect([...signedInIds({ "printco#sandbox.printco.test": yes, "printco#app.printco.test": no })]).toEqual(["printco"]);
    expect([...signedInIds({ "printco#app.printco.test": no })]).toEqual([]);
  });
});

describe("renewal warning uses the portal of the entry", () => {
  const entry = (id: string, browserHost: string | null, daysLeft = 3): WarnableEntry => ({ id, name: id.toUpperCase(), vendor: "printco", browser: true, expires: "2026-11-07", daysLeft, browserHost });
  const checks = [{ host: "app.printco.test", signedIn: true, checkedAt: ago(20) }, { host: "sandbox.printco.test", signedIn: false, checkedAt: ago(20) }];
  const warn = (entries: WarnableEntry[], extra: Partial<CardInput> = {}) => renewalWarnings(entries, buildCards(base({ signInChecks: checks, ...extra })));

  it("warns for an entry of the portal that is signed out, not for one of the portal that is signed in", () => {
    const warnings = warn([entry("test-key", "sandbox.printco.test"), entry("live-key", "app.printco.test")]);
    expect(warnings.map((w) => [w.secretId, w.state])).toEqual([["test-key", "signed-out"]]);
  });

  it("warns when the entry's own portal was never checked, even if the other one is signed in", () => {
    const warnings = warn([entry("test-key", "sandbox.printco.test")], { signInChecks: [checks[0]!] });
    expect(warnings.map((w) => [w.secretId, w.state])).toEqual([["test-key", "unknown"]]);
  });

  it("does not warn when the entry's portal is signed in although the other one is signed out", () => {
    expect(warn([entry("live-key", "app.printco.test")])).toEqual([]);
    expect(warn([entry("live-key", "app.printco.test")], { signInChecks: [{ host: "app.printco.test", signedIn: true, checkedAt: ago(20) }, { host: "sandbox.printco.test", signedIn: false, checkedAt: ago(20) }] })).toEqual([]);
  });

  it("falls back to the card's state without a portal (single host or unknown)", () => {
    expect(warn([entry("k", null)])).toEqual([]);
  });
});
