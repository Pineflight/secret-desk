"use client";
import { useEffect, useState } from "react";
import type { ParamsView } from "@secret-desk/runtime";
import { api, enc } from "./api";
import { useDebounced, useQuery } from "./hooks";
import { dependencyKey, dependencyParams, dependencyQuery, type Draft } from "./params-form";

/**
 * Parameter-Spezifikation und entdeckte Ressourcen fuer einen Anbieter, auch fuer einen Eintrag, der noch nicht existiert
 * (Anlegedialog) oder gerade bearbeitet wird. Aendert sich ein Parameter, von dem andere Listen abhaengen (param.<key>),
 * werden die Listen neu gelesen (verzoegert, damit Tippen nicht jede Taste einen Aufruf kostet). `providerId = null` pausiert.
 * Der letzte Stand bleibt waehrend des Nachladens sichtbar.
 */
export function useDraftParams(providerId: string | null, repo: string, stage: string, draft: Draft): { view: ParamsView | undefined; loading: boolean; error: Error | null; reload: () => void } {
  const [view, setView] = useState<ParamsView | undefined>(undefined);
  const deps = dependencyKey(dependencyParams(view?.specs ?? [], draft));
  const settled = useDebounced(deps, 400);
  const key = providerId ? `draft-params:${providerId}:${repo}:${stage}:${settled}` : null;
  const q = useQuery<ParamsView>(key, () => {
    const qs = dependencyQuery(Object.fromEntries(JSON.parse(settled) as [string, string][]));
    if (repo) qs.set("repo", repo);
    if (stage) qs.set("stage", stage);
    return api<ParamsView>("GET", `providers/${enc(providerId!)}/params?${qs}`);
  });
  useEffect(() => {
    if (q.data) setView(q.data);
  }, [q.data]);
  useEffect(() => {
    setView(undefined);
  }, [providerId]);
  return { view: providerId ? view : undefined, loading: q.loading, error: q.error, reload: q.reload };
}
