import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDriver, RecipeRunError, RecipeSchema, SUDO_FLOWS, WaitAbortedError, WaitTimeoutError, runRecipe, revokeRecipe, dryRunRecipe, type ResolvedCondition, type RunHooks, type RunOptions } from "../src/index.js";
import { TOKEN, VARS } from "./helpers.js";

const HOME = "https://example.test/";
const CREATE = { click: { role: "button", name: "Create", createsToken: true } };
const CREATE_KEY = 'button "Create"';

/** A driver whose waits can be scripted; every other action is the plain fake. */
class Scripted extends FakeDriver {
  waits: { cond: ResolvedCondition; ms: number }[] = [];
  waitImpl: ((cond: ResolvedCondition, ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** When set, waitImpl only answers the waits this accepts; every other wait is the plain fake's. */
  waitOnly: ((cond: ResolvedCondition) => boolean) | undefined;
  override async waitFor(cond: ResolvedCondition, ms: number, signal?: AbortSignal): Promise<void> {
    this.waits.push({ cond, ms });
    if (this.waitImpl && (this.waitOnly?.(cond) ?? true)) return this.waitImpl(cond, ms, signal);
    return super.waitFor(cond, ms, signal);
  }
}

const driverFor = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
  new Scripted({
    url: HOME,
    visible: [CREATE_KEY],
    on: (e, d) => {
      if (e.action === "click" && e.key === CREATE_KEY) {
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
    ...over,
  });

const recipe = (steps: unknown[] = [], over: Record<string, unknown> = {}) =>
  RecipeSchema.parse({
    id: "run-cov",
    label: "Run coverage",
    host: "example.test",
    steps: [...steps, CREATE],
    capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 } },
    ...over,
  });

const fails = async (p: Promise<unknown>): Promise<RecipeRunError> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RecipeRunError);
  return err as RecipeRunError;
};

describe("step labels in progress and error messages", () => {
  it("names every kind of step", async () => {
    const labels: string[] = [];
    const d = driverFor({
      visible: [CREATE_KEY, "css #ok", 'Feld "Name"', 'Feld "Agree"', 'Feld "Size"', 'button "Next"', 'css a.next'],
      attributes: { "css a.next@href": "/next" },
    });
    d.waitImpl = async () => undefined;
    const r = recipe([
      { goto: HOME },
      { follow: { css: "a.next" } },
      { fill: { label: "Name", value: "x" } },
      { select: { label: "Size", value: "L" } },
      { check: { label: "Agree" } },
      { click: { role: "button", name: "Next" } },
      { press: { key: "Enter" } },
      { waitFor: { visible: { css: "#ok" } } },
      { pause: { human: "Look at this", until: { visible: { css: "#ok" } } } },
      { confirmAccess: { flow: "github-sudo", until: { visible: { css: "#ok" } } } },
      { set: { var: "mode", value: "x" } },
      { screenshot: "shot" },
    ]);
    await runRecipe(r, VARS, d, { onProgress: (p) => void labels.push(p.label) });
    expect(labels).toEqual([
      "goto",
      "follow css a.next",
      'fill Feld "Name"',
      'select Feld "Size"',
      'check Feld "Agree"',
      'click button "Next"',
      "press Enter",
      "waitFor",
      "pause human: Look at this",
      "confirmAccess github-sudo",
      "set mode",
      "screenshot shot",
      'click button "Create"',
    ]);
  });
  it("a fail step ends the run with its message, or as unsupported", async () => {
    const labels: string[] = [];
    const hooks: RunHooks = { onProgress: (p) => void labels.push(p.label) };
    const plain = await fails(runRecipe(recipe([{ fail: "This variant is not supported" }]), VARS, driverFor(), hooks));
    expect(plain).toMatchObject({ kind: "step" });
    expect(plain.message).toContain("This variant is not supported");
    const unsupported = await fails(runRecipe(recipe([{ fail: "No create button", unsupported: true }]), VARS, driverFor()));
    expect(unsupported.kind).toBe("unsupported");
    expect(labels).toEqual(["fail"]);
  });
  it("names the failing step of each kind in the error", async () => {
    class Broken extends Scripted {
      override async currentUrl(): Promise<string> {
        throw new Error("no url");
      }
    }
    const visible = [CREATE_KEY];
    const message = async (step: unknown): Promise<string> => (await fails(runRecipe(recipe([step]), VARS, new Broken({ url: HOME, visible })))).message;
    expect(await message({ follow: { css: "a" } })).toContain("Schritt 1 (follow css a) fehlgeschlagen: Aktion nicht moeglich.");
    expect(await message({ fill: { label: "Name", value: "x" } })).toContain('(fill Feld "Name")');
    expect(await message({ select: { label: "Size", value: "L" } })).toContain('(select Feld "Size")');
    expect(await message({ check: { label: "Agree" } })).toContain('(check Feld "Agree")');
    expect(await message({ click: { role: "button", name: "Next" } })).toContain('(click button "Next")');
    expect(await message({ press: { key: "Enter" } })).toContain("(press Enter)");
    expect(await message({ confirmAccess: { flow: "github-sudo", until: { visible: { css: "#ok" } } } })).toContain("(confirmAccess github-sudo)");
    expect(await message({ screenshot: "shot" })).toContain("(screenshot shot)");
  });
  it("names the failing waitFor, pause and goto steps", async () => {
    const waiting = driverFor();
    waiting.waitImpl = async () => {
      throw new WaitTimeoutError();
    };
    const w = await fails(runRecipe(recipe([{ waitFor: { visible: { css: "#ok" } } }]), VARS, waiting));
    expect(w.message).toContain("Schritt 1 (waitFor) fehlgeschlagen: Zeitueberschreitung");
    const paused = await fails(
      runRecipe(recipe([{ pause: { human: "Check", until: { visible: { css: "#ok" } } } }]), VARS, driverFor(), {
        onWaitingForHuman: () => {
          throw new Error("hook broke");
        },
      }),
    ).catch((e: unknown) => e);
    expect(paused).toBeDefined();
  });
});

