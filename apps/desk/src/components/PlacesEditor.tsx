"use client";
import { useEffect } from "react";
import type { ConnectionResources } from "@secret-desk/runtime";
import { api, enc } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { optionText, optionsOf, resourceStatus } from "@/lib/params-form";
import { defaultAccountId, emptyPlaceRow, type PlaceRow } from "@/lib/places";
import { environmentOf } from "@/lib/stages";
import { useStageDefs } from "@/lib/use-stages";
import { Button } from "./ui";
import { RepoPicker } from "./RepoPicker";
import { Icon } from "./Icons";
import { inputClass } from "./ui";
import { SelectBox } from "./SelectBox";

/**
 * Ziele eines Eintrags. Bei Bereich "Umgebung" kommt der Environment-Name aus der gewaehlten Stage; ein eigener Name ist nur eine Ausnahme.
 * Mit `allowWorker` kann ein Ziel auch ein Secret eines Cloudflare Workers sein (nur fuer Secrets, nie fuer Variablen).
 */
export function PlacesEditor({ rows, onChange, stage, allowWorker = false }: { rows: PlaceRow[]; onChange: (rows: PlaceRow[]) => void; stage: string; allowWorker?: boolean }) {
  const t = useT();
  const defs = useStageDefs();
  const derived = environmentOf(defs, stage);
  const set = (i: number, patch: Partial<PlaceRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t(allowWorker ? "meta.placesLegendMixed" : "meta.placesLegend")}</legend>
      <p className="text-xs text-muted">{t("meta.scopeHint")}</p>
      {rows.map((r, i) => (
        <div key={i} className="space-y-1">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_auto]">
            {r.scope === "cloudflare-worker" ? (
              <WorkerFields n={i + 1} row={r} onChange={(patch) => set(i, patch)} />
            ) : (
              <RepoPicker ariaLabel={t("meta.placeRepoAria", { n: i + 1 })} placeholder={t("meta.placeRepo")} value={r.repo} onChange={(v) => set(i, { repo: v })} />
            )}
            <SelectBox aria-label={t("meta.placeScopeAria", { n: i + 1 })} value={r.scope} onChange={(e) => set(i, { scope: e.target.value as PlaceRow["scope"] })}>
              <option value="repository">{t("meta.scopeRepository")}</option>
              <option value="environment">{t("meta.scopeEnvironment")}</option>
              {allowWorker || r.scope === "cloudflare-worker" ? <option value="cloudflare-worker">{t("meta.scopeWorker")}</option> : null}
            </SelectBox>
            <button type="button" aria-label={t("meta.placeRemove", { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="rounded-xl p-2 text-muted hover:bg-page">
              <Icon name="trash" className="h-4 w-4" />
            </button>
          </div>
          {r.scope === "cloudflare-worker" ? <p className="pl-1 text-xs text-muted-text">{t("meta.workerHint")}</p> : null}
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

const ACCOUNT_KIND = "cloudflare.account";
const SCRIPT_KIND = "cloudflare.workerScript";

/**
 * Account and Worker of a Worker secret target. The account starts with the integration default (or the only account the token
 * sees); the Worker is typed with the deployed Workers of that account as suggestions. Both stay free text, so the form works
 * without a connection.
 */
function WorkerFields({ n, row, onChange }: { n: number; row: PlaceRow; onChange: (patch: Partial<PlaceRow>) => void }) {
  const t = useT();
  const accounts = useQuery<ConnectionResources>("worker-places:accounts", () => api<ConnectionResources>("GET", `connections/cloudflare/resources?kind=${enc(ACCOUNT_KIND)}`));
  const preset = defaultAccountId(accounts.data);
  const accountId = row.accountId ?? "";
  const script = row.script ?? "";
  useEffect(() => {
    if (!accountId && preset) onChange({ accountId: preset });
  }, [preset, accountId]);
  const scripts = useQuery<ConnectionResources>(accountId ? `worker-places:scripts:${accountId}` : null, () => api<ConnectionResources>("GET", `connections/cloudflare/resources?kind=${enc(SCRIPT_KIND)}&param.accountId=${enc(accountId)}`));
  const accountState = accounts.data?.resources[ACCOUNT_KIND];
  const scriptOptions = optionsOf(scripts.data?.resources[SCRIPT_KIND]);
  const listId = `worker-scripts-${n}`;
  const accountOptions = optionsOf(accountState);
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {accountOptions.length > 0 ? (
          <SelectBox aria-label={t("meta.workerAccountAria", { n })} value={accountId} onChange={(e) => onChange({ accountId: e.target.value })}>
            {accountId && !accountOptions.some((o) => String(o.value) === accountId) ? <option value={accountId}>{accountId}</option> : null}
            {accountId ? null : <option value="">{t("meta.workerAccount")}</option>}
            {accountOptions.map((o) => <option key={String(o.value)} value={String(o.value)}>{optionText(o)}</option>)}
          </SelectBox>
        ) : (
          <input aria-label={t("meta.workerAccountAria", { n })} placeholder={t("meta.workerAccount")} value={accountId} onChange={(e) => onChange({ accountId: e.target.value })} className={inputClass} autoComplete="off" spellCheck={false} />
        )}
        <input aria-label={t("meta.workerScriptAria", { n })} placeholder={t("meta.workerScript")} value={script} onChange={(e) => onChange({ script: e.target.value })} className={inputClass} autoComplete="off" spellCheck={false} list={listId} />
        <datalist id={listId}>{scriptOptions.map((o) => <option key={String(o.value)} value={String(o.value)} />)}</datalist>
      </div>
      {resourceStatus(accountState) === "not-connected" ? <p className="text-xs text-warn-text">{t("meta.workerNoConnection")}</p> : null}
    </div>
  );
}
