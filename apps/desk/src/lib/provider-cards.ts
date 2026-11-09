import { expiryLevel, type ExpiryLevel } from "./connection-health";
import { daysLabel, formatDate } from "./format";
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
  /** The vendor has a guided sign-in (a facade): its card always offers "Connect", whatever the facade list says. */
  facade?: boolean;
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
  /** Provider definition that creates the value (`stripe-webhook-secret`), for the card's "creates for your entries" line. */
  provider?: string;
  /** The entry's value is created by a browser recipe. */
  browser?: boolean;
  daysLeft?: number | null;
  /** Day the entry expires (YYYY-MM-DD), null: never. */
  expires?: string | null;
  /** `none`: the value does not expire (a read-only key); such entries are left out of the expiry calculation. */
  expiry?: string;
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
  /** The earliest expiry among those entries, like connected keys have. Entries that never expire are left out. */
  expiry: EarliestExpiry | null;
  /** Every one of those entries is marked as never expiring (`expiry: none`), so the card can say so. */
  neverExpires: boolean;
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
  /** Connection id prefixes of keys per account (`stripe:`): the card lists one line per connection of such a kind. */
  prefixes: string[];
  /** Browser view of the card; null when the provider has no loaded recipe. */
  browser: BrowserWay | null;
  /** An API connection exists, so keys are issued without any browser sign-in. Only for providers with a guided sign-in. */
  worksWithoutBrowser: boolean;
  /** The remote browser is known to be signed in at the provider (a fresh check, or a check in this page session said yes). */
  browserSignedIn: boolean;
  /** What secret-desk creates for the inventory entries of this provider: one row per provider definition, most entries first. */
  produces: ProducedRow[];
  secrets: number;
  variables: number;
}

