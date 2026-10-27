import { ProviderRegistry } from "@secret-desk/core";
import { cloudflareProviders } from "./cloudflare.js";
import { grafanaProviders } from "./grafana.js";
import { manualProviders } from "./manual.js";
import { randomProviders } from "./random.js";
import { resendProviders } from "./resend.js";
import { stripeProviders } from "./stripe.js";
import { supabaseProviders } from "./supabase.js";

export * from "./http.js";
export * from "./random.js";
export * from "./cloudflare.js";
export * from "./supabase.js";
export * from "./stripe.js";
export * from "./resend.js";
export * from "./grafana.js";
export * from "./manual.js";

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of [
    ...randomProviders,
    ...cloudflareProviders,
    ...supabaseProviders,
    ...stripeProviders,
    ...resendProviders,
    ...grafanaProviders,
    ...manualProviders,
  ]) {
    registry.register(p);
  }
  return registry;
}
