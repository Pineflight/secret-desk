"use client";
import Link from "next/link";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { ParamSpec } from "@secret-desk/core";
import { Icon } from "@/components/Icons";
import { SelectBox } from "@/components/SelectBox";
import { Button, inputClass } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { filterOptions } from "@/lib/select-options";
import {
  applyPreset,
  describeValue,
  effectiveValues,
  fieldKind,
  isBlank,
  isRequiredNow,
  isSuggested,
  isUnlisted,
  optionText,
  optionsOf,
  presetActive,
  presetLabel,
  presetNeeds,
  resourceStatus,
  specHelp,
  specLabel,
  suggestionOf,
  toParams,
  toggleValue,
  type Draft,
  type ResourceState,
} from "@/lib/params-form";

interface Props {
  specs: ParamSpec[];
  draft: Draft;
  onDraft: (next: Draft) => void;
  /** Entdeckte Ressourcen je Parameter (Schluessel = Parameter). */
  resources: Record<string, ResourceState>;
  loading?: boolean;
  connection?: string | null;
  defaults?: Draft;
  errors?: Record<string, string>;
  disabled?: boolean;
  onReload?: () => void;
}

const BADGE = "rounded-full px-2 py-0.5 text-[11px] font-medium";

/** Felder fuer die Parameter eines Anbieters aus seiner Spezifikation. Vorschlaege werden nie ohne Klick uebernommen. */
export function ParamsForm({ specs, draft, onDraft, resources, loading = false, connection = null, defaults = {}, errors = {}, disabled = false, onReload }: Props) {
  const { locale, t } = useI18n();
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const effective = useMemo(() => effectiveValues(specs, toParams(specs, draft).params, defaults), [specs, draft, defaults]);
  const set = (key: string, value: unknown) => onDraft({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      {specs.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          specs={specs}
          required={isRequiredNow(spec, specs, effective)}
          value={draft[spec.key]}
          draft={draft}
          state={resources[spec.key]}
          loading={loading}
          connection={connection}
          defaultValue={defaults[spec.key]}
          error={errors[spec.key]}
          disabled={disabled}
          manual={Boolean(manual[spec.key])}
          setManual={(v) => setManual((m) => ({ ...m, [spec.key]: v }))}
          onChange={(v) => set(spec.key, v)}
          onDraft={onDraft}
          onReload={onReload}
          lang={locale}
          t={t}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  spec: ParamSpec;
  specs: ParamSpec[];
  required: boolean;
  value: unknown;
  draft: Draft;
  state: ResourceState | undefined;
  loading: boolean;
  connection: string | null;
  defaultValue: unknown;
  error: string | undefined;
  disabled: boolean;
  manual: boolean;
  setManual: (v: boolean) => void;
  onChange: (v: unknown) => void;
  onDraft: (d: Draft) => void;
  onReload: (() => void) | undefined;
  lang: "de" | "en";
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function ParamField(p: FieldProps) {
  const { spec, t, lang } = p;
  const id = useId();
  const kind = fieldKind(spec);
  const label = specLabel(spec, lang);
  const help = specHelp(spec, lang);
  const useDefault = spec.integrationDefault && isBlank(p.value) && !isBlank(p.defaultValue);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {label}
        <span className={`${BADGE} ${p.required ? "bg-primary-light text-primary" : "bg-page text-muted ring-1 ring-inset ring-line"}`}>{p.required ? t("params.required") : t("params.optional")}</span>
        <span className="font-mono text-[11px] font-normal text-muted">{spec.key}</span>
      </label>
      {kind === "pick" ? <PickField {...p} id={id} /> : null}
      {kind === "pickMany" ? <MultiField {...p} id={id} /> : null}
      {kind === "enum" ? (
        <SelectBox id={id} value={typeof p.value === "string" ? p.value : ""} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value)}>
          {!p.required || spec.defaultValue === undefined ? <option value="">{spec.defaultValue ? `${spec.defaultValue} (${t("params.optional")})` : t("params.pick")}</option> : null}
          {(spec.options ?? []).map((o) => <option key={o.value} value={o.value}>{lang === "en" ? o.labelEn : o.label}</option>)}
        </SelectBox>
      ) : null}
      {kind === "list" ? (
        <>
          <textarea id={id} rows={3} disabled={p.disabled} value={Array.isArray(p.value) ? p.value.join("\n") : typeof p.value === "string" ? p.value : ""} onChange={(e) => p.onChange(e.target.value)} className={`${inputClass} font-mono`} spellCheck={false} autoComplete="off" />
          <p className="text-xs text-muted">{t("params.list.hint")}</p>
        </>
      ) : null}
      {kind === "url" || kind === "text" ? (
        <input id={id} type={kind === "url" ? "url" : "text"} disabled={p.disabled} value={typeof p.value === "string" ? p.value : ""} onChange={(e) => p.onChange(e.target.value)} className={inputClass} spellCheck={false} autoComplete="off" />
      ) : null}
      {kind === "integer" ? (
        <input id={id} type="number" inputMode="numeric" min={spec.min ?? 1} {...(spec.max !== undefined ? { max: spec.max } : {})} disabled={p.disabled} value={typeof p.value === "string" || typeof p.value === "number" ? p.value : ""} onChange={(e) => p.onChange(e.target.value)} className={inputClass} />
      ) : null}
      {useDefault ? <p className="text-xs text-muted">{t("params.defaultValue", { value: describeValue(spec, p.defaultValue, p.state, lang) })}</p> : null}
      {help ? <p className="text-xs text-muted">{help}</p> : null}
      {p.error ? <p role="alert" className="text-xs font-medium text-danger-text">{p.error}</p> : null}
      {spec.presets && spec.presets.length > 0 ? <Presets {...p} /> : null}
    </div>
  );
}

function Presets({ spec, draft, onDraft, lang, t, specs }: FieldProps) {
  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-xs font-medium text-muted-text">{t("params.preset.title")}</p>
      <div className="flex flex-wrap gap-2">
        {(spec.presets ?? []).map((preset) => {
          const active = presetActive(preset, draft);
          const needs = presetNeeds(preset, draft).map((k) => { const s = specs.find((x) => x.key === k); return s ? specLabel(s, lang) : k; });
          return (
            <div key={preset.id} className="max-w-full">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onDraft(applyPreset(draft, preset))}
                className={`rounded-xl border px-3 py-1.5 text-left text-sm font-medium ${active ? "border-primary bg-primary-light text-primary" : "border-line bg-card hover:bg-page"}`}
              >
                {presetLabel(preset, lang)}
              </button>
              {needs.length > 0 ? <p className="mt-0.5 text-[11px] text-muted">{t("params.preset.needs", { keys: needs.join(", ") })}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Hinweis zum Stand der Entdeckung, wenn keine Liste da ist. */
function StatusNote({ state, connection, t }: { state: ResourceState | undefined; connection: string | null; t: FieldProps["t"] }): ReactNode {
  const status = resourceStatus(state);
  if (status === "none" || status === "ok") return null;
  const box = "rounded-lg bg-warn-light px-3 py-2 text-xs text-warn-text";
  if (status === "not-connected") {
    return <p className={box}>{t("params.res.notConnected", { connection: state?.connection ?? connection ?? "?" })} <Link href="/connections" className="font-medium underline">{t("params.toConnections")}</Link></p>;
  }
  if (status === "needs-params") return <p className={box}>{t("params.res.needsParams")}</p>;
  if (status === "error") return <p className={box}>{state?.error ? t("params.res.error", { error: state.error }) : t("params.res.errorPlain")}</p>;
  return <p className={box}>{t("params.res.unsupported")}</p>;
}

function PickField(p: FieldProps & { id: string }) {
  const { spec, state, t } = p;
  const status = resourceStatus(state);
  const options = optionsOf(state);
  const value = isBlank(p.value) ? "" : String(p.value);
  const hasList = status === "ok" && options.length > 0;
  const showManual = p.manual || !hasList;
  const suggestion = suggestionOf(state);
  return (
    <div className="space-y-1.5">
      {showManual ? (
        <input id={p.id} type="text" disabled={p.disabled} value={value} onChange={(e) => p.onChange(e.target.value)} className={`${inputClass} font-mono`} spellCheck={false} autoComplete="off" />
      ) : (
        <SelectBox id={p.id} value={value} disabled={p.disabled} searchable onChange={(e) => p.onChange(e.target.value)}>
          <option value="">{t("params.pick")}</option>
          {value !== "" && !options.some((o) => String(o.value) === value) ? <option value={value}>{value}</option> : null}
          {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{optionText(o)}{o.suggestedFor ? ` · ${t("params.suggestionTag")}` : ""}</option>)}
        </SelectBox>
      )}
      {p.loading && status === "none" ? <p className="text-xs text-muted">{t("params.loading")}</p> : null}
      {!p.loading && status === "ok" && options.length === 0 ? <p className="text-xs text-muted">{t("params.res.empty")}</p> : null}
      {showManual ? <StatusNote state={state} connection={p.connection} t={t} /> : null}
      {hasList && suggestion && !isSuggested(state, value) && !p.manual ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-info-light px-3 py-2 text-xs text-info-text">
          <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t("params.suggestionText", { name: suggestion.label, reason: suggestion.suggestedFor?.reason ?? "" })}</span>
          <Button className="!px-2.5 !py-1 !text-xs" disabled={p.disabled} onClick={() => p.onChange(String(suggestion.value))}>{t("params.suggestionAdopt")}</Button>
        </div>
      ) : null}
      {hasList && isSuggested(state, value) ? <p className="text-xs text-info-text"><span className={`${BADGE} bg-info-light`}>{t("params.suggestionTag")}</span></p> : null}
      {hasList && isUnlisted(spec, value, state) ? <p className="text-xs text-warn-text">{t("params.unlisted")}</p> : null}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {hasList ? <button type="button" className="text-primary underline" onClick={() => p.setManual(!p.manual)}>{p.manual ? t("params.fromList") : t("params.manual")}</button> : null}
        {p.onReload && status !== "none" ? <button type="button" className="text-muted underline" onClick={p.onReload}>{t("params.reload")}</button> : null}
      </div>
    </div>
  );
}

/** Mehrfachauswahl mit Suche (zum Beispiel Cloudflare-Berechtigungen). Ohne Liste: Eingabe von Hand. */
function MultiField(p: FieldProps & { id: string }) {
  const { state, t } = p;
  const [query, setQuery] = useState("");
  const status = resourceStatus(state);
  const options = optionsOf(state);
  const selected = Array.isArray(p.value) ? p.value.filter((x): x is string => typeof x === "string") : [];
  const items = useMemo(() => options.map((o) => ({ value: String(o.value), label: optionText(o), name: o.label })), [options]);
  const shown = useMemo(() => filterOptions(items, query) as typeof items, [items, query]);
  const nameOf = (v: string): string => items.find((i) => i.value === v)?.name ?? v;
  if (status !== "ok" || options.length === 0) {
    return (
      <div className="space-y-1.5">
        <textarea id={p.id} rows={3} disabled={p.disabled} value={typeof p.value === "string" ? p.value : selected.join("\n")} onChange={(e) => p.onChange(e.target.value)} className={`${inputClass} font-mono`} spellCheck={false} autoComplete="off" />
        <p className="text-xs text-muted">{t("params.list.hint")}</p>
        <StatusNote state={state} connection={p.connection} t={t} />
        {p.loading && status === "none" ? <p className="text-xs text-muted">{t("params.loading")}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("params.multi.selected", { count: selected.length })}>
          {selected.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2.5 py-0.5 text-xs text-primary">
              {nameOf(v)}
              <button type="button" disabled={p.disabled} aria-label={t("params.multi.remove", { name: nameOf(v) })} onClick={() => p.onChange(toggleValue(selected, v))}><Icon name="x" className="h-3 w-3" /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-xl border border-line">
        <div className="relative border-b border-line p-2">
          <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input id={p.id} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("params.multi.search")} aria-label={t("params.multi.search")} autoComplete="off" className="w-full rounded-lg border border-line bg-card py-1.5 pl-8 pr-2 text-sm" />
        </div>
        <ul className="max-h-52 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
          {shown.map((i) => {
            const on = selected.includes(i.value);
            return (
              <li key={i.value} role="option" aria-selected={on}>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-page">
                  <input type="checkbox" disabled={p.disabled} checked={on} onChange={() => p.onChange(toggleValue(selected, i.value))} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--sd-primary)]" />
                  <span className="min-w-0 break-words">{i.label}</span>
                </label>
              </li>
            );
          })}
          {shown.length === 0 ? <li className="px-3 py-2 text-sm text-muted">{t("params.multi.noMatches")}</li> : null}
        </ul>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted">{t("params.multi.selected", { count: selected.length })}</span>
        {selected.length > 0 ? <button type="button" className="text-primary underline" onClick={() => p.onChange([])}>{t("params.multi.clear")}</button> : null}
      </div>
    </div>
  );
}
