"use client";
import { useCallback, useEffect, useState } from "react";
import type { RepoList } from "@secret-desk/runtime";
import { api } from "./api";

/** Gemeinsamer Zwischenspeicher: Alle Auswahlfelder teilen sich eine Anfrage (GitHub live, Fehler werden still ignoriert). */
const TTL_MS = 60_000;
let cache: { at: number; data: RepoList } | null = null;
let inflight: Promise<RepoList | null> | null = null;

export function invalidateRepoList(): void {
  cache = null;
}

export function loadRepoList(force = false): Promise<RepoList | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (!inflight) {
    inflight = api<RepoList>("GET", "repos?live=1")
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useRepoList(): { data: RepoList | null; reload: () => void } {
  const [data, setData] = useState<RepoList | null>(cache?.data ?? null);
  useEffect(() => {
    let alive = true;
    void loadRepoList().then((d) => alive && d && setData(d));
    return () => {
      alive = false;
    };
  }, []);
  const reload = useCallback(() => {
    invalidateRepoList();
    void loadRepoList(true).then((d) => d && setData(d));
  }, []);
  return { data, reload };
}
