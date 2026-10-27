"use client";
import type { StageView } from "@secret-desk/runtime";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { FALLBACK_STAGES, type StageDefLite } from "./stages";

/** Gemeinsamer Zwischenspeicher fuer die Stage-Definitionen: Alle Seiten teilen sich eine Anfrage. */
const TTL_MS = 30_000;
let cache: { at: number; data: StageView[] } | null = null;
let inflight: Promise<StageView[] | null> | null = null;
const listeners = new Set<(d: StageView[]) => void>();

/** Nach einer Aenderung der Einstellungen: Cache setzen und alle offenen Seiten benachrichtigen. */
export function publishStages(data: StageView[]): void {
  cache = { at: Date.now(), data };
  for (const fn of [...listeners]) fn(data);
}

export function loadStages(force = false): Promise<StageView[] | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (!inflight) {
    inflight = api<StageView[]>("GET", "stages")
      .then((data) => {
        publishStages(data);
        return data;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Die konfigurierten Stages. Bis zur Antwort leer: Aufrufer nehmen dann FALLBACK_STAGES. */
export function useStages(): { stages: StageView[] | undefined; reload: () => void } {
  const [data, setData] = useState<StageView[] | undefined>(cache?.data);
  useEffect(() => {
    let alive = true;
    const fn = (d: StageView[]) => alive && setData(d);
    listeners.add(fn);
    void loadStages();
    return () => {
      alive = false;
      listeners.delete(fn);
    };
  }, []);
  const reload = useCallback(() => void loadStages(true), []);
  return { stages: data, reload };
}

/** Definitionen mit Rueckfall auf die Standard-Stages, damit Auswahl und Badges nie leer sind. */
export function useStageDefs(): StageDefLite[] {
  return useStages().stages ?? FALLBACK_STAGES;
}
