import { describe, expect, it } from "vitest";
import { VENDOR_CATEGORIES, VENDORS, connectionRole, vendorById, vendorOfConnection, vendorOfProvider, vendorOfRecipe } from "../src/vendors.js";

describe("vendor catalog", () => {
  it("has unique ids and only known categories", () => {
    expect(new Set(VENDORS.map((v) => v.id)).size).toBe(VENDORS.length);
    for (const v of VENDORS) expect(VENDOR_CATEGORIES).toContain(v.category);
  });
  it("assigns every connection, provider and recipe to exactly one vendor", () => {
    const seen = new Map<string, string>();
    for (const v of VENDORS) {
      for (const key of [...v.connections, ...v.legacyConnections, ...v.optionalConnections].map((c) => `connection:${c}`).concat(v.providers.map((p) => `provider:${p}`), v.recipes.map((r) => `recipe:${r}`))) {
        expect(seen.get(key), key).toBeUndefined();
        seen.set(key, v.id);
      }
    }
  });
  it("covers every category from the brief", () => {
    expect(new Set(VENDORS.map((v) => v.category))).toEqual(new Set(["code", "hosting", "database", "payments", "messaging", "observability", "ai", "data", "print"]));
  });
  it("maps technical connections onto their vendor", () => {
    expect(vendorOfConnection("github-app-key")?.id).toBe("github");
    expect(vendorOfConnection("team-sync")?.id).toBe("github");
    expect(vendorOfConnection("cloudflare-turnstile")?.id).toBe("cloudflare");
    expect(vendorOfConnection("stripe-test")?.id).toBe("stripe");
    expect(vendorOfConnection("stripe-live")?.id).toBe("stripe");
    expect(vendorOfConnection("stripe")?.id).toBe("stripe");
    expect(vendorOfConnection("stripe:acct_1AbC:sandbox")?.id).toBe("stripe");
    expect(vendorOfConnection("unknown-thing")).toBeUndefined();
  });
  it("assigns the role of a connection under its card", () => {
    const stripe = vendorById("stripe")!;
    expect(connectionRole(stripe, "stripe-live")).toBe("legacy");
    expect(connectionRole(stripe, "stripe")).toBe("legacy");
    expect(connectionRole(stripe, "stripe:acct_1AbC:live")).toBe("primary");
    expect(connectionRole(vendorById("github")!, "github-app-key")).toBe("optional");
    expect(connectionRole(vendorById("github")!, "github")).toBe("primary");
  });
  it("maps providers, browser providers and recipes", () => {
    expect(vendorOfProvider("supabase-db-password")?.id).toBe("supabase");
    expect(vendorOfProvider("supabase-access-token-browser")?.id).toBe("supabase");
    expect(vendorOfProvider("vesselapi-api-key-browser")?.id).toBe("vesselapi");
    expect(vendorOfProvider("telegram-bot")?.id).toBe("telegram");
    expect(vendorOfProvider("random-hex")).toBeUndefined();
    expect(vendorOfRecipe("revenuecat-secret-api-key")?.id).toBe("revenuecat");
    expect(vendorOfRecipe("nope")).toBeUndefined();
  });
  it("gives Peecho a card without any way in yet", () => {
    const p = vendorById("peecho")!;
    expect([p.connections, p.providers, p.recipes].every((x) => x.length === 0)).toBe(true);
  });
});

describe("planned sign-in", () => {
  it("is set only where no recipe exists yet", () => {
    for (const v of VENDORS) if (v.signInPlanned) expect(v.recipes).toEqual([]);
    expect(vendorById("peecho")!.signInPlanned).toBe(true);
  });
});
