import { ANTHROPIC_API_PREFIXES, isAnthropicApiKey } from "@secret-desk/providers/portable";
import { stripeConnectionId, stripeKeyCarriesAccount, stripeKeyMode, type SecretValue, type StripeAccountMode } from "@secret-desk/core/portable";
import type { RuntimeCore } from "./runtime-core.js";

/**
 * The descriptors of the provider facades (one guided flow per provider that signs in through the remote browser) and the lookups
 * over them. Nothing here touches the browser automation: the flow itself lives in `facade.ts`, which re-exports everything below
 * under the same names. The descriptors are plain data plus a few checks of a new key, so the inventory views can use them in a
 * runtime without the automation.
 */

/**
 * One way to connect a provider whose accounts differ (Anthropic: a Team organization with an Admin key, or a Personal account with
 * a normal API key). The sign-in (the descriptor's recipe) is shared; the variant picks the recipe that creates the key and what
 * goes with it. The human chooses a variant for each run and nothing is preselected on the server: a request without a valid
 * variant is refused.
 */
export interface FacadeVariant {
  /** Stable id sent by the portal (`variant` in the request body). */
  id: string;
  /** Catalog key of the variant's name in the connect dialog. */
  label: string;
  /** Recipe that creates the key of this variant (replaces the descriptor's `recipeId` for the key step only). */
  recipeId: string;
  /** Fixed recipe parameters of the integration key. */
  keyParams: Record<string, string>;
  /** Expiry of the key in days; the value is also the recipe variable `days`. */
  keyExpiryDays?: number;
  /** The key is optional (see the descriptor's `keyOptional`). */
  keyOptional?: boolean;
  /** Catalog key of the sentence that says what this variant can do (shown under its name). */
  promise?: string;
  /** Checks the new key before it is stored (see the descriptor's `verifyKey`). */
  verifyKey?(rt: RuntimeCore, key: SecretValue, inputs: Record<string, string>): Promise<string | null>;
}

