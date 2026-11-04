import type { ProviderCard } from "./provider-cards";

export interface Connection {
  id: string;
  connected: boolean;
  source: "session" | "env" | "op" | "none" | string;
  hint?: string;
  expires?: string | null;
  daysLeft?: number | null;
  savedAt?: string | null;
  fingerprint?: string;
  canRemember?: boolean;
  label: string;
  vendor: string | null;
  role: "primary" | "legacy" | "optional";
  description: string | null;
  url: string | null;
  openUrl: string | null;
  steps: string[];
  permissions: string[];
}
export interface Provider {
  id: string;
  label: string;
  kind: string;
  browser: boolean;
  vendor: string | null;
  connection: string | null;
  guide: { url: string; steps: string[] } | null;
}

export const NAMES: Record<string, string> = { github: "GitHub", cloudflare: "Cloudflare", supabase: "Supabase", stripe: "Stripe", resend: "Resend", revenuecat: "RevenueCat", grafana: "Grafana" };
export const SOURCE_KEYS: Record<string, string> = { session: "connections.srcSession", env: "connections.srcEnv", op: "connections.srcOp", vault: "connections.srcVault", github: "connections.srcGithub", none: "connections.srcNone" };

/** Where the picker opens: a provider (or the full list), optionally straight into one of its ways in. */
export type Picking = false | { vendor: string | null; key?: string; signIn?: boolean; portal?: string | null; inputs?: Record<string, string>; renewal?: boolean };

export const labelOf = (c: Connection): string => c.label || NAMES[c.id] || c.id;

/** One plain sentence about how the provider's browser sign-in works. */
export function signInSentence(card: ProviderCard, t: (k: string, v?: Record<string, string | number>) => string): string {
  const s = card.signIn;
  if (s.state === "facade") return t(s.facade && s.facade.id === "stripe" ? "providers.signIn.facadeScoped" : "providers.signIn.facade");
  if (s.state === "recipe") return t(s.available ? "providers.signIn.recipe" : "providers.signIn.recipeOff", { name: card.label });
  return t("providers.signIn.coming", { name: card.label });
}
