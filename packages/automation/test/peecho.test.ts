import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, RecipeSchema, createBrowserProvider, dryRunRecipe, loadRecipeFile, runRecipe, type FakeDriverOptions, type Recipe } from "../src/index.js";

const FILE = resolve(import.meta.dirname, "../../../recipes/peecho-api-keys.yaml");

// Made-up values of the right shape (32 to 64 letters and digits).
const MERCHANT = "AbCdEf0123456789AbCdEf0123456789AbCdEf01";
const SECRET = "ZyXwVu9876543210ZyXwVu9876543210ZyXwVu98";

const MERCHANT_DD = 'css #spa dt:text-is("Merchant API Key") + dd';
const SECRET_DD = 'css #spa dt:text-is("Secret key") + dd';
const MERCHANT_INPUT = 'css :text-is("Merchant API Key") >> xpath=following::input[1]';
const SECRET_INPUT = 'css :text-is("Secret key") >> xpath=following::input[1]';
const APP_LINK = 'css a[href*="/dashboard/applications/edit?applicationId="]';

/** The recipe with short waits, so a missing element fails fast. */
async function recipe(): Promise<Recipe> {
  const r = await loadRecipeFile(FILE);
  for (const set of [r.capture.values, r.capture.fallback?.values]) for (const v of Object.values(set ?? {})) v.timeoutSeconds = 0.05;
  return r;
}

const vars = (over: Record<string, string> = {}): Record<string, string> => ({ name: "n", owner: "", days: "30", date: "2026-11-04", description: "", repos: "", permissions: "", permissionsQuery: "", stage: "test", secretId: "peecho-test", portal: "live", value: "merchantKey", companionEntry: "", ...over });

/** A signed-in browser: /dashboard answers with /dashboard/orders like the real portal. */
function driver(over: FakeDriverOptions = {}): FakeDriver {
  return new FakeDriver({
    url: "https://www.peecho.com/dashboard/orders",
    on: (e, d) => {
      if (e.action === "goto" && /\/dashboard$/.test(e.key)) d.url = `${e.key}/orders`;
    },
    ...over,
  });
}

/** The verified page: application settings, tab "API". */
const spaPage = (host = "www.peecho.com"): FakeDriverOptions => ({
  visible: ['css a[href="#spa"]', MERCHANT_DD, SECRET_DD],
  texts: { [MERCHANT_DD]: MERCHANT, [SECRET_DD]: SECRET },
  attributes: { [`${APP_LINK}@href`]: `/dashboard/applications/edit?applicationId=42` },
  url: `https://${host}/dashboard/orders`,
});

/** The first page tried: read-only inputs. */
const inputPage = (): FakeDriverOptions => ({ visible: [MERCHANT_INPUT, SECRET_INPUT], texts: { [MERCHANT_INPUT]: MERCHANT, [SECRET_INPUT]: SECRET } });

async function expectFailure(p: Promise<unknown>, kind: string): Promise<RecipeRunError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RecipeRunError);
  expect((err as RecipeRunError).kind).toBe(kind);
  return err as RecipeRunError;
}

