"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDebounced } from "./hooks";

/**
 * Suchtext einer Listenseite: gefiltert wird sofort nach `text`, die URL (?q=) folgt entprellt und haelt die Suche
 * mit der Kopfzeilensuche und der gemerkten Sitzung (Shell) zusammen. Aenderungen der URL von aussen (Kopfzeile,
 * Zurueck-Knopf) landen im Text.
 */
export function usePageSearch(path: string): { text: string; setText: (v: string) => void } {
  const params = useSearchParams();
  const router = useRouter();
  const urlQ = params.get("q") ?? "";
  const [text, setText] = useState(urlQ);
  const written = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== written.current) {
      written.current = urlQ;
      setText(urlQ);
    }
  }, [urlQ]);
  const settled = useDebounced(text, 200);
  useEffect(() => {
    if (settled === written.current) return;
    written.current = settled;
    const next = new URLSearchParams(params.toString());
    if (settled) next.set("q", settled);
    else next.delete("q");
    const s = next.toString();
    router.replace(s ? `${path}?${s}` : path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  return { text, setText };
}
