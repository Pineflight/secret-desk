import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, RecipeSchema, SUDO_FLOWS, SudoError, confirmAccess, hostAllowed, idpHostAllowed, loadRecipes, loginMethodsOf, runRecipe, signIn, sudoNumberFrom, type Recipe, type SudoAnswer, type SudoAsk, type SudoEvent } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");
const FLOW = SUDO_FLOWS["github-sudo"];
const PW = "made-up-sudo-password-1";
const CODE = "135790";

/** A fake "Confirm access" page. `accepts` decides which typed value lets the page go. */
function page(accepts: { code?: string; password?: string } = {}): FakeDriver {
  const leave = (d: FakeDriver): void => {
    d.pageText.delete("Confirm access");
    d.visible.clear();
    d.url = "https://github.com/settings/personal-access-tokens/new";
  };
  const show = (d: FakeDriver): void => {
    d.pageText.add("Confirm access");
    d.visible.clear();
    for (const v of ['button "Use GitHub Mobile"', 'Text "Use your password"', 'Text "Use your authenticator app"']) d.visible.add(v);
  };
  const d: FakeDriver = new FakeDriver({
    url: "https://github.com/sessions/sudo",
    pollMs: 2,
    on: (e, drv) => {
      if (e.action === "goto") return show(drv);
      if (e.key === 'button "Use GitHub Mobile"') {
        drv.pageText.add("Enter the digits shown below");
        drv.texts.set("css main", "Confirm access Enter the digits shown below 42");
      }
      if (e.key === 'Text "Use your authenticator app"') for (const v of ['css input[name="sudo_app_otp"]', 'button "Verify" (exact)']) drv.visible.add(v);
      if (e.key === 'Text "Use your password"') for (const v of ['css input[name="sudo_password"]', 'button "Confirm" (exact)']) drv.visible.add(v);
      if (e.key === 'button "Verify" (exact)' && drv.filled.get('css input[name="sudo_app_otp"]') === accepts.code) leave(drv);
      if (e.key === 'button "Confirm" (exact)' && drv.filled.get('css input[name="sudo_password"]') === accepts.password) leave(drv);
    },
  });
  show(d);
  return d;
}

interface Run {
  asks: SudoAsk[];
  events: SudoEvent[];
  secrets: string[];
}
function io(d: FakeDriver, answers: SudoAnswer[], onMobile?: () => void): { run: Run; args: Parameters<typeof confirmAccess>[1] } {
  const run: Run = { asks: [], events: [], secrets: [] };
  const queue = [...answers];
  return {
    run,
    args: {
      driver: d,
      hooks: {
        request: async (ask) => {
          run.asks.push(ask);
          const a = queue.shift();
          if (!a) throw new Error("gave up");
          return a;
        },
        onEvent: (e) => {
          run.events.push(e);
          if (e.type === "mobile") onMobile?.();
        },
      },
      checkHost: async () => undefined,
      addSecret: (v) => run.secrets.push(v),
      pollMs: 2,
      mobileTimeoutMs: 120,
      submitTimeoutMs: 60,
    },
  };
}

describe("sudoNumberFrom", () => {
  it("reads one or two digits after the sentence and nothing else", () => {
    expect(sudoNumberFrom("We sent you a verification request. Enter the digits shown below to enter sudo mode.\n 17 ")).toBe("17");
    expect(sudoNumberFrom("Enter the digits shown below to enter sudo mode. 5")).toBe("5");
    expect(sudoNumberFrom("Enter the digits shown below 1234")).toBe("");
    expect(sudoNumberFrom("nothing here 42")).toBe("");
  });
});

