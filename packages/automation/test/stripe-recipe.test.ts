import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, dryRunRecipe, loadRecipes, recipeParamVars, revokeRecipe, runRecipe, RecipeRunError, type Recipe } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");
// Built from parts so secret scanners do not mistake the fake for a real key.
const KEY = ["rk", "test", "FAKEKEYFORTESTSONLY0123456789"].join("_");
const ACCOUNT = "acct_1AbCdEf";
const BAD_KEY = ["sk", "live", "notAllowedHere12345"].join("_");
const VARS = { name: "secret-desk-test-2026-11-03-1200", owner: "", days: "0", date: "2026-11-03", description: "", repos: "", permissions: "", permissionsQuery: "", stage: "", secretId: "" };

const BANNER = 'button "Reject all" (exact)';
const CONTINUE = 'button "Continue" (exact)';

async function recipe(): Promise<Recipe> {
  const r = (await loadRecipes([RECIPES])).find((x) => x.id === "stripe-restricted-key")!;
  // The banner wait is 8 s in the real run; the fakes do not wait that long.
  for (const s of r.steps) if ("click" in s && s.click.optional) s.click.timeoutSeconds = 0.03;
  return r;
}

/** A fake of the key wizard: each "Continue" shows the next heading; "Create key" shows the result with the key in data-text. */
function wizard(opts: { banner?: boolean; key?: string } = {}): FakeDriver {
  let stage = 0;
  let custom = false;
  const d: FakeDriver = new FakeDriver({
    pollMs: 2,
    visible: ['css input[type="search"]', 'css role=group[name="Permission level"s] >> role=radio[name="Write"s]', 'Feld "Name" (exact)', 'button "Create key"', CONTINUE, 'radio "Custom permissions"', 'radio "Full access—except sensitive operations"', ...(opts.banner === false ? [] : [BANNER])],
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        drv.pageText.add("Choose how you"); // the recipe waits for the start of the heading
        drv.visible.add('Text "Choose how you"');
        return;
      }
      if (e.action === "check" && e.key === 'radio "Custom permissions"') custom = true;
      if (e.action === "click" && e.key === CONTINUE) {
        stage += 1;
        // The permission list is shown only for custom permissions; otherwise step 2 leads straight to the review.
        const heading = stage === 1 ? "Assign permissions to your key" : stage === 2 ? (custom ? "Select permissions" : "Name and review your key") : "Name and review your key";
        drv.pageText.add(heading);
        return;
      }
      if (e.action === "fill" && e.key === 'css input[type="search"]') drv.pageText.add("Webhook Endpoints, Event Destinations");
      if (e.action === "click" && e.key === 'button "Create key"') {
        drv.pageText.add("Your new secret key");
        drv.visible.add('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]');
        drv.texts.set('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]', "rk_test_FAKE…"); // the page prints the key truncated
        drv.attributes.set('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]@aria-label', opts.key ?? KEY);
      }
    },
  });
  return d;
}

const vars = (r: Recipe, params: Record<string, string>) => ({ ...VARS, ...recipeParamVars(r, params) });

