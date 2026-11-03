import { expiryLevel, type ExpiryLevel } from "./connection-health";

/**
 * One card per provider (vendor) on the Integrations page. The technical connections, provider definitions and browser recipes
 * are only the provider's ways in. Pure grouping: the vendor catalog comes from the server (`GET /vendors`), every row names its
 * vendor, so nothing here guesses from ids.
 */

export interface VendorInfo {
  id: string;
  label: string;
  category: string;
  icon: string | null;
  connections: string[];
  connectionPrefixes: string[];
  legacyConnections: string[];
  optionalConnections: string[];
  providers: string[];
  recipes: string[];
  signInPlanned: boolean;
}
export interface VendorsResponse {
  categories: string[];
  vendors: VendorInfo[];
}

export type ConnectionRole = "primary" | "legacy" | "optional";
export interface ConnectionRow {
  id: string;
  label: string;
  connected: boolean;
  vendor: string | null;
  role: ConnectionRole;
  daysLeft?: number | null;
}
export interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  browser?: boolean;
  vendor: string | null;
  guide: { url: string; steps: string[] } | null;
}
export interface RecipeRow {
  id: string;
  label: string;
}
export interface FacadeRow {
  id: string;
  label: string;
  available: boolean;
  connected: boolean;
  reason: string | null;
  connectionId: string;
}
export interface SecretRow {
  vendor: string | null;
}
export interface VariableRow {
  from: { connection: string } | null;
}

export interface KeyRow {
  id: string;
  label: string;
  connected: boolean;
  role: ConnectionRole;
  daysLeft: number | null;
  level: ExpiryLevel | null;
}

/** How a provider's browser sign-in stands. `none`: the provider has no recipe and none is planned. */
export type SignInState = "facade" | "recipe" | "coming" | "none";
export interface SignInWay {
  state: SignInState;
  /** The guided sign-in that creates the provider's integration keys (Stripe, RevenueCat). */
  facade: FacadeRow | null;
  /** Loaded recipes of this provider. */
  recipes: RecipeRow[];
  /** The recipes or the guided sign-in can run now (browser automation on and the recipe loaded). */
  available: boolean;
}

export type CardStatus = "connected" | "signin" | "none";

export interface ProviderCard {
  id: string;
  label: string;
  category: string;
  icon: string | null;
  /** True for a provider that is not in the catalog (a manual provider added by hand, an unknown connection). */
  custom: boolean;
  status: CardStatus;
  signIn: SignInWay;
  /** API keys: primary keys first, then optional, then older connections. */
  keys: KeyRow[];
  /** Providers whose value only a human can create (no API, no recipe). */
  byHand: ProviderRow[];
  secrets: number;
  variables: number;
}

export interface CardInput {
  catalog: VendorsResponse;
  connections: readonly ConnectionRow[];
  providers: readonly ProviderRow[];
  recipes: readonly RecipeRow[];
  facades: readonly FacadeRow[];
  secrets?: readonly SecretRow[];
  variables?: readonly VariableRow[];
  /** Vendors whose "check sign-in" answered yes in this session. */
  signedIn?: ReadonlySet<string>;
}

const ROLE_ORDER: Record<ConnectionRole, number> = { primary: 0, optional: 1, legacy: 2 };

const keyOf = (c: ConnectionRow): KeyRow => ({ id: c.id, label: c.label, connected: c.connected, role: c.role, daysLeft: c.daysLeft ?? null, level: c.connected ? expiryLevel(c.daysLeft) : null });

