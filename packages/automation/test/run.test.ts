import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, dryRunRecipe, revokeRecipe, runRecipe, type HumanWait } from "../src/index.js";
import { FORM_VISIBLE, TOKEN, VARS, sampleRecipe } from "./helpers.js";

const TOKENS_URL = "https://example.test/tokens/new";

/** Fake, bei dem der Klick auf Create das Token-Feld zeigt. */
function formDriver(extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}): FakeDriver {
  return new FakeDriver({
    url: "about:blank",
    visible: FORM_VISIBLE,
    on: (e, d) => {
      if (e.action === "click" && e.key === 'button "Create"') {
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
    ...extra,
  });
}

describe("runRecipe", () => {
  it("returns value, identifier, expiry, receipts and createdName", async () => {
    const d = formDriver();
    const progress: string[] = [];
    const r = await runRecipe(sampleRecipe(), VARS, d, { onProgress: (p) => progress.push(p.label) });
    expect(r.value.reveal()).toBe(TOKEN);
    expect(r.externalId).toBe("demo-20261027");
    expect(r.expiresAt).toBe("2026-11-26");
    expect(r.createdName).toBe("demo-20261027");
    expect(r.screenshots.map((s) => s.name)).toEqual(["vorher", "nach-erzeugen"]);
    expect(d.opened && d.closed).toBe(true);
    expect(d.calls).toContain("goto https://example.test/tokens/new?name=demo-20261027&owner=acme");
    expect(d.calls.filter((c) => c.startsWith('fill Platzhalter'))).toHaveLength(2); // je Repo
    expect(progress.length).toBeGreaterThan(3);
  });

  it("the value appears nowhere except in the value field", async () => {
    const d = formDriver();
    const hooks: unknown[] = [];
    const r = await runRecipe(sampleRecipe(), VARS, d, { onProgress: (p) => hooks.push(p) });
    expect(JSON.stringify({ ...r, value: undefined })).not.toContain(TOKEN);
    expect(JSON.stringify(hooks)).not.toContain(TOKEN);
    expect(String(r.value)).toBe("[SecretValue]");
    for (const s of r.screenshots) expect(s.png.toString()).not.toContain(TOKEN);
    expect(d.calls.join("\n")).not.toContain(TOKEN);
  });

  it("masks the token in all screenshots", async () => {
    const d = formDriver();
    await runRecipe(sampleRecipe(), VARS, d);
    expect(d.shots.length).toBe(2);
    for (const s of d.shots) expect(s.masks).toContain("css #tok");
  });

  it("waits for the sign-in and continues afterwards", async () => {
    const waits: HumanWait[] = [];
    let gotos = 0;
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "goto") {
          gotos++;
          dd.url = gotos === 1 ? "https://example.test/login?token=geheim" : TOKENS_URL;
        }
        if (e.action === "click") {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", TOKEN);
        }
      },
    });
    // Der "Mensch" meldet sich an, sobald der Hinweis kommt (kein Wanduhr-Timer).
    const r = await runRecipe(sampleRecipe(), VARS, d, { onWaitingForHuman: (w) => { waits.push(w); d.url = "https://example.test/tokens"; } }, { pollMs: 5 });
    expect(r.value.reveal()).toBe(TOKEN);
    expect(waits).toEqual([{ kind: "login", reason: "Bitte anmelden", url: "https://example.test/login" }]);
    expect(gotos).toBe(2); // Zielseite nach der Anmeldung erneut geladen
  });

  it("aborts after the sign-in timeout", async () => {
    const d = formDriver({ on: (_e, dd) => void (dd.url = "https://example.test/login") });
    const err = await runRecipe(sampleRecipe(), VARS, d, {}, { loginTimeoutMinutes: 0.0005, pollMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("timeout");
    expect((err as RecipeRunError).createdName).toBeUndefined();
    expect(d.closed).toBe(true);
  });

  it("respects the abort signal while waiting", async () => {
    const d = formDriver({ on: (_e, dd) => void (dd.url = "https://example.test/login") });
    const ac = new AbortController();
    const err = await runRecipe(sampleRecipe(), VARS, d, { onWaitingForHuman: () => ac.abort() }, { signal: ac.signal, pollMs: 5 }).catch((e: unknown) => e);
    expect((err as RecipeRunError).kind).toBe("abort");
  });

  it("names the created name in the error after createsToken", async () => {
    const d = new FakeDriver({ visible: FORM_VISIBLE, on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    // Klick klappt, aber das Token-Feld erscheint nie
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.createdName).toBe("demo-20261027");
    expect(err.message).toContain("demo-20261027");
  });

  it("never shows the read value on a wrong format", async () => {
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "click") {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", "falschesGeheimnis123");
        }
      },
    });
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.message).not.toContain("falschesGeheimnis123");
    expect(err.createdName).toBe("demo-20261027");
  });

  it("error before createsToken has no createdName", async () => {
    const d = new FakeDriver({ visible: [], on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("step");
    expect(err.createdName).toBeUndefined();
    expect(err.message).toContain('fill Feld "Name"');
  });

  it("aborts when the page leaves the allowed host", async () => {
    const d = formDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = "https://evil.test/x")) });
    const err = (await runRecipe(sampleRecipe({ login: undefined }), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("host");
    expect(d.filled.size).toBe(0);
  });
});

