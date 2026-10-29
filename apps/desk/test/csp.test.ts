import { describe, expect, it } from "vitest";
import config from "../next.config.js";

describe("security headers", () => {
  it("sets a Content-Security-Policy without foreign sources", async () => {
    const rules = await config.headers!();
    const csp = rules[0]!.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    for (const part of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp).toContain(part);
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("unsafe-eval"); // Test laeuft nicht im Entwicklungsmodus
  });
});

describe("legacy German routes", () => {
  it("redirect permanently to the English routes", async () => {
    const rules = await config.redirects!();
    const map = new Map(rules.map((r) => [r.source, r]));
    for (const [from, to] of [["/einstellungen", "/settings"], ["/freigaben", "/approvals"], ["/pruefen", "/reviews"], ["/pruefen/:id", "/reviews/:id"], ["/variablen", "/entries?kind=variable"], ["/verbindungen", "/connections"], ["/vergleich", "/compare"]] as const) {
      expect(map.get(from)).toMatchObject({ destination: to, permanent: true });
    }
  });
});

describe("merged list routes", () => {
  it("/secrets and /variables redirect permanently to /entries with the kind set", async () => {
    const rules = await config.redirects!();
    const map = new Map(rules.map((r) => [r.source, r]));
    expect(map.get("/secrets")).toMatchObject({ destination: "/entries?kind=secret", permanent: true });
    expect(map.get("/variables")).toMatchObject({ destination: "/entries?kind=variable", permanent: true });
  });
  it("keeps the detail route /secrets/:id (no catch-all redirect)", async () => {
    const rules = await config.redirects!();
    expect(rules.some((r) => r.source.startsWith("/secrets/"))).toBe(false);
    expect(rules.every((r) => r.source !== "/secrets/:path*")).toBe(true);
  });
});
