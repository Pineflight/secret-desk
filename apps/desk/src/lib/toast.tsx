"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "./i18n";
import { Icon } from "@/components/Icons";
import { dismissToast, pauseToast, pushToast, tickToasts, type ToastItem, type ToastKind } from "./toast-queue";

interface ToastApi {
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
}

const Ctx = createContext<ToastApi>({ success: () => {}, error: () => {}, info: () => {} });
export const useToast = (): ToastApi => useContext(Ctx);

const TICK_MS = 250;

/**
 * The one toast component of the portal: a polite live region, every message dismissible, hidden after about five seconds, and
 * the clock of a message stands still while the pointer or the keyboard focus is on it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const tr = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const close = useCallback((id: number) => setItems((l) => dismissToast(l, id)), []);
  const hold = useCallback((id: number, paused: boolean) => setItems((l) => pauseToast(l, id, paused)), []);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = next.current++;
    setItems((l) => pushToast(l, { id, kind, text }));
  }, []);
  const active = items.length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setItems((l) => tickToasts(l, TICK_MS)), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  const api = useMemo<ToastApi>(() => ({ success: (t) => push("success", t), error: (t) => push("error", t), info: (t) => push("info", t) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => hold(t.id, true)}
            onMouseLeave={() => hold(t.id, false)}
            onFocus={() => hold(t.id, true)}
            onBlur={() => hold(t.id, false)}
            className={`sd-slide pointer-events-auto flex items-start gap-3 rounded-xl border p-3 text-sm shadow-lg ${
              t.kind === "error" ? "border-danger bg-danger-light text-danger-text" : t.kind === "success" ? "border-success bg-success-light text-success-text" : "border-info bg-info-light text-info-text"
            }`}
          >
            <Icon name={t.kind === "error" ? "x" : t.kind === "success" ? "check" : "info"} className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1">{t.text}</p>
            <button type="button" onClick={() => close(t.id)} className="rounded p-0.5 hover:bg-black/5" aria-label={tr("common.closeToast")}>
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
