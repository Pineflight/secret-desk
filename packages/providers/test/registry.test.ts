import { describe, expect, it } from "vitest";
import { callJson, ProviderError } from "../src/http.js";
import { createDefaultRegistry } from "../src/index.js";
import { CONN_TOKEN } from "./helpers.js";

describe("createDefaultRegistry", () => {
  const list = createDefaultRegistry().list();
  it("contains every id exactly once", () => {
    const ids = list.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["random-hex", "cloudflare-token", "supabase-api-key", "stripe-webhook-secret", "resend-api-key", "grafana-service-account-token", "openai"]));
  });
  it("all manual providers have a guide with URL", () => {
    const manual = list.filter((p) => p.kind === "manual");
    // Feste Ids muessen dabei sein; neue manuelle Anbieter duerfen dazukommen, ohne dass der Test bricht.
    expect(manual.map((p) => p.id)).toEqual(expect.arrayContaining(["stripe-restricted-key", "supabase-access-token", "github-fine-grained-token", "telegram-bot", "openai"]));
    expect(manual.length).toBeGreaterThanOrEqual(5);
    for (const p of manual) {
      expect(p.guide?.url).toMatch(/^https:\/\//);
      expect(p.guide!.steps.length).toBeGreaterThanOrEqual(3);
      expect(p.guide!.steps.length).toBeLessThanOrEqual(6);
      expect(p.issue).toBeUndefined();
    }
  });
  it("all automatic providers can issue", () => {
    for (const p of list.filter((x) => x.kind === "automatic")) expect(typeof p.issue).toBe("function");
  });
});

describe("callJson", () => {
  it("turns network errors into ProviderError without token", async () => {
    const f = (async () => {
      throw new Error(`connect failed ${CONN_TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await callJson("x", f, "https://a.example", { method: "GET" }, [CONN_TOKEN]).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
  it("reports a timeout", async () => {
    const f = (async () => {
      throw new DOMException("timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(callJson("x", f, "https://a.example", { method: "GET" }, [])).rejects.toThrow(/20 s/);
  });
});

import { githubTokenUrl } from "../src/manual.js";

describe("githubTokenUrl", () => {
  const secret = { id: "sd-trial", description: "Probe", ttlDays: 7, params: { permissions: { secrets: "write", environments: "read", evil: "root", "x y": "read" } } } as never;
  it("prefills name, owner, expiry and valid permissions", () => {
    const u = new URL(githubTokenUrl(secret, "acme", new Date("2026-10-27T12:00:00Z")));
    expect(u.origin + u.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(u.searchParams.get("name")).toBe("sd-trial-20261027");
    expect(u.searchParams.get("target_name")).toBe("acme");
    expect(u.searchParams.get("expires_in")).toBe("7");
    expect(u.searchParams.get("secrets")).toBe("write");
    expect(u.searchParams.get("environments")).toBe("read");
    expect(u.searchParams.has("evil")).toBe(false);
    expect(u.searchParams.has("x y")).toBe(false);
  });
});
