import { describe, expect, it } from "vitest";
import { FakeDriver, IDP_FLOWS, LoginError, RecipeSchema, describeSelector, idpHostAllowed, loginMethodsOf, signIn, type IdpId, type LoginEvent, type Recipe } from "../src/index.js";

const EMAIL = "someone@example.test";
const PW = "typed-pw-value-1";
const CODE = "135790";
const APP = "https://example.test/app/home";

const button = (name: string) => ({ role: "button", name });
const methodSteps = (name: string) => [{ waitFor: { visible: button(name), timeoutSeconds: 0.05 } }, { click: button(name) }];

const NAMES: Record<IdpId, string> = { apple: "Continue with Apple", google: "Continue with Google", microsoft: "Continue with Microsoft", github: "Continue with GitHub" };

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sample-token",
    label: "Sample",
    host: "example.test",
    login: {
      expect: { url: "^https://example\\.test/app" },
      form: {
        start: "https://example.test/login",
        steps: [
          { waitFor: { visible: { css: "#email" }, timeoutSeconds: 0.05 } },
          { fill: { css: "#email", value: "{{login.username}}" } },
          { fill: { css: "#pw", value: "{{login.password}}" } },
          { click: { role: "button", name: "Log in" } },
        ],
      },
      methods: (Object.keys(NAMES) as IdpId[]).map((id) => ({ id, steps: methodSteps(NAMES[id]) })),
    },
    steps: [{ goto: "https://example.test/a" }, { click: { role: "button", name: "Go", createsToken: true } }],
    capture: { token: { find: { css: "#t" } } },
    ...over,
  };
}
const recipe = (): Recipe => RecipeSchema.parse(doc());
const issues = (login: Record<string, unknown>): string => {
  const r = RecipeSchema.safeParse(doc({ login }));
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
};
const baseLogin = () => doc()["login"] as { expect: unknown; form: unknown; methods: unknown[] };

describe("login.methods in the schema", () => {
  it("offers email from login.form even when no method is declared", () => {
    const r = RecipeSchema.parse(doc({ login: { expect: baseLogin().expect, form: baseLogin().form } }));
    expect(loginMethodsOf(r)).toEqual([{ id: "email", label: null, labelEn: null }]);
  });
  it("lists email first, then the declared methods", () => {
    expect(loginMethodsOf(recipe()).map((m) => m.id)).toEqual(["email", "apple", "google", "microsoft", "github"]);
  });
  it("offers nothing without a guided sign-in", () => {
    expect(loginMethodsOf(RecipeSchema.parse(doc({ login: { expect: baseLogin().expect } })))).toEqual([]);
  });
  it("rejects methods without login.form", () => {
    expect(issues({ expect: baseLogin().expect, methods: [{ id: "apple", steps: methodSteps("x") }] })).toMatch(/needs login\.form/);
  });
  it("rejects a single-sign-on method without steps, email with steps, duplicates, fill steps and variables", () => {
    const l = baseLogin();
    expect(issues({ ...l, methods: [{ id: "apple" }] })).toMatch(/needs the provider-side steps/);
    expect(issues({ ...l, methods: [{ id: "email", steps: methodSteps("x") }] })).toMatch(/no steps of its own/);
    expect(issues({ ...l, methods: [{ id: "apple", steps: methodSteps("x") }, { id: "apple", steps: methodSteps("y") }] })).toMatch(/declared twice/);
    expect(issues({ ...l, methods: [{ id: "apple", steps: [{ fill: { css: "#x", value: "a" } }] }] })).toMatch(/click or waitFor/);
    expect(issues({ ...l, methods: [{ id: "apple", steps: [{ click: { role: "button", name: "{{login.password}}" } }] }] })).toMatch(/No variables/);
    expect(issues({ ...l, methods: [{ id: "bing", steps: methodSteps("x") }] })).not.toBe("");
  });
});

describe("identity-provider hosts", () => {
  it("allows exactly the declared hosts", () => {
    expect(idpHostAllowed("apple", "appleid.apple.com")).toBe(true);
    expect(idpHostAllowed("apple", "idmsa.apple.com")).toBe(true);
    expect(idpHostAllowed("google", "accounts.google.com")).toBe(true);
    expect(idpHostAllowed("github", "github.com")).toBe(true);
    expect(idpHostAllowed("apple", "accounts.google.com")).toBe(false);
    expect(idpHostAllowed("google", "accounts.google.com.evil.test")).toBe(false);
    expect(idpHostAllowed("github", "gist.github.com")).toBe(false);
  });
});

type Stage = "ok" | "mfa" | "approval" | "consent" | "passkey" | "wrong";

