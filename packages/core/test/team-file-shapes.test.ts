import { describe, expect, it } from "vitest";
import { TeamBundleError, assertTeamFileClean } from "../src/index.js";

const rep = (c: string, n: number) => c.repeat(n);
// Fixtures are assembled at run time so no key-shaped literal sits in the repository.
const SHAPES: Record<string, string> = {
  "stripe live": ["sk", "live", rep("a", 24)].join("_"),
  "stripe restricted": ["rk", "test", rep("b", 24)].join("_"),
  "revenuecat": ["sk", rep("Cd1", 10)].join("_"),
  "webhook secret": ["whsec", rep("Ab3", 8)].join("_"),
  "supabase": ["sbp", rep("0f", 15)].join("_"),
  "openai": ["sk", rep("Ab1", 12)].join("-"),
  "anthropic": ["sk", "ant", "api03", rep("Xy9", 10)].join("-"),
  "resend": ["re", rep("Ab1", 8)].join("_"),
  "cloudflare prefixed": ["cfut", rep("Zy8", 10)].join("_"),
  "cloudflare classic": rep("aB3_", 10),
  "github": ["ghp", rep("a1", 15)].join("_"),
  "github fine-grained": ["github", "pat", rep("A1", 15)].join("_"),
  "pem": ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
};

describe("assertTeamFileClean key shapes", () => {
  for (const [name, value] of Object.entries(SHAPES)) {
    it(`rejects a ${name} key and does not echo it`, () => {
      for (const text of [`description: ${value}\n`, `x: "prefix ${value} suffix"\n`]) {
        let message = "";
        try {
          assertTeamFileClean(text);
        } catch (e) {
          expect(e).toBeInstanceOf(TeamBundleError);
          message = (e as Error).message;
        }
        expect(message, name).not.toBe("");
        expect(message).not.toContain(value);
      }
    });
  }

  it("rejects an exact token text passed by the caller", () => {
    const token = ["made", "up", "provider", "token", "0001"].join("_");
    expect(() => assertTeamFileClean(`note: ${token}\n`, [token])).toThrow(TeamBundleError);
  });

  it("accepts ordinary structure: ids, names, sha-like hex, kebab-case words", () => {
    const text = [
      "version: 1",
      "secrets:",
      "  - id: task-queue-signing-key-for-the-app",
      "    name: STRIPE_WEBHOOK_SECRET",
      "    description: the rest_of_the_world_needs_no_key and a risk_level_assessment_record",
      `    hash: ${rep("ab12", 10)}`,
      "    service: re_use",
      "",
    ].join("\n");
    expect(() => assertTeamFileClean(text)).not.toThrow();
  });
});