describe("peecho-api-keys recipe", () => {
  it("is a read recipe without anything to create or revoke, and says what is verified", async () => {
    const r = await recipe();
    expect(r.kind).toBe("read");
    expect(r.host).toBe("www.peecho.com");
    expect(r.hostBy).toBe("portal");
    expect(r.hosts).toEqual({ live: "www.peecho.com", test: "test.www.peecho.com" });
    expect(r.allowHosts).toEqual([]);
    expect(r.revoke).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("createsToken");
    expect(r.capture.pick).toBe("value");
    expect(r.capture.companion).toBe("companionEntry");
    expect((await readFile(FILE, "utf8")).split("\n")[0]).toMatch(/^# STATUS: full read verified live 2026-11-04 on both portals with an existing sign-in; the sign-in form is not verified$/);
  });

  it("reads both keys from the application settings of the live portal (first page absent)", async () => {
    const d = driver(spaPage());
    const result = await runRecipe(await recipe(), vars(), d);
    expect(result.value.reveal()).toBe(MERCHANT);
    expect(result.values?.["merchantKey"]?.reveal()).toBe(MERCHANT);
    expect(result.values?.["secretKey"]?.reveal()).toBe(SECRET);
    expect(result.externalId).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
    expect(d.calls).toContain("goto https://www.peecho.com/mio-dashboard/settings/api");
    expect(d.calls).toContain("goto https://www.peecho.com/dashboard/applications/edit?applicationId=42");
    expect(d.calls.some((c) => c.includes("test.www.peecho.com"))).toBe(false);
    expect(d.closed).toBe(true);
  });

  it("reads the test portal from the test host only, with the application id of that portal", async () => {
    const d = driver({ ...spaPage("test.www.peecho.com"), attributes: { [`${APP_LINK}@href`]: "https://test.www.peecho.com/dashboard/applications/edit?applicationId=7" } });
    const result = await runRecipe(await recipe(), vars({ portal: "test", value: "secretKey" }), d);
    expect(result.value.reveal()).toBe(SECRET);
    expect(d.calls).toContain("goto https://test.www.peecho.com/dashboard/applications/edit?applicationId=7");
    expect(d.calls.some((c) => c.startsWith("goto https://www.peecho.com"))).toBe(false);
  });

  it("tries the read-only inputs first and does not open the application settings when they are there", async () => {
    const d = driver(inputPage());
    const result = await runRecipe(await recipe(), vars({ value: "secretKey" }), d);
    expect(result.value.reveal()).toBe(SECRET);
    expect(result.values?.["merchantKey"]?.reveal()).toBe(MERCHANT);
    expect(d.calls.some((c) => c.includes("applicationId"))).toBe(false);
  });

  it("fails closed when a value is missing on both pages", async () => {
    const d = driver({ ...spaPage(), visible: ['css a[href="#spa"]', MERCHANT_DD], texts: { [MERCHANT_DD]: MERCHANT } });
    const err = await expectFailure(runRecipe(await recipe(), vars(), d), "capture");
    expect(err.message).not.toContain(MERCHANT);
    expect(d.closed).toBe(true);
  });

  it("fails closed when the application link is missing or leads off the allowed hosts", async () => {
    await expectFailure(runRecipe(await recipe(), vars(), driver({ ...spaPage(), attributes: {} })), "step");
    const off = driver({ ...spaPage(), attributes: { [`${APP_LINK}@href`]: "https://evil.example.com/dashboard/applications/edit?applicationId=1" } });
    await expectFailure(runRecipe(await recipe(), vars(), off), "host");
    expect(off.calls.some((c) => c.includes("evil.example.com"))).toBe(false);
  });

  it("fails closed when a value does not match the pattern, without echoing it", async () => {
    const bad = "short-and-wrong";
    const d = driver({ ...spaPage(), texts: { [MERCHANT_DD]: bad, [SECRET_DD]: SECRET } });
    const err = await expectFailure(runRecipe(await recipe(), vars(), d), "capture");
    expect(err.message).not.toContain(bad);
    expect(err.message).not.toContain(SECRET);
  });

  it("fails closed when both values are the same", async () => {
    const d = driver({ ...spaPage(), texts: { [MERCHANT_DD]: MERCHANT, [SECRET_DD]: MERCHANT } });
    const err = await expectFailure(runRecipe(await recipe(), vars(), d), "capture");
    expect(err.message).not.toContain(MERCHANT);
  });

  it("does not pick a value the page does not carry", async () => {
    await expectFailure(runRecipe(await recipe(), vars({ value: "somethingElse" }), driver(spaPage())), "params");
  });

  it("masks the values in the evidence screenshot and the recipe's mask list", async () => {
    const d = driver(spaPage());
    const result = await runRecipe(await recipe(), vars(), d);
    expect(result.screenshots.map((s) => s.name)).toEqual(["nach-lesen"]);
    const masks = d.shots[0]?.masks ?? [];
    expect(masks).toEqual(expect.arrayContaining(["css #spa dd", "css input[readonly]", MERCHANT_DD, SECRET_DD]));
    for (const s of result.screenshots) {
      expect(s.png.toString()).not.toContain(MERCHANT);
      expect(s.png.toString()).not.toContain(SECRET);
    }
  });

  it("a dry run only navigates (nothing to create, nothing read)", async () => {
    const d = driver(spaPage());
    const dry = await dryRunRecipe(await recipe(), vars(), d);
    expect(dry.screenshots).toEqual([]);
    expect(d.calls).toContain("goto https://www.peecho.com/dashboard");
  });
});

describe("peecho-api-keys provider (kind read)", () => {
  async function provider(d: FakeDriver, opened?: { n: number }) {
    return createBrowserProvider({ recipe: await recipe(), driverFactory: () => ((opened ? opened.n++ : 0), d) });
  }
  const secret = (params: Record<string, unknown>) =>
    ({ id: "peecho-key-test", name: "PEECHO_API_KEY", stage: "test", service: "peecho", provider: "peecho-api-keys", params, places: [], expiry: "none", expires: null }) as never;
  const ctx = (params: Record<string, unknown>) => ({ secret: secret(params), params, stage: "test", connections: {} as never, fetch: fetch, now: new Date("2026-11-04T10:00:00Z"), label: "peecho-key-test-2026-11-04" }) as never;

  it("is marked read-only, has no revoke and names the companion parameter", async () => {
    const p = await provider(driver(spaPage()));
    expect(p.id).toBe("peecho-api-keys");
    expect(p.readOnly).toBe(true);
    expect(p.revoke).toBeUndefined();
    expect(p.companionParams).toEqual(["companionEntry"]);
    expect(p.params?.map((s) => s.key)).toEqual(["portal", "value", "companionEntry"]);
    expect(p.params?.find((s) => s.key === "portal")).toMatchObject({ type: "enum", required: true });
  });

  it("returns the picked key as the value and the other one as the companion, with no expiry and no external id", async () => {
    const p = await provider(driver(spaPage()));
    const issued = await p.issue!(ctx({ portal: "live", value: "merchantKey", companionEntry: "peecho-secret-live" }));
    expect(issued.value.reveal()).toBe(MERCHANT);
    expect(issued.companions).toHaveLength(1);
    expect(issued.companions?.[0]?.entryId).toBe("peecho-secret-live");
    expect(issued.companions?.[0]?.value.reveal()).toBe(SECRET);
    expect(issued.expiresAt).toBeNull();
    expect(issued.externalId).toBeUndefined();
  });

  it("maps the other way round for the entry that holds the secret key", async () => {
    const p = await provider(driver(spaPage()));
    const issued = await p.issue!(ctx({ portal: "live", value: "secretKey", companionEntry: "peecho-merchant-live" }));
    expect(issued.value.reveal()).toBe(SECRET);
    expect(issued.companions?.[0]).toMatchObject({ entryId: "peecho-merchant-live" });
    expect(issued.companions?.[0]?.value.reveal()).toBe(MERCHANT);
  });

  it("writes no companion when the entry names none", async () => {
    const p = await provider(driver(spaPage()));
    const issued = await p.issue!(ctx({ portal: "live", value: "merchantKey" }));
    expect(issued.value.reveal()).toBe(MERCHANT);
    expect(issued.companions).toBeUndefined();
  });

  it("checks the parameters before a browser is opened", async () => {
    const opened = { n: 0 };
    const p = await provider(driver(spaPage()), opened);
    await expect(p.issue!(ctx({ portal: "staging", value: "merchantKey" }))).rejects.toThrow(/portal/);
    await expect(p.issue!(ctx({ portal: "live" }))).rejects.toThrow(/value/);
    await expect(p.issue!(ctx({ portal: "live", value: "merchantKey", companionEntry: "Not A Slug" }))).rejects.toThrow(/companionEntry/);
    expect(opened.n).toBe(0);
  });

  it("says in its checks that nothing was verified against the provider", async () => {
    const p = await provider(driver(spaPage()));
    const checks = await p.verify!({ ...(ctx({ portal: "live", value: "merchantKey" }) as object), value: undefined } as never);
    expect(checks.map((c) => c.id)).toEqual(["read-shape", "read-unchecked"]);
    expect(checks.find((c) => c.id === "read-unchecked")?.label).toBe("Not checked against Peecho API keys");
    expect(JSON.stringify(checks)).not.toContain(MERCHANT);
  });

  it("the checklist talks about reading, not creating", async () => {
    const p = await provider(driver(spaPage()));
    const items = p.reviewChecklist!(secret({ portal: "test", value: "merchantKey" }));
    expect(items.join(" ")).toContain("read from the provider");
    expect(items.join(" ")).toContain("portal: test");
    expect(items.join(" ")).not.toMatch(/Rechte|Name beim Anbieter/);
  });

  it("a recipe that creates is not read-only and keeps its revoke", async () => {
    const r = RecipeSchema.parse({
      id: "sample-token",
      label: "Sample",
      host: "example.test",
      steps: [{ click: { role: "button", name: "Create", createsToken: true } }],
      capture: { token: { find: { css: "#tok" } } },
      revoke: { steps: [{ click: { role: "button", name: "Delete" } }] },
    });
    const p = createBrowserProvider({ recipe: r, driverFactory: () => new FakeDriver() });
    expect(p.readOnly).toBeUndefined();
    expect(p.revoke).toBeTypeOf("function");
    expect(p.companionParams).toBeUndefined();
  });
});

describe("kind read: schema", () => {
  const base = {
    id: "read-sample",
    label: "Read sample",
    host: "example.test",
    params: [
      { key: "value", label: "Value", options: ["a", "b"] },
      { key: "other", label: "Other", required: false, pattern: "^[a-z0-9-]+$" },
    ],
    steps: [{ goto: "https://example.test/keys" }],
    capture: { pick: "value", companion: "other", values: { a: { find: { css: "#a" }, pattern: "^[a-z]+$" }, b: { find: { css: "#b" }, pattern: "^[a-z]+$" } } },
    kind: "read",
  };
  const parse = (over: Record<string, unknown>) => RecipeSchema.safeParse({ ...base, ...over });
  const messages = (over: Record<string, unknown>): string => {
    const r = parse(over);
    return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");
  };

  it("accepts the sample", () => {
    expect(parse({}).success).toBe(true);
  });
  it("never offers a create step", () => {
    expect(messages({ steps: [{ click: { role: "button", name: "Create", createsToken: true } }] })).toContain("must not create anything");
    expect(messages({ capture: { ...base.capture, fallback: { steps: [{ click: { role: "button", name: "Go", createsToken: true } }], values: base.capture.values } } })).toContain("must not create anything");
    expect(messages({ steps: [{ click: { role: "button", name: "Save", stopsDryRun: true } }] })).toContain("must not change anything");
    expect(messages({ capture: { ...base.capture, fallback: { steps: [{ click: { role: "button", name: "Go", stopsDryRun: true } }], values: base.capture.values } } })).toContain("must not change anything");
  });
  it("has no token, no revoke, no expiry and no external id", () => {
    expect(messages({ capture: { ...base.capture, token: { find: { css: "#t" } } } })).toContain("capture.values");
    expect(messages({ revoke: { steps: [{ goto: "https://example.test/x" }] } })).toContain("nothing to revoke");
    expect(messages({ capture: { ...base.capture, expires: { from: "days" } } })).toContain("no expiry");
    expect(messages({ capture: { ...base.capture, externalId: { from: "name" } } })).toContain("externalId");
  });
  it("needs a pattern on every value (a value of any shape is never accepted)", () => {
    expect(parse({ capture: { ...base.capture, values: { a: { find: { css: "#a" } }, b: base.capture.values.b } } }).success).toBe(false);
  });
  it("needs one or two values", () => {
    expect(messages({ capture: { values: {} } })).toContain("one or two values");
    expect(messages({ capture: { pick: "value", values: { a: base.capture.values.a, b: base.capture.values.b, c: base.capture.values.a } } })).toContain("one or two values");
  });
  it("maps entries to values through declared parameters", () => {
    expect(messages({ capture: { ...base.capture, pick: undefined } })).toContain("capture.pick");
    expect(messages({ capture: { ...base.capture, pick: "nope" } })).toContain("not declared");
    expect(messages({ params: [{ key: "value", label: "Value", options: ["a", "c"] }, base.params[1]] })).toContain("lists exactly the value names");
    expect(messages({ params: [{ key: "value", label: "Value", options: ["a", "b"] }] })).toContain("not declared");
    expect(messages({ params: [base.params[0], { key: "other", label: "Other", pattern: "^[a-z]+$" }] })).toContain("is optional");
    expect(messages({ capture: { ...base.capture, companion: "value" } })).toContain("different parameters");
  });
  it("the fallback reads the same value names", () => {
    expect(messages({ capture: { ...base.capture, fallback: { steps: [{ goto: "https://example.test/alt" }], values: { a: base.capture.values.a } } } })).toContain("same value names");
  });
  it("create recipes cannot carry read-only capture fields", () => {
    const create = { id: "c", label: "C", host: "example.test", steps: [{ click: { role: "button", name: "Create", createsToken: true } }] };
    const msg = (capture: unknown): string => {
      const r = RecipeSchema.safeParse({ ...create, capture });
      return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");
    };
    expect(msg({ token: { find: { css: "#t" } }, values: base.capture.values })).toContain("belongs to kind read");
    expect(msg({})).toContain("capture.token is required");
    expect(RecipeSchema.parse({ ...create, capture: { token: { find: { css: "#t" } } } }).kind).toBe("create");
  });
  it("follow is checked like goto for its variables and its step shape", () => {
    expect(parse({ steps: [{ follow: { css: "a.next" } }] }).success).toBe(true);
    expect(parse({ steps: [{ follow: {} }] }).success).toBe(false);
  });
});
