import { describe, expect, it } from "vitest";
import { buildCards, capitalized, connectionLines, expiryLine, lineExpiry, hostLinePhaseKey, type CardInput, type ConnectionRow, type FacadeRow, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";
import { checkHostsOf, checkPathOf } from "../src/lib/sign-in-check";
import { messages } from "../src/messages";
import { translate } from "../src/lib/i18n";

const NOW = new Date("2026-11-04T12:00:00Z");
const t = (key: string, vars?: Record<string, string | number>): string => translate(key, vars, "en");
const v = (id: string, label: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category: "other", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const catalog: VendorsResponse = {
  categories: ["other"],
  vendors: [
    v("acme-ai", "Acme AI", { connections: ["acme-ai"], recipes: ["acme-admin-key", "acme-api-key"], facade: true }),
    v("acme-pay", "Acme Pay", { connectionPrefixes: ["acme-pay:"], legacyConnections: ["acme-pay", "acme-pay-test"], recipes: ["acme-pay-key"], facade: true }),
    v("acme-print", "Acme Print", { recipes: ["acme-print-keys"] }),
  ],
};
const recipes = [
  { id: "acme-admin-key", label: "Admin key", host: "console.acme-ai.test", canCheckSignIn: true },
  { id: "acme-api-key", label: "API key", host: "console.acme-ai.test", canCheckSignIn: true },
  { id: "acme-pay-key", label: "Pay key", host: "dash.acme-pay.test", canCheckSignIn: true },
  { id: "acme-print-keys", label: "Print keys", host: "www.acme-print.test", hostBy: "mode", hosts: [{ value: "live", host: "admin.acme-print.test" }, { value: "test", host: "admin-test.acme-print.test" }], canCheckSignIn: true },
];
const facade = (id: string, extra: Partial<FacadeRow> = {}): FacadeRow => ({ id, label: id, available: true, connected: false, reason: null, connectionId: id, ...extra });
const input = (extra: Partial<CardInput> = {}): CardInput => ({ catalog, connections: [], providers: [], recipes, facades: [facade("acme-ai"), facade("acme-pay")], secrets: [], variables: [], now: NOW, automationEnabled: true, ...extra });
const card = (id: string, i: CardInput = input()) => buildCards(i).find((c) => c.id === id)!;
const conn = (id: string, label: string, rest: Partial<ConnectionRow> = {}): ConnectionRow => ({ id, label, vendor: "acme-pay", role: "primary", connected: true, ...rest });

describe("a provider with a guided sign-in always offers Connect", () => {
  it("has the facade although the provider also has recipes with browser sign-in", () => {
    const c = card("acme-ai");
    expect(c.signIn.state).toBe("facade");
    expect(c.signIn.facade).toMatchObject({ id: "acme-ai", available: true, connected: false });
    // The check goes through the facade, not through one of the recipes.
    expect(checkPathOf(c)).toBe("facades/acme-ai/check");
    expect(c.signIn.checkRecipe).toBeNull();
    expect(checkHostsOf(c)).toEqual([]);
  });

  it("keeps the facade when the facade list did not say anything about the vendor (request failed or not loaded)", () => {
    const c = card("acme-ai", input({ facades: [] }));
    expect(c.signIn.state).toBe("facade");
    expect(c.signIn.facade).toMatchObject({ id: "acme-ai", available: true, connected: false });
    expect(checkPathOf(c)).toBe("facades/acme-ai/check");
  });

  it("marks that fallback unavailable while browser automation is off or the recipe is missing", () => {
    expect(card("acme-ai", input({ facades: [], automationEnabled: false })).signIn.facade?.available).toBe(false);
    expect(card("acme-ai", input({ facades: [], recipes: [] })).signIn.facade?.available).toBe(false);
  });

  it("reports the fallback as connected when a key is connected", () => {
    const c = card("acme-ai", input({ facades: [], connections: [conn("acme-ai", "Acme AI", { vendor: "acme-ai" })] }));
    expect(c.signIn.facade?.connected).toBe(true);
    expect(c.worksWithoutBrowser).toBe(true);
  });

  it("does not invent a facade for a vendor that has none", () => {
    expect(card("acme-print").signIn.facade).toBeNull();
    expect(card("acme-print").signIn.state).toBe("recipe");
  });
});

describe("connectionLines: one line per connection, one for the older ones", () => {
  const conns = [
    conn("acme-pay:acct_1:sandbox", "Acme Pay Shop (Sandbox)", { daysLeft: 90, expires: "2027-02-01" }),
    conn("acme-pay:acct_1:live", "Acme Pay Shop (Live)", { daysLeft: 5, expires: "2026-11-09" }),
    conn("acme-pay:acct_2:live", "Acme Pay acct_2 (Live)"),
    conn("acme-pay:acct_3:live", "Acme Pay Closed (Live)", { connected: false }),
    conn("acme-pay", "Acme Pay", { role: "legacy" }),
    conn("acme-pay-test", "Acme Pay test", { role: "legacy" }),
  ];
  const lines = () => connectionLines(card("acme-pay", input({ connections: conns })));

  it("names the account and the mode of every connected connection, sandbox before live", () => {
    expect(lines().accounts.map((l) => [l.id, l.account, l.accountId, l.mode])).toEqual([
      ["acme-pay:acct_2:live", "acct_2", "acct_2", "live"],
      ["acme-pay:acct_1:sandbox", "Shop", "acct_1", "sandbox"],
      ["acme-pay:acct_1:live", "Shop", "acct_1", "live"],
    ]);
  });

  it("carries the expiry of the key and leaves out connections that are not connected", () => {
    const [, sandbox, live] = lines().accounts;
    expect(sandbox).toMatchObject({ expires: "2027-02-01", level: "ok" });
    expect(live).toMatchObject({ expires: "2026-11-09", level: "critical" });
    expect(lines().accounts.some((l) => l.id.endsWith("acct_3:live"))).toBe(false);
  });

  it("folds the connected older connections into one line", () => {
    expect(lines().legacy).toEqual({ ids: ["acme-pay", "acme-pay-test"], labels: ["Acme Pay", "Acme Pay test"] });
    expect(lines().others).toEqual([]);
  });

  it("has no legacy line without an older connection and keeps other keys as they are", () => {
    const only = connectionLines(card("acme-pay", input({ connections: [conn("acme-pay:acct_1:live", "Acme Pay Shop (Live)")] })));
    expect(only.legacy).toBeNull();
    expect(only.accounts).toHaveLength(1);
    const plain = connectionLines(card("acme-ai", input({ connections: [conn("acme-ai", "Acme AI", { vendor: "acme-ai" })] })));
    expect(plain.accounts).toEqual([]);
    expect(plain.others.map((k) => k.id)).toEqual(["acme-ai"]);
  });

  it("never contains a key value: only ids, labels and dates", () => {
    const text = JSON.stringify(lines());
    expect(text).not.toMatch(/rk_|sk_|token/i);
  });

  it("says what the expiry is: a date, never, or unknown", () => {
    expect(lineExpiry({ expires: "2027-02-01", daysLeft: 90 }, t)).toContain("Valid until");
    expect(lineExpiry({ expires: null, daysLeft: null }, t)).toBe("Never expires");
    expect(lineExpiry({ expires: undefined, daysLeft: null }, t)).toBe("Validity not specified");
  });
});

describe("expiry of browser-managed values", () => {
  const secrets = (rows: { expiry: string; daysLeft?: number | null; expires?: string | null }[]) => rows.map((r, i) => ({ vendor: "acme-print", browser: true, id: `s${i}`, daysLeft: null, expires: null, ...r }));
  const print = (rows: Parameters<typeof secrets>[0]) => card("acme-print", input({ secrets: secrets(rows) }));

  it("says it does not expire when every entry is a read-only key without expiry", () => {
    const c = print([{ expiry: "none" }, { expiry: "none" }]);
    expect(c.browser?.neverExpires).toBe(true);
    expect(expiryLine(c, t)).toEqual({ text: "Does not expire", level: null });
    expect(messages.de["providers.card.browserNeverExpires"]).toBeTruthy();
  });

  it("leaves entries without expiry out of the earliest expiry", () => {
    const c = print([{ expiry: "none" }, { expiry: "required", daysLeft: 20, expires: "2026-11-24" }]);
    expect(c.browser?.neverExpires).toBe(false);
    expect(c.browser?.expiry).toMatchObject({ daysLeft: 20, keyId: "s1" });
    expect(expiryLine(c, t)?.text).toContain("Earliest expiry");
  });

  it("still says not specified for entries whose expiry is simply unknown", () => {
    const c = print([{ expiry: "none" }, { expiry: "unknown" }]);
    expect(c.browser?.neverExpires).toBe(false);
    expect(expiryLine(c, t)?.text).toBe("Expiry not specified");
  });
});

describe("a queued check is a status, not a button label", () => {
  it("names the status of the portal while a check waits or runs", () => {
    expect(hostLinePhaseKey("waiting")).toBe("providers.card.hostWaiting");
    expect(hostLinePhaseKey("checking")).toBe("providers.card.hostChecking");
    expect(hostLinePhaseKey(undefined)).toBeNull();
  });

  it("reads as a sentence with the portal name", () => {
    expect(t("providers.card.hostWaiting", { portal: capitalized("live") })).toBe("Live: waiting for the browser …");
    expect(translate("providers.card.hostWaiting", { portal: "Live" }, "de")).toBe("Live: wartet auf den Browser …");
  });

  it("keeps the button labels naming the action only", () => {
    expect(t("providers.signIn.hostCheck", { portal: "live" })).toBe("Check live");
    expect(messages.en["providers.signIn.hostWaiting"]).toBeUndefined();
    expect(messages.en["providers.signIn.hostChecking"]).toBeUndefined();
  });
});

describe("catalogs", () => {
  it("define every new key in German and English", () => {
    const keys = ["providers.mode.sandbox", "providers.mode.live", "providers.page.facadesFailed", "providers.card.hostWaiting", "providers.card.hostChecking", "providers.card.browserNeverExpires", ...["title", "hint", "missing", "connectMode", "connectModeLabel", "keyConnected", "legacyTitle.one", "legacyTitle.other"].map((k) => `providers.account.${k}`), ...["testOk", "testProblems", "test", "testLabel", "reconnect", "reconnectLabel", "remove", "removeLabel", "details", "connect", "connectAnother"].map((k) => `providers.line.${k}`)];
    for (const k of keys) {
      expect(messages.en[k], k).toBeTruthy();
      expect(messages.de[k], k).toBeTruthy();
    }
  });
});
