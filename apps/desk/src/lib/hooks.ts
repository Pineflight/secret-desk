"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

/** Winziger Datenhaken ohne Bibliothek. `key = null` pausiert. */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, opts: { refreshMs?: number } = {}): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const run = useRef(0);

  const load = useCallback(
    (silent: boolean) => {
      if (key === null) return;
      const id = ++run.current;
      if (!silent) setLoading(true);
      fetcherRef
        .current()
        .then((d) => {
          if (run.current !== id) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => {
          if (run.current !== id) return;
          setError(e instanceof Error ? e : new Error("Unbekannter Fehler"));
        })
        .finally(() => {
          if (run.current === id) setLoading(false);
        });
    },
    [key],
  );

  useEffect(() => {
    setData(undefined);
    setError(null);
    load(false);
    return () => {
      run.current++;
    };
  }, [load]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (!refreshMs || key === null) return;
    const t = setInterval(() => load(true), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, key, load]);

  return { data, error, loading, reload: useCallback(() => load(false), [load]) };
}

export interface MutationState<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: ApiError | Error | null;
  reset: () => void;
}

/** Fuehrt eine Aenderung aus. Fehler landen in `error`, `run` liefert dann `undefined`. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>): MutationState<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Unbekannter Fehler"));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, reset: useCallback(() => setError(null), []) };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
