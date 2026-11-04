/**
 * What is running on the Integrations page right now (connection tests, sign-in checks, reconnects, removals, renewals) and how the
 * last one of each ended. A pure reducer so the card header, the lines and the toasts all read the same state.
 */

export type ActivityKind = "signin" | "test" | "reconnect" | "remove" | "renewal";

export interface ActivityKey {
  card: string;
  kind: ActivityKind;
  /** The line that is checked (a portal host or a connection id); empty for the card as a whole. */
  line?: string;
}

export interface ActivityResult {
  ok: boolean;
  /** Epoch milliseconds the activity ended. */
  at: number;
  kind: ActivityKind;
  line: string;
}

export interface ActivityState {
  running: ReadonlyMap<string, ActivityKey>;
  /** The last result per card and line (`card|line`), whatever the kind was. */
  last: ReadonlyMap<string, ActivityResult>;
}

export const emptyActivity = (): ActivityState => ({ running: new Map(), last: new Map() });

const runKey = (k: ActivityKey): string => `${k.card}|${k.kind}|${k.line ?? ""}`;
const lastKey = (card: string, line = ""): string => `${card}|${line}`;

export type ActivityAction = { type: "start"; key: ActivityKey } | { type: "finish"; key: ActivityKey; ok: boolean; at: number };

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  const running = new Map(state.running);
  if (action.type === "start") {
    running.set(runKey(action.key), action.key);
    return { running, last: state.last };
  }
  running.delete(runKey(action.key));
  const last = new Map(state.last);
  last.set(lastKey(action.key.card, action.key.line), { ok: action.ok, at: action.at, kind: action.key.kind, line: action.key.line ?? "" });
  return { running, last };
}

/** Something runs on this card (any line): the header shows a spinner. */
export function isCardBusy(state: ActivityState, card: string): boolean {
  for (const k of state.running.values()) if (k.card === card) return true;
  return false;
}

/** This line of the card is being checked, tested, reconnected or removed. */
export function isLineBusy(state: ActivityState, card: string, line = ""): boolean {
  for (const k of state.running.values()) if (k.card === card && (k.line ?? "") === line) return true;
  return false;
}

/** The result of the last activity on this line of the card, or undefined. */
export const lastResult = (state: ActivityState, card: string, line = ""): ActivityResult | undefined => state.last.get(lastKey(card, line));

/** The newest result of any line of the card (what the header shows beside the badge). */
export function lastCardResult(state: ActivityState, card: string): ActivityResult | undefined {
  let best: ActivityResult | undefined;
  for (const [k, r] of state.last) if (k.startsWith(`${card}|`) && (!best || r.at > best.at)) best = r;
  return best;
}

/** "14:05" in the local time zone of the browser. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Message keys of the toast for a finished activity. */
export function toastKey(kind: ActivityKind, ok: boolean): string {
  return `activity.${ok ? "ok" : "fail"}.${kind}`;
}

/** The last connection test of one of the card's keys failed (a later passing test of the same key clears it). */
export function hasFailedTest(state: ActivityState, card: string): boolean {
  for (const [k, r] of state.last) if (k.startsWith(`${card}|`) && r.kind === "test" && !r.ok) return true;
  return false;
}
