import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/index.js";
import { createPortableRegistry, portableProviders } from "../src/portable.js";

// The order of the default registry is part of its behaviour (lists in the portal and the CLI follow it): pinned here.
const DEFAULT_ORDER = [
  "random-hex", "random-base64", "random-uuid",
  "cloudflare-token", "cloudflare-turnstile",
  "cloudflare-access-service-token",
  "cloudflare-r2-credentials",
  "supabase-api-key", "supabase-service-role", "supabase-db-password",
  "stripe-webhook-secret",
  "resend-api-key",
  "revenuecat-secret-key",
  "openai",
  "grafana-service-account-token", "grafana-access-policy-token",
  "vapid-keypair",
  "stripe-restricted-key", "supabase-access-token", "github-fine-grained-token", "telegram-bot",
];
const PORTABLE_ORDER = [
  "cloudflare-token", "cloudflare-turnstile", "cloudflare-access-service-token", "stripe-webhook-secret", "resend-api-key", "revenuecat-secret-key", "openai",
  "grafana-service-account-token", "grafana-access-policy-token", "stripe-restricted-key", "supabase-access-token", "github-fine-grained-token", "telegram-bot",
];

describe("registry order", () => {
  it("createDefaultRegistry registers the providers in a fixed order", () => {
    expect(createDefaultRegistry().list().map((p) => p.id)).toEqual(DEFAULT_ORDER);
  });

  it("createPortableRegistry registers the portable providers in the same relative order", () => {
    const portable = createPortableRegistry().list().map((p) => p.id);
    expect(portable).toEqual(PORTABLE_ORDER);
    expect(DEFAULT_ORDER.filter((id) => portable.includes(id))).toEqual(portable);
    expect(portableProviders.map((p) => p.id)).toEqual(portable);
  });

  it("the portable registry holds the very same provider objects as the default registry", () => {
    const defaults = createDefaultRegistry();
    for (const p of createPortableRegistry().list()) expect(defaults.get(p.id), p.id).toBe(p);
  });

  it("the portable registry has no provider that needs Node APIs", () => {
    const ids = createPortableRegistry().list().map((p) => p.id);
    for (const id of ["random-hex", "random-base64", "random-uuid", "cloudflare-r2-credentials", "supabase-api-key", "supabase-service-role", "supabase-db-password", "vapid-keypair"]) expect(ids).not.toContain(id);
  });
});
