import { describe, expect, it } from "vitest";
import { daysSince, expiryLevel, shortHash, staleWithoutExpiry, stripePrefixMismatch } from "../src/lib/connection-health";

const NOW = new Date("2026-11-01T12:00:00Z");

describe("expiryLevel", () => {
  it("Grenzen: >14 gruen, 7..14 gelb, <7 rot, abgelaufen", () => {
    expect(expiryLevel(15)).toBe("ok");
    expect(expiryLevel(14)).toBe("soon");
    expect(expiryLevel(7)).toBe("soon");
    expect(expiryLevel(6)).toBe("critical");
    expect(expiryLevel(0)).toBe("critical");
    expect(expiryLevel(-1)).toBe("expired");
    expect(expiryLevel(null)).toBeNull();
    expect(expiryLevel(undefined)).toBeNull();
  });
});

describe("Alter des Tokens", () => {
  it("daysSince", () => {
    expect(daysSince("2026-11-01T00:00:00Z", NOW)).toBe(0);
    expect(daysSince("2026-10-01T12:00:00Z", NOW)).toBe(31);
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("kaputt", NOW)).toBeNull();
    expect(daysSince("2027-01-01T00:00:00Z", NOW)).toBe(0);
  });
  it("Warnung nur ohne Ablauf und ueber 90 Tage", () => {
    const old = "2026-07-01T00:00:00Z";
    expect(staleWithoutExpiry(null, old, NOW)).toBe(123);
    expect(staleWithoutExpiry(null, "2026-08-03T12:00:00Z", NOW)).toBeNull();
    expect(staleWithoutExpiry(null, "2026-08-02T12:00:00Z", NOW)).toBe(91);
    expect(staleWithoutExpiry("2026-12-01", old, NOW)).toBeNull();
    expect(staleWithoutExpiry(undefined, old, NOW)).toBeNull();
    expect(staleWithoutExpiry(null, undefined, NOW)).toBeNull();
  });
});

describe("stripePrefixMismatch", () => {
  it("erkennt Live in Sandbox und umgekehrt", () => {
    expect(stripePrefixMismatch("stripe-test", "rk_live_abc")).toBe("live");
    expect(stripePrefixMismatch("stripe-live", " sk_test_abc")).toBe("test");
    expect(stripePrefixMismatch("stripe-test", "rk_test_abc")).toBeNull();
    expect(stripePrefixMismatch("stripe", "rk_live_abc")).toBeNull();
    expect(stripePrefixMismatch("stripe-live", "xyz")).toBeNull();
  });
});

describe("shortHash", () => {
  it("kuerzt lange Werte", () => {
    expect(shortHash("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(shortHash("abc")).toBe("abc");
  });
});
