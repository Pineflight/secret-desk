import { expiryLevel, type ExpiryLevel } from "./connection-health";
import { ageParts, browserReadiness, newestCheck, sessionHoursOf, DEFAULT_FRESH_HOURS, type AgeParts, type Readiness, type SessionLifetimeRow, type SignInCheckRow } from "./browser-ready";

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
  expires?: string | null;
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
  /** Host the recipe signs in at; the browser sign-in memory is kept per host. */
  host?: string;
  /** A recipe with several portals: the parameter that picks one, and the host of each value. */
  hostBy?: string | null;
  hosts?: readonly { value: string; host: string }[];
  /** The recipe has a guided sign-in, so its browser session can be checked and the human can sign in from the portal. */
  canCheckSignIn?: boolean;
  /** The ways to sign in (the provider's own form first). Absent or empty: email only. */
  signInMethods?: readonly { id: string; label: string | null; labelEn: string | null }[];
  /** The email sign-in has no password (a one-time code is sent). */
  signInPasswordless?: boolean;
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
  /** The entry's value is created by a browser recipe. */
  browser?: boolean;
  daysLeft?: number | null;
  /** Day the entry expires (YYYY-MM-DD), null: never. */
  expires?: string | null;
  id?: string;
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
  /** Day the key expires (YYYY-MM-DD), null: never, undefined: not known. */
  expires?: string | null | undefined;
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
  /** Without a guided sign-in: the recipe whose browser session can be checked instead, if any. */
  checkRecipe?: string | null;
  /** The portals of the checkable recipe when it has several (each is checked on its own, with its own account). Empty: one portal. */
  checkHosts?: readonly { value: string; host: string }[];
}

/** The sign-in state of one portal of a recipe with several portals. */
export interface HostLine {
  /** The value of the recipe's host parameter (for example `live`, `test`). */
  value: string;
  host: string;
  readiness: Readiness;
  /** How long sign-ins at this portal lasted, in whole hours; null until measured. */
  sessionHours: number | null;
}

/** What the browser contributes to a card whose keys come from recipes. */
export interface BrowserWay {
  readiness: Readiness;
  /** Inventory entries of this provider whose values the browser creates. */
  secrets: number;
  /** The earliest expiry among those entries, like connected keys have. */
  expiry: EarliestExpiry | null;
  /** How long a sign-in here has lasted, in whole hours (at least 1), from measurements; null until there is one. */
  sessionHours: number | null;
  /** One line per portal when a recipe of this provider has several (live and test with separate accounts); empty otherwise. */
  hostLines: HostLine[];
}

/**
 * `connected`: an API connection exists. `ready`/`signout`/`unknown`: keys come from the browser and the last sign-in answer is
 * fresh and yes / fresh and no / missing or too old. `signin`: a check in this page session said yes. `none`: nothing usable.
 */
export type CardStatus = "connected" | "ready" | "signout" | "unknown" | "signin" | "none";

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
  /** Browser view of the card; null when the provider has no loaded recipe. */
  browser: BrowserWay | null;
  /** An API connection exists, so keys are issued without any browser sign-in. Only for providers with a guided sign-in. */
  worksWithoutBrowser: boolean;
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
  /** The server's memory of the last browser sign-in state per recipe host. */
  signInChecks?: readonly SignInCheckRow[];
  /** Hours a sign-in answer counts as current (`automation.signInFreshHours`). */
  signInFreshHours?: number;
  /** How long sign-ins lasted per recipe host, as measured by the server. */
  signInLifetimes?: readonly SessionLifetimeRow[];
  /** Time source; the caller passes one so the badge is testable. */
  now?: Date;
  /** Browser automation is on. Without it no recipe is usable. */
  automationEnabled?: boolean;
}

const ROLE_ORDER: Record<ConnectionRole, number> = { primary: 0, optional: 1, legacy: 2 };

