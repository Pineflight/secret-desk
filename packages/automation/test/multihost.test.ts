import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, LoginError, RecipeRunError, RecipeSchema, checkSession, hostAllowed, hostForParams, hostListOf, loadRecipeFile, resolveRecipe, runRecipe, signIn, type Recipe } from "../src/index.js";

const PEECHO = resolve(import.meta.dirname, "../../../recipes/peecho-api-keys.yaml");

/** A recipe with two portals of one provider, each with its own account. */
const multi = (over: Record<string, unknown> = {}) => ({
  id: "acme-keys",
  label: "Acme keys",
  kind: "read",
  hostBy: "portal",
  hosts: { live: "app.acme.test", test: "sandbox.acme.test" },
  params: [{ key: "portal", label: "Portal", options: ["live", "test"] }],
  login: {
    expect: { url: "^https://{{host}}/home" },
    form: {
      start: "https://{{host}}/login",
      home: "https://{{host}}/",
      steps: [
        { waitFor: { visible: { css: "#email" }, timeoutSeconds: 0.05 } },
        { fill: { css: "#email", value: "{{login.username}}" } },
        { fill: { css: "#pw", value: "{{login.password}}" } },
        { click: { role: "button", name: "Log in" } },
      ],
    },
  },
  steps: [{ goto: "https://app.acme.test/keys", when: { var: "portal", equals: "live" } }, { goto: "https://sandbox.acme.test/keys", when: { var: "portal", equals: "test" } }],
  capture: { values: { key: { find: { css: "#key" }, pattern: "^[a-z0-9]{8,}$", timeoutSeconds: 0.05 } } },
  ...over,
});

function problems(doc: unknown): string {
  const r = RecipeSchema.safeParse(doc);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("recipe with several hosts: schema", () => {
  it("accepts hostBy with hosts and keeps the first host as the label host", () => {
    const r = RecipeSchema.parse(multi());
    expect(r.host).toBe("app.acme.test");
    expect(r.hosts).toEqual({ live: "app.acme.test", test: "sandbox.acme.test" });
    expect(hostListOf(r)).toEqual(["app.acme.test", "sandbox.acme.test"]);
  });

  it("keeps the single-host form unchanged", () => {
    const r = RecipeSchema.parse({ ...multi(), hostBy: undefined, hosts: undefined, host: "app.acme.test", login: undefined, params: [], steps: [{ goto: "https://app.acme.test/keys" }] });
    expect(r.hosts).toBeUndefined();
    expect(hostListOf(r)).toEqual(["app.acme.test"]);
  });

  it("wants exactly one of the two forms", () => {
    expect(problems(multi({ host: "app.acme.test" }))).toMatch(/host: Use either host or hostBy/);
    expect(problems(multi({ hostBy: undefined, hosts: undefined }))).toMatch(/host: host is required/);
    expect(problems(multi({ hostBy: undefined }))).toMatch(/hostBy and hosts belong together/);
    expect(problems(multi({ hosts: undefined }))).toMatch(/hostBy and hosts belong together/);
  });

  it("wants the parameter to list exactly the keys of hosts as options", () => {
    expect(problems(multi({ params: [] }))).toMatch(/hostBy names the parameter portal/);
    expect(problems(multi({ params: [{ key: "portal", label: "P", options: ["live"] }] }))).toMatch(/lists exactly the keys of hosts/);
    expect(problems(multi({ params: [{ key: "portal", label: "P" }] }))).toMatch(/lists exactly the keys of hosts/);
    expect(problems(multi({ hosts: { live: "app.acme.test" } }))).toMatch(/at least two hosts/);
  });

  it("allows {{host}} in the sign-in addresses and login.expect, and nothing else", () => {
    expect(problems(multi())).toBe("");
    const form = (start: string) => ({ ...multi().login, form: { ...multi().login.form, start } });
    expect(problems(multi({ login: form("https://{{host}}/{{name}}") }))).toMatch(/only \{\{host\}\}/);
    expect(problems(multi({ login: form("https://other.test/login") }))).toMatch(/nicht host\/allowHosts/);
    expect(problems(multi({ login: form("https://{{host}}.evil.test/login") }))).toMatch(/nicht host\/allowHosts|host/);
  });

  it("checks a goto against every host of the recipe", () => {
    expect(problems(multi({ steps: [{ goto: "https://other.test/keys" }] }))).toMatch(/nicht host\/allowHosts/);
  });
});

describe("resolveRecipe", () => {
  const recipe = (): Recipe => RecipeSchema.parse(multi({ allowHosts: ["idp.acme.test"] }));

  it("turns the recipe into a single-host recipe of the chosen portal and fills in {{host}}", () => {
    const r = resolveRecipe(recipe(), "test");
    expect(r.host).toBe("sandbox.acme.test");
    expect(r.hosts).toBeUndefined();
    expect(r.hostBy).toBeUndefined();
    expect(r.login?.form?.start).toBe("https://sandbox.acme.test/login");
    expect(r.login?.form?.home).toBe("https://sandbox.acme.test/");
    expect(r.login?.expect).toEqual({ url: "^https://sandbox\\.acme\\.test/home" });
  });

  it("takes the host itself as the choice and refuses a missing or unknown one", () => {
    expect(resolveRecipe(recipe(), "app.acme.test").host).toBe("app.acme.test");
    expect(() => resolveRecipe(recipe())).toThrow(/no host chosen/);
    expect(() => resolveRecipe(recipe(), "staging")).toThrow(/unknown host/);
    expect(() => resolveRecipe(recipe(), "evil.test")).toThrow(/unknown host/);
  });

  it("allows only the chosen host (plus allowHosts), not the other portal", () => {
    const live = resolveRecipe(recipe(), "live");
    expect(hostAllowed("app.acme.test", live)).toBe(true);
    expect(hostAllowed("idp.acme.test", live)).toBe(true);
    expect(hostAllowed("sandbox.acme.test", live)).toBe(false);
    const test = resolveRecipe(recipe(), "test");
    expect(hostAllowed("sandbox.acme.test", test)).toBe(true);
    expect(hostAllowed("app.acme.test", test)).toBe(false);
  });

  it("leaves a single-host recipe alone and fills {{host}} with its host", () => {
    const one = RecipeSchema.parse({ ...multi(), hostBy: undefined, hosts: undefined, host: "app.acme.test", params: [], steps: [{ goto: "https://app.acme.test/keys" }] });
    const r = resolveRecipe(one);
    expect(r.host).toBe("app.acme.test");
    expect(r.login?.form?.start).toBe("https://app.acme.test/login");
  });

  it("finds the host of an entry from its parameters (value, default, or none)", () => {
    const r = recipe();
    expect(hostForParams(r, { portal: "test" })).toBe("sandbox.acme.test");
    expect(hostForParams(r, { portal: "live" })).toBe("app.acme.test");
    expect(hostForParams(r, {})).toBeNull();
    expect(hostForParams(r, { portal: "other" })).toBeNull();
    const one = RecipeSchema.parse({ ...multi(), hostBy: undefined, hosts: undefined, host: "app.acme.test", params: [], steps: [{ goto: "https://app.acme.test/keys" }] });
    expect(hostForParams(one, {})).toBe("app.acme.test");
  });
});

/** A browser that is signed in at the listed hosts: their home page leads to /home, the others to /login. */
function browser(signedInAt: string[], opts: { onType?: (host: string) => void } = {}): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    visible: ['button "Log in"'],
    on: (e, d) => {
      if (e.action === "goto") {
        const u = new URL(e.key);
        d.url = signedInAt.includes(u.hostname) ? `https://${u.hostname}/home` : `https://${u.hostname}/login`;
        if (!signedInAt.includes(u.hostname)) d.visible.add("css #email").add("css #pw");
      }
      if (e.action === "fill") opts.onType?.(new URL(d.url).hostname);
      if (e.key === 'button "Log in"') d.url = `https://${new URL(d.url).hostname}/home`;
    },
  });
}

