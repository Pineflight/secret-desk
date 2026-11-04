import { describe, expect, it } from "vitest";
import { initialPortal, recipeSignInBody, recipeSignInButtonState, recipeSignInSubject, stepsOf, type FacadeState } from "../src/lib/facade";
import { buildCards, signInPrompts, signInRecipeOf, type CardInput, type VendorInfo, type VendorsResponse } from "../src/lib/provider-cards";
import { messages } from "../src/messages";

const NOW = new Date("2026-11-04T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const v = (id: string, label: string, rest: Partial<VendorInfo> = {}): VendorInfo => ({ id, label, category: "other", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: [], signInPlanned: false, ...rest });
const catalog: VendorsResponse = { categories: ["other"], vendors: [v("printco", "Print Co", { recipes: ["printco-keys"] }), v("single", "Single Co", { recipes: ["single-key"] }), v("nologin", "No Login", { recipes: ["nologin-key"] }), v("acme", "Acme", { recipes: ["acme-key"] })] };
const recipes = [
  { id: "printco-keys", label: "Print Co keys", host: "app.printco.test", hostBy: "portal", hosts: [{ value: "live", host: "app.printco.test" }, { value: "test", host: "sandbox.printco.test" }], canCheckSignIn: true, signInMethods: [{ id: "email", label: null, labelEn: null }] },
  { id: "single-key", label: "Single key", host: "dash.single.test", hostBy: null, hosts: [], canCheckSignIn: true, signInMethods: [{ id: "email", label: null, labelEn: null }, { id: "github", label: null, labelEn: null }], signInPasswordless: true },
  { id: "nologin-key", label: "No login", host: "dash.nologin.test", canCheckSignIn: false },
  { id: "acme-key", label: "Acme key", host: "dash.acme.test", canCheckSignIn: true },
];
const facades = [{ id: "acme", label: "Acme", available: true, connected: false, reason: null, connectionId: "acme" }];
const base = (extra: Partial<CardInput> = {}): CardInput => ({ catalog, connections: [], providers: [], recipes, facades: [], secrets: [], variables: [], now: NOW, signInFreshHours: 12, automationEnabled: true, ...extra });
const card = (i: CardInput, id: string) => buildCards(i).find((c) => c.id === id)!;
const check = (host: string, signedIn: boolean, minutes: number) => ({ host, signedIn, checkedAt: ago(minutes) });

describe("sign-in prompts on a card", () => {
  it("offers one Sign in per portal whose line says sign-in needed or unknown", () => {
    const c = card(base({ signInChecks: [check("app.printco.test", true, 60), check("sandbox.printco.test", false, 10)] }), "printco");
    expect(signInPrompts(c)).toEqual([{ portal: "test" }]);
    expect(signInPrompts(card(base(), "printco"))).toEqual([{ portal: "live" }, { portal: "test" }]);
    expect(signInPrompts(card(base({ signInChecks: [check("app.printco.test", true, 5), check("sandbox.printco.test", true, 5)] }), "printco"))).toEqual([]);
  });

  it("treats an old answer as unknown and offers the sign-in", () => {
    const c = card(base({ signInChecks: [check("dash.single.test", true, 13 * 60)] }), "single");
    expect(signInPrompts(c)).toEqual([{ portal: null }]);
  });

  it("offers none when the sign-in is current, signed in, or cannot run", () => {
    expect(signInPrompts(card(base({ signInChecks: [check("dash.single.test", true, 5)] }), "single"))).toEqual([]);
    expect(signInPrompts(card(base({ automationEnabled: false }), "single"))).toEqual([]);
    // A recipe without a guided sign-in has nothing to sign in at.
    expect(signInPrompts(card(base(), "nologin"))).toEqual([]);
  });

  it("leaves a provider with its own sign-in dialog alone", () => {
    const c = card(base({ facades }), "acme");
    expect(signInRecipeOf(c)).toBeNull();
    expect(signInPrompts(c)).toEqual([]);
  });

  it("names the recipe to sign in at", () => {
    expect(signInRecipeOf(card(base(), "printco"))?.id).toBe("printco-keys");
    expect(signInRecipeOf(card(base(), "nologin"))).toBeNull();
  });
});

describe("recipe sign-in dialog helpers", () => {
  const printco = recipeSignInSubject(recipes[0]!, true);
  const single = recipeSignInSubject(recipes[1]!, true);

  it("takes methods, passwordless and portals from the recipe row", () => {
    expect(printco.hosts.map((h) => h.value)).toEqual(["live", "test"]);
    expect(single).toMatchObject({ passwordless: true, hosts: [], methods: [{ id: "email" }, { id: "github" }] });
    expect(recipeSignInSubject({ id: "x", signInMethods: [{ id: "unknown-idp", label: null, labelEn: null }] }, true).methods).toEqual([]);
  });

  it("preselects the asked-for portal, the only one, or none", () => {
    expect(initialPortal(printco, "test")).toBe("test");
    expect(initialPortal(printco, "elsewhere")).toBe("");
    expect(initialPortal(printco, null)).toBe("");
    expect(initialPortal(recipeSignInSubject({ id: "x", hosts: [{ value: "only", host: "a.test" }] }, true), null)).toBe("only");
    expect(initialPortal(single, "live")).toBe("");
  });

  it("is ready only with a portal (several), an email and a password", () => {
    expect(recipeSignInButtonState(printco, "", "a@b.test", "pw", false)).toBe("disabled");
    expect(recipeSignInButtonState(printco, "elsewhere", "a@b.test", "pw", false)).toBe("disabled");
    expect(recipeSignInButtonState(printco, "live", "a@b.test", "pw", false)).toBe("ready");
    expect(recipeSignInButtonState(printco, "live", "a@b.test", "", false)).toBe("disabled");
    expect(recipeSignInButtonState(printco, "live", "a@b.test", "pw", true)).toBe("busy");
    expect(recipeSignInButtonState({ ...printco, available: false }, "live", "a@b.test", "pw", false)).toBe("disabled");
  });

  it("asks a passwordless email sign-in for the email only, but a single sign-on method still for a password", () => {
    expect(recipeSignInButtonState(single, "", "a@b.test", "", false, "email")).toBe("ready");
    expect(recipeSignInButtonState(single, "", "a@b.test", "", false, "github")).toBe("disabled");
  });

  it("sends the portal only for a recipe with several, trimmed email, nothing else", () => {
    expect(recipeSignInBody(printco, "test", "email", " a@b.test ", "pw")).toEqual({ method: "email", username: "a@b.test", password: "pw", host: "test" });
    expect(recipeSignInBody(single, "", "github", "a@b.test", "pw")).toEqual({ method: "github", username: "a@b.test", password: "pw" });
  });
});

describe("the steps of a run that only signs in", () => {
  const state = (over: Partial<FacadeState>): FacadeState => ({ secretId: "recipe-signin:x", providerId: "x", status: "running", text: "", startedAt: ago(1), updatedAt: ago(0), kind: "signin", ...over });

  it("leaves out the steps that create, store and test a key", () => {
    expect(stepsOf(state({}), { signInOnly: true }).map((s) => s.phase)).toEqual(["opening", "username", "password", "signed-in"]);
    expect(stepsOf(state({})).map((s) => s.phase)).toContain("key");
  });

  it("shows the code step only when the provider asked for it, and ends every step done on success", () => {
    const timeline = ["opening", "username", "password", "code", "signed-in"].map((phase) => ({ phase, state: "done" as const, at: ago(0) }));
    const steps = stepsOf(state({ status: "done", timeline }), { signInOnly: true });
    expect(steps.map((s) => s.phase)).toEqual(["opening", "username", "password", "code", "signed-in"]);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });
});

describe("catalogs", () => {
  it("have every key of the dialog and the card buttons in German and English", () => {
    for (const key of ["recipeSignIn.intro", "recipeSignIn.portal", "recipeSignIn.portalHint", "recipeSignIn.portalHost", "recipeSignIn.unavailable", "recipeSignIn.start", "recipeSignIn.doneTitle", "recipeSignIn.doneHint", "providers.signIn.button", "providers.signIn.buttonAt", "providers.signIn.buttonLabel", "providers.signIn.buttonLabelAt"]) {
      expect(messages.de[key], `de ${key}`).toBeTruthy();
      expect(messages.en[key], `en ${key}`).toBeTruthy();
    }
  });
});
