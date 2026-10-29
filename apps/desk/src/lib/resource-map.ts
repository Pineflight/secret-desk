"use client";
import type { ResourceMapView } from "@secret-desk/runtime";
import { api } from "./api";
import { useQuery } from "./hooks";

/** Ein Zuordnungseintrag, wie ihn die Route liefert. */
export type MapEntry = ResourceMapView["entries"][number];

/** Die Zuordnung Repository/Stage zu Ressourcen (nicht geheim). */
export function useResourceMap() {
  return useQuery<ResourceMapView>("resource-map", () => api<ResourceMapView>("GET", "resource-map"));
}

/** Gleicher Schluessel (kind, repo, stage); ohne Stage heisst "alle Stages". */
export const sameMapKey = (a: { kind: string; repo: string; stage?: string | undefined }, b: { kind: string; repo: string; stage?: string | undefined }): boolean =>
  a.kind === b.kind && a.repo === b.repo && (a.stage ?? "") === (b.stage ?? "");

/** Eintraege der genannten Arten, nach Art, Repository und Stage sortiert. */
export const entriesOfKinds = (entries: readonly MapEntry[], kinds: readonly string[]): MapEntry[] =>
  entries.filter((e) => kinds.includes(e.kind)).sort((a, b) => a.kind.localeCompare(b.kind) || a.repo.localeCompare(b.repo) || (a.stage ?? "").localeCompare(b.stage ?? ""));
