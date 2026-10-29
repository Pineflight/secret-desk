"use client";
import { highlight } from "@/lib/smart-search";

/** Text mit hervorgehobenen Treffern (Befehlspalette und Listen). */
export function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return <>{highlight(text, terms).map((s, i) => (s.hit ? <mark key={i} className="rounded bg-warn-light px-0.5 text-ink">{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}