describe("stripe-restricted-key recipe", () => {
  it("creates a webhooks key in the sandbox: rejects the banner first, never accepts it", async () => {
    const r = await recipe();
    const d = wizard();
    const res = await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d, {}, { pollMs: 2 });
    expect(res.value.reveal()).toBe(KEY);
    expect(res.createdName).toBe(VARS.name);
    expect(d.calls[1]).toBe(`goto https://dashboard.stripe.com/${ACCOUNT}/test/apikeys/create`);
    // The engine loads the target page once more after the sign-in check; every goto is the sandbox address.
    expect(new Set(d.calls.filter((c) => c.startsWith("goto")))).toEqual(new Set([`goto https://dashboard.stripe.com/${ACCOUNT}/test/apikeys/create`]));
    const banner = d.calls.findIndex((c) => c === `click ${BANNER}`);
    const firstContinue = d.calls.findIndex((c) => c === `click ${CONTINUE}`);
    expect(banner).toBeGreaterThan(0);
    expect(banner).toBeLessThan(firstContinue);
    expect(d.calls.join("\n")).not.toContain("Accept all");
    expect(d.calls).toContain('check radio "Custom permissions"');
    expect(d.calls).toContain('fill css input[type="search"]');
    expect(d.calls).toContain('check css role=group[name="Permission level"s] >> role=radio[name="Write"s]');
    expect(d.calls).not.toContain('check radio "Full access—except sensitive operations"');
    expect(d.filled.get('Feld "Name" (exact)')).toBe(VARS.name);
    // The key reaches no screenshot as text, and the screenshots mask the element.
    for (const s of d.shots) expect(s.masks).toContain('css [data-text^="rk_"]');
  });

  it("uses the live address for the live mode and the full-access preset without the permission list", async () => {
    const r = await recipe();
    const d = wizard();
    await runRecipe(r, vars(r, { account: ACCOUNT, mode: "live", preset: "full-except-sensitive" }), d, { onWaitingForHuman: () => undefined }, { pollMs: 2 });
    expect(d.calls[1]).toBe(`goto https://dashboard.stripe.com/${ACCOUNT}/apikeys/create`);
    expect(d.calls).toContain('check radio "Full access—except sensitive operations"');
    expect(d.calls).not.toContain('check radio "Custom permissions"');
    expect(d.calls).not.toContain('check css role=group[name="Permission level"s] >> role=radio[name="Write"s]');
  });

  it("works without a cookie banner", async () => {
    const r = await recipe();
    const d = wizard({ banner: false });
    const res = await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d, {}, { pollMs: 2 });
    expect(res.value.reveal()).toBe(KEY);
    expect(d.calls).not.toContain(`click ${BANNER}`);
  });

  it("the live mode waits for a password confirmation and goes on once the field is gone", async () => {
    const r = await recipe();
    const d = wizard();
    d.visible.add('css input[type="password"]');
    const reasons: string[] = [];
    const res = await runRecipe(r, vars(r, { account: ACCOUNT, mode: "live" }), d, { onWaitingForHuman: (w) => { reasons.push(`${w.kind}:${w.reason.slice(0, 6)}`); d.visible.delete('css input[type="password"]'); } }, { pollMs: 2 });
    expect(reasons).toEqual(["pause:Stripe"]);
    expect(res.value.reveal()).toBe(KEY);
  });

  it("refuses a value that is not a restricted key and never shows it", async () => {
    const r = await recipe();
    const d = wizard({ key: BAD_KEY });
    const err = (await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.kind).toBe("capture");
    expect(err.message).not.toContain(BAD_KEY);
    expect(err.createdName).toBe(VARS.name);
  });

  it("requires a valid account and a mode", async () => {
    const r = await recipe();
    expect(() => recipeParamVars(r, { mode: "sandbox" })).toThrow(/account/);
    expect(() => recipeParamVars(r, { account: "not-an-account", mode: "sandbox" })).toThrow(/Format/);
    expect(() => recipeParamVars(r, { account: ACCOUNT })).toThrow(/mode/);
    expect(() => recipeParamVars(r, { account: ACCOUNT, mode: "test" })).toThrow(/nicht erlaubt/);
  });

  it("expires a key through the row menu and the dialog", async () => {
    const r = await recipe();
    const row = `css tr:has-text("${VARS.name}")`;
    const menu = `${row} a[role=button][aria-haspopup=true] >> nth=-1`;
    const d = new FakeDriver({
      pollMs: 2,
      visible: [BANNER, menu, `${row} a[role=button][aria-haspopup=true]`],
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = e.key;
          drv.visible.add(row);
          return;
        }
        if (e.action === "click" && e.key === menu) drv.visible.add('menuitem "Expire key"');
        if (e.action === "click" && e.key === 'menuitem "Expire key"') {
          drv.pageText.add("Expire API key");
          drv.visible.add('button "Expire" (exact)');
        }
        if (e.action === "click" && e.key === 'button "Expire" (exact)') drv.visible.delete(row);
      },
    });
    await revokeRecipe(r, { ...vars(r, { account: ACCOUNT, mode: "sandbox" }), externalId: VARS.name }, d, {}, { pollMs: 2 });
    expect(d.calls[1]).toBe(`goto https://dashboard.stripe.com/${ACCOUNT}/test/apikeys`);
    expect(d.calls).toContain(`click ${menu}`);
    expect(d.calls).toContain('click menuitem "Expire key"');
    expect(d.calls).toContain('click button "Expire" (exact)');
  });
  it("expires a key through the row menu button of the single-page UI", async () => {
    const r = await recipe();
    const row = `css tr:has-text("${VARS.name}")`;
    const plain = `${row} button[aria-haspopup="menu"]`;
    const menu = `${plain} >> nth=-1`;
    const d = new FakeDriver({
      pollMs: 2,
      visible: [BANNER, menu, plain],
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = e.key;
          drv.visible.add(row);
          return;
        }
        if (e.action === "click" && e.key === menu) drv.visible.add('menuitem "Expire key"');
        if (e.action === "click" && e.key === 'menuitem "Expire key"') {
          drv.pageText.add("Expire API key");
          drv.visible.add('button "Expire" (exact)');
        }
        if (e.action === "click" && e.key === 'button "Expire" (exact)') drv.visible.delete(row);
      },
    });
    await revokeRecipe(r, { ...vars(r, { account: ACCOUNT, mode: "sandbox" }), externalId: VARS.name }, d, {}, { pollMs: 2 });
    expect(d.calls).toContain(`click ${menu}`);
    expect(d.calls.filter((c) => c.includes("a[role=button]"))).toEqual([]);
    expect(d.calls).toContain('click button "Expire" (exact)');
  });
});