/** What a provider needs to join the facade. The recipe carries the sign-in (login.form) and the key creation. */
export interface FacadeDescriptor {
  /** Provider id shown in the portal. */
  id: string;
  label: string;
  /** Recipe with `login.form` and the steps that create the integration key. */
  recipeId: string;
  /** Connection that receives the key (see connection-guides.ts). For a provider with `inputs` this is the general connection that opens the flow. */
  connectionId: string;
  /**
   * The provider has an API that issues the keys of inventory entries once the integration key is stored, so entries work without
   * the browser sign-in. false: entries are created by a browser recipe (Anthropic: the Admin API cannot create keys; RevenueCat: no key API).
   */
  issuesKeysByApi: boolean;
  /** Name of the key at the provider. `inputs` are the values the human chose for this run. */
  keyName(now: Date, inputs: Record<string, string>): string;
  /**
   * Recipe parameters the human chooses for each run (for example the Stripe account and mode). Each is validated against the
   * recipe's parameter specification and passed to the recipe.
   */
  inputs: string[];
  /** The connection that receives the key of this run, when it depends on `inputs` (one per Stripe account and mode). */
  connectionFor?(inputs: Record<string, string>): string;
  /** Connections starting with this prefix also count as connected (the per-account connections of Stripe). */
  connectionPrefix?: string;
  /**
   * Checks the new key before it is stored (for example that it belongs to the chosen account). Resolves to a problem text, or
   * null when the key is fine.
   */
  verifyKey?(rt: RuntimeCore, key: SecretValue, inputs: Record<string, string>): Promise<string | null>;
  /** Fixed recipe parameters of the integration key (for example the read-only permission). */
  keyParams: Record<string, string>;
  /** The recipe parameter that names the provider project, and how to read it from a dashboard address. */
  project: { param: string; fromUrl: RegExp } | null;
  /** Catalog key of the sentence that says what kind of key this is (shown in the connect dialog). Without it nothing is shown. */
  promise?: string;
  /** Discovery kinds whose option counts are reported after the connection test ("1 project, 3 apps"). */
  summary: { key: string; kind: string }[];
  /**
   * The integration key is optional: when the recipe ends as "unsupported" (the account has no such feature), the run finishes
   * as done ("ready, keys come from the browser") instead of failing.
   */
  keyOptional?: boolean;
  /**
   * The integration key expires after this many days (the recipe asks the provider for that expiry). The portal stores the
   * expiry day with the connection, so the connection health shows it before the key stops working.
   */
  keyExpiryDays?: number;
  /**
   * Ways to connect, when the key differs by account type. The descriptor's `recipeId` then only signs in (and checks the session);
   * the chosen variant's `recipeId`, `keyParams`, `keyExpiryDays`, `keyOptional` and `promise` replace the descriptor's for the run,
   * so a descriptor with variants sets none of those fields itself (except `recipeId` and `keyParams`, which the sign-in needs).
   */
  variants?: FacadeVariant[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The account a Stripe key belongs to (`GET /v1/account`). Null when the key is refused or the answer has no id. */
async function stripeKeyAccount(rt: RuntimeCore, key: SecretValue): Promise<string | null> {
  try {
    const res = await rt.fetch("https://api.stripe.com/v1/account", { method: "GET", headers: { Authorization: `Bearer ${key.reveal()}`, Accept: "application/json", "User-Agent": "secret-desk" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * A new Anthropic API key (Personal) must be a normal API key and must work: `GET /v1/models?limit=1`. Resolves to a problem text
 * (never the key), or null when the key is fine.
 */
async function anthropicApiKeyProblem(rt: RuntimeCore, key: SecretValue): Promise<string | null> {
  const value = key.reveal();
  if (!isAnthropicApiKey(value)) return `The new key does not start with ${ANTHROPIC_API_PREFIXES.join(" or ")}, so it is not a normal API key and was not stored.`;
  let status: number;
  try {
    const res = await rt.fetch("https://api.anthropic.com/v1/models?limit=1", { method: "GET", headers: { "x-api-key": value, "anthropic-version": "2023-06-01", Accept: "application/json", "User-Agent": "secret-desk" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    status = res.status;
  } catch {
    return "The new key could not be checked at Anthropic, so it was not stored.";
  }
  return status === 200 ? null : `Anthropic did not accept the new key (HTTP ${status}), so it was not stored.`;
}

export const FACADES: readonly FacadeDescriptor[] = [
  {
    id: "revenuecat",
    label: "RevenueCat",
    recipeId: "revenuecat-secret-api-key",
    connectionId: "revenuecat",
    issuesKeysByApi: false,
    // Date and time (UTC): a second key on the same day must not share a name, the key list is found by that name.
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    // v2 secret key, Project configuration: Read only, every other section stays "No access" (the recipe default).
    keyParams: { projectConfiguration: "Read only" },
    promise: "facade.promise.revenuecat",
    project: { param: "projectId", fromUrl: /^https:\/\/app\.revenuecat\.com\/projects\/([a-z0-9]+)(?:\/|$)/ },
    inputs: [],
    summary: [
      { key: "projects", kind: "revenuecat.project" },
      { key: "apps", kind: "revenuecat.app" },
    ],
  },
  {
    // The Admin API key is created once through the signed-in browser; project keys are issued with it from then on.
    id: "openai",
    label: "OpenAI",
    recipeId: "openai-admin-key",
    connectionId: "openai",
    issuesKeysByApi: true,
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: {},
    promise: "facade.promise.openai",
    project: null,
    inputs: [],
    summary: [{ key: "projects", kind: "openai.project" }],
  },
  {
    // Two ways to connect, one Console sign-in (the recipe `anthropic-admin-key` carries it). Team: the organization Admin key
    // lets the portal list workspaces and check and deactivate keys. Personal: a normal API key, created by the browser recipe
    // `anthropic-api-key` (the Admin API cannot create keys), which the portal can only check. Both are the `anthropic` connection.
    id: "anthropic",
    label: "Anthropic",
    recipeId: "anthropic-admin-key",
    connectionId: "anthropic",
    issuesKeysByApi: false,
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: {},
    project: null,
    inputs: [],
    summary: [{ key: "workspaces", kind: "anthropic.workspace" }],
    variants: [
      { id: "team", label: "facade.variant.anthropic.team", recipeId: "anthropic-admin-key", keyParams: {}, keyOptional: true, promise: "facade.promise.anthropic.team" },
      // 30 days is the default of the Console dialog (it has no 90 days); `days` carries it to the recipe and the expiry day to the connection.
      { id: "personal", label: "facade.variant.anthropic.personal", recipeId: "anthropic-api-key", keyParams: {}, keyExpiryDays: 30, promise: "facade.promise.anthropic.personal", verifyKey: (rt, key) => anthropicApiKeyProblem(rt, key) },
    ],
  },
  {
    // The Cloud access policy token is created once through the signed-in browser (grafana.com, portal sign-in only); after that
    // the portal creates stack service accounts and tokens through the Cloud API. The facade belongs to the vendor `grafana`,
    // whose card also holds the stack connection (`grafana`), which stays a pasted token.
    id: "grafana",
    label: "Grafana Cloud",
    recipeId: "grafana-cloud-access-policy",
    connectionId: "grafana-cloud",
    issuesKeysByApi: true,
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: { expiry: "90 days" },
    keyExpiryDays: 90,
    promise: "facade.promise.grafana",
    project: null,
    inputs: [],
    summary: [],
  },
  {
    // One Stripe organization holds several accounts, each with a sandbox and a live mode. The human names the account and the
    // mode; the key is created in that account and stored as the connection of exactly that (account, mode).
    id: "stripe",
    label: "Stripe",
    recipeId: "stripe-restricted-key",
    connectionId: "stripe",
    issuesKeysByApi: true,
    keyName: (now, inputs) => `secret-desk-${inputs["mode"] === "live" ? "live" : "test"}-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    // Only webhook endpoints: that is all the portal needs from Stripe.
    keyParams: { preset: "webhooks" },
    promise: "facade.promise.stripe",
    inputs: ["account", "mode"],
    connectionFor: (inputs) => stripeConnectionId(inputs["account"] ?? "", inputs["mode"] === "live" ? "live" : "sandbox"),
    connectionPrefix: "stripe:",
    async verifyKey(rt, key, inputs) {
      const mode: StripeAccountMode | undefined = stripeKeyMode(key.reveal());
      const want: StripeAccountMode = inputs["mode"] === "live" ? "live" : "sandbox";
      if (mode && mode !== want) return `The key is a ${mode === "live" ? "live" : "sandbox"} key, but the ${want} mode was chosen.`;
      const have = await stripeKeyAccount(rt, key);
      if (have === null) {
        // Restricted keys usually may not read /v1/account; the key itself names its account.
        if (stripeKeyCarriesAccount(key.reveal(), inputs["account"] ?? "")) return null;
        return "The account of the new key could not be read, so it was not stored.";
      }
      if (have !== inputs["account"]) return `The new key belongs to the account ${have}, not to ${inputs["account"]}, so it was not stored.`;
      return null;
    },
    project: null,
    summary: [],
  },
];

export const facadeById = (id: string): FacadeDescriptor | undefined => FACADES.find((f) => f.id === id);

/** Integration a browser recipe belongs to (its facade's connection), so its secrets count for that integration. */
export const facadeConnectionForRecipe = (recipeId: string | undefined): string | null =>
  (recipeId ? FACADES.find((f) => f.recipeId === recipeId)?.connectionId : undefined) ?? null;
