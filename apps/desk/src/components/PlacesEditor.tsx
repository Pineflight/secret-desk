"use client";
import { emptyPlaceRow, type PlaceRow } from "@/lib/places";
import { Button } from "./ui";
import { Icon } from "./Icons";
import { inputClass, selectClass } from "./ui";

export function PlacesEditor({ rows, onChange }: { rows: PlaceRow[]; onChange: (rows: PlaceRow[]) => void }) {
  const set = (i: number, patch: Partial<PlaceRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Ziele in GitHub</legend>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
          <input aria-label={`Repository, Ziel ${i + 1}`} placeholder="Repository" value={r.repo} onChange={(e) => set(i, { repo: e.target.value })} className={inputClass} autoComplete="off" />
          <select aria-label={`Bereich, Ziel ${i + 1}`} value={r.scope} onChange={(e) => set(i, { scope: e.target.value as PlaceRow["scope"] })} className={selectClass}>
            <option value="repository">Repository</option>
            <option value="environment">Umgebung</option>
          </select>
          <input aria-label={`Umgebungsname, Ziel ${i + 1}`} placeholder="Umgebungsname" disabled={r.scope !== "environment"} value={r.environment} onChange={(e) => set(i, { environment: e.target.value })} className={inputClass} autoComplete="off" />
          <button type="button" aria-label={`Ziel ${i + 1} entfernen`} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="rounded-xl p-2 text-muted hover:bg-page">
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button variant="ghost" onClick={() => onChange([...rows, emptyPlaceRow()])}>
        <Icon name="plus" />Ziel hinzufügen
      </Button>
    </fieldset>
  );
}