export function buildCards(input: CardInput): ProviderCard[] {
  const { catalog } = input;
  const vendorIds = new Set(catalog.vendors.map((v) => v.id));
  const connVendor = new Map(input.connections.map((c) => [c.id, c.vendor] as const));
  const loaded = new Set(input.recipes.map((r) => r.id));
  const cards: ProviderCard[] = [];

  for (const v of catalog.vendors) {
    const keys = input.connections.filter((c) => c.vendor === v.id).map(keyOf).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.label.localeCompare(b.label));
    const facade = input.facades.find((f) => f.id === v.id) ?? null;
    const recipes = input.recipes.filter((r) => v.recipes.includes(r.id));
    const state: SignInState = facade ? "facade" : v.recipes.length > 0 ? "recipe" : v.signInPlanned ? "coming" : "none";
    // With a loaded recipe the manual definition is just the recipe's other face; only an unloaded recipe leaves it by hand.
    const covered = v.recipes.some((r) => loaded.has(r));
    const byHand = input.providers.filter((p) => p.vendor === v.id && p.kind === "manual" && p.guide && !p.browser && !covered);
    cards.push({
      id: v.id,
      label: v.label,
      category: v.category,
      icon: v.icon,
      custom: false,
      status: statusOf(keys, facade, input.signedIn?.has(v.id) ?? false),
      signIn: { state, facade, recipes, available: facade ? facade.available : recipes.length > 0 },
      keys,
      byHand,
      secrets: (input.secrets ?? []).filter((s) => s.vendor === v.id).length,
      variables: (input.variables ?? []).filter((x) => x.from && connVendor.get(x.from.connection) === v.id).length,
    });
  }

  // Things the catalog does not know: a manual provider added by hand, a connection with no vendor.
  for (const p of input.providers) {
    if ((p.vendor && vendorIds.has(p.vendor)) || p.kind !== "manual" || !p.guide || p.browser) continue;
    cards.push(customCard(`provider:${p.id}`, p.label, [], [p]));
  }
  for (const c of input.connections) {
    if (c.vendor && vendorIds.has(c.vendor)) continue;
    cards.push(customCard(`connection:${c.id}`, c.label, [keyOf(c)], []));
  }

  const order = new Map(catalog.categories.map((c, i) => [c, i] as const));
  return cards.sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || (a.custom ? 1 : 0) - (b.custom ? 1 : 0) || a.label.localeCompare(b.label));
}

function statusOf(keys: readonly KeyRow[], facade: FacadeRow | null, signedIn: boolean): CardStatus {
  if (keys.some((k) => k.connected) || facade?.connected) return "connected";
  return signedIn ? "signin" : "none";
}

function customCard(id: string, label: string, keys: KeyRow[], byHand: ProviderRow[]): ProviderCard {
  return {
    id,
    label,
    category: "other",
    icon: null,
    custom: true,
    status: statusOf(keys, null, false),
    signIn: { state: "none", facade: null, recipes: [], available: false },
    keys,
    byHand,
    secrets: 0,
    variables: 0,
  };
}

/** The cards that are set up or have entries attached: the ones the page itself shows. */
export const isInUse = (c: ProviderCard): boolean => c.status !== "none" || c.secrets > 0 || c.variables > 0;

export interface CardGroup {
  category: string;
  cards: ProviderCard[];
}

/** Cards under their category, in the order the catalog gives. Empty categories are left out. */
export function groupByCategory(cards: readonly ProviderCard[], categories: readonly string[]): CardGroup[] {
  const known = new Set(categories);
  const order = [...categories, ...(cards.some((c) => !known.has(c.category)) ? ["other"] : [])];
  return [...new Set(order)]
    .map((category) => ({ category, cards: cards.filter((c) => c.category === category || (!known.has(c.category) && category === "other")) }))
    .filter((g) => g.cards.length > 0);
}

/** Search over name, category name and purpose (the last two come translated from the caller). Empty needle matches. */
export function cardMatches(card: ProviderCard, needle: string, extra: { purpose: string; category: string }): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  const haystack = [card.label, card.id, extra.purpose, extra.category, ...card.keys.map((k) => k.label), ...card.byHand.map((p) => p.label)].join(" ").toLowerCase();
  return n.split(/\s+/).every((word) => haystack.includes(word));
}

/** Short key of the ways a card offers, for the tile: sign-in, API keys, by hand. */
export function waysOf(card: ProviderCard): { signIn: boolean; keys: boolean; byHand: boolean } {
  return { signIn: card.signIn.state !== "none", keys: card.keys.length > 0, byHand: card.byHand.length > 0 };
}

/** The keys a card shows as "older connection": they stay readable, nothing is deleted. */
export const legacyKeys = (card: ProviderCard): KeyRow[] => card.keys.filter((k) => k.role === "legacy");

/** Per-account keys of the sign-in (Stripe), the ones the card lists as "Account · mode". */
export const primaryKeys = (card: ProviderCard): KeyRow[] => card.keys.filter((k) => k.role !== "legacy");

/** A legacy key is only worth a hint while a primary one could replace it. */
export const showsLegacyHint = (card: ProviderCard): boolean => legacyKeys(card).some((k) => k.connected) && card.signIn.state === "facade";