interface SiteOptions {
  stage: Stage;
  /** Where the provider button leads (default: the identity provider's first host). */
  redirectTo?: string;
  goodCode?: boolean;
}

/** A fake provider that hands over to the identity provider `id`, whose pages follow the built-in flow. */
function site(id: IdpId, o: SiteOptions): FakeDriver {
  const flow = IDP_FLOWS[id];
  const key = (s: { [k: string]: unknown }) => describeSelector(s as never);
  const stepKeys = flow.steps.flatMap((s) => ("fill" in s ? [key(s.fill)] : "click" in s ? [key(s.click)] : []));
  const lastClick = flow.steps.filter((s) => "click" in s).map((s) => ("click" in s ? key(s.click) : "")).at(-1)!;
  const firstWait = flow.steps[0] && "waitFor" in flow.steps[0] ? describeSelector((flow.steps[0].waitFor as { visible: never }).visible) : "";
  const mfaKey = describeSelector(flow.mfa.detect.visible!);
  const consentKey = flow.consent ? describeSelector(flow.consent.detect.visible!) : "";
  const lastClickCount = flow.steps.filter((s) => "click" in s && key(s.click) === lastClick).length;
  let clicks = 0;
  const showMfa = (d: FakeDriver): void => {
    d.visible.add(mfaKey);
    d.visible.add(describeSelector(flow.mfa.field));
    d.visible.add(describeSelector(flow.mfa.submit));
  };
  return new FakeDriver({
    pollMs: 2,
    visible: [`button "${NAMES[id]}"`, "css #email", "css #pw", 'button "Log in"'],
    on: (e, d) => {
      if (e.action === "goto") {
        d.url = e.key;
        return;
      }
      if (e.key === `button "${NAMES[id]}"`) {
        d.url = o.redirectTo ?? `https://${flow.hosts[0]}/auth`;
        for (const k of stepKeys) d.visible.add(k);
        d.visible.add(firstWait);
        return;
      }
      if (e.key === lastClick && e.action === "click" && ++clicks === lastClickCount) {
        if (o.stage === "ok") d.url = APP;
        if (o.stage === "wrong") d.pageText.add((flow.failure[0]!.detect as { text: string }).text);
        if (o.stage === "mfa") showMfa(d);
        if (o.stage === "approval") {
          d.pageText.add((flow.approval.detect as { text: string }).text);
          if (flow.approval.number) {
            const n = describeSelector(flow.approval.number);
            d.visible.add(n);
            d.texts.set(n, "42");
          }
        }
        if (o.stage === "consent") {
          d.visible.add(consentKey);
          d.texts.set(describeSelector(flow.consent!.scopes), "Repository access (read)\n  Email addresses (read)");
          d.visible.add(describeSelector(flow.consent!.scopes));
        }
        if (o.stage === "passkey" && flow.passkey) {
          d.pageText.add((flow.passkey.detect as { text: string }).text);
          d.visible.add(describeSelector(flow.passkey.fallback));
        }
        return;
      }
      if (e.key === describeSelector(flow.mfa.submit) && e.action === "click") {
        if (o.goodCode !== false) {
          d.visible.delete(mfaKey);
          d.url = APP;
        }
        return;
      }
      if (flow.passkey && e.key === describeSelector(flow.passkey.fallback)) {
        d.pageText.delete((flow.passkey.detect as { text: string }).text);
        showMfa(d);
        return;
      }
      if (flow.consent && e.key === describeSelector(flow.consent.approve)) {
        d.visible.delete(consentKey);
        d.url = APP;
      }
    },
  });
}

const creds = () => ({ username: EMAIL, password: PW });
const fast = { pollMs: 2, settleMs: 5, captchaGraceMs: 20 };
const typed = (d: FakeDriver): string[] => [...d.filled.values()];

async function error(p: Promise<unknown>): Promise<LoginError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LoginError);
  return e as LoginError;
}