describe("dryRunRecipe", () => {
  it("ends before creating", async () => {
    const d = formDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    const r = await dryRunRecipe(sampleRecipe(), VARS, d);
    expect(r.screenshots.map((s) => s.name)).toEqual(["vorher"]);
    expect(d.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(d.closed).toBe(true);
  });
});

describe("capture on a foreign host", () => {
  it("does not read the token when the browser stands on a foreign page after the click", async () => {
    let reads = 0;
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "click" && e.key === 'button "Create"') {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", TOKEN);
          dd.url = "https://evil.test/phish";
        }
      },
    });
    const orig = d.readText.bind(d);
    d.readText = async (sel) => {
      reads++;
      return orig(sel);
    };
    const err = await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("host");
    expect(reads).toBe(0);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});

describe("M10: each with empty list", () => {
  it("fails before the first step, nothing is opened or clicked", async () => {
    const d = formDriver();
    const err = await runRecipe(sampleRecipe(), { ...VARS, repos: "" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).message).toMatch(/Liste "repos".*leer/);
    expect((err as RecipeRunError).createdName).toBeUndefined();
    expect(d.calls.filter((c) => c.startsWith("click") || c.startsWith("goto"))).toEqual([]);
    expect(d.closed).toBe(true);
  });
  it("commas and spaces alone also count as empty; in the dry run too", async () => {
    const d = formDriver();
    await expect(dryRunRecipe(sampleRecipe(), { ...VARS, repos: " , " }, d)).rejects.toThrow(/leer/);
  });
});

