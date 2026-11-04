import { describe, expect, it } from "vitest";
import { collapsedAction, collapsedBadge, collapsedMeta } from "../src/lib/card-collapsed";
import type { ProviderCard } from "../src/lib/provider-cards";

const NOW = new Date("2026-11-04T10:00:00Z");
const key = (daysLeft: number | null, expires: string | null = null) => ({ id: "k", label: "K", connected: true, role: "primary" as const, daysLeft, expires, level: daysLeft === null ? null : daysLeft < 0 ? ("expired" as const) : daysLeft < 7 ? ("critical" as const) : daysLeft <= 14 ? ("soon" as const) : ("ok" as const) });
const card = (rest: Partial<ProviderCard> = {}): ProviderCard => ({
  id: "acme", label: "Acme", category: "other", icon: null, custom: false, status: "connected",
  signIn: { state: "facade", facade: null, recipes: [], available: true }, keys: [key(85, "2027-01-28")], byHand: [], prefixes: [],
  browser: null, worksWithoutBrowser: false, secrets: 2, variables: 8, ...rest,
});

describe("collapsed card badge", () => {
  it("is Connected for a healthy connection and Not set up without anything", () => {
    expect(collapsedBadge(card(), { signIn: null, now: NOW })).toBe("connected");
    expect(collapsedBadge(card({ status: "none", keys: [], secrets: 0, variables: 0 }), { signIn: null })).toBe("none");
  });
  it("is Expires soon within 14 days and Expired once past", () => {
    expect(collapsedBadge(card({ keys: [key(10)] }), { signIn: null })).toBe("expiring");
    expect(collapsedBadge(card({ keys: [key(-2)] }), { signIn: null })).toBe("expired");
  });
  it("is Ready (browser) for a fresh browser sign-in and Sign-in needed otherwise", () => {
    expect(collapsedBadge(card({ status: "ready", keys: [] }), { signIn: null })).toBe("ready");
    expect(collapsedBadge(card({ status: "signout", keys: [] }), { signIn: null })).toBe("signin-needed");
    expect(collapsedBadge(card({ status: "unknown", keys: [] }), { signIn: null })).toBe("signin-needed");
  });
});

describe("collapsed card meta line", () => {
  it("says valid-until with the secret count when nothing is wrong", () => {
    const m = collapsedMeta(card(), { signIn: "unchecked", now: NOW });
    expect(m).toMatchObject({ kind: "valid", problem: false, key: "providers.meta.secretsUntil", vars: { count: 2 }, date: "2027-01-28" });
  });
  it("drops the date when no expiry is known, and says nothing without secrets", () => {
    expect(collapsedMeta(card({ keys: [key(null)] }), { signIn: null })).toMatchObject({ key: "providers.meta.secrets" });
    expect(collapsedMeta(card({ secrets: 0 }), { signIn: null })).toBeNull();
  });
  it("never shows the sign-in state of a facade provider whose API connection works", () => {
    for (const signIn of ["unchecked", "no", "failed", "waiting", "checking"] as const) {
      const m = collapsedMeta(card({ worksWithoutBrowser: true }), { signIn, now: NOW });
      expect(m?.kind).toBe("valid");
    }
  });
  it("lets an expiry within 14 days beat the neutral line", () => {
    expect(collapsedMeta(card({ keys: [key(9, "2026-11-13")] }), { signIn: null, now: NOW })).toMatchObject({ kind: "expiry", problem: true, key: "providers.meta.expiresSoon", date: "2026-11-13" });
    expect(collapsedMeta(card({ keys: [key(-1, "2026-11-03")] }), { signIn: null, now: NOW })).toMatchObject({ key: "providers.meta.expired" });
  });
  it("lets a needed sign-in beat an expiry, and a failed test beat everything", () => {
    const needs = card({ status: "signout", keys: [], browser: { readiness: { state: "signed-out", checkedAt: null, ageMinutes: null, stale: false }, secrets: 1, expiry: { keyId: "k", expires: "2026-11-10", daysLeft: 6, level: "critical" }, neverExpires: false, sessionHours: null, hostLines: [] } });
    expect(collapsedMeta(needs, { signIn: null, now: NOW })).toMatchObject({ kind: "signin-needed", problem: true });
    expect(collapsedMeta(needs, { signIn: null, testFailed: true, now: NOW })).toMatchObject({ kind: "test-failed" });
    expect(collapsedMeta(card({ keys: [key(5)] }), { signIn: null, testFailed: true, now: NOW })?.kind).toBe("test-failed");
  });
  it("treats a portal that is signed out as a needed sign-in", () => {
    const line = { value: "live", host: "x", readiness: { state: "signed-out" as const, checkedAt: null, ageMinutes: null, stale: false }, sessionHours: null };
    const c = card({ status: "ready", keys: [], browser: { readiness: { state: "ready", checkedAt: null, ageMinutes: null, stale: false }, secrets: 0, expiry: null, neverExpires: false, sessionHours: null, hostLines: [line] } });
    expect(collapsedMeta(c, { signIn: null })?.kind).toBe("signin-needed");
  });
});

describe("collapsed card action", () => {
  it("offers Set up only for a card that is not set up", () => {
    expect(collapsedAction({ status: "none" })).toBe("set-up");
    for (const status of ["connected", "ready", "signout", "unknown", "signin"] as const) expect(collapsedAction({ status })).toBeNull();
  });
});
