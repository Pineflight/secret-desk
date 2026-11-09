import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDriver, SUDO_FLOWS, SudoError, WaitAbortedError, confirmAccess, sudoPageShown, type SudoAnswer, type SudoAsk, type SudoEvent, type SudoFlow } from "../src/index.js";

// Waits in confirmAccess are driven by a fake clock: nothing here sleeps for real.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs a promise to its end while the fake clock moves on. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(500);
  return p;
}
const outcome = (p: Promise<unknown>): Promise<unknown> => settle(p.then(() => "resolved", (e: unknown) => e));

const GITHUB = SUDO_FLOWS["github-sudo"];
const STRIPE = SUDO_FLOWS["stripe-verify"];
const GENERIC = SUDO_FLOWS["generic-verify"];
const { mobile: _mobile, ...githubWithoutMobile } = GITHUB;
const { code: _code, ...githubWithoutCode } = GITHUB;

const START = 'button "Use GitHub Mobile"';
const OTP = 'css input[name="sudo_app_otp"]';
const PW_FIELD = 'css input[name="sudo_password"]';
const VERIFY = 'button "Verify" (exact)';
const CONFIRM = 'button "Confirm" (exact)';
const SWITCH_CODE = 'Text "Use your authenticator app"';
const SWITCH_PW = 'Text "Use your password"';

interface Harness {
  asks: SudoAsk[];
  events: SudoEvent[];
  secrets: string[];
  args: Parameters<typeof confirmAccess>[1];
}
function harness(d: FakeDriver, answers: SudoAnswer[], extra: Partial<Parameters<typeof confirmAccess>[1]> = {}): Harness {
  const queue = [...answers];
  const h: Harness = {
    asks: [],
    events: [],
    secrets: [],
    args: {
      driver: d,
      hooks: {
        request: async (ask) => {
          h.asks.push(ask);
          const a = queue.shift();
          if (!a) throw new Error("gave up");
          return a;
        },
        onEvent: (e) => void h.events.push(e),
      },
      checkHost: async () => undefined,
      addSecret: (v) => void h.secrets.push(v),
      pollMs: 100,
      mobileTimeoutMs: 1000,
      submitTimeoutMs: 1000,
      discoverTimeoutMs: 1000,
      ...extra,
    },
  };
  return h;
}
const githubPage = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
  new FakeDriver({ url: "https://github.com/sessions/sudo", pollMs: 2, pageText: ["Confirm access"], visible: [START, SWITCH_CODE, SWITCH_PW], ...over });
const kind = (e: unknown): string => (e as SudoError).kind;

describe("sudoPageShown", () => {
  it("needs the text and one visible element, tolerates failing probes, and tries every detection of a flow", async () => {
    const d = githubPage();
    expect(await sudoPageShown(d, GITHUB)).toBe(true);
    expect(await sudoPageShown(githubPage({ pageText: [] }), GITHUB)).toBe(false);
    const broken = { hasText: async () => Promise.reject(new Error("x")), isVisible: async () => Promise.reject(new Error("x")) };
    expect(await sudoPageShown(broken, GITHUB)).toBe(false);
    const textOnly = { hasText: async () => true, isVisible: async () => Promise.reject(new Error("x")) };
    expect(await sudoPageShown(textOnly, GITHUB)).toBe(false);
    const dialog = new FakeDriver({ visible: ['css [role=dialog] input[type="password"]'] });
    expect(await sudoPageShown(dialog, GENERIC)).toBe(true);
    const field = new FakeDriver({ pageText: ["Please confirm your identity"], visible: ['css input[type="password"]'] });
    expect(await sudoPageShown(field, GENERIC)).toBe(true);
    expect(await sudoPageShown(new FakeDriver({ visible: ['css input[type="password"]'] }), GENERIC)).toBe(false);
  });
});

