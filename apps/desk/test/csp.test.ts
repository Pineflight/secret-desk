import { describe, expect, it } from "vitest";
import config from "../next.config.js";

describe("Sicherheits-Header", () => {
  it("setzt eine Content-Security-Policy ohne fremde Quellen", async () => {
    const rules = await config.headers!();
    const csp = rules[0]!.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    for (const part of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp).toContain(part);
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("unsafe-eval"); // Test laeuft nicht im Entwicklungsmodus
  });
});
