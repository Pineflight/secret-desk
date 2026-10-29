import { describe, expect, it } from "vitest";
import { filterBySearch, isTypingTarget, searchWords } from "../src/lib/page-search";

const secret = (o: Record<string, unknown>) => ({ id: "cf-token", name: "CLOUDFLARE_API_TOKEN", stage: "production", places: [{ repo: "wake-miles", scope: "repository" as const }], tags: ["infra"], description: "Deploy token", provider: "cloudflare", service: "github-actions", ...o });
const variable = (o: Record<string, unknown>) => ({ id: "api-url", name: "API_URL", stage: "staging", value: "https://api.example.test", from: { connection: "main", kind: "worker", resource: "edge-api", field: "url" }, places: [{ repo: "lupe", scope: "environment" as const, environment: "staging" }], ...o });

describe("page search", () => {
  const items = [secret({}), secret({ id: "stripe", name: "STRIPE_KEY", provider: "stripe", tags: ["billing"], description: null, places: [{ repo: "web-studio", scope: "repository" as const }], stage: "staging" })];
  it("splits words and ignores case and extra whitespace", () => expect(searchWords("  Foo   BAR ")).toEqual(["foo", "bar"]));
  it("returns the list unchanged for an empty query", () => {
    expect(filterBySearch(items, "")).toBe(items);
    expect(filterBySearch(items, "   ")).toBe(items);
  });
  it("matches name, id, description, repo, stage, provider and tags", () => {
    for (const q of ["cloudflare_api", "cf-tok", "deploy", "wake-miles", "production", "stripe", "BILLING", "infra"]) expect(filterBySearch(items, q).length, q).toBeGreaterThan(0);
    expect(filterBySearch(items, "billing").map((i) => i.id)).toEqual(["stripe"]);
  });
  it("matches partial words, case-insensitively", () => expect(filterBySearch(items, "CLOUDF").map((i) => i.id)).toEqual(["cf-token"]));
  it("combines several words with AND, in any order", () => {
    expect(filterBySearch(items, "wake token").map((i) => i.id)).toEqual(["cf-token"]);
    expect(filterBySearch(items, "token wake").map((i) => i.id)).toEqual(["cf-token"]);
    expect(filterBySearch(items, "wake stripe")).toEqual([]);
  });
  it("finds nothing for unknown text", () => expect(filterBySearch(items, "zzz")).toEqual([]));
  it("matches variable value and source", () => {
    const v = [variable({}), variable({ id: "other", name: "OTHER", value: "x", from: null })];
    expect(filterBySearch(v, "example.test").map((i) => i.id)).toEqual(["api-url"]);
    expect(filterBySearch(v, "edge-api").map((i) => i.id)).toEqual(["api-url"]);
    expect(filterBySearch(v, "lupe staging")).toHaveLength(2);
  });
  it("does not match across the words of different fields by accident of concatenation", () => {
    const one = [secret({ id: "a", name: "AB", description: null, tags: [], service: "x", provider: "y", places: [{ repo: "cd", scope: "repository" as const }], stage: "z" })];
    expect(filterBySearch(one, "abcd")).toEqual([]);
  });
  it("detects typing targets for the slash shortcut", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