describe("recipe with several hosts: sign-in check and guided sign-in per host", () => {
  const recipe = (): Recipe => RecipeSchema.parse(multi());

  it("checks the portal that was asked for, and the answer does not depend on the other portal", async () => {
    const live = browser(["app.acme.test"]);
    expect(await checkSession(recipe(), live, { host: "live", timeoutSeconds: 1, pollMs: 2 })).toMatchObject({ signedIn: true });
    expect(live.calls).toContain("goto https://app.acme.test/");
    expect(live.calls.some((c) => c.includes("sandbox"))).toBe(false);
    const test = browser(["app.acme.test"]);
    expect(await checkSession(recipe(), test, { host: "test", timeoutSeconds: 0.05, pollMs: 2 })).toMatchObject({ signedIn: false });
    expect(test.calls).toContain("goto https://sandbox.acme.test/");
    expect(test.calls.some((c) => c.includes("app.acme.test"))).toBe(false);
  });

  it("expects the sign-in state at the chosen host: a live session does not count as a test session", async () => {
    // The sandbox's home page lands on the live host's /home: not the chosen portal, so not signed in.
    const d = new FakeDriver({ pollMs: 2, on: (e, dd) => void (e.action === "goto" && (dd.url = "https://app.acme.test/home")) });
    expect(await checkSession(recipe(), d, { host: "test", timeoutSeconds: 0.05, pollMs: 2 })).toMatchObject({ signedIn: false });
  });

  it("refuses to check a recipe with several hosts without a choice", async () => {
    const e = await checkSession(recipe(), browser([]), { timeoutSeconds: 0.05 }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LoginError);
    expect((e as LoginError).kind).toBe("unsupported");
  });

  it("signs in at the chosen portal only and types credentials nowhere else", async () => {
    const typed: string[] = [];
    const d = browser([], { onType: (h) => typed.push(h) });
    const r = await signIn(recipe(), { username: "alice@example.test", password: "fake-typed-value-1" }, d, {}, { host: "test", pollMs: 2, settleMs: 5 });
    expect(r.url).toBe("https://sandbox.acme.test/home");
    expect(d.calls).toContain("goto https://sandbox.acme.test/login");
    expect(d.calls.some((c) => c.includes("app.acme.test"))).toBe(false);
    expect(typed).toEqual(["sandbox.acme.test", "sandbox.acme.test"]);
  });

  it("stops a sign-in that the other portal's host takes over", async () => {
    const typed: string[] = [];
    const d = new FakeDriver({
      pollMs: 2,
      visible: ['button "Log in"'],
      on: (e, dd) => {
        if (e.action === "goto") {
          dd.url = "https://app.acme.test/login";
          dd.visible.add("css #email").add("css #pw");
        }
        if (e.action === "fill") typed.push(e.key);
      },
    });
    const e = await signIn(recipe(), { username: "alice@example.test", password: "fake-typed-value-1" }, d, {}, { host: "test", pollMs: 2, settleMs: 5 }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LoginError);
    expect((e as LoginError).kind).toBe("host");
    expect(typed).toEqual([]);
  });
});