export interface ProducedRow {
  provider: string;
  label: string;
  count: number;
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

/** Counts the entries per provider definition that secret-desk issues, labelled with the definition's name. */
export function producedRows(secrets: readonly SecretRow[], providers: readonly ProviderRow[]): ProducedRow[] {
  const counts = new Map<string, number>();
  for (const s of secrets) if (s.provider) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  // Only definitions secret-desk issues itself: a by-hand definition (a value only a human can create) or an unknown one is left out.
  return [...counts].flatMap(([provider, count]) => {
    const def = providers.find((p) => p.id === provider);
    return def && def.kind !== "manual" ? [{ provider, label: def.label, count }] : [];
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
    const recipes = input.recipes.filter((r) => v.recipes.includes(r.id));
    // A vendor with a guided sign-in always offers it. When the facade list did not say anything about it (not loaded yet, the
    // request failed), the card still shows "Connect": the dialog reads the real state itself and reports a problem there.
    const facade = input.facades.find((f) => f.id === v.id) ?? (v.facade === true ? { id: v.id, label: v.label, available: recipes.length > 0 && (input.automationEnabled ?? true), connected: keys.some((k) => k.connected), reason: null, connectionId: v.connections[0] ?? v.id } : null);
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
      ? { readiness: browserReadiness(newestCheck(input.signInChecks ?? [], hosts), now, freshHours), secrets: managed.length, expiry: earliestAmong(managed), neverExpires: managed.length > 0 && managed.every((m) => m.expiry === "none"), sessionHours: sessionHoursOf(input.signInLifetimes ?? [], hosts), hostLines }
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
      prefixes: [...v.connectionPrefixes],
      browser,
      worksWithoutBrowser: state === "facade" && (keys.some((k) => k.connected) || facade?.connected === true),
      browserSignedIn: browser?.readiness.state === "ready" || (input.signedIn?.has(v.id) ?? false),
      produces: producedRows((input.secrets ?? []).filter((s) => s.vendor === v.id), input.providers),
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
    if (r.expiry === "none") continue;
    const daysLeft = r.daysLeft;
    if (daysLeft === null || daysLeft === undefined) continue;
    const level = expiryLevel(daysLeft)!; // never null: daysLeft is a number here
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
    prefixes: [],
    browser: null,
    worksWithoutBrowser: false,
    browserSignedIn: false,
    produces: [],
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

export type KeyAction = "paste" | "signin" | "none";
export type DetailKey = KeyRow & { action: KeyAction };

/**
 * The rows of the keys section in the integration dialog. A vendor without a guided sign-in lists every key it can have, each with
 * "Set up". A vendor with one lists only the connected keys, which the sign-in manages (no button). A vendor with a guided sign-in
 * and more than one current connection (Grafana: the stack token is pasted, the Cloud token comes from the sign-in) lists all of
 * them: the sign-in's own connection offers "Connect with sign-in", the others stay pasted.
 */
export function detailKeys(card: Pick<ProviderCard, "keys" | "signIn" | "prefixes">): DetailKey[] {
  const facade = card.signIn.facade;
  const current = card.keys.filter((k) => k.role !== "legacy");
  const several = facade !== null && current.length > 1;
  const managed = (k: KeyRow): boolean => facade !== null && (k.role === "legacy" || k.id === facade.connectionId || card.prefixes.some((p) => k.id.startsWith(p)));
  return card.keys
    .filter((k) => k.connected || (k.role !== "legacy" && (facade === null || several)))
    .map((k) => ({ ...k, action: facade === null ? "paste" : managed(k) ? (k.connected ? "none" : "signin") : "paste" }));
}

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

/** One connection of a per-account kind (`stripe:<account>:<mode>`), as one compact line on the card. */
export interface AccountLine {
  /** The connection id. */
  id: string;
  /** What names the account: the connection label without vendor name and mode, else the account id from the connection id. */
  account: string;
  /** The account part of the connection id (`acct_1AbC`), for prefilling the sign-in dialog. */
  accountId: string;
  /** The mode of the connection (`sandbox`, `live`), or null when the id carries none. */
  mode: string | null;
  daysLeft: number | null;
  /** Day the key expires (YYYY-MM-DD), null: never, undefined: not known. */
  expires: string | null | undefined;
  level: ExpiryLevel | null;
}

/** The connections of an older layout (`stripe`, `stripe-test`) that are still connected: one line, with a hint to replace them. */
export interface LegacyLine {
  ids: string[];
  labels: string[];
}

export interface ConnectionLines {
  /** One line per connected connection under a connection prefix, ordered by account and then sandbox before live. */
  accounts: AccountLine[];
  /** One line for all connected older connections, or null. */
  legacy: LegacyLine | null;
  /** Other connected keys (optional ones, or a vendor without prefixes): shown as before. */
  others: KeyRow[];
}

const MODE_ORDER: Record<string, number> = { sandbox: 0, test: 0, live: 1 };

/** The account a connection stands for. The label is `Vendor Name (Mode)`; what is left of it, or the id part, is the account. */
function accountOf(key: KeyRow, rest: string, vendorLabel: string): string {
  let name = key.label.trim();
  if (name.toLowerCase().startsWith(`${vendorLabel.toLowerCase()} `)) name = name.slice(vendorLabel.length + 1);
  name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (name && name !== key.id) return name;
  const at = rest.lastIndexOf(":");
  return at > 0 ? rest.slice(0, at) : rest;
}

/**
 * The card's connected keys as lines: one per connection of a per-account kind, one for the older connections, the rest as they
 * are. A vendor without connection prefixes has no account lines (`accounts` empty, the keys are `others`).
 */
export function connectionLines(card: Pick<ProviderCard, "keys" | "prefixes" | "label">): ConnectionLines {
  const connected = card.keys.filter((k) => k.connected);
  if (card.prefixes.length === 0) return { accounts: [], legacy: null, others: connected };
  const accounts: AccountLine[] = [];
  const legacy: KeyRow[] = [];
  const others: KeyRow[] = [];
  for (const k of connected) {
    const prefix = card.prefixes.find((p) => k.id.startsWith(p));
    if (prefix) {
      const rest = k.id.slice(prefix.length);
      const at = rest.lastIndexOf(":");
      accounts.push({ id: k.id, account: accountOf(k, rest, card.label), accountId: at > 0 ? rest.slice(0, at) : rest, mode: at > 0 ? rest.slice(at + 1) : null, daysLeft: k.daysLeft, expires: k.expires, level: k.level });
    } else if (k.role === "legacy") legacy.push(k);
    else others.push(k);
  }
  accounts.sort((a, b) => a.account.localeCompare(b.account) || (MODE_ORDER[a.mode ?? ""] ?? 2) - (MODE_ORDER[b.mode ?? ""] ?? 2));
  return { accounts, legacy: legacy.length > 0 ? { ids: legacy.map((k) => k.id), labels: legacy.map((k) => k.label) } : null, others };
}

/** What a portal line says while a check of it is queued or running; null when no check is pending (the sign-in note applies). */
export function hostLinePhaseKey(phase: "waiting" | "checking" | undefined): string | null {
  return phase === "waiting" ? "providers.card.hostWaiting" : phase === "checking" ? "providers.card.hostChecking" : null;
}

/** "live" -> "Live": the portal name starts a sentence. */
export const capitalized = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const EXPIRY_TEXT: Record<ExpiryLevel, string> = {
  ok: "providers.card.expiresIn",
  soon: "providers.card.expiryWarn",
  critical: "providers.card.expiryCritical",
  expired: "providers.card.expiryExpired",
};

/** The expiry sentence of a collapsed card: the key that runs out first, or why there is nothing to say. */
export function expiryLine(card: Pick<ProviderCard, "keys" | "browser">, t: Translate, now: Date = new Date()): { text: string; level: ExpiryLevel | null } | null {
  const managed = card.browser?.secrets ?? 0;
  if (connectedKeyCount(card) === 0 && managed === 0) return null;
  const e = managedExpiry(card);
  if (e) {
    const date = e.expires ?? new Date(now.getTime() + e.daysLeft * 86_400_000).toISOString().slice(0, 10);
    return { text: t(EXPIRY_TEXT[e.level], { date: formatDate(date), days: daysLabel(e.daysLeft) }), level: e.level };
  }
  // Values the browser reads and that never expire (read-only keys): say so instead of "not specified".
  if (connectedKeyCount(card) === 0 && card.browser?.neverExpires) return { text: t("providers.card.browserNeverExpires"), level: null };
  const connected = card.keys.filter((k) => k.connected);
  return { text: t(connected.length > 0 && connected.every((k) => k.expires === null) ? "providers.card.neverExpires" : "providers.card.expiryUnknown"), level: null };
}


/** The expiry sentence of one connection line: the date the key runs out, "never expires", or that nothing is known. */
export function lineExpiry(line: Pick<AccountLine, "expires" | "daysLeft">, t: Translate): string {
  if (line.expires === undefined) return t("connections.expiryUnknown");
  if (line.expires === null) return t("connections.neverExpires");
  return t("connections.validUntil", { date: formatDate(line.expires), days: daysLabel(line.daysLeft) });
}

/**
 * What a connection is, in plain words: a short name (what kind of key: API key, admin key, access policy token, restricted
 * key) and one line on what secret-desk does with it and what depends on it. Keyed by connection id; ids under a connection
 * prefix (`stripe:<account>:<mode>`) by the prefix. Every vendor in the catalog has its connections here.
 */
export const CONNECTION_INFO: Readonly<Record<string, { name: string; purpose: string; required?: true }>> = {
  github: { name: "connectionName.github", purpose: "connectionPurpose.github", required: true },
  "team-sync": { name: "connectionName.teamSync", purpose: "connectionPurpose.teamSync" },
  "github-app-key": { name: "connectionName.githubAppKey", purpose: "connectionPurpose.githubAppKey" },
  cloudflare: { name: "connectionName.cloudflare", purpose: "connectionPurpose.cloudflare", required: true },
  "cloudflare-turnstile": { name: "connectionName.cloudflareTurnstile", purpose: "connectionPurpose.cloudflareTurnstile" },
  supabase: { name: "connectionName.supabase", purpose: "connectionPurpose.supabase", required: true },
  "stripe:": { name: "connectionName.stripeAccount", purpose: "connectionPurpose.stripeAccount" },
  stripe: { name: "connectionName.stripeLegacy", purpose: "connectionPurpose.stripeLegacy" },
  "stripe-test": { name: "connectionName.stripeLegacy", purpose: "connectionPurpose.stripeLegacy" },
  "stripe-live": { name: "connectionName.stripeLegacy", purpose: "connectionPurpose.stripeLegacy" },
  revenuecat: { name: "connectionName.revenuecat", purpose: "connectionPurpose.revenuecat", required: true },
  resend: { name: "connectionName.resend", purpose: "connectionPurpose.resend", required: true },
  grafana: { name: "connectionName.grafana", purpose: "connectionPurpose.grafana", required: true },
  "grafana-cloud": { name: "connectionName.grafanaCloud", purpose: "connectionPurpose.grafanaCloud" },
  openai: { name: "connectionName.openai", purpose: "connectionPurpose.openai", required: true },
  anthropic: { name: "connectionName.anthropic", purpose: "connectionPurpose.anthropic" },
};

/** The plain-words entry of a connection (also for per-account ids under a prefix), or null for an unknown connection. */
export function connectionInfo(id: string): { name: string; purpose: string; required?: true } | null {
  const direct = CONNECTION_INFO[id];
  if (direct) return direct;
  const prefix = Object.keys(CONNECTION_INFO).find((k) => k.endsWith(":") && id.startsWith(k));
  return prefix ? CONNECTION_INFO[prefix]! : null;
}

/** Catalog key of a connection's purpose line, or null when the connection is not known. */
export const connectionPurposeKey = (id: string): string | null => connectionInfo(id)?.purpose ?? null;

/** The card holds more than one current connection (legacy ones do not count), so a dialog must name the one it is about. */
export const hasSeveralConnections = (card: Pick<ProviderCard, "keys">): boolean => card.keys.filter((k) => k.role !== "legacy").length > 1;

/**
 * What the integration dialog shows in its header. `title` is shown as is unless `titleKey` is set, then `t(titleKey, { name:
 * title, key: t(nameKey) })`. `purposeKey` null: the vendor's own purpose line.
 */
export interface DialogHeading {
  title: string;
  titleKey: string | null;
  nameKey: string | null;
  purposeKey: string | null;
}

/** The part of the integration dialog that is open: a pasted key, the guided sign-in, or the vendor overview (null). */
export type DialogSubject = null | { kind: "key"; id: string } | { kind: "signin" } | { kind: "hand"; id: string };

/**
 * Header of the integration dialog: it names what is being set up, not the vendor's general purpose. A view about one connection
 * (pasting its key, or the guided sign-in that creates it) reads "<vendor> – <kind of key>" with that key's purpose, e.g. "Grafana
 * Cloud – Konto-Token" or "Stripe – eingeschränkter Schlüssel je Konto und Modus". A browser-only sign-in (recipes) reads
 * "<vendor> – Browser-Anmeldung". The overview, a by-hand provider and an unknown connection keep the vendor header.
 */
export function dialogHeading(card: Pick<ProviderCard, "label" | "keys" | "signIn" | "prefixes">, sub: DialogSubject): DialogHeading {
  const vendor: DialogHeading = { title: card.label, titleKey: null, nameKey: null, purposeKey: null };
  if (!sub || sub.kind === "hand") return vendor;
  const facade = card.signIn.facade;
  if (sub.kind === "signin" && !facade) return card.signIn.state === "recipe" ? { title: card.label, titleKey: "providers.dialog.titleBrowser", nameKey: null, purposeKey: "providers.dialog.purposeBrowser" } : vendor;
  const id = sub.kind === "key" ? sub.id : facade!.connectionId;
  // A sign-in that picks its connection itself (Stripe: account and mode) is about the kind under the prefix.
  const info = sub.kind === "signin" && card.prefixes.length > 0 ? connectionInfo(card.prefixes[0]!) : connectionInfo(id);
  if (!info) {
    const row = card.keys.find((k) => k.id === id);
    return row && hasSeveralConnections(card) ? { ...vendor, title: row.label } : vendor;
  }
  return { title: card.label, titleKey: "providers.dialog.titleKey", nameKey: info.name, purposeKey: info.purpose };
}

/** A key the card still lacks: an account without one of its modes, or a primary connection that is not set up. */
export type MissingKey = { kind: "mode"; account: string; accountId: string; mode: "sandbox" | "live" } | { kind: "connection"; id: string; label: string };

/**
 * What the card still lacks, for the "Missing: …" line. For a vendor with keys per account and mode (Stripe) every connected
 * account should have both modes. For other vendors a connection marked `required` in CONNECTION_INFO that is not connected is
 * missing once the card is in use (some key connected or browser signed in) or has a guided sign-in. Optional keys (the team
 * repository token, the GitHub App key, the Anthropic admin key, the Grafana account token) are never reported as missing.
 */
export function missingKeys(card: Pick<ProviderCard, "keys" | "prefixes" | "label" | "signIn" | "status">): MissingKey[] {
  if (card.prefixes.length > 0) {
    const out: MissingKey[] = [];
    for (const a of stripeAccounts(card)) {
      for (const mode of ["sandbox", "live"] as const) if (!a.modes[mode]) out.push({ kind: "mode", account: a.account, accountId: a.accountId, mode });
    }
    return out;
  }
  const inUse = card.status !== "none" || card.signIn.state === "facade";
  if (!inUse) return [];
  return card.keys
    .filter((k) => !k.connected && k.role !== "legacy" && connectionInfo(k.id)?.required === true)
    .map((k) => ({ kind: "connection" as const, id: k.id, label: k.label }));
}

/** One account of a per-account vendor with its key per mode (null: that mode has no key yet). */
export interface AccountBlock {
  account: string;
  accountId: string;
  modes: { sandbox: AccountLine | null; live: AccountLine | null };
  /** Lines with a mode other than sandbox/live (kept, shown after the two). */
  other: AccountLine[];
}

/** The per-account lines grouped by account: one block each, sandbox and live side by side, in the order of the lines. */
export function stripeAccounts(card: Pick<ProviderCard, "keys" | "prefixes" | "label">): AccountBlock[] {
  const blocks: AccountBlock[] = [];
  for (const l of connectionLines(card).accounts) {
    let b = blocks.find((x) => x.accountId === l.accountId);
    if (!b) {
      b = { account: l.account, accountId: l.accountId, modes: { sandbox: null, live: null }, other: [] };
      blocks.push(b);
    }
    const mode = l.mode === "test" ? "sandbox" : l.mode;
    if (mode === "sandbox" || mode === "live") b.modes[mode] = l;
    else b.other.push(l);
  }
  return blocks;
}

/**
 * What a card can do now. `api`: a key is connected, secret-desk calls the provider's API. `browser`: the remote browser is
 * signed in, recipes can create values that have no API.
 */
export interface Capability {
  api: boolean;
  browser: boolean;
}
export const capabilityOf = (card: Pick<ProviderCard, "keys" | "signIn" | "browserSignedIn" | "status">): Capability => ({
  api: card.keys.some((k) => k.connected) || card.signIn.facade?.connected === true,
  browser: card.browserSignedIn || card.status === "ready" || card.status === "signin",
});

/** Catalog key of the status chip: it says what is ready for what. */
export function capabilityLabelKey(card: Pick<ProviderCard, "keys" | "signIn" | "browserSignedIn" | "status">): string {
  const c = capabilityOf(card);
  if (c.api && c.browser) return "providers.status.apiBrowser";
  if (c.api) return "providers.status.api";
  if (c.browser) return "providers.status.browser";
  if (card.status === "signout") return "providers.status.signout";
  if (card.status === "unknown") return "providers.status.unknown";
  return "providers.status.none";
}