const keyOf = (c: ConnectionRow): KeyRow => ({ id: c.id, label: c.label, connected: c.connected, role: c.role, daysLeft: c.daysLeft ?? null, expires: c.expires, level: c.connected ? expiryLevel(c.daysLeft) : null });

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
    const usable = recipes.length > 0 && (input.automationEnabled ?? true);
    const hostsOf = (r: RecipeRow): string[] => (r.hosts && r.hosts.length > 0 ? r.hosts.map((h) => h.host) : r.host ? [r.host] : []);
    const hosts = recipes.flatMap(hostsOf);
    const now = input.now ?? new Date();
    const freshHours = input.signInFreshHours ?? DEFAULT_FRESH_HOURS;
    const hostLines: HostLine[] = recipes.flatMap((r) => (r.hosts ?? []).map((h) => ({ value: h.value, host: h.host, readiness: browserReadiness(newestCheck(input.signInChecks ?? [], [h.host]), now, freshHours), sessionHours: sessionHoursOf(input.signInLifetimes ?? [], [h.host]) })));
    const managed = (input.secrets ?? []).filter((s) => s.vendor === v.id && s.browser === true);
    const browser: BrowserWay | null = usable
      ? { readiness: browserReadiness(newestCheck(input.signInChecks ?? [], hosts), now, freshHours), secrets: managed.length, expiry: earliestAmong(managed), sessionHours: sessionHoursOf(input.signInLifetimes ?? [], hosts), hostLines }
      : null;
    const byHand = input.providers.filter((p) => p.vendor === v.id && p.kind === "manual" && p.guide && !p.browser && !covered);
    cards.push({
      id: v.id,
      label: v.label,
      category: v.category,
      icon: v.icon,
      custom: false,
      status: statusOf(keys, facade, input.signedIn?.has(v.id) ?? false, browser),
      signIn: { state, facade, recipes, available: facade ? facade.available : recipes.length > 0, checkRecipe: facade ? null : (recipes.find((r) => r.canCheckSignIn)?.id ?? null), checkHosts: facade ? [] : (recipes.find((r) => r.canCheckSignIn)?.hosts ?? []) },
      keys,
      byHand,
      browser,
      worksWithoutBrowser: state === "facade" && (keys.some((k) => k.connected) || facade?.connected === true),
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

function statusOf(keys: readonly KeyRow[], facade: FacadeRow | null, signedIn: boolean, browser: BrowserWay | null): CardStatus {
  if (keys.some((k) => k.connected) || facade?.connected) return "connected";
  if (browser) {
    if (browser.readiness.state === "ready") return "ready";
    if (browser.readiness.state === "signed-out") return "signout";
    // An old or missing answer is only worth a card when the browser creates values for it: otherwise it is not set up.
    if (browser.secrets > 0) return "unknown";
  }
  return signedIn ? "signin" : "none";
}

/** The entry that runs out first among the browser-managed ones (entries without a known end are skipped). */
function earliestAmong(rows: readonly SecretRow[]): EarliestExpiry | null {
  let best: EarliestExpiry | null = null;
  for (const r of rows) {
    const daysLeft = r.daysLeft;
    if (daysLeft === null || daysLeft === undefined) continue;
    const level = expiryLevel(daysLeft);
    if (level === null) continue;
    if (best === null || daysLeft < best.daysLeft) best = { keyId: r.id ?? "", expires: r.expires, daysLeft, level };
  }
  return best;
}

function customCard(id: string, label: string, keys: KeyRow[], byHand: ProviderRow[]): ProviderCard {
  return {
    id,
    label,
    category: "other",
    icon: null,
    custom: true,
    status: statusOf(keys, null, false, null),
    signIn: { state: "none", facade: null, recipes: [], available: false },
    keys,
    byHand,
    browser: null,
    worksWithoutBrowser: false,
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

export interface EarliestExpiry {
  keyId: string;
  expires: string | null | undefined;
  daysLeft: number;
  level: ExpiryLevel;
}

/**
 * The connected key of the card that runs out first, for the collapsed card. `null` when no connected key has a known end date
 * (never expires or not specified: the card then says nothing about expiry).
 */
export function earliestExpiry(card: Pick<ProviderCard, "keys">): EarliestExpiry | null {
  let best: EarliestExpiry | null = null;
  for (const k of card.keys) {
    if (!k.connected || k.daysLeft === null || k.level === null) continue;
    if (best === null || k.daysLeft < best.daysLeft) best = { keyId: k.id, expires: k.expires, daysLeft: k.daysLeft, level: k.level };
  }
  return best;
}

/**
 * What the collapsed card says about expiry: the connected key that runs out first, else the earliest browser-managed entry.
 * `null` when neither has a known end date.
 */
export const managedExpiry = (card: Pick<ProviderCard, "keys" | "browser">): EarliestExpiry | null => earliestExpiry(card) ?? (connectedKeyCount(card) === 0 ? (card.browser?.expiry ?? null) : null);

/** How many connected keys the card has (what the collapsed card counts). */
export const connectedKeyCount = (card: Pick<ProviderCard, "keys">): number => card.keys.filter((k) => k.connected).length;

export interface BrowserNote {
  /** Message key of the line under the card summary. */
  key: string;
  /** How long ago the sign-in was last seen; the caller turns it into words. Null when there is no answer. */
  age: AgeParts | null;
}

/**
 * The one line a collapsed card says about the browser. A card with an API connection says that it works without any browser
 * sign-in; a card whose keys come from the browser says how fresh the last sign-in answer is. Null when the browser plays no part.
 */
export function browserNote(card: Pick<ProviderCard, "status" | "browser" | "worksWithoutBrowser">): BrowserNote | null {
  if (card.worksWithoutBrowser) return { key: "providers.card.worksWithoutBrowser", age: null };
  if (card.status === "connected" || !card.browser) return null;
  const r = card.browser.readiness;
  const age = r.ageMinutes === null ? null : ageParts(r.ageMinutes);
  if (r.state === "ready") return { key: "providers.card.browserReadyChecked", age };
  if (r.state === "signed-out") return { key: "providers.card.browserSignedOutChecked", age };
  return { key: r.checkedAt === null ? "providers.card.browserUnknownNever" : "providers.card.browserUnknownChecked", age };
}

export interface HostLineNote {
  key: string;
  age: AgeParts | null;
}

/**
 * What a card says about one portal: signed in (with the age of the answer), sign-in needed, or not known (no answer, or an old
 * one). The text names the provider and the portal ("Peecho live: signed in, checked 2 hours ago").
 */
export function hostLineNote(line: Pick<HostLine, "readiness">): HostLineNote {
  const r = line.readiness;
  const age = r.ageMinutes === null ? null : ageParts(r.ageMinutes);
  if (r.state === "ready") return { key: "providers.card.hostReady", age };
  if (r.state === "signed-out") return { key: "providers.card.hostSignedOut", age: null };
  return { key: r.checkedAt === null ? "providers.card.hostUnknownNever" : "providers.card.hostUnknownChecked", age };
}

/** A place on a card where the human can start the sign-in: one portal (several portals), or the provider as a whole. */
export interface SignInPrompt {
  /** The value of the recipe's host parameter, or null for a recipe with one portal. */
  portal: string | null;
}

/** The recipe a browser-only card signs in at (a facade card has its own dialog). */
export function signInRecipeOf(card: Pick<ProviderCard, "signIn">): RecipeRow | null {
  if (card.signIn.facade) return null;
  return card.signIn.recipes.find((r) => r.canCheckSignIn === true) ?? null;
}

/**
 * The "Sign in" buttons of a collapsed card: one for every line that says the sign-in is needed or unknown (per portal for a
 * recipe with several), none when the sign-in is current, when an API connection makes the browser unnecessary, or when the
 * sign-in cannot run (automation off, recipe without a guided sign-in, facade card).
 */
export function signInPrompts(card: Pick<ProviderCard, "status" | "signIn" | "browser">): SignInPrompt[] {
  const recipe = signInRecipeOf(card);
  if (!recipe || !card.signIn.available || card.status === "connected" || !card.browser) return [];
  const lines = card.browser.hostLines;
  if (lines.length > 0) return lines.filter((l) => l.readiness.state !== "ready").map((l) => ({ portal: l.value }));
  return card.browser.readiness.state === "ready" ? [] : [{ portal: null }];
}