describe("M10: further steps with FakeDriver", () => {
  const base = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    sampleRecipe({
      login: undefined,
      steps: [...steps, { click: { role: "button", name: "Create", createsToken: true } }],
      ...extra,
    });
  const driver = (extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
    new FakeDriver({
      url: "https://example.test/start",
      visible: ["css #field", "css #agree", "css #box", ...FORM_VISIBLE],
      on: (e, d) => {
        if (e.action === "click" && e.key === 'button "Create"') {
          d.visible.add("css #tok");
          d.texts.set("css #tok", TOKEN);
        }
      },
      ...extra,
    });

  it("select, check and press run against the driver", async () => {
    const d = driver();
    await runRecipe(base([{ select: { css: "#field", value: "30" } }, { check: { css: "#agree", checked: true } }, { press: { css: "#field", key: "Enter" } }, { press: { key: "Tab" } }]), VARS, d);
    expect(d.calls).toContain("select css #field");
    expect(d.calls).toContain("check css #agree");
    expect(d.calls).toContain("press Enter css #field");
    expect(d.calls).toContain("press Tab");
  });
  it("waitFor waits for an element that appears a step earlier; timeout -> step error", async () => {
    const ok = driver({ visible: ["css #ready", "css #field", ...FORM_VISIBLE] });
    await expect(runRecipe(base([{ waitFor: { visible: { css: "#ready" }, timeoutSeconds: 1 } }]), VARS, ok)).resolves.toBeDefined();
    const never = driver();
    const err = await runRecipe(base([{ waitFor: { visible: { css: "#niemals" }, timeoutSeconds: 0.05 } }]), VARS, never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("step");
    expect((err as RecipeRunError).message).toMatch(/Zeitueberschreitung/);
  });
  it("pause: if the condition is already met, nobody waits for the human; otherwise hook and continuation", async () => {
    const waits: HumanWait[] = [];
    let resumed = 0;
    const met = driver({ pageText: ["Bestaetigt"] });
    await runRecipe(base([{ pause: { human: "Bitte bestaetigen", until: { text: "Bestaetigt" } } }]), VARS, met, { onWaitingForHuman: (w) => void waits.push(w), onResumed: () => void resumed++ });
    expect(waits).toEqual([]);
    const later = driver();
    const run = runRecipe(base([{ pause: { human: "Bitte bestaetigen", until: { text: "Bestaetigt" } } }]), VARS, later, { onWaitingForHuman: (w) => void waits.push(w), onResumed: () => void resumed++ }, { pollMs: 2 });
    // Kein Wanduhr-Rennen: der Hook ist der Zeitpunkt, an dem der "Mensch" handelt.
    const gate = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (waits.length > 0) {
          later.pageText.add("Bestaetigt");
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    await gate;
    await expect(run).resolves.toBeDefined();
    expect(waits).toHaveLength(1);
    expect(waits[0]!.reason).toBe("Bitte bestaetigen");
    expect(resumed).toBe(1);
  });
  it("pause: abort signal while waiting -> kind abort", async () => {
    const ac = new AbortController();
    const d = driver();
    const run = runRecipe(base([{ pause: { human: "warten", until: { text: "nie" } } }]), VARS, d, { onWaitingForHuman: () => ac.abort() }, { signal: ac.signal, pollMs: 2 });
    const err = await run.catch((e: unknown) => e);
    expect((err as RecipeRunError).kind).toBe("abort");
  });
  it("abort between two steps: later steps do not run", async () => {
    const ac = new AbortController();
    const d = driver({ on: (e) => void (e.action === "fill" && ac.abort()) });
    const err = await runRecipe(base([{ fill: { css: "#field", value: "a" } }, { fill: { css: "#field", value: "b" } }]), VARS, d, {}, { signal: ac.signal }).catch((e: unknown) => e);
    expect((err as RecipeRunError).kind).toBe("abort");
    expect(d.filled.get("css #field")).toBe("a");
    expect(d.calls.filter((c) => c === "fill css #field")).toHaveLength(1);
    expect(d.closed).toBe(true);
  });
  it("capture.externalId with find and pattern reads the identifier from the page; the value never becomes the identifier", async () => {
    const recipe = base([], { capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }, externalId: { find: { css: "#id" }, pattern: "id=(\\w+)" } } });
    const d = driver({ on: (e, dd) => { if (e.action === "click" && e.key === 'button "Create"') { dd.visible.add("css #tok"); dd.texts.set("css #tok", TOKEN); dd.texts.set("css #id", "id=abc123"); } } });
    const r = await runRecipe(recipe, VARS, d);
    expect(r.externalId).toBe("abc123");
    const leak = driver({ on: (e, dd) => { if (e.action === "click" && e.key === 'button "Create"') { dd.visible.add("css #tok"); dd.texts.set("css #tok", TOKEN); dd.texts.set("css #id", TOKEN); } } });
    const r2 = await runRecipe(base([], { capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }, externalId: { find: { css: "#id" } } } }), VARS, leak);
    expect(r2.externalId).toBeUndefined();
  });
  it("revokeRecipe: runs revoke.steps with externalId; without revoke a clear error", async () => {
    const withRevoke = sampleRecipe({ login: undefined, revoke: { steps: [{ goto: "https://example.test/tokens/{{externalId}}/delete" }, { click: { role: "button", name: "Delete" } }] } });
    const d = new FakeDriver({ url: "https://example.test/", visible: ['button "Delete"'] });
    await revokeRecipe(withRevoke, { ...VARS, externalId: "x1" }, d);
    expect(d.calls).toContain("goto https://example.test/tokens/x1/delete");
    expect(d.calls).toContain('click button "Delete"');
    expect(d.closed).toBe(true);
    await expect(revokeRecipe(sampleRecipe(), VARS, new FakeDriver())).rejects.toThrow(/kennt keinen Widerruf/);
  });
});