describe.each(["apple", "google", "microsoft", "github"] as const)("sign-in through %s", (id) => {
  it("types the credentials only on the identity provider and reaches the provider", async () => {
    const d = site(id, { stage: "ok" });
    const events: LoginEvent[] = [];
    const r = await signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e) }, { ...fast, method: id });
    expect(r.url).toBe(APP);
    expect(typed(d)).toEqual([EMAIL, PW]);
    // Nothing was typed into the provider's own form.
    expect(d.filled.has("css #email") && id !== "microsoft" && id !== "google" ? d.filled.get("css #email") : undefined).toBeUndefined();
    expect(events.filter((e) => e.type === "entered").map((e) => (e as { field: string }).field)).toEqual(["username", "password"]);
    expect(d.closed).toBe(true);
  });

  it("asks the portal for the code and types it on the identity provider", async () => {
    const d = site(id, { stage: "mfa" });
    const events: LoginEvent[] = [];
    await signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e), requestCode: async () => CODE }, { ...fast, method: id });
    expect(typed(d)).toContain(CODE);
    expect(events.some((e) => e.type === "needs" && e.need === "mfa-code")).toBe(true);
  });

  it("waits for the device approval, shows its number and goes on", async () => {
    const d = site(id, { stage: "approval" });
    const events: LoginEvent[] = [];
    const run = signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e) }, { ...fast, method: id });
    await new Promise((r) => setTimeout(r, 40));
    const need = events.find((e) => e.type === "needs");
    expect(need).toMatchObject({ need: "approval", messageEn: expect.stringContaining("Approve") });
    if (IDP_FLOWS[id].approval.number) expect(need).toMatchObject({ detail: "42" });
    d.url = APP;
    await run;
    expect(events.some((e) => e.type === "resumed")).toBe(true);
  });

  it("reports a refusal by the identity provider", async () => {
    const e = await error(signIn(recipe(), creds(), site(id, { stage: "wrong" }), {}, { ...fast, method: id }));
    expect(e.kind).toBe("rejected");
    expect(e.message).not.toContain(PW);
  });

  it("types nothing when the provider hands over to a foreign host", async () => {
    const d = site(id, { stage: "ok", redirectTo: "https://evil.test/auth" });
    const e = await error(signIn(recipe(), creds(), d, {}, { ...fast, method: id }));
    expect(e.kind).toBe("host");
    expect(typed(d)).toEqual([]);
  });
});

describe("sign-in through GitHub", () => {
  it("takes the code fallback of a passkey prompt", async () => {
    const d = site("github", { stage: "passkey" });
    await signIn(recipe(), creds(), d, { requestCode: async () => CODE }, { ...fast, method: "github" });
    expect(d.calls).toContain(`click ${describeSelector(IDP_FLOWS.github.passkey!.fallback)}`);
    expect(typed(d)).toContain(CODE);
  });

  it("shows the requested scopes and approves only after the human confirmed", async () => {
    const d = site("github", { stage: "consent" });
    const events: LoginEvent[] = [];
    let asked = "";
    await signIn(
      recipe(),
      creds(),
      d,
      {
        onEvent: (e) => events.push(e),
        requestConfirm: async (scopes) => {
          asked = scopes;
          expect(d.calls.some((c) => c === `click ${describeSelector(IDP_FLOWS.github.consent!.approve)}`)).toBe(false);
          return true;
        },
      },
      { ...fast, method: "github" },
    );
    expect(asked).toBe("Repository access (read); Email addresses (read)");
    expect(events.find((e) => e.type === "needs")).toMatchObject({ need: "consent", detail: asked });
    expect(d.calls).toContain(`click ${describeSelector(IDP_FLOWS.github.consent!.approve)}`);
  });

  it("never approves when the human declines", async () => {
    const d = site("github", { stage: "consent" });
    const e = await error(signIn(recipe(), creds(), d, { requestConfirm: async () => false }, { ...fast, method: "github" }));
    expect(e.kind).toBe("rejected");
    expect(d.calls).not.toContain(`click ${describeSelector(IDP_FLOWS.github.consent!.approve)}`);
  });

  it("never approves when the run cannot ask", async () => {
    const d = site("github", { stage: "consent" });
    const e = await error(signIn(recipe(), creds(), d, {}, { ...fast, method: "github" }));
    expect(e.kind).toBe("unsupported");
    expect(d.calls).not.toContain(`click ${describeSelector(IDP_FLOWS.github.consent!.approve)}`);
  });
});

describe("method selection and host allowlist", () => {
  it("refuses a method the recipe does not declare", async () => {
    const r = RecipeSchema.parse(doc({ login: { expect: baseLogin().expect, form: baseLogin().form, methods: [{ id: "apple", steps: methodSteps(NAMES.apple) }] } }));
    const e = await error(signIn(r, creds(), site("google", { stage: "ok" }), {}, { ...fast, method: "google" }));
    expect(e.kind).toBe("unsupported");
  });

  it("does not let the email method type on an identity-provider host", async () => {
    const d = new FakeDriver({
      pollMs: 2,
      visible: ["css #email", "css #pw", 'button "Log in"'],
      on: (e, dr) => {
        if (e.action === "goto") dr.url = e.key;
        if (e.action === "fill" && e.key === "css #email") dr.url = "https://appleid.apple.com/auth";
      },
    });
    const e = await error(signIn(recipe(), creds(), d, {}, { ...fast }));
    expect(e.kind).toBe("host");
    expect(typed(d)).toEqual([EMAIL]);
  });
});
