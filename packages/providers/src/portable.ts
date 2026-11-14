// Portable entry point (`@secret-desk/providers/portable`) for runtimes without Node APIs, for example a Cloudflare Worker.
//
// Rule: this file reaches only provider modules that import no Node built-ins and use no `Buffer`, and it takes the core
// from `@secret-desk/core/portable`. Adding a module here means adding it to the guard in `test/portable-modules.test.ts`
// (it checks the whole import closure of this file). Not ported: `random` (random bytes), `cloudflare-r2` and `sigv4`
// (HMAC and digest from `node:crypto`), `supabase` (`node:crypto`, `Buffer`) and `vapid` (`node:crypto` key agreement).
import { ProviderRegistry, type Provider } from "@secret-desk/core/portable";
import { cloudflareAccessProviders } from "./cloudflare-access.js";
import { cloudflareProviders } from "./cloudflare.js";
import { grafanaProviders } from "./grafana.js";
import { manualProviders } from "./manual.js";
import { openaiProviders } from "./openai.js";
import { resendProviders } from "./resend.js";
import { revenueCatProviders } from "./revenuecat.js";
import { stripeProviders } from "./stripe.js";

export * from "./http.js";
export * from "./cloudflare.js";
export * from "./cloudflare-access.js";
export * from "./stripe.js";
export * from "./resend.js";
export * from "./revenuecat.js";
export * from "./openai.js";
export * from "./anthropic.js";
export * from "./grafana.js";
export * from "./manual.js";
export * from "./variable-sources.js";

/** The providers that run without Node APIs, in the order `createDefaultRegistry()` registers them. */
export const portableProviders: Provider[] = [
  ...cloudflareProviders,
  ...cloudflareAccessProviders,
  ...stripeProviders,
  ...resendProviders,
  ...revenueCatProviders,
  ...openaiProviders,
  ...grafanaProviders,
  ...manualProviders,
];

/** A registry with the portable providers only. The local edition keeps using `createDefaultRegistry()`. */
export function createPortableRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of portableProviders) registry.register(p);
  return registry;
}
