import { describe, expect, it } from "vitest";
import { messages } from "../src/messages";
import { translate } from "../src/lib/i18n";
import { outcomeOf, outcomeOfError, outcomeProblem, signInStatus, signedInIds, type CheckOutcome } from "../src/lib/sign-in-check";

const card = (facade: boolean) => ({ signIn: { state: facade ? ("facade" as const) : ("recipe" as const), facade: facade ? { id: "stripe", label: "Stripe", available: true, connected: false, reason: null, connectionId: "stripe" } : null, recipes: [], available: true } });
const t = (key: string): string => translate(key, undefined, "de");
const failure = (code: string) => ({ code, message: "The page could not be opened.", messageEn: "The page could not be opened." });

describe("sign-in check results", () => {
  it("tells the sign-in state of a card, only for providers that can be checked", () => {
    expect(signInStatus(card(false), undefined, undefined)).toBeNull();
    expect(signInStatus(card(true), undefined, undefined)).toBe("unchecked");
    expect(signInStatus(card(true), "waiting", undefined)).toBe("waiting");
    expect(signInStatus(card(true), "checking", outcomeOf({ signedIn: true, checkedAt: "x" }))).toBe("checking");
    expect(signInStatus(card(true), undefined, outcomeOf({ signedIn: true, checkedAt: "x" }))).toBe("yes");
    expect(signInStatus(card(true), undefined, outcomeOf({ signedIn: false, checkedAt: "x" }))).toBe("no");
    expect(signInStatus(card(true), undefined, outcomeOf({ signedIn: false, checkedAt: "x", failure: failure("page") }))).toBe("failed");
  });

  it("counts only a successful yes as signed in", () => {
    const o: Record<string, CheckOutcome> = {
      a: outcomeOf({ signedIn: true, checkedAt: "x" }),
      b: outcomeOf({ signedIn: false, checkedAt: "x" }),
      c: outcomeOf({ signedIn: false, checkedAt: "x", failure: failure("busy") }),
      d: outcomeOfError(new Error("network")),
    };
    expect([...signedInIds(o)]).toEqual(["a"]);
  });

  it("translates every failure of a check into the interface language", () => {
    for (const code of ["page", "busy", "browser", "timeout", "cancelled", "host", "step"]) {
      expect(messages.de[`facade.fail.${code}`], `de ${code}`).toBeTruthy();
      expect(messages.en[`facade.fail.${code}`], `en ${code}`).toBeTruthy();
    }
    const o = outcomeOf({ signedIn: false, checkedAt: "x", failure: failure("page") });
    const de = outcomeProblem(o, "de", t);
    expect(de).toBe(messages.de["facade.fail.page"]);
    expect(de).not.toMatch(/could not be opened/);
    expect(outcomeProblem(o, "en", (k) => translate(k, undefined, "en"))).toBe("The page could not be opened.");
    expect(outcomeProblem(outcomeOf({ signedIn: false, checkedAt: "x", failure: failure("busy") }), "de", t)).toBe(messages.de["facade.fail.busy"]);
  });

  it("shows no problem for a check that worked, and a request error as given", () => {
    expect(outcomeProblem(undefined, "de", t)).toBeNull();
    expect(outcomeProblem(outcomeOf({ signedIn: false, checkedAt: "x" }), "de", t)).toBeNull();
    expect(outcomeProblem(outcomeOfError(new Error("Keine Verbindung")), "de", t)).toBe("Keine Verbindung");
    expect(outcomeProblem(outcomeOfError("odd"), "de", t)).toBe(messages.de["common.unknownError"]);
  });
});