describe("recipe with several hosts: a run uses the host of its parameter", () => {
  const vars = (portal: string) => ({ name: "n", owner: "", days: "30", date: "2026-11-04", description: "", repos: "", permissions: "", permissionsQuery: "", stage: "test", secretId: "s", portal });
  const recipe = (): Recipe => {
    const r = RecipeSchema.parse(multi());
    for (const v of Object.values(r.capture.values ?? {})) v.timeoutSeconds = 0.05;
    return r;
  };
  /** The pages answer with /home on `host` whatever address is opened (a signed-in browser that stays on its portal). */
  const page = (host: string): FakeDriver =>
    new FakeDriver({ url: `https://${host}/home`, visible: ["css #key"], texts: { "css #key": "abcdef123456" }, pollMs: 2, on: (e, d) => void (e.action === "goto" && (d.url = `https://${host}/home`)) });

  it("reads at the host of the portal and nowhere else", async () => {
    const d = page("sandbox.acme.test");
    const result = await runRecipe(recipe(), vars("test"), d);
    expect(result.value.reveal()).toBe("abcdef123456");
    expect(d.calls).toContain("goto https://sandbox.acme.test/keys");
    expect(d.calls.some((c) => c.includes("app.acme.test"))).toBe(false);
  });

  it("does not take the other portal's session for the chosen one", async () => {
    // Portal live, but the pages answer from the sandbox: login.expect names the live host, so the run asks for a sign-in.
    const ctl = new AbortController();
    let waited = 0;
    const err = await runRecipe(recipe(), vars("live"), page("sandbox.acme.test"), { onWaitingForHuman: () => { waited += 1; ctl.abort(); } }, { signal: ctl.signal }).then(() => null, (x: unknown) => x);
    expect(waited).toBe(1);
    expect((err as RecipeRunError).kind).toBe("abort");
  });

  it("refuses a portal value the recipe does not list, before a page is opened", async () => {
    const d = page("sandbox.acme.test");
    const err = await runRecipe(recipe(), vars("staging"), d).then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("params");
    expect(d.calls).toEqual([]);
  });
});

describe("peecho-api-keys: sign-in form for both portals", () => {
  it("signs in at the test portal with the same form and expects the dashboard of that host", async () => {
    const r = await loadRecipeFile(PEECHO);
    const test = resolveRecipe(r, "test");
    expect(test.login?.form?.start).toBe("https://test.www.peecho.com/dashboard");
    expect(test.login?.form?.home).toBe("https://test.www.peecho.com/dashboard");
    expect(test.login?.expect).toEqual({ url: "^https://test\\.www\\.peecho\\.com/dashboard/" });
    const live = resolveRecipe(r, "live");
    expect(live.login?.form?.start).toBe("https://www.peecho.com/dashboard");
    expect(live.login?.expect).toEqual({ url: "^https://www\\.peecho\\.com/dashboard/" });
    expect(live.login?.form?.steps).toEqual(test.login?.form?.steps);
  });

  it("checks each portal on its own", async () => {
    const r = await loadRecipeFile(PEECHO);
    const signedIn = (host: string) => new FakeDriver({ pollMs: 2, on: (e, d) => void (e.action === "goto" && (d.url = `https://${host}/dashboard/orders`)) });
    expect(await checkSession(r, signedIn("www.peecho.com"), { host: "live", timeoutSeconds: 1, pollMs: 2 })).toMatchObject({ signedIn: true });
    expect(await checkSession(r, signedIn("www.peecho.com"), { host: "test", timeoutSeconds: 0.05, pollMs: 2 })).toMatchObject({ signedIn: false });
    expect(await checkSession(r, signedIn("test.www.peecho.com"), { host: "test", timeoutSeconds: 1, pollMs: 2 })).toMatchObject({ signedIn: true });
  });
});