describe("confirmAccess: GitHub Mobile", () => {
  it("waits for the number text, hands over an empty number when it cannot be read, and times out", async () => {
    const d = githubPage();
    const h = harness(d, [{ method: "mobile" }], { maxAttempts: 1 });
    const err = await outcome(confirmAccess(GITHUB, h.args));
    expect(kind(err)).toBe("timeout");
    expect((err as SudoError).message).toBe("GitHub Mobile was not approved in time.");
    expect(h.events).toContainEqual({ type: "mobile", number: "" });
  });
  it("reads the number from the first area that shows it", async () => {
    const d = githubPage({ texts: { "css main": "nothing here", "css body": "Enter the digits shown below 73" } });
    const h = harness(d, [{ method: "mobile" }], { maxAttempts: 1 });
    await outcome(confirmAccess(GITHUB, h.args));
    expect(h.events).toContainEqual({ type: "mobile", number: "73" });
  });
  it("a flow without GitHub Mobile reports the way as unavailable", async () => {
    const h = harness(githubPage(), [{ method: "mobile" }], { maxAttempts: 1 });
    const err = await outcome(confirmAccess(githubWithoutMobile, h.args));
    expect(kind(err)).toBe("failed");
    expect((err as SudoError).message).toBe("GitHub offered none of the chosen ways to confirm access.");
  });
  it("a hidden start button reports the way as unavailable", async () => {
    const h = harness(githubPage({ visible: [] }), [{ method: "mobile" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("failed");
  });
  it("treats a failing text probe while waiting for the number as 'not there yet'", async () => {
    class Flaky extends FakeDriver {
      override async hasText(): Promise<boolean> {
        throw new Error("probe failed");
      }
    }
    const d = new Flaky({ url: "https://github.com/sessions/sudo", visible: [START] });
    const h = harness(d, [{ method: "mobile" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("timeout");
  });
});

describe("confirmAccess: a browser whose visibility probe fails", () => {
  class NoProbe extends FakeDriver {
    override async isVisible(): Promise<boolean> {
      throw new Error("probe failed");
    }
  }
  it("counts a failing probe as 'not visible' for a button, and as 'still open' for a flow that is open while elements show", async () => {
    const d = new NoProbe({ url: "https://github.com/sessions/sudo", pageText: ["Confirm access"] });
    const h = harness(d, [{ method: "mobile" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("failed");
    const stripe = new NoProbe({ url: "https://dashboard.stripe.com/" });
    const noPrepare: SudoFlow = { ...STRIPE, prepare: [] };
    const h2 = harness(stripe, [], { discoverTimeoutMs: 300 });
    expect(kind(await outcome(confirmAccess(noPrepare, h2.args)))).toBe("unrecognized");
  });
});

describe("confirmAccess: typing a code or password", () => {
  it("reports the way as unavailable when no submit button shows after typing", async () => {
    const d = githubPage({ visible: [OTP] });
    const h = harness(d, [{ method: "code", code: "123456" }], { maxAttempts: 1 });
    const err = await outcome(confirmAccess(GITHUB, h.args));
    expect(kind(err)).toBe("failed");
    expect(h.secrets).toEqual(["123456"]);
  });
  it("reports the way as unavailable when switching the view never shows the field", async () => {
    const h = harness(githubPage({ visible: [SWITCH_CODE] }), [{ method: "code", code: "123456" }], { maxAttempts: 1 });
    const d = h.args.driver as FakeDriver;
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("failed");
    expect(d.calls).toContain(`click ${SWITCH_CODE}`);
    expect(d.filled.size).toBe(0);
  });
  it("reports the way as unavailable when the flow has no such way", async () => {
    const h = harness(githubPage(), [{ method: "code", code: "123456" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(githubWithoutCode, h.args)))).toBe("failed");
  });
  it("clears the typed value from the answer", async () => {
    const answer: SudoAnswer = { method: "password", password: "made-up-pw" };
    const d = githubPage({ visible: [PW_FIELD, CONFIRM] });
    const h = harness(d, [answer], { maxAttempts: 1 });
    await outcome(confirmAccess(GITHUB, h.args));
    expect(answer).toEqual({ method: "password", password: "" });
    expect(d.filled.get(PW_FIELD)).toBe("made-up-pw");
  });
});

describe("confirmAccess: errors of a step", () => {
  const failingOn = (action: "fill" | "click", thrown: () => unknown, over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
    githubPage({
      visible: [OTP, VERIFY],
      on: (e) => {
        if (e.action === action) throw thrown();
      },
      ...over,
    });
  it("a page that does not work as expected ends with kind step, without the code", async () => {
    const h = harness(failingOn("fill", () => new Error("boom")), [{ method: "code", code: "987654" }], { maxAttempts: 1 });
    const err = await outcome(confirmAccess(GITHUB, h.args));
    expect(kind(err)).toBe("step");
    expect((err as SudoError).message).not.toContain("987654");
  });
  it("an aborted run ends with kind abort, also when the error is a wait that was aborted", async () => {
    const ac = new AbortController();
    const h = harness(
      failingOn("fill", () => {
        ac.abort();
        return new Error("boom");
      }),
      [{ method: "code", code: "987654" }],
      { signal: ac.signal, maxAttempts: 1 },
    );
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("abort");
    const h2 = harness(failingOn("fill", () => new WaitAbortedError()), [{ method: "code", code: "987654" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(GITHUB, h2.args)))).toBe("abort");
  });
  it("lets the host check of the run end the run as it is", async () => {
    const stop = Object.assign(new Error("outside the allowed hosts"), { name: "RecipeRunError" });
    const h = harness(githubPage({ visible: [OTP, VERIFY] }), [{ method: "code", code: "987654" }], {
      checkHost: async () => {
        throw stop;
      },
    });
    expect(await outcome(confirmAccess(GITHUB, h.args))).toBe(stop);
  });
  it("cancels before the first question when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness(githubPage(), [{ method: "password", password: "x" }], { signal: ac.signal });
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("abort");
    expect(h.asks).toEqual([]);
  });
});

describe("confirmAccess: reload between tries", () => {
  const wrongPassword = (): SudoAnswer => ({ method: "password", password: "wrong" });
  const rejecting = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) => githubPage({ visible: [PW_FIELD, CONFIRM], ...over });
  it("goes on with what is there when the page cannot be reloaded", async () => {
    class NoUrl extends FakeDriver {
      override async currentUrl(): Promise<string> {
        throw new Error("no url");
      }
    }
    const d = new NoUrl({ url: "https://github.com/sessions/sudo", pageText: ["Confirm access"], visible: [PW_FIELD, CONFIRM] });
    const h = harness(d, [wrongPassword(), wrongPassword()], { maxAttempts: 2 });
    expect(kind(await outcome(confirmAccess(GITHUB, h.args)))).toBe("failed");
    expect(h.asks.map((a) => a.problem)).toEqual([undefined, "rejected"]);
  });
  it("ends the confirmation when the reload is refused with a confirmation error", async () => {
    class Refusing extends FakeDriver {
      override async currentUrl(): Promise<string> {
        throw new SudoError("failed", "reload refused");
      }
    }
    const d = new Refusing({ url: "https://github.com/sessions/sudo", pageText: ["Confirm access"], visible: [PW_FIELD, CONFIRM] });
    const h = harness(d, [wrongPassword(), wrongPassword()], { maxAttempts: 2 });
    const err = await outcome(confirmAccess(GITHUB, h.args));
    expect((err as SudoError).message).toBe("reload refused");
    expect(h.asks).toHaveLength(1);
  });
  it("reloads the page between tries when it can", async () => {
    const d = rejecting();
    const h = harness(d, [wrongPassword(), wrongPassword()], { maxAttempts: 2 });
    await outcome(confirmAccess(GITHUB, h.args));
    expect(d.calls.filter((c) => c.startsWith("goto "))).toEqual(["goto https://github.com/sessions/sudo"]);
  });
});

describe("confirmAccess: flows that discover their fields (Stripe)", () => {
  const PREPARE_TEXT = 'Text "Verify by email + more verification"';
  const CONTINUE = 'css [role=dialog] >> role=button[name="Continue"s]';
  const DIALOG = "css [role=dialog]";
  const CODE_FIELD = 'css [role=dialog] input[autocomplete="one-time-code"], [role=dialog] input[inputmode="numeric"]';
  const PASSWORD_FIELD = 'css [role=dialog] input[type="password"]';
  const SUBMIT = 'css [role=dialog] >> role=button[name=/^(Continue|Verify|Submit|Confirm)$/i]';
  const stripePage = (on: ConstructorParameters<typeof FakeDriver>[0]["on"], visible: string[] = [PREPARE_TEXT, CONTINUE]) =>
    new FakeDriver({ url: "https://dashboard.stripe.com/", pollMs: 2, visible, on });

  it("gives up with 'unrecognized' when the first choice of the preparation never shows", async () => {
    const h = harness(stripePage(undefined, []), []);
    expect(kind(await outcome(confirmAccess(STRIPE, h.args)))).toBe("unrecognized");
  });
  it("a preparation click that fails ends with kind step", async () => {
    const d = stripePage((e) => {
      if (e.action === "click") throw new Error("detached");
    });
    expect(kind(await outcome(confirmAccess(STRIPE, harness(d, []).args)))).toBe("step");
  });
  it("ends at once when the dialog is gone after the preparation", async () => {
    const d = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) drv.visible.clear();
    });
    const h = harness(d, []);
    expect(await outcome(confirmAccess(STRIPE, h.args))).toBe("resolved");
    expect(h.events.map((e) => e.type)).toEqual(["confirmed"]);
  });
  it("gives up with 'unrecognized' when the dialog stays but shows no field", async () => {
    const d = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) drv.visible.add(DIALOG);
    });
    const h = harness(d, []);
    expect(kind(await outcome(confirmAccess(STRIPE, h.args)))).toBe("unrecognized");
    expect(h.asks).toEqual([]);
  });
  it("follows a further factor: the code field goes away and a password field shows", async () => {
    const d = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) for (const v of [DIALOG, CODE_FIELD, SUBMIT]) drv.visible.add(v);
      if (e.action === "click" && e.key === SUBMIT && drv.filled.has(CODE_FIELD) && !drv.filled.has(PASSWORD_FIELD)) {
        drv.visible.delete(CODE_FIELD);
        drv.visible.add(PASSWORD_FIELD);
      } else if (e.action === "click" && e.key === SUBMIT && drv.filled.has(PASSWORD_FIELD)) drv.visible.clear();
    });
    const h = harness(d, [{ method: "code", code: "246810" }, { method: "password", password: "made-up-pw" }]);
    expect(await outcome(confirmAccess(STRIPE, h.args))).toBe("resolved");
    expect(h.asks.map((a) => a.methods)).toEqual([["code"], ["password"]]);
    expect(h.asks.map((a) => a.problem)).toEqual([undefined, undefined]);
    expect(h.events.map((e) => e.type)).toEqual(["choose", "checking", "choose", "checking", "confirmed"]);
    expect(d.calls.filter((c) => c.startsWith("goto "))).toEqual([]);
  });
  it("rejects a code when the field leaves and nothing else shows, or when the field never leaves", async () => {
    const leaves = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) for (const v of [DIALOG, CODE_FIELD, SUBMIT]) drv.visible.add(v);
      if (e.action === "click" && e.key === SUBMIT) drv.visible.delete(CODE_FIELD);
    });
    const h = harness(leaves, [{ method: "code", code: "246810" }], { maxAttempts: 1 });
    const err = await outcome(confirmAccess(STRIPE, h.args));
    expect(kind(err)).toBe("failed");
    expect((err as SudoError).message).toBe("Stripe did not accept the confirmation.");
    const stays = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) for (const v of [DIALOG, CODE_FIELD, SUBMIT]) drv.visible.add(v);
    });
    const h2 = harness(stays, [{ method: "code", code: "246810" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(STRIPE, h2.args)))).toBe("failed");
  });
  it("lets the human give up at the question", async () => {
    const d = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) for (const v of [DIALOG, CODE_FIELD, SUBMIT]) drv.visible.add(v);
    });
    expect(kind(await outcome(confirmAccess(STRIPE, harness(d, []).args)))).toBe("abort");
  });
  it("a flow that also lists GitHub Mobile skips it when looking for fields", async () => {
    const mixed: SudoFlow = { ...STRIPE, methods: ["mobile", "code"], mobile: { start: { css: "#m" }, waiting: "w", area: [{ css: "main" }] }, prepare: [] };
    const d = stripePage((e, drv) => {
      if (e.action === "click") drv.visible.clear();
    }, [DIALOG, CODE_FIELD, SUBMIT]);
    const h = harness(d, [{ method: "code", code: "246810" }]);
    expect(await outcome(confirmAccess(mixed, h.args))).toBe("resolved");
    expect(h.asks[0]!.methods).toEqual(["code"]);
  });
  it("treats a field that leaves and comes back as a further question", async () => {
    let step = 0;
    const d = stripePage((e, drv) => {
      if (e.action === "click" && e.key === CONTINUE) for (const v of [DIALOG, CODE_FIELD, SUBMIT]) drv.visible.add(v);
      if (e.action === "click" && e.key === SUBMIT) {
        step += 1;
        if (step === 1) {
          drv.visible.delete(CODE_FIELD);
          // Back after a moment (the dialog redraws itself): the fake clock moves on while the flow polls.
          setTimeout(() => drv.visible.add(CODE_FIELD), 300);
        } else drv.visible.clear();
      }
    });
    const h = harness(d, [{ method: "code", code: "111111" }, { method: "code", code: "222222" }]);
    expect(await outcome(confirmAccess(STRIPE, h.args))).toBe("resolved");
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]!.problem).toBeUndefined();
  });
  it("a rejected code is told apart from a further factor even when the flow lists GitHub Mobile", async () => {
    const mixed: SudoFlow = { ...STRIPE, methods: ["mobile", "code"], mobile: { start: { css: "#m" }, waiting: "w", area: [{ css: "main" }] }, prepare: [] };
    const d = stripePage((e, drv) => {
      if (e.action === "click") drv.visible.delete(CODE_FIELD);
    }, [DIALOG, CODE_FIELD, SUBMIT]);
    const h = harness(d, [{ method: "code", code: "246810" }], { maxAttempts: 1 });
    expect(kind(await outcome(confirmAccess(mixed, h.args)))).toBe("failed");
  });
  it("uses its default polling when the caller gives none", async () => {
    const d = githubPage({
      visible: [PW_FIELD, CONFIRM],
      on: (e, drv) => {
        if (e.key === CONFIRM) drv.pageText.delete("Confirm access");
      },
    });
    const h = harness(d, [{ method: "password", password: "made-up-pw" }]);
    const { pollMs: _poll, ...withoutPoll } = h.args;
    expect(await outcome(confirmAccess(GITHUB, withoutPoll))).toBe("resolved");
  });
});
