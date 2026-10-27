"use client";
import { useT } from "@/lib/i18n";
import { emptyPlaceRow, type PlaceRow } from "@/lib/places";
import { environmentOf } from "@/lib/stages";
import { useStageDefs } from "@/lib/use-stages";
import { Button } from "./ui";
import { RepoPicker } from "./RepoPicker";
import { Icon } from "./Icons";
import { inputClass } from "./ui";
import { SelectBox } from "./SelectBox";

/**
 * Ziele in GitHub. Bei Bereich "Umgebung" kommt der Environment-Name aus der gewaehlten Stage; ein eigener Name ist nur eine Ausnahme.
 */
export function PlacesEditor({ rows, onChange, stage }: { rows: PlaceRow[]; onChange: (rows: PlaceRow[]) => void; stage: string }) {
  const t = useT();
  const defs = useStageDefs();
  const derived = environmentOf(defs, stage);
  const set = (i: number, patch: Partial<PlaceRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t("meta.placesLegend")}</legend>
      <p className="text-xs text-muted">{t("meta.scopeHint")}</p>
      {rows.map((r, i) => (
        <div key={i} className="space-y-1">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_auto]">
            <RepoPicker ariaLabel={t("meta.placeRepoAria", { n: i + 1 })} placeholder={t("meta.placeRepo")} value={r.repo} onChange={(v) => set(i, { repo: v })} />
            <SelectBox aria-label={t("meta.placeScopeAria", { n: i + 1 })} value={r.scope} onChange={(e) => set(i, { scope: e.target.value as PlaceRow["scope"] })}>
              <option value="repository">{t("meta.scopeRepository")}</option>
              <option value="environment">{t("meta.scopeEnvironment")}</option>
            </SelectBox>
            <button type="button" aria-label={t("meta.placeRemove", { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="rounded-xl p-2 text-muted hover:bg-page">
              <Icon name="trash" className="h-4 w-4" />
            </button>
          </div>
          {r.scope === "environment" ? (
            <div className="space-y-1 pl-1 text-xs">
              {derived && !r.environment ? <p className="text-muted-text">{t("meta.envDerived", { name: derived, stage })}</p> : null}
              {!derived && !r.environment ? <p className="text-warn-text">{t("meta.envNone", { stage })}</p> : null}
              <details open={Boolean(r.environment)}>
                <summary className="cursor-pointer text-muted">{t("meta.envOverride")}</summary>
                <input aria-label={t("meta.placeEnvAria", { n: i + 1 })} placeholder={derived ? t("meta.envOverridePlaceholder", { name: derived }) : t("meta.placeEnv")} value={r.environment} onChange={(e) => set(i, { environment: e.target.value })} className={`${inputClass} mt-1`} autoComplete="off" />
              </details>
            </div>
          ) : null}
        </div>
      ))}
      <Button variant="ghost" onClick={() => onChange([...rows, emptyPlaceRow()])}>
        <Icon name="plus" />{t("meta.placeAdd")}
      </Button>
    </fieldset>
  );
}