describe("when, optional steps, attribute capture and pause", () => {
  const recipe = (steps: unknown[], capture: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    sampleRecipe({
      login: undefined,
      params: [{ key: "mode", label: "Modus", options: ["sandbox", "live"] }],
      steps: [{ goto: "https://example.test/start" }, ...steps, { click: { role: "button", name: "Create", createsToken: true } }],
      ...(Object.keys(capture).length ? { capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05, ...capture }, externalId: { from: "name" } } } : {}),
      ...extra,
    });
  const driver = (extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
    new FakeDriver({
      url: "about:blank",
      visible: ["css #a", "css #b", ...FORM_VISIBLE],
      on: (e, d) => {
        if (e.action === "click" && e.key === 'button "Create"') {
          d.visible.add("css #tok");
          d.texts.set("css #tok", TOKEN);
          d.attributes.set("css #tok@data-text", TOKEN);
        }
      },
      ...extra,
    });

  it("runs a step only when its variable has the value", async () => {
    const steps = [
      { click: { css: "#a" }, when: { var: "mode", equals: "sandbox" } },
      { click: { css: "#b" }, when: { var: "mode", equals: "live" } },
    ];
    const sandbox = driver();
    await runRecipe(recipe(steps), { ...VARS, mode: "sandbox" }, sandbox);
    expect(sandbox.calls).toContain("click css #a");
    expect(sandbox.calls).not.toContain("click css #b");
    const live = driver();
    await runRecipe(recipe(steps), { ...VARS, mode: "live" }, live);
    expect(live.calls).toContain("click css #b");
    expect(live.calls).not.toContain("click css #a");
  });

  it("a skipped step is not counted and a conditional createsToken stop still ends the dry run", async () => {
    const d = driver();
    const r = await dryRunRecipe(recipe([{ click: { css: "#a" }, when: { var: "mode", equals: "live" } }]), { ...VARS, mode: "sandbox" }, d);
    expect(r.executed).toBe(1); // only the goto
  });

  it("an optional click is skipped when the element does not appear", async () => {
    const d = driver();
    const r = recipe([{ click: { css: "#banner", optional: true, timeoutSeconds: 0.03 } }, { click: { css: "#a" } }]);
    const res = await runRecipe(r, { ...VARS, mode: "sandbox" }, d, {}, { pollMs: 5 });
    expect(res.value.reveal()).toBe(TOKEN);
    expect(d.calls.some((c) => c.includes("#banner"))).toBe(false);
    expect(d.calls).toContain("click css #a");
  });

  it("an optional click is made when the element is there", async () => {
    const d = driver({ visible: ["css #banner", "css #a", ...FORM_VISIBLE] });
    await runRecipe(recipe([{ click: { css: "#banner", optional: true, timeoutSeconds: 0.5 } }]), { ...VARS, mode: "sandbox" }, d, {}, { pollMs: 5 });
    expect(d.calls).toContain("click css #banner");
  });

  it("a non-optional click on a missing element still fails", async () => {
    const err = await runRecipe(recipe([{ click: { css: "#banner" } }]), { ...VARS, mode: "sandbox" }, driver()).catch((e: unknown) => e);
    expect((err as RecipeRunError).kind).toBe("step");
  });

  it("captures the token from an attribute", async () => {
    const d = driver({ texts: {} });
    const r = recipe([], { attribute: "data-text" });
    d.texts.clear();
    const res = await runRecipe(r, { ...VARS, mode: "sandbox" }, d);
    expect(res.value.reveal()).toBe(TOKEN);
    // readText is not used for it: the page text would be the truncated form.
    expect(String(res.screenshots.map((s) => s.png.toString()))).not.toContain(TOKEN);
  });

  it("a missing attribute is a capture error without the value", async () => {
    const d = driver({ on: (e, dd) => void (e.action === "click" && e.key === 'button "Create"' && (dd.visible.add("css #tok"), dd.texts.set("css #tok", TOKEN))) });
    const err = (await runRecipe(recipe([], { attribute: "data-text" }), { ...VARS, mode: "sandbox" }, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.message).not.toContain(TOKEN);
  });

  it("reports a pause as kind pause", async () => {
    const waits: HumanWait[] = [];
    const d = driver();
    const r = recipe([{ pause: { human: "Passwort bestaetigen", until: { hidden: { css: "#pw" } } } }]);
    d.visible.add("css #pw");
    await runRecipe(r, { ...VARS, mode: "live" }, d, { onWaitingForHuman: (w) => { waits.push(w); d.visible.delete("css #pw"); } }, { pollMs: 5 });
    expect(waits).toEqual([{ kind: "pause", reason: "Passwort bestaetigen", url: "https://example.test/start" }]);
  });
});

describe("runRecipe: signed out where nobody sees the window", () => {
  const FORM = { form: { start: "https://example.test/login", steps: [{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }] } };
  const signedOut = (): FakeDriver => formDriver({ on: (_e, dd) => void (dd.url = "https://example.test/login?token=geheim") });
  const withForm = () => sampleRecipe({ login: { expect: { url: "^https://example\\.test/tokens" }, message: "Bitte anmelden", ...FORM } });

  it("ends at once with the kind signin when no hook is registered, naming no query and no value", async () => {
    const waits: HumanWait[] = [];
    const d = signedOut();
    const err = (await runRecipe(withForm(), VARS, d, { onWaitingForHuman: (w) => void waits.push(w) }, { signInOutsideWindow: true, pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.kind).toBe("signin");
    expect(err.createdName).toBeUndefined();
    expect(err.message).toContain("example.test");
    expect(err.message).not.toContain("geheim");
    expect(err.message).not.toContain(TOKEN);
    expect(waits).toEqual([]);
    expect(d.closed).toBe(true);
  });

  it("calls a registered sign-in hook and continues the run", async () => {
    let signedIn = false;
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "goto") dd.url = signedIn ? TOKENS_URL : "https://example.test/login?token=geheim";
        if (e.action === "click") {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", TOKEN);
        }
      },
    });
    let called = 0;
    const r = await runRecipe(
      withForm(),
      VARS,
      d,
      {
        signIn: async (drv) => {
          called++;
          signedIn = true;
          (drv as FakeDriver).url = "https://example.test/tokens";
        },
      },
      { signInOutsideWindow: true, pollMs: 5 },
    );
    expect(called).toBe(1);
    expect(r.value.reveal()).toBe(TOKEN);
  });

  it("a hook that leaves the browser signed out still ends with signin, not a wait", async () => {
    const err = (await runRecipe(withForm(), VARS, signedOut(), { signIn: async () => undefined }, { signInOutsideWindow: true, pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("signin");
  });

  it("a recipe without a guided sign-in keeps waiting for the human in the window", async () => {
    const err = (await runRecipe(sampleRecipe(), VARS, signedOut(), {}, { signInOutsideWindow: true, loginTimeoutMinutes: 0.0005, pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("timeout");
  });

  it("without the option (a local window) it still waits", async () => {
    const err = (await runRecipe(withForm(), VARS, signedOut(), {}, { loginTimeoutMinutes: 0.0005, pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("timeout");
  });
});
