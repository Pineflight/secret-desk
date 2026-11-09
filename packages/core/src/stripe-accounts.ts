import type { ConnectionStore } from "./connections.js";
import type { StageKind } from "./stages.js";

/**
 * Stripe connections per account and mode.
 *
 * A Stripe organization holds several accounts (one per product), each with a sandbox and a live mode. A connection is
 * therefore identified by `(account, mode)`. The id is `stripe:<acct_id>:<mode>`, for example `stripe:acct_1AbC:sandbox`.
 * The fixed ids `stripe`, `stripe-test` and `stripe-live` keep working; they carry no account and are checked by the key
 * prefix only.
 */

export type StripeAccountMode = "sandbox" | "live";

export const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/;
const CONNECTION_ID = /^stripe:(acct_[A-Za-z0-9]+):(sandbox|live)$/;

export const stripeConnectionId = (account: string, mode: StripeAccountMode): string => `stripe:${account}:${mode}`;

export function parseStripeConnectionId(id: string): { account: string; mode: StripeAccountMode } | null {
  const m = CONNECTION_ID.exec(id);
  return m ? { account: m[1] as string, mode: m[2] as StripeAccountMode } : null;
}

/** Mode a stage kind uses: live -> live, test and dev -> sandbox. `shared` fits both, so it names no mode. */
export function stripeModeForStage(kind: StageKind): StripeAccountMode | null {
  if (kind === "live") return "live";
  if (kind === "shared") return null;
  return "sandbox";
}

/** Mode of a Stripe key by its prefix (`rk_test_`, `sk_live_` ...), or undefined. */
export function stripeKeyMode(key: string): StripeAccountMode | undefined {
  const m = /^[rs]k_(test|live)_/.exec(key.trim())?.[1];
  return m === "live" ? "live" : m === "test" ? "sandbox" : undefined;
}

/** Entry that holds the display label (the account name) of a connection. It is a name, not a secret. */
const labelEntry = (id: string): string => `${id}#label`;

export async function readConnectionLabel(store: ConnectionStore, id: string): Promise<string | undefined> {
  try {
    const v = store.session.get(labelEntry(id)) ?? (await store.vault?.get(labelEntry(id))) ?? undefined;
    const text = v?.reveal().trim();
    return text ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function writeConnectionLabel(store: ConnectionStore, id: string, label: string): Promise<void> {
  const text = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
  if (!text) return;
  if (store.vault) await store.vault.set(labelEntry(id), text, null);
  else store.session.set(labelEntry(id), text, null);
}

export async function deleteConnectionLabel(store: ConnectionStore, id: string): Promise<void> {
  store.session.delete(labelEntry(id));
  await store.vault?.delete(labelEntry(id)).catch(() => undefined);
}

export interface StripeAccountInfo {
  id: string;
  /** Account name, if it was read when the connection was made. */
  name: string | null;
  modes: StripeAccountMode[];
}

/** Connected Stripe accounts (any mode that holds a key), by account id. Offline: reads only the store. */
export async function listStripeAccounts(store: ConnectionStore): Promise<StripeAccountInfo[]> {
  const found = new Map<string, StripeAccountInfo>();
  for (const id of await store.ids("stripe:")) {
    const p = parseStripeConnectionId(id);
    if (!p || !(await store.status(id)).connected) continue;
    const cur = found.get(p.account) ?? { id: p.account, name: null, modes: [] };
    cur.name ??= (await readConnectionLabel(store, id)) ?? null;
    if (!cur.modes.includes(p.mode)) cur.modes.push(p.mode);
    found.set(p.account, cur);
  }
  // Sandbox first, then live (reverse alphabetical): a stable order for display.
  for (const a of found.values()) a.modes.sort((x, y) => y.localeCompare(x));
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a Stripe key's body carries the account id. A restricted key without account read access gets 403 from
 * /v1/account, so the check falls back to the key itself: Stripe API keys start with `<prefix>_<mode>_51` followed by the
 * account id without its `acct_1` (checked live on 2026-11-04 for a restricted sandbox key). Not an official guarantee,
 * so it is used only when the API cannot answer.
 */
export function stripeKeyCarriesAccount(key: string, account: string): boolean {
  const m = /^(?:rk|sk)_(?:test|live)_51([A-Za-z0-9]+)$/.exec(key);
  const tail = /^acct_1([A-Za-z0-9]+)$/.exec(account)?.[1];
  return !!m && !!tail && tail.length >= 10 && m[1]!.startsWith(tail);
}
