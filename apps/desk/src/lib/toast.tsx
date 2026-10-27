"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icons";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}
interface ToastApi {
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
}

const Ctx = createContext<ToastApi>({ success: () => {}, error: () => {}, info: () => {} });
export const useToast = (): ToastApi => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const close = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Kind, text: string) => {
      const id = next.current++;
      setItems((l) => [...l, { id, kind, text }]);
      if (kind !== "error") setTimeout(() => close(id), 6000);
    },
    [close],
  );
  const api = useMemo<ToastApi>(() => ({ success: (t) => push("success", t), error: (t) => push("error", t), info: (t) => push("info", t) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`sd-slide pointer-events-auto flex items-start gap-3 rounded-xl border p-3 text-sm shadow-lg ${
              t.kind === "error" ? "border-danger bg-danger-light text-danger-text" : t.kind === "success" ? "border-success bg-success-light text-success-text" : "border-info bg-info-light text-info-text"
            }`}
          >
            <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1">{t.text}</p>
            <button type="button" onClick={() => close(t.id)} className="rounded p-0.5 hover:bg-black/5" aria-label="Meldung schließen">
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
