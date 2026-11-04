import { ProviderRegistry } from "@secret-desk/core";
import { cloudflareAccessProviders } from "./cloudflare-access.js";
import { cloudflareR2Providers } from "./cloudflare-r2.js";
import { cloudflareProviders } from "./cloudflare.js";
import { grafanaProviders } from "./grafana.js";
import { manualProviders } from "./manual.js";
import { openaiProviders } from "./openai.js";
import { randomProviders } from "./random.js";
import { resendProviders } from "./resend.js";
import { revenueCatProviders } from "./revenuecat.js";
import { stripeProviders } from "./stripe.js";
import { supabaseProviders } from "./supabase.js";
import { vapidProviders } from "./vapid.js";

export * from "./http.js";
export * from "./random.js";
export * from "./cloudflare.js";
export * from "./cloudflare-access.js";
export * from "./cloudflare-r2.js";
export * from "./sigv4.js";
export * from "./supabase.js";
export * from "./stripe.js";
export * from "./resend.js";
export * from "./revenuecat.js";
export * from "./openai.js";
export * from "./anthropic.js";
export * from "./grafana.js";
export * from "./vapid.js";
export * from "./manual.js";

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of [
    ...randomProviders,
    ...cloudflareProviders,
    ...cloudflareAccessProviders,
    ...cloudflareR2Providers,
    ...supabaseProviders,
    ...stripeProviders,
    ...resendProviders,
    ...revenueCatProviders,
    ...openaiProviders,
    ...grafanaProviders,
    ...vapidProviders,
    ...manualProviders,
  ]) {
    registry.register(p);
  }
  return registry;
}
export * from "./variable-sources.js";
