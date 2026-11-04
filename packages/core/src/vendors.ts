/**
 * Vendors: the one place that says which provider a connection, a provider definition or a browser recipe belongs to,
 * and which category a provider is shown under. The portal shows one card per vendor; the technical connections
 * (`github-app-key`, `stripe-test`, ...) are only ways in under that card.
 *
 * Pure data and lookups: no network, no values. Texts (purposes, category names) live in the interface catalogs.
 */

export const VENDOR_CATEGORIES = ["code", "hosting", "database", "payments", "messaging", "observability", "ai", "data", "print", "other"] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export interface VendorDef {
  /** Stable id; a vendor with a guided sign-in uses the id of that sign-in (`stripe`, `revenuecat`). */
  id: string;
  label: string;
  category: VendorCategory;
  /** Slug of the logo in the `simple-icons` package, or null for a neutral monogram. */
  icon: string | null;
  /** Connections that hold the API key the portal uses for this vendor. */
  connections: readonly string[];
  /** Connection id prefixes of keys per account (Stripe: `stripe:<acct>:<mode>`). */
  connectionPrefixes: readonly string[];
  /** Connections of an older layout. They stay readable and are shown as "older connection". */
  legacyConnections: readonly string[];
  /** Connections that are not needed for the basics and are shown as optional. */
  optionalConnections: readonly string[];
  /** Provider definitions (inventory providers) of this vendor. */
  providers: readonly string[];
  /** Browser recipes (recipe ids) that create keys at this vendor. */
  recipes: readonly string[];
  /** A browser sign-in is planned but no recipe exists yet ("recipe coming"). */
  signInPlanned: boolean;
}

const vendor = (v: Partial<VendorDef> & Pick<VendorDef, "id" | "label" | "category" | "icon">): VendorDef => ({
  connections: [],
  connectionPrefixes: [],
  legacyConnections: [],
  optionalConnections: [],
  providers: [],
  recipes: [],
  signInPlanned: false,
  ...v,
});

export const VENDORS: readonly VendorDef[] = [
  vendor({
    id: "github",
    label: "GitHub",
    category: "code",
    icon: "github",
    connections: ["github", "team-sync"],
    optionalConnections: ["github-app-key"],
    providers: ["github-fine-grained-token"],
    recipes: ["github-fine-grained-token"],
  }),
  vendor({ id: "cloudflare", label: "Cloudflare", category: "hosting", icon: "cloudflare", connections: ["cloudflare"], optionalConnections: ["cloudflare-turnstile"], providers: ["cloudflare-token", "cloudflare-turnstile", "cloudflare-access-service-token"] }),
  vendor({
    id: "supabase",
    label: "Supabase",
    category: "database",
    icon: "supabase",
    connections: ["supabase"],
    providers: ["supabase-api-key", "supabase-service-role", "supabase-db-password", "supabase-access-token"],
    recipes: ["supabase-access-token"],
  }),
  vendor({
    id: "stripe",
    label: "Stripe",
    category: "payments",
    icon: "stripe",
    connectionPrefixes: ["stripe:"],
    legacyConnections: ["stripe", "stripe-test", "stripe-live"],
    providers: ["stripe-webhook-secret", "stripe-restricted-key"],
    recipes: ["stripe-restricted-key"],
  }),
  vendor({ id: "revenuecat", label: "RevenueCat", category: "payments", icon: "revenuecat", connections: ["revenuecat"], providers: ["revenuecat-secret-key"], recipes: ["revenuecat-secret-api-key"] }),
  vendor({ id: "resend", label: "Resend", category: "messaging", icon: "resend", connections: ["resend"], providers: ["resend-api-key"] }),
  vendor({ id: "telegram", label: "Telegram", category: "messaging", icon: "telegram", providers: ["telegram-bot"] }),
  vendor({ id: "grafana", label: "Grafana Cloud", category: "observability", icon: "grafana", connections: ["grafana"], providers: ["grafana-service-account-token"] }),
  vendor({ id: "openai", label: "OpenAI", category: "ai", icon: null, connections: ["openai"], providers: ["openai"], recipes: ["openai-admin-key", "openai-api-key"] }),
  vendor({ id: "anthropic", label: "Anthropic", category: "ai", icon: null, connections: ["anthropic"], providers: ["anthropic-api-key-browser"], recipes: ["anthropic-admin-key", "anthropic-api-key"] }),
  vendor({ id: "vesselapi", label: "VesselAPI", category: "data", icon: null, recipes: ["vesselapi-api-key"] }),
  vendor({ id: "peecho", label: "Peecho", category: "print", icon: null, recipes: ["peecho-api-keys"] }),
];

export const vendorById = (id: string): VendorDef | undefined => VENDORS.find((v) => v.id === id);

/** A browser recipe registers its provider as `<recipe id>-browser`. */
const BROWSER_SUFFIX = "-browser";

/** The vendor a connection id belongs to (also the per-account Stripe connections and the older layout). */
export function vendorOfConnection(id: string): VendorDef | undefined {
  return VENDORS.find((v) => v.connections.includes(id) || v.legacyConnections.includes(id) || v.optionalConnections.includes(id) || v.connectionPrefixes.some((p) => id.startsWith(p)));
}

/** The vendor of a provider definition id, including the browser providers of a recipe. */
export function vendorOfProvider(id: string): VendorDef | undefined {
  const recipe = id.endsWith(BROWSER_SUFFIX) ? id.slice(0, -BROWSER_SUFFIX.length) : null;
  return VENDORS.find((v) => v.providers.includes(id) || (recipe !== null && v.recipes.includes(recipe)));
}

export const vendorOfRecipe = (recipeId: string): VendorDef | undefined => VENDORS.find((v) => v.recipes.includes(recipeId));

/** The role a connection plays under its vendor card. */
export type ConnectionRole = "primary" | "legacy" | "optional";

export function connectionRole(v: VendorDef, id: string): ConnectionRole {
  if (v.legacyConnections.includes(id)) return "legacy";
  if (v.optionalConnections.includes(id)) return "optional";
  return "primary";
}