describe("lists and conditions", () => {
  it("an empty or missing list stops the run before any step", async () => {
    const vars: Record<string, string> = { ...VARS };
    delete vars["repos"];
    const d = driverFor();
    const err = await fails(runRecipe(recipe([{ fill: { placeholder: "Repo", value: "{{item}}" }, each: "repos" }]), vars, d));
    expect(err.message).toContain('braucht eine Liste "repos", sie ist leer');
    expect(d.calls.filter((c) => c.startsWith("fill"))).toEqual([]);
  });
  it("a when on a variable that is not set counts as an empty value", async () => {
    const r = recipe([{ goto: HOME, when: { var: "mode", equals: "x" } }, { goto: "https://example.test/other", when: { var: "mode", notEquals: "x" } }], { params: [{ key: "mode", label: "Mode", required: false }] });
    const d = driverFor();
    await runRecipe(r, VARS, d);
    expect(d.calls.filter((c) => c.startsWith("goto"))).toEqual(["goto https://example.test/other"]);
  });
  it("an element that does not show within the wait decides a when; other wait errors end the run", async () => {
    const absent = recipe([{ goto: HOME, when: { absent: { css: "#banner" }, timeoutSeconds: 2 } }]);
    const onlyBanner = (c: ResolvedCondition): boolean => c.visible?.css === "#banner";
    const present = driverFor();
    present.waitOnly = onlyBanner;
    present.waitImpl = async () => undefined;
    await runRecipe(absent, VARS, present);
    expect(present.calls.filter((c) => c.startsWith("goto"))).toEqual([]);
    const gone = driverFor();
    gone.waitOnly = onlyBanner;
    gone.waitImpl = async () => {
      throw new WaitTimeoutError();
    };
    await runRecipe(absent, VARS, gone);
    expect(gone.calls.filter((c) => c.startsWith("goto"))).toEqual([HOME].map((u) => `goto ${u}`));
    const broken = driverFor();
    broken.waitOnly = onlyBanner;
    broken.waitImpl = async () => {
      throw new Error("page crashed");
    };
    expect((await fails(runRecipe(absent, VARS, broken))).message).toContain("fehlgeschlagen: Aktion nicht moeglich.");
    const visibleWhen = recipe([{ goto: HOME, when: { visible: { css: "#banner" }, timeoutSeconds: 2 } }]);
    const brokenVisible = driverFor();
    brokenVisible.waitOnly = onlyBanner;
    brokenVisible.waitImpl = async () => {
      throw new Error("page crashed");
    };
    expect((await fails(runRecipe(visibleWhen, VARS, brokenVisible))).message).toContain("Aktion nicht moeglich.");
    const aborted = driverFor();
    aborted.waitOnly = onlyBanner;
    aborted.waitImpl = async () => {
      throw new WaitAbortedError();
    };
    expect((await fails(runRecipe(visibleWhen, VARS, aborted))).kind).toBe("abort");
  });
  it("a template problem in a step is reported with its own message", async () => {
    const vars: Record<string, string> = { ...VARS };
    delete vars["owner"];
    const err = await fails(runRecipe(recipe([{ fill: { label: "Name", value: "{{owner}}" } }]), vars, driverFor({ visible: [CREATE_KEY, 'Feld "Name"'] })));
    expect(err.message).toMatch(/Schritt 1 \(fill Feld "Name"\) fehlgeschlagen: .*owner/);
  });
  it("waitFor takes every kind of condition", async () => {
    const d = driverFor();
    d.waitImpl = async () => undefined;
    await runRecipe(
      recipe([
        { waitFor: { url: "^https://example\\.test/done", timeoutSeconds: 5 } },
        { waitFor: { hidden: { css: "#spinner" } } },
        { waitFor: { text: "Done" } },
        { waitFor: { any: [{ visible: { css: "#a" } }, { text: "b" }] } },
        { waitFor: { all: [{ url: "^https://example\\.test/" }, { text: "c" }] } },
      ]),
      VARS,
      d,
    );
    const conds = d.waits.slice(0, 5);
    expect(conds[0]!.ms).toBe(5000);
    expect(conds[0]!.cond.url).toEqual(/^https:\/\/example\.test\/done/);
    expect(conds[1]!.cond).toEqual({ hidden: { css: "#spinner" } });
    expect(conds[2]!.cond).toEqual({ text: "Done" });
    expect(conds[3]!.cond).toEqual({ any: [{ visible: { css: "#a" } }, { text: "b" }] });
    expect(conds[4]!.cond).toEqual({ all: [{ url: /^https:\/\/example\.test\// }, { text: "c" }] });
  });
});

describe("a browser whose probes fail", () => {
  class NoProbe extends Scripted {
    override async isVisible(): Promise<boolean> {
      throw new Error("probe failed");
    }
  }
  it("a when that cannot look decides: absent holds, visible does not", async () => {
    const flaky = (): NoProbe => new NoProbe({ url: HOME, visible: [CREATE_KEY], texts: { "css #tok": TOKEN } });
    const a = flaky();
    a.waitImpl = async () => undefined;
    await runRecipe(recipe([{ goto: "https://example.test/a", when: { absent: { css: "#banner" } } }]), VARS, a);
    expect(a.calls).toContain("goto https://example.test/a");
    const v = flaky();
    v.waitImpl = async () => undefined;
    await runRecipe(recipe([{ goto: "https://example.test/v", when: { visible: { css: "#banner" } } }]), VARS, v);
    expect(v.calls).not.toContain("goto https://example.test/v");
  });
  it("a token field whose visibility cannot be probed is read from the first place", async () => {
    const d = new NoProbe({ url: HOME, visible: [CREATE_KEY], texts: { "css #tok": TOKEN } });
    d.waitImpl = async () => undefined;
    const result = await runRecipe(recipe(), VARS, d);
    expect(result.value.reveal()).toBe(TOKEN);
  });
  it("a screenshot that fails does not lose the token or the read values", async () => {
    class NoShot extends Scripted {
      override async screenshot(): Promise<Buffer> {
        throw new Error("no screenshot");
      }
    }
    const created = await runRecipe(recipe(), VARS, new NoShot({ url: HOME, visible: [CREATE_KEY, "css #tok"], texts: { "css #tok": TOKEN } }));
    expect(created.value.reveal()).toBe(TOKEN);
    expect(created.screenshots).toEqual([]);
    const readRecipe = RecipeSchema.parse({ id: "read-shot", label: "Read shot", kind: "read", host: "example.test", steps: [{ goto: HOME }], capture: { values: { key: { find: { css: "#k" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } } } });
    const read = await runRecipe(readRecipe, VARS, new NoShot({ url: HOME, visible: ["css #k"], texts: { "css #k": "abc123def" } }));
    expect(read.value.reveal()).toBe("abc123def");
  });
  it("the sign-in check and the wait for the human survive failing probes", async () => {
    class Flaky extends FakeDriver {
      probes = 0;
      override async isVisible(sel: Parameters<FakeDriver["isVisible"]>[0]): Promise<boolean> {
        if (++this.probes <= 3) throw new Error("probe failed");
        return super.isVisible(sel);
      }
      override async currentUrl(): Promise<string> {
        throw new Error("no url");
      }
    }
    const d = new Flaky({ url: HOME, visible: ["css #signed-in"], pollMs: 1 });
    const seen: string[] = [];
    const r = recipe([{ goto: HOME }], { login: { expect: { visible: { css: "#signed-in" } }, form: { start: "https://example.test/login", steps: [{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }] } } });
    await dryRunRecipe(r, VARS, d, { signIn: async () => undefined, onWaitingForHuman: (info) => void seen.push(info.url) });
    expect(seen).toEqual([""]);
  });
});

describe("hosts and navigation", () => {
  it("a page that is no web page or not a valid address ends the run", async () => {
    const fill = [{ fill: { label: "Name", value: "x" } }];
    for (const url of ["ftp://example.test/", "garbage"]) {
      const err = await fails(runRecipe(recipe(fill), VARS, driverFor({ url, visible: ['Feld "Name"'] })));
      expect(err).toMatchObject({ kind: "host" });
      expect(err.message).toContain("keine erlaubte Webseite");
    }
  });
  it("an address that cannot be opened ends the run", async () => {
    const err = await fails(runRecipe(recipe([{ goto: "https://example.test:99999/x" }]), VARS, driverFor()));
    expect(err).toMatchObject({ kind: "host", message: "Adresse im Rezept ist ungueltig." });
  });
  it("follow: an address that cannot be resolved or that leaves https ends the run", async () => {
    const link = (href: string) => driverFor({ visible: [CREATE_KEY, "css a"], attributes: { "css a@href": href } });
    const bad = await fails(runRecipe(recipe([{ follow: { css: "a" } }]), VARS, link("http://[::1")));
    expect(bad.message).toBe("The link to follow is not a valid address.");
    const insecure = await fails(runRecipe(recipe([{ follow: { css: "a" } }]), VARS, link("http://example.test/x")));
    expect(insecure).toMatchObject({ kind: "host", message: "Adresse im Rezept ist ungueltig." });
    const missing = await fails(runRecipe(recipe([{ follow: { css: "a" } }]), VARS, driverFor({ visible: [CREATE_KEY, "css a"] })));
    expect(missing.message).toBe("The link to follow was not found or has no address.");
  });
});

describe("optional clicks", () => {
  const onlyCookies = (c: ResolvedCondition): boolean => c.visible?.name === "Cookies";
  const optional = (extra: Record<string, unknown> = {}) => recipe([{ click: { role: "button", name: "Cookies", optional: true, ...extra } }]);
  it("waits for the given time, and the default of 3 seconds otherwise", async () => {
    const withTime = driverFor();
    withTime.waitOnly = onlyCookies;
    withTime.waitImpl = async () => {
      throw new WaitTimeoutError();
    };
    await runRecipe(optional({ timeoutSeconds: 2 }), VARS, withTime);
    expect(withTime.waits[0]!.ms).toBe(2000);
    const defaulted = driverFor();
    defaulted.waitOnly = onlyCookies;
    defaulted.waitImpl = async () => {
      throw new WaitTimeoutError();
    };
    await runRecipe(optional(), VARS, defaulted);
    expect(defaulted.waits[0]!.ms).toBe(3000);
  });
  it("another wait error ends the run", async () => {
    const d = driverFor();
    d.waitOnly = onlyCookies;
    d.waitImpl = async () => {
      throw new Error("page crashed");
    };
    expect((await fails(runRecipe(optional(), VARS, d))).message).toContain("Aktion nicht moeglich.");
  });
  it("a click that cannot be done is skipped, but a host problem, an abort and a failing hook end the run", async () => {
    const d = driverFor({
      visible: [CREATE_KEY, 'button "Cookies"'],
      on: (e, drv) => {
        if (e.action === "click" && e.key === 'button "Cookies"') throw new Error("covered");
        if (e.action === "click" && e.key === CREATE_KEY) {
          drv.visible.add("css #tok");
          drv.texts.set("css #tok", TOKEN);
        }
      },
    });
    d.waitOnly = onlyCookies;
    d.waitImpl = async () => undefined;
    await expect(runRecipe(optional(), VARS, d)).resolves.toBeDefined();
    const ac = new AbortController();
    const aborting = driverFor({
      visible: [CREATE_KEY, 'button "Cookies"'],
      on: (e) => {
        if (e.action === "click" && e.key === 'button "Cookies"') {
          ac.abort();
          throw new Error("covered");
        }
      },
    });
    aborting.waitOnly = onlyCookies;
    aborting.waitImpl = async () => undefined;
    expect((await fails(runRecipe(optional(), VARS, aborting, {}, { signal: ac.signal }))).kind).toBe("abort");
    class Leaving extends Scripted {
      urls = 0;
      override async currentUrl(): Promise<string> {
        return ++this.urls > 1 ? "https://evil.example/" : HOME;
      }
    }
    const leaving = new Leaving({ url: HOME, visible: [CREATE_KEY, 'button "Cookies"'] });
    leaving.waitOnly = onlyCookies;
    leaving.waitImpl = async () => undefined;
    expect((await fails(runRecipe(optional(), VARS, leaving))).kind).toBe("host");
  });
});

describe("sign-in", () => {
  const withLogin = (over: Record<string, unknown> = {}) =>
    recipe([{ goto: HOME }], {
      login: { expect: { visible: { css: "#signed-in" } }, form: { start: "https://example.test/login", steps: [{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }] } },
      ...over,
    });
  it("a failing sign-in hook ends the run with the hook's own error", async () => {
    const boom = new Error("sign-in refused");
    const err = await runRecipe(withLogin(), VARS, driverFor(), {
      signIn: async () => {
        throw boom;
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBe(boom);
  });
  it("shows the waiting address without a query, or nothing when the address is not valid", async () => {
    const seen: string[] = [];
    const hooks = (d: FakeDriver): RunHooks => ({
      onWaitingForHuman: (info) => {
        seen.push(info.url);
        d.visible.add("#ok");
        d.visible.add("css #ok");
      },
    });
    const pause = recipe([{ pause: { human: "Look", until: { visible: { css: "#ok" } } } }]);
    const valid = driverFor({ url: "https://example.test/page?token=secret#frag" });
    await dryRunRecipe(pause, VARS, valid, hooks(valid));
    const invalid = driverFor({ url: "" });
    await dryRunRecipe(pause, VARS, invalid, hooks(invalid));
    expect(seen).toEqual(["https://example.test/page", ""]);
  });
});

describe("capturing a token", () => {
  it("an aborted wait for the token field ends the run as aborted", async () => {
    const d = driverFor();
    d.waitImpl = async () => {
      throw new WaitAbortedError();
    };
    expect((await fails(runRecipe(recipe(), VARS, d))).kind).toBe("abort");
  });
  it("an empty token field ends the run without echoing anything", async () => {
    const r = recipe([], { capture: { token: { find: { css: "#tok" }, timeoutSeconds: 0.05 } } });
    const d = driverFor({
      on: (e, drv) => {
        if (e.action === "click") {
          drv.visible.add("css #tok");
          drv.texts.set("css #tok", "  ");
        }
      },
    });
    const err = await fails(runRecipe(r, VARS, d));
    expect(err).toMatchObject({ kind: "capture" });
    expect(err.message).toContain("Token-Feld ist leer.");
  });
  it("an expiry needs a usable number of days and a date, and the created name is only reported when there is one", async () => {
    const r = recipe([], { capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }, expires: { from: "days" } } });
    const { date: _date, name: _name, ...rest } = VARS;
    const noDate = await runRecipe(r, rest, driverFor());
    expect(noDate).not.toHaveProperty("expiresAt");
    expect(noDate).not.toHaveProperty("createdName");
    const noDays = await runRecipe(r, { ...VARS, days: "many" }, driverFor());
    expect(noDays).not.toHaveProperty("expiresAt");
    const ok = await runRecipe(r, { ...VARS, days: "2", date: "2026-11-01" }, driverFor());
    expect(ok.expiresAt).toBe("2026-11-03");
  });
});

describe("kind read", () => {
  const read = (over: Record<string, unknown> = {}) =>
    RecipeSchema.parse({
      id: "read-cov",
      label: "Read cov",
      kind: "read",
      host: "example.test",
      steps: [{ goto: HOME }],
      capture: { values: { key: { find: { css: "#k" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } } },
      ...over,
    });
  const page = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) => driverFor({ visible: ["css #k"], texts: { "css #k": "abc123def" }, on: undefined, ...over });
  it("an aborted wait for a value ends the run as aborted", async () => {
    const d = page();
    d.waitImpl = async () => {
      throw new WaitAbortedError();
    };
    expect((await fails(runRecipe(read(), VARS, d))).kind).toBe("abort");
  });
  it("values missing without a fallback, or missing again after the fallback, end the run", async () => {
    const d = page({ visible: [] });
    expect((await fails(runRecipe(read(), VARS, d))).message).toBe("The values were not found on the page.");
    const withFallback = read({ capture: { values: { key: { find: { css: "#k" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } }, fallback: { steps: [{ goto: "https://example.test/alt" }], values: { key: { find: { css: "#alt" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } } } } });
    expect((await fails(runRecipe(withFallback, VARS, page({ visible: [] })))).message).toBe("The values were not found on the page.");
    const viaFallback = await runRecipe(withFallback, VARS, page({ visible: ["css #alt"], texts: { "css #alt": "fallback99" } }));
    expect(viaFallback.value.reveal()).toBe("fallback99");
  });
  it("a selector that cannot be rendered ends the run", async () => {
    const r = read({ capture: { values: { key: { find: { css: "#k-{{owner}}" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } } } });
    const vars: Record<string, string> = { ...VARS };
    delete vars["owner"];
    expect((await fails(runRecipe(r, vars, page()))).kind).toBe("capture");
  });
  it("without a picking parameter the single value is the entry's value", async () => {
    const result = await runRecipe(read(), VARS, page());
    expect(result.value.reveal()).toBe("abc123def");
    expect(Object.keys(result.values!)).toEqual(["key"]);
  });
});

describe("dry run and revoke", () => {
  it("a recipe without revoke steps says to revoke by hand", async () => {
    await expect(revokeRecipe(recipe(), VARS, driverFor())).rejects.toThrow("kennt keinen Widerruf");
  });
  it("a dry run stops before the step that creates something", async () => {
    const d = driverFor();
    const dry = await dryRunRecipe(recipe([{ goto: HOME }]), VARS, d);
    expect(dry.executed).toBe(1);
    expect(d.calls).not.toContain(`click ${CREATE_KEY}`);
  });
});

describe("confirmAccess steps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 4000 && !done; i++) await vi.advanceTimersByTimeAsync(500);
    return p;
  }
  const confirming = (flow: "github-sudo" | "stripe-verify" = "github-sudo") => recipe([{ confirmAccess: { flow, until: { visible: { css: "#ok" } }, timeoutSeconds: 5 } }]);
  const GITHUB_PAGE = { url: HOME, pageText: ["Confirm access"], visible: ['button "Use GitHub Mobile"', 'css input[name="sudo_password"]', 'button "Confirm" (exact)', CREATE_KEY] };
  const run = (r: ReturnType<typeof recipe>, d: FakeDriver, hooks: RunHooks = {}, options: RunOptions = {}) => settle(runRecipe(r, VARS, d, hooks, options).then(() => null, (e: unknown) => e));
  const passwordAnswer = { request: async () => ({ method: "password" as const, password: "made-up-pw" }) };

  it("fails with a clear message when neither the wanted page nor the confirmation page shows", async () => {
    const err = (await run(confirming(), driverFor({ url: HOME }))) as RecipeRunError;
    expect(err).toMatchObject({ kind: "step" });
    expect(err.message).toContain("Neither the expected page nor the confirmation page of the provider appeared.");
  });
  it("hands a flow that discovers its fields over to the human when the page never appears", async () => {
    let waited = 0;
    const d = driverFor({ url: HOME });
    const result = await run(confirming("stripe-verify"), d, {
      onWaitingForHuman: (info) => {
        waited += 1;
        expect(info.kind).toBe("pause");
        d.visible.add("css #ok");
      },
    });
    expect(result).toBeNull();
    expect(waited).toBe(1);
  });
  it("a confirmation page that cannot be probed counts as not shown", async () => {
    class NoProbe extends Scripted {
      override async isVisible(): Promise<boolean> {
        throw new Error("probe failed");
      }
    }
    const err = (await run(confirming(), new NoProbe({ url: HOME }))) as RecipeRunError;
    expect(err.message).toContain("Neither the expected page nor the confirmation page of the provider appeared.");
  });
  it("a cancelled question ends the run as aborted", async () => {
    const err = (await run(confirming(), new Scripted(GITHUB_PAGE), { access: { request: async () => Promise.reject(new Error("gave up")) } })) as RecipeRunError;
    expect(err.kind).toBe("abort");
  });
  it("a refused code or password ends the run as a failed step with the provider's message", async () => {
    const err = (await run(confirming(), new Scripted(GITHUB_PAGE), { access: passwordAnswer }, { access: { maxAttempts: 1, submitTimeoutMs: 600 } })) as RecipeRunError;
    expect(err).toMatchObject({ kind: "step" });
    expect(err.message).toContain("GitHub did not accept the confirmation.");
    expect(err.message).not.toContain("made-up-pw");
  });
  it("GitHub Mobile that is never approved ends the run as a timeout", async () => {
    const err = (await run(confirming(), new Scripted(GITHUB_PAGE), { access: { request: async () => ({ method: "mobile" as const }) } }, { access: { maxAttempts: 1, mobileTimeoutMs: 600 } })) as RecipeRunError;
    expect(err.kind).toBe("timeout");
  });
  it("a run that leaves the allowed hosts while asking ends as a host error", async () => {
    const d = new Scripted(GITHUB_PAGE);
    const err = (await run(confirming(), d, {
      access: {
        request: async () => {
          d.url = "https://evil.example/";
          return { method: "password" as const, password: "made-up-pw" };
        },
      },
    })) as RecipeRunError;
    expect(err.kind).toBe("host");
  });
  it("a page the flow cannot fill in is left to the human in the browser window", async () => {
    const d = new Scripted({
      url: "https://dashboard.stripe.com/",
      pageText: ["Verification required"],
      visible: ["Text \"Verify by email + more verification\"", CREATE_KEY],
    });
    let waited = 0;
    const r = RecipeSchema.parse({ id: "stripe-cov", label: "Stripe cov", host: "dashboard.stripe.com", steps: [{ confirmAccess: { flow: "stripe-verify", until: { visible: { css: "#ok" } } } }, CREATE], capture: { token: { find: { css: "#tok" }, timeoutSeconds: 0.05 } } });
    const err = await settle(
      runRecipe(r, VARS, d, {
        access: passwordAnswer,
        onWaitingForHuman: (info) => {
          waited += 1;
          expect(info.reason).toBe(SUDO_FLOWS["stripe-verify"].humanHint);
          d.visible.add("css #ok");
          d.visible.add("css #tok");
          d.texts.set("css #tok", TOKEN);
        },
      }).then(() => null, (e: unknown) => e),
    );
    expect(err).toBeNull();
    expect(waited).toBe(1);
  });
});