describe("confirmAccess (github-sudo)", () => {
  it("GitHub Mobile: clicks the button, hands the number to the portal and ends when the page leaves", async () => {
    const d = page();
    const { run, args } = io(d, [{ method: "mobile" }], () => setTimeout(() => d.pageText.delete("Confirm access"), 10));
    await confirmAccess(FLOW, args);
    expect(d.calls).toContain('click button "Use GitHub Mobile"');
    expect(run.events.map((e) => e.type)).toEqual(["choose", "mobile", "confirmed"]);
    expect(run.events.find((e) => e.type === "mobile")).toEqual({ type: "mobile", number: "42" });
    expect(run.asks[0]).toMatchObject({ methods: ["mobile", "code", "password"], attempt: 1, maxAttempts: 3 });
    expect(run.asks[0]!.problem).toBeUndefined();
  });

  it("GitHub Mobile that is not approved times out, the portal asks again with the reason, then a code works", async () => {
    const d = page({ code: CODE });
    const { run, args } = io(d, [{ method: "mobile" }, { method: "code", code: CODE }]);
    await confirmAccess(FLOW, args);
    expect(run.asks.map((a) => a.problem)).toEqual([undefined, "timeout"]);
    expect(d.filled.get('css input[name="sudo_app_otp"]')).toBe(CODE);
    expect(d.calls).toContain('click button "Verify" (exact)');
    // The page was reloaded between the tries to get back to the first view.
    expect(d.calls.filter((c) => c.startsWith("goto ")).length).toBe(1);
  });

  it("authenticator code: switches the view, types the code into sudo_app_otp, clicks Verify", async () => {
    const d = page({ code: CODE });
    const { run, args } = io(d, [{ method: "code", code: CODE }]);
    await confirmAccess(FLOW, args);
    expect(d.calls).toEqual(expect.arrayContaining(['click Text "Use your authenticator app"', 'fill css input[name="sudo_app_otp"]', 'click button "Verify" (exact)']));
    expect(run.events.map((e) => e.type)).toEqual(["choose", "checking", "confirmed"]);
    expect(JSON.stringify(run.events)).not.toContain(CODE);
    expect(run.secrets).toContain(CODE);
  });

  it("password: types into sudo_password and clicks Confirm; never in events or asks", async () => {
    const d = page({ password: PW });
    const { run, args } = io(d, [{ method: "password", password: PW }]);
    await confirmAccess(FLOW, args);
    expect(d.filled.get('css input[name="sudo_password"]')).toBe(PW);
    expect(d.calls).toContain('click button "Confirm" (exact)');
    expect(JSON.stringify([run.events, run.asks])).not.toContain(PW);
    expect(d.calls.join("\n")).not.toContain(PW);
  });

  it("a wrong password asks again with the reason rejected; three failures end with a clear error", async () => {
    const d = page({ password: PW });
    const answers: SudoAnswer[] = [1, 2, 3].map(() => ({ method: "password", password: "wrong" }));
    const { run, args } = io(d, answers);
    const err = await confirmAccess(FLOW, args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SudoError);
    expect((err as SudoError).kind).toBe("failed");
    expect(run.asks.map((a) => a.problem)).toEqual([undefined, "rejected", "rejected"]);
    expect((err as SudoError).message).not.toContain("wrong");
  });

  it("a last try that only times out ends with kind timeout", async () => {
    const d = page();
    const { args } = io(d, [{ method: "mobile" }, { method: "mobile" }, { method: "mobile" }]);
    const err = (await confirmAccess(FLOW, args).catch((e: unknown) => e)) as SudoError;
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("not approved in time");
  });

  it("a way the page does not offer is reported as unavailable and asked again", async () => {
    const d = page({ password: PW });
    d.visible.delete('Text "Use your authenticator app"');
    const { run, args } = io(d, [{ method: "code", code: CODE }, { method: "password", password: PW }]);
    await confirmAccess(FLOW, args);
    expect(run.asks.map((a) => a.problem)).toEqual([undefined, "unavailable"]);
    expect(d.filled.has('css input[name="sudo_app_otp"]')).toBe(false);
  });

  it("the human giving up or a cancelled run ends with kind abort", async () => {
    const d = page();
    const a = io(d, []);
    expect(((await confirmAccess(FLOW, a.args).catch((e: unknown) => e)) as SudoError).kind).toBe("abort");
    const ac = new AbortController();
    ac.abort();
    const b = io(page(), [{ method: "mobile" }]);
    expect(((await confirmAccess(FLOW, { ...b.args, signal: ac.signal }).catch((e: unknown) => e)) as SudoError).kind).toBe("abort");
  });

  it("types nothing when the host check refuses", async () => {
    const d = page({ password: PW });
    const { args } = io(d, [{ method: "password", password: PW }]);
    const err = await confirmAccess(FLOW, {
      ...args,
      checkHost: async () => {
        throw new RecipeRunError("host", "elsewhere");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(d.filled.size).toBe(0);
  });
});

describe("confirmAccess step in a recipe run", () => {
  const recipe = (): Recipe =>
    RecipeSchema.parse({
      id: "sudo-sample",
      label: "Sample",
      host: "github.com",
      login: {
        expect: { url: "^https://github\\.com/settings/" },
        form: { start: "https://github.com/login", steps: [{ fill: { css: "#login_field", value: "{{login.username}}" } }, { fill: { css: "#password", value: "{{login.password}}" } }] },
      },
      steps: [
        { goto: "https://github.com/settings/personal-access-tokens/new" },
        { confirmAccess: { flow: "github-sudo", until: { visible: { label: "Token name" } } } },
        { fill: { label: "Token name", value: "{{name}}" } },
        { click: { role: "button", name: "Generate", createsToken: true } },
      ],
      capture: { token: { find: { css: "#tok" }, timeoutSeconds: 0.05 } },
    });
  const VARS = { name: "n1", owner: "o", days: "1", date: "2026-11-03", description: "", repos: "", permissions: "", permissionsQuery: "", stage: "", secretId: "" };

  function site(sudo: boolean): FakeDriver {
    return new FakeDriver({
      pollMs: 2,
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = e.key;
          if (sudo) {
            drv.pageText.add("Confirm access");
            drv.visible.add('button "Use GitHub Mobile"');
          } else {
            drv.visible.add('Feld "Token name"');
            drv.visible.add('button "Generate"');
          }
        }
        if (e.key === 'button "Use GitHub Mobile"') drv.pageText.add("Enter the digits shown below");
        if (e.key === 'button "Generate"') {
          drv.visible.add("css #tok");
          drv.texts.set("css #tok", "tok_value_1");
        }
      },
    });
  }

  it("skips the confirmation when the page the recipe wants is already there", async () => {
    const asks: SudoAsk[] = [];
    const r = await runRecipe(recipe(), VARS, site(false), { access: { request: async (a) => (asks.push(a), { method: "mobile" }) } }, { pollMs: 2 });
    expect(r.value.reveal()).toBe("tok_value_1");
    expect(asks).toHaveLength(0);
  });

  it("answers in the portal when GitHub asks, then continues with the form", async () => {
    const d = site(true);
    const events: string[] = [];
    const r = await runRecipe(
      recipe(),
      VARS,
      d,
      {
        access: {
          request: async () => ({ method: "mobile" }),
          onEvent: (e) => {
            events.push(e.type);
            if (e.type === "mobile") {
              d.pageText.delete("Confirm access");
              d.visible.delete('button "Use GitHub Mobile"');
              d.visible.add('Feld "Token name"');
              d.visible.add('button "Generate"');
            }
          },
        },
      },
      { pollMs: 2, access: { mobileTimeoutMs: 2000 } },
    );
    expect(r.value.reveal()).toBe("tok_value_1");
    expect(events).toEqual(["choose", "mobile", "confirmed"]);
  });

  it("without a portal to answer in it waits for the human in the browser window (kind pause)", async () => {
    const d = site(true);
    const waits: string[] = [];
    const r = await runRecipe(
      recipe(),
      VARS,
      d,
      {
        onWaitingForHuman: (w) => {
          waits.push(w.kind);
          d.pageText.delete("Confirm access");
          d.visible.add('Feld "Token name"');
          d.visible.add('button "Generate"');
        },
      },
      { pollMs: 2 },
    );
    expect(waits).toEqual(["pause"]);
    expect(r.value.reveal()).toBe("tok_value_1");
  });

  it("a failed confirmation ends the run with a RecipeRunError and a clear message", async () => {
    const err = await runRecipe(recipe(), VARS, site(true), { access: { request: async () => ({ method: "password", password: "nope" }) } }, { pollMs: 2, access: { submitTimeoutMs: 20, maxAttempts: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as Error).message).not.toContain("nope");
  });

  it("the sign-in hook runs on the open driver when the browser is signed out", async () => {
    let signedIn = false;
    const d = new FakeDriver({
      pollMs: 2,
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = signedIn ? e.key : "https://github.com/login";
          if (signedIn) {
            drv.visible.add('Feld "Token name"');
            drv.visible.add('button "Generate"');
          }
        }
        if (e.key === 'button "Generate"') {
          drv.visible.add("css #tok");
          drv.texts.set("css #tok", "tok_value_1");
        }
      },
    });
    let hooked = 0;
    const r = await runRecipe(
      recipe(),
      VARS,
      d,
      {
        signIn: async (driver) => {
          hooked++;
          expect(driver).toBe(d);
          signedIn = true;
          d.url = "https://github.com/settings/profile";
        },
        access: { request: async () => ({ method: "mobile" }) },
      },
      { pollMs: 2 },
    );
    expect(hooked).toBe(1);
    expect(d.opened && d.closed).toBe(true);
    expect(r.value.reveal()).toBe("tok_value_1");
  });
});

