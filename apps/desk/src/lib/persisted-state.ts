import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

const PREFIX = "sd:filter:";

/** Liest einen gespeicherten Wert; kaputtes JSON oder gesperrter Speicher ergeben den Vorgabewert. */
export function readStored<T>(key: string, fallback: T, storage: Pick<Storage, "getItem"> | null = safeStorage()): T {
  try {
    const raw = storage?.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored<T>(key: string, value: T, initial: T, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): void {
  try {
    if (JSON.stringify(value) === JSON.stringify(initial)) storage?.removeItem(PREFIX + key);
    else storage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* Speicher gesperrt oder voll: Filter gilt dann nur bis zum Verlassen der Seite */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Wie useState, aber der Wert bleibt in der Browser-Sitzung erhalten: Wer in einen Eintrag springt und zurueckgeht
 * (oder ueber die Seitenleiste wiederkommt), findet seine Filter vor. Wird erst nach dem Mounten gelesen, damit
 * Server und Client zuerst dasselbe rendern.
 */
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const ready = useRef(false);
  const first = useRef(initial);
  useEffect(() => {
    const stored = readStored<T>(key, first.current);
    setValue(stored);
    ready.current = true;
  }, [key]);
  useEffect(() => {
    if (ready.current) writeStored(key, value, first.current);
  }, [key, value]);
  return [value, setValue];
}