const FILTER = 'Platzhalter "Filter resources"';
const ROW = 'css tr:has-text("Webhook Endpoints, Event Destinations")';
const WRITE = `${ROW} >> role=button[name="Write"s]`;
const CREATE_EXACT = 'button "Create key" (exact)';
const COPY_LINK = (name: string) => `css tr:has-text("${name}") a[aria-label="Click to copy"]`;

/** A fake of the older single-page form: filter, Write in the row, "Create key" returns to the list with the key as the text of the copy link. */
function singlePage(opts: { key?: string; extraVisible?: string[] } = {}): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    visible: [BANNER, 'css #key-name', FILTER, CREATE_EXACT, ...(opts.extraVisible ?? [])],
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        drv.pageText.add("Create restricted API key");
        drv.visible.add('Text "Create restricted API key"');
        return;
      }
      if (e.action === "fill" && e.key === FILTER) drv.visible.add(ROW).add(WRITE);
      if (e.action === "click" && e.key === CREATE_EXACT) {
        drv.visible.add(COPY_LINK(VARS.name));
        drv.texts.set(COPY_LINK(VARS.name), ` ${opts.key ?? KEY} `);
      }
    },
  });
}

describe("stripe-restricted-key recipe, single-page form", () => {
  it("creates a webhooks key: name, filter, Write in the row, key from the copy link of the list", async () => {
    const r = await recipe();
    const d = singlePage();
    const res = await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d, {}, { pollMs: 2 });
    expect(res.value.reveal()).toBe(KEY);
    expect(res.createdName).toBe(VARS.name);
    expect(d.filled.get("css #key-name")).toBe(VARS.name);
    expect(d.filled.get(FILTER)).toBe("Webhook Endpoints");
    expect(d.calls).toContain(`click ${WRITE}`);
    // None of the wizard's steps ran.
    expect(d.calls).not.toContain(`click ${CONTINUE}`);
    expect(d.calls.join("\n")).not.toContain("Custom permissions");
    // Order: Write before Create key; the banner is rejected, never accepted.
    expect(d.calls.indexOf(`click ${WRITE}`)).toBeLessThan(d.calls.indexOf(`click ${CREATE_EXACT}`));
    expect(d.calls.join("\n")).not.toContain("Accept all");
    // The key reaches no screenshot as text, and the copy link is masked.
    expect(d.shots.length).toBeGreaterThan(0);
    for (const s of d.shots) expect(s.masks).toContain('css a[aria-label="Click to copy"]');
    expect(d.shots.at(-1)?.masks).toContain(COPY_LINK(VARS.name));
  });

  it("refuses the full-access preset before any key exists", async () => {
    const r = await recipe();
    const d = singlePage();
    const err = (await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox", preset: "full-except-sensitive" }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.kind).toBe("step");
    expect(err.message).toMatch(/single-page key form/);
    expect(err.createdName).toBeUndefined();
    expect(d.calls.some((c) => c.startsWith("fill"))).toBe(false);
    expect(d.calls).not.toContain(`click ${CREATE_EXACT}`);
    expect(d.closed).toBe(true);
  });

  it("creates a refunds key: Write on Charges and Refunds, Read on Payment Intents and Invoices, first column only", async () => {
    const r = await recipe();
    const rowOf = (name: string) => `css tr:has-text("${name}"):not(:has-text("View documentation"))`;
    const button = (name: string, level: string) => `${rowOf(name)} >> role=button[name="${level}"s] >> nth=0`;
    const rows = [["Charges and Refunds", "Write"], ["Payment Intents", "Read"], ["Invoices", "Read"]] as const;
    const d = singlePage({ extraVisible: rows.flatMap(([row, level]) => [rowOf(row), button(row, level)]) });
    const res = await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox", preset: "refunds" }), d, {}, { pollMs: 2 });
    expect(res.value.reveal()).toBe(KEY);
    expect(d.calls).toContain(`click ${button("Charges and Refunds", "Write")}`);
    expect(d.calls).toContain(`click ${button("Payment Intents", "Read")}`);
    expect(d.calls).toContain(`click ${button("Invoices", "Read")}`);
    // The webhook row is not touched for this preset.
    expect(d.calls).not.toContain(`click ${WRITE}`);
  });

  it("refuses the refunds preset on the wizard before any key exists", async () => {
    const r = await recipe();
    const d = new FakeDriver({
      pollMs: 2,
      visible: [BANNER],
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = e.key;
          drv.pageText.add("Choose how you");
          drv.visible.add('Text "Choose how you"');
        }
      },
    });
    const err = (await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox", preset: "refunds" }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.message).toMatch(/single-page form only/);
    expect(err.createdName).toBeUndefined();
  });

  it("a dry run stops before Create key", async () => {
    const r = await recipe();
    const d = singlePage();
    await dryRunRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d, {}, { pollMs: 2 });
    expect(d.calls).toContain(`click ${WRITE}`);
    expect(d.calls).not.toContain(`click ${CREATE_EXACT}`);
  });

  it("refuses a copy link that does not hold a restricted key, and never shows it", async () => {
    const r = await recipe();
    const d = singlePage({ key: BAD_KEY });
    const err = (await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.message).not.toContain(BAD_KEY);
  });

  it("clicks nothing when neither form shows up", async () => {
    const r = await recipe();
    const d = new FakeDriver({ pollMs: 2, visible: [BANNER], on: (e, drv) => { if (e.action === "goto") drv.url = e.key; } });
    for (const s of r.steps) if ("waitFor" in s && s.waitFor.any) s.waitFor.timeoutSeconds = 0.05;
    const err = (await runRecipe(r, vars(r, { account: ACCOUNT, mode: "sandbox" }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(d.calls).not.toContain(`click ${CREATE_EXACT}`);
    expect(d.calls.some((c) => c.startsWith("fill"))).toBe(false);
  });
});