describe("bundled recipes: sign-in methods from the survey", () => {
  const byId = async (id: string): Promise<Recipe> => (await loadRecipes([RECIPES])).find((r) => r.id === id)!;
  const buttonOf = (r: Recipe, method: string) => r.login?.methods?.find((m) => m.id === method)?.steps?.find((s) => "click" in s);

  it("github: email form, Google and Apple buttons, GitHub Mobile number on the sign-in approval", async () => {
    const r = await byId("github-fine-grained-token");
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google", "apple"]);
    expect(r.login?.form?.steps).toEqual(
      expect.arrayContaining([{ fill: { css: "#login_field", value: "{{login.username}}" } }, { fill: { css: "#password", value: "{{login.password}}" } }, { click: { css: 'input[type=submit][value="Sign in"]' } }]),
    );
    expect(buttonOf(r, "google")).toMatchObject({ click: { role: "button", name: "Continue with Google" } });
    expect(buttonOf(r, "apple")).toMatchObject({ click: { role: "button", name: "Continue with Apple" } });
    expect(r.login?.form?.approval?.number).toBeDefined();
    expect(r.steps.some((s) => "confirmAccess" in s)).toBe(true);
    expect(r.steps.some((s) => "pause" in s)).toBe(false);
    expect(r.revoke?.steps.some((s) => "confirmAccess" in s)).toBe(true);
    expect(idpHostAllowed("google", "accounts.google.com")).toBe(true);
  });

  it("stripe: Google; supabase: GitHub", async () => {
    expect(loginMethodsOf(await byId("stripe-restricted-key")).map((m) => m.id)).toEqual(["email", "google"]);
    expect(buttonOf(await byId("stripe-restricted-key"), "google")).toMatchObject({ click: { role: "button", name: "Google" } });
    const sb = await byId("supabase-access-token");
    expect(loginMethodsOf(sb).map((m) => m.id)).toEqual(["email", "github"]);
    expect(buttonOf(sb, "github")).toMatchObject({ click: { role: "button", name: "Continue with GitHub" } });
    // The sign-in page does not count as signed in.
    expect(new RegExp(sb.login!.expect.url!).test("https://supabase.com/dashboard/sign-in")).toBe(false);
    expect(new RegExp(sb.login!.expect.url!).test("https://supabase.com/dashboard/project/abc")).toBe(true);
  });

  it("vesselapi: Cognito host allowed for typing, Google, email form", async () => {
    const r = await byId("vesselapi-api-key");
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google"]);
    expect(buttonOf(r, "google")).toMatchObject({ click: { role: "button", name: "Continue with Google" } });
    expect(hostAllowed("my-pool.auth.us-east-1.amazoncognito.com", r)).toBe(true);
    expect(hostAllowed("my-pool.auth.eu-west-1.amazoncognito.com", r)).toBe(false);
    expect(hostAllowed("evil.test", r)).toBe(false);
    expect(hostAllowed("amazoncognito.com.evil.test", r)).toBe(false);
  });

  it("revenuecat: email only", async () => {
    expect(loginMethodsOf(await byId("revenuecat-secret-api-key")).map((m) => m.id)).toEqual(["email"]);
  });
});

