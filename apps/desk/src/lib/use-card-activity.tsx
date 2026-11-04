"use client";
import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from "react";
import { activityReducer, emptyActivity, toastKey, type ActivityKey, type ActivityKind, type ActivityState } from "./card-activity";
import { useT } from "./i18n";
import { useToast } from "./toast";

export interface TrackSpec<R> {
  card: string;
  kind: ActivityKind;
  /** The line that is checked: a portal host or a connection id. */
  line?: string;
  /** What the toast calls the thing ("Acme", "Acme live"). */
  name: string;
  work: () => Promise<R>;
  /** Did it work? `detail` is appended to a failure toast. */
  judge: (result: R) => { ok: boolean; detail?: string | null };
}

export interface CardActivity {
  state: ActivityState;
  /** Runs `work` with a spinner on the card and a toast at the end. A thrown error is a failure; `track` then resolves to undefined. */
  track: <R>(spec: TrackSpec<R>) => Promise<R | undefined>;
  /** Records an activity that ran elsewhere (a dialog): result on the card and a toast. */
  note: (key: ActivityKey, name: string, ok: boolean, detail?: string | null) => void;
}

const fallback: CardActivity = { state: emptyActivity(), track: async (s) => s.work(), note: () => undefined };
const Ctx = createContext<CardActivity>(fallback);
export const useCardActivity = (): CardActivity => useContext(Ctx);

/** Builds the activity state of one page; give the result to `CardActivityProvider`. */
export function useCardActivityState(): CardActivity {
  const t = useT();
  const toast = useToast();
  const [state, dispatch] = useReducer(activityReducer, undefined, emptyActivity);
  const tRef = useRef(t);
  tRef.current = t;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const say = useCallback((kind: ActivityKind, name: string, ok: boolean, detail?: string | null) => {
    const text = tRef.current(toastKey(kind, ok), { name });
    const full = !ok && detail ? `${text} ${tRef.current("activity.detail", { detail })}` : text;
    if (ok) toastRef.current.success(full);
    else toastRef.current.error(full);
  }, []);
  const track = useCallback(
    async <R,>(spec: TrackSpec<R>): Promise<R | undefined> => {
      const key: ActivityKey = { card: spec.card, kind: spec.kind, ...(spec.line ? { line: spec.line } : {}) };
      dispatch({ type: "start", key });
      try {
        const result = await spec.work();
        const verdict = spec.judge(result);
        dispatch({ type: "finish", key, ok: verdict.ok, at: Date.now() });
        say(spec.kind, spec.name, verdict.ok, verdict.detail);
        return result;
      } catch (e) {
        dispatch({ type: "finish", key, ok: false, at: Date.now() });
        say(spec.kind, spec.name, false, e instanceof Error ? e.message : null);
        return undefined;
      }
    },
    [say],
  );
  const note = useCallback(
    (key: ActivityKey, name: string, ok: boolean, detail?: string | null) => {
      dispatch({ type: "finish", key, ok, at: Date.now() });
      say(key.kind, name, ok, detail);
    },
    [say],
  );
  return useMemo(() => ({ state, track, note }), [state, track, note]);
}

export function CardActivityProvider({ value, children }: { value: CardActivity; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
