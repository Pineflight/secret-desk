/**
 * The toast list as a pure model. Every toast hides itself after `TOAST_MS` of visible time; while the pointer rests on it (or
 * focus is inside) its clock stands still. The provider only calls `tick` on a timer.
 */

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** Visible time left in milliseconds. */
  remaining: number;
  paused: boolean;
}

export const TOAST_MS = 5000;
/** More than this many at once and the oldest ones make room. */
export const TOAST_MAX = 4;

/** Adds a toast; an identical one that is already shown only renews its clock (no stack of the same message). */
export function pushToast(list: readonly ToastItem[], item: { id: number; kind: ToastKind; text: string }, max = TOAST_MAX): ToastItem[] {
  const same = list.find((t) => t.kind === item.kind && t.text === item.text);
  if (same) return list.map((t) => (t === same ? { ...t, remaining: TOAST_MS } : t));
  const next = [...list, { ...item, remaining: TOAST_MS, paused: false }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Lets `dt` milliseconds pass: paused toasts keep their time, the others lose it and leave at zero. */
export function tickToasts(list: readonly ToastItem[], dt: number): ToastItem[] {
  return list.flatMap((t) => {
    if (t.paused) return [t];
    const remaining = t.remaining - dt;
    return remaining <= 0 ? [] : [{ ...t, remaining }];
  });
}

export const pauseToast = (list: readonly ToastItem[], id: number, paused: boolean): ToastItem[] => list.map((t) => (t.id === id ? { ...t, paused } : t));
export const dismissToast = (list: readonly ToastItem[], id: number): ToastItem[] => list.filter((t) => t.id !== id);