describe("github email sign-in", () => {
  it("types the details on github.com, asks for the authenticator code and the GitHub Mobile number", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "github-fine-grained-token")!;
    const d = new FakeDriver({
      pollMs: 2,
      on: (e, drv) => {
        if (e.action === "goto") {
          drv.url = e.key;
          for (const v of ["css #login_field", "css #password", 'css input[type=submit][value="Sign in"]']) drv.visible.add(v);
        }
        if (e.key === 'css input[type=submit][value="Sign in"]') {
          for (const v of ["css #login_field", "css #password"]) drv.visible.delete(v);
          drv.pageText.add("GitHub Mobile");
          drv.texts.set("css .mobile-number, [data-testid=mobile-number]", "63");
        }
      },
    });
    const needs: string[] = [];
    const details: string[] = [];
    const creds = { username: "me@example.test", password: "made-up-gh-pw" };
    setTimeout(() => {
      d.url = "https://github.com/settings/profile";
    }, 60);
    const res = await signIn(r, creds, d, { onEvent: (e) => (e.type === "needs" ? (needs.push(e.need), details.push(e.detail ?? "")) : undefined) }, { pollMs: 5, settleMs: 5 });
    expect(res.url).toBe("https://github.com/settings/profile");
    expect(d.filled.get("css #login_field")).toBe("me@example.test");
    expect(needs).toEqual(["approval"]);
    expect(details).toEqual(["63"]);
  });
});
