"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Checkbox, PageHeader, SelectField, TextAreaField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { ConnectionCheckPanel, type CheckResult } from "@/components/ConnectionCheck";
import { ConnectionDefaultsSummary, ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { daysLabel, formatDate } from "@/lib/format";
import { daysSince, expiryLevel, shortHash, staleWithoutExpiry, stripePrefixMismatch } from "@/lib/connection-health";
import { useMutation, useQuery } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";

interface Connection {
  id: string;
  connected: boolean;
  source: "session" | "env" | "op" | "none" | string;
  hint?: string;
  expires?: string | null;
  daysLeft?: number | null;
  savedAt?: string | null;
  fingerprint?: string;
  canRemember?: boolean;
  label: string;
  description: string | null;
  url: string | null;
  openUrl: string | null;
  steps: string[];
  permissions: string[];
}
interface AutomationInfo {
  enabled: boolean;
  chrome: { found: boolean; path: string | null; hint: string | null };
  profileDir: string;
  loginTimeoutMinutes: number;
  allowExternalRecipes: boolean;
  recipes: { id: string; providerId: string; label: string; host: string; status: string; sha256: string; allowHosts: string[]; bundled: boolean }[];
  problems: { file: string; message: string }[];
}
interface Provider {
  id: string;
  label: string;
  kind: string;
  connection: string | null;
  guide: { url: string; steps: string[] } | null;
}

const NAMES: Record<string, string> = { github: "GitHub", cloudflare: "Cloudflare", supabase: "Supabase", stripe: "Stripe", resend: "Resend", grafana: "Grafana" };
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_KEYS: Record<string, string> = { session: "connections.srcSession", env: "connections.srcEnv", op: "connections.srcOp", vault: "connections.srcVault", none: "connections.srcNone" };

export default function ConnectionsPage() {
  const t = useT();
  const toast = useToast();
  const [picking, setPicking] = useState<string | null | false>(false);
  const [adding, setAdding] = useState(false);
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
  const auto = useQuery<AutomationInfo>("automation", () => api<AutomationInfo>("GET", "automation"));
  const del = useMutation(async (id: string) => api<Connection>("DELETE", `connections/${enc(id)}/token`));
  const connected = (conns.data ?? []).filter((c) => c.connected);
  return (
    <>
      <PageHeader
        title={t("connections.title")}
        subtitle={t("connections.subtitle")}
        actions={<Button variant="primary" onClick={() => setPicking(null)}><Icon name="plus" className="h-4 w-4" />{t("connections.add")}</Button>}
      />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {conns.loading && !conns.data ? <ListSkeleton rows={2} /> : null}
      {conns.data && connected.length === 0 ? (
        <EmptyState title={t("connections.emptyTitle")} icon="plug">
          <Button variant="primary" onClick={() => setPicking(null)}>{t("connections.add")}</Button>
        </EmptyState>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {connected.map((c) => (
          <ConnectionCard key={c.id} c={c} onGuide={() => setPicking(c.id)} onDisconnect={async () => { if (await del.run(c.id)) { toast.success(t("connections.disconnected", { name: labelOf(c) })); conns.reload(); } }} disconnecting={del.pending} />
        ))}
      </div>
      <BrowserAutomationSection q={auto} />
      {picking !== false ? (
        <IntegrationPicker
          initial={picking}
          conns={conns.data ?? []}
          provs={provs.data ?? []}
          onClose={() => setPicking(false)}
          onChanged={conns.reload}
          onNewProvider={() => { setPicking(false); setAdding(true); }}
        />
      ) : null}
      {adding ? <AddProviderDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); provs.reload(); setPicking(null); }} /> : null}
    </>
  );
}

/** Eine verbundene Integration: Ablauf-Ampel, Alter des gespeicherten Tokens, Test. */
function ConnectionCard({ c, onGuide, onDisconnect, disconnecting }: { c: Connection; onGuide: () => void; onDisconnect: () => void; disconnecting: boolean }) {
  const t = useT();
  const [checked, setChecked] = useState<CheckResult | null>(null);
  // Das vom Anbieter genannte Ablaufdatum ersetzt die manuelle Angabe, solange das Testergebnis sichtbar ist.
  const expires = checked && checked.expires !== undefined ? checked.expires : c.expires;
  const daysLeft = typeof expires === "string" ? Math.ceil((Date.parse(`${expires}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
  const level = expiryLevel(daysLeft);
  const saved = daysSince(c.savedAt);
  const stale = staleWithoutExpiry(expires, c.savedAt);
  const levelBadge = level === "ok" ? { label: t("connections.expOk"), tone: "success" as const, icon: "check" as const }
    : level === "soon" ? { label: t("connections.expSoon"), tone: "warn" as const, icon: "clock" as const }
    : level === "critical" ? { label: t("connections.expCritical"), tone: "danger" as const, icon: "alert" as const }
    : level === "expired" ? { label: t("connections.expExpired"), tone: "danger" as const, icon: "x" as const }
    : null;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{labelOf(c)}</p>
        <Badge info={{ label: t("connections.connectedBadge", { source: SOURCE_KEYS[c.source] ? t(SOURCE_KEYS[c.source]!) : c.source }), tone: "success", icon: "check" }} />
      </div>
      {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
      {c.fingerprint ? <p className="mt-1 text-xs text-muted">{t("connections.fingerprint", { fp: c.fingerprint })}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className={`text-sm ${level === "critical" || level === "expired" ? "font-medium text-danger" : "text-muted"}`}>
          {expires === undefined ? t("connections.expiryUnknown") : expires === null ? t("connections.neverExpires") : t("connections.validUntil", { date: formatDate(expires), days: daysLabel(daysLeft) })}
        </p>
        {levelBadge ? <Badge info={levelBadge} /> : null}
      </div>
      {level === "expired" ? <div className="mt-2"><Notice tone="danger">{t("connections.expExpiredHint")}</Notice></div> : null}
      {saved !== null ? <p className="mt-1 text-xs text-muted">{saved === 0 ? t("connections.savedToday") : t("connections.savedDaysAgo", { count: saved })}</p> : null}
      {stale !== null ? <div className="mt-2"><Notice tone="warn">{t("connections.staleNoExpiry", { days: stale })}</Notice></div> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onGuide}>{t("connections.guide")}</Button>
        {c.source === "session" || c.source === "vault" ? <Button loading={disconnecting} onClick={onDisconnect}>{t("connections.disconnect")}</Button> : null}
      </div>
      <ConnectionDefaultsSummary id={c.id} />
      <ConnectionCheckPanel id={c.id} onResult={setChecked} />
    </Card>
  );
}

/** Chrome-Status, Profilordner, Rezepte und Probleme der Browser-Automatisierung. */
function BrowserAutomationSection({ q }: { q: { data: AutomationInfo | undefined; error: Error | null; loading: boolean; reload: () => void } }) {
  const t = useT();
  const a = q.data;
  return (
    <section className="mt-10" aria-labelledby="browser-automation-title">
      <h2 id="browser-automation-title" className="text-lg font-semibold tracking-tight">{t("connections.browserTitle")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("connections.browserSubtitle")}</p>
      {q.error ? <div className="mt-4"><ErrorState error={q.error} onRetry={q.reload} /></div> : null}
      {q.loading && !a ? <div className="mt-4"><ListSkeleton rows={1} /></div> : null}
      {a && !a.enabled ? <div className="mt-4"><Notice tone="info">{t("connections.browserOff")}</Notice></div> : null}
      {a && a.enabled ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <dl className="divide-y divide-line text-sm">
              <div className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-muted-text">{t("connections.browserChrome")}</dt><dd className="min-w-0 text-right font-medium">{a.chrome.found ? <><Badge info={{ label: t("connections.browserChromeFoundShort"), tone: "success", icon: "check" }} /><span className="mt-1 block break-all font-mono text-xs font-normal text-muted-text" title={a.chrome.path ?? ""}>{a.chrome.path ?? ""}</span></> : <Badge info={{ label: t("connections.browserChromeMissing"), tone: "warn", icon: "alert" }} />}</dd></div>
              {!a.chrome.found && a.chrome.hint ? <div className="py-2 text-xs text-muted">{a.chrome.hint}</div> : null}
              <div className="flex justify-between gap-4 py-2"><dt className="text-muted-text">{t("connections.browserProfile")}</dt><dd className="break-all text-right font-mono text-xs">{a.profileDir}</dd></div>
              <div className="flex justify-between gap-4 py-2"><dt className="text-muted-text">{t("connections.browserTimeout")}</dt><dd className="text-right font-medium">{t("connections.browserMinutes", { count: a.loginTimeoutMinutes })}</dd></div>
            </dl>
          </Card>
          <Card>
            <p className="text-sm font-medium">{t("connections.browserRecipes")}</p>
            <p className="mt-2 text-xs text-muted">{a.allowExternalRecipes ? t("connections.recipeExternalOn") : t("connections.recipeExternalOff")}</p>
            {a.recipes.length === 0 ? <p className="mt-2 text-sm text-muted">{t("connections.browserNoRecipes")}</p> : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {a.recipes.map((r) => (
                  <li key={r.providerId} className="py-2">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{r.label} <span className="font-mono text-xs font-normal text-muted">{r.providerId}</span> <Badge info={r.bundled ? { label: t("connections.recipeBundled"), tone: "success", icon: "shield" } : { label: t("connections.recipeExternal"), tone: "warn", icon: "alert" }} /></p>
                    <p className="text-xs text-muted">{r.host}: {r.status}</p>
                    <p className="text-xs text-muted">{t("connections.recipeHosts", { hosts: r.allowHosts.length > 0 ? r.allowHosts.join(", ") : t("connections.recipeHostsNone") })}</p>
                    <p className="font-mono text-xs text-muted" title={t("connections.recipeShaTitle", { sha: r.sha256 })}>{t("connections.recipeSha", { sha: shortHash(r.sha256) })}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="md:col-span-2">
            <p className="text-sm font-medium">{t("connections.browserProblems")}</p>
            {a.problems.length === 0 ? <p className="mt-2 text-sm text-muted">{t("connections.browserNoProblems")}</p> : (
              <ul className="mt-2 space-y-2 text-sm">
                {a.problems.map((p, i) => <li key={i}><Notice tone="warn"><span className="font-mono text-xs">{p.file}</span><br />{p.message}</Notice></li>)}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </section>
  );
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Setzt die Laufzeit im Anbieter-Link, falls dieser expires_in kennt (GitHub: 1 bis 366 Tage oder none). */
function withExpiry(url: string, days: number | null): string {
  const u = new URL(url);
  if (!u.searchParams.has("expires_in")) return url;
  u.searchParams.set("expires_in", days === null ? "none" : String(Math.min(366, days)));
  return u.toString();
}

const labelOf = (c: Connection) => c.label || NAMES[c.id] || c.id;

function IntegrationPicker({ initial, conns, provs, onClose, onChanged, onNewProvider }: { initial: string | null; conns: Connection[]; provs: Provider[]; onClose: () => void; onChanged: () => void; onNewProvider: () => void }) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(initial);
  const [q, setQ] = useState("");
  const manual = provs.filter((p) => p.kind === "manual" && p.guide);
  const sel = selected ? (conns.find((c) => c.id === selected) ?? null) : null;
  const selProv = selected?.startsWith("provider:") ? (manual.find((p) => `provider:${p.id}` === selected) ?? null) : null;
  const needle = q.trim().toLowerCase();
  const connItems = conns.filter((c) => !needle || `${labelOf(c)} ${c.description ?? ""} ${c.id}`.toLowerCase().includes(needle));
  const provItems = manual.filter((p) => !needle || `${p.label} ${p.id}`.toLowerCase().includes(needle));

  if (sel || selProv) {
    return (
      <Dialog title={sel ? labelOf(sel) : selProv!.label} onClose={onClose} wide>
        <button type="button" onClick={() => setSelected(null)} className="mb-4 inline-flex items-center gap-1 text-sm text-primary">{t("connections.back")}</button>
        {sel ? <ConnectionDetail c={sel} onChanged={onChanged} onDone={onClose} /> : <ProviderDetail p={selProv!} />}
      </Dialog>
    );
  }
  return (
    <Dialog title={t("connections.add")} description={t("connections.pickDesc")} onClose={onClose}>
      <input type="search" autoComplete="off" placeholder={t("connections.search")} aria-label={t("connections.search")} data-autofocus value={q} onChange={(e) => setQ(e.target.value)} className={`${inputClass} mb-4`} />
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t("connections.withConnection")}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {connItems.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setSelected(c.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-page">
              <span><span className="block text-sm font-medium">{labelOf(c)}</span>{c.description ? <span className="block text-xs text-muted">{c.description}</span> : null}</span>
              {c.connected ? <span className="shrink-0 text-xs text-success">{t("connections.connected")}</span> : <Icon name="plug" className="h-4 w-4 shrink-0 text-muted" />}
            </button>
          </li>
        ))}
        {connItems.length === 0 ? <li className="px-4 py-3 text-sm text-muted">{t("connections.noMatches")}</li> : null}
      </ul>
      <p className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted">{t("connections.noApi")}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {provItems.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => setSelected(`provider:${p.id}`)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-page">
              <span className="font-medium">{p.label}</span><Icon name="external" className="h-4 w-4 shrink-0 text-muted" />
            </button>
          </li>
        ))}
        {provItems.length === 0 ? <li className="px-4 py-3 text-sm text-muted">{t("connections.noMatches")}</li> : null}
      </ul>
      <button type="button" onClick={onNewProvider} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary"><Icon name="plus" className="h-4 w-4" />{t("connections.addCustom")}</button>
    </Dialog>
  );
}

function ProviderDetail({ p }: { p: Provider }) {
  const t = useT();
  return (
    <div className="text-sm">
      <a href={p.guide!.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline">{t("connections.openProvider")}<Icon name="external" className="h-3.5 w-3.5" /></a>
      {p.guide!.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{p.guide!.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      <p className="mt-4 text-xs text-muted">{t("connections.providerHint")}</p>
    </div>
  );
}

function ConnectionDetail({ c, onChanged, onDone }: { c: Connection; onChanged: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [preset, setPreset] = useState("90");
  const [custom, setCustom] = useState("");
  const [remember, setRemember] = useState(Boolean(c.canRemember));
  // Nach dem Verbinden bleibt der Dialog offen: Test, entdeckte Ressourcen und Standardwerte.
  const [connectedNow, setConnectedNow] = useState(false);
  const set = useMutation(async (body: unknown) => api<Connection>("POST", `connections/${enc(c.id)}/token`, body));
  const name = labelOf(c);
  const today = new Date().toISOString().slice(0, 10);
  const never = preset === "never";
  const expires = never ? "" : preset === "custom" ? custom : addDays(today, Number(preset));
  const days = never ? null : Math.max(1, Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  const link = c.openUrl ? withExpiry(c.openUrl, days) : null;
  const mismatch = stripePrefixMismatch(c.id, value);
  const valid = Boolean(value) && !mismatch && (never || (expires !== "" && expires >= today));
  const submit = async () => {
    const v = value;
    if (!valid) return;
    setValue("");
    if (await set.run({ token: v, ...(remember ? { remember: true } : {}), ...(never ? { neverExpires: true } : { expires }) })) {
      toast.success(t(remember ? "connections.connectedVault" : "connections.connectedSession", { name }));
      onChanged();
      setConnectedNow(true);
    }
  };
  if (connectedNow) {
    return (
      <div className="space-y-4 text-sm">
        <Notice tone="success">{t("params.conn.afterConnect")}</Notice>
        <ConnectionCheckPanel id={c.id} onResult={() => undefined} />
        <ConnectionResourcesPanel id={c.id} />
        <div className="flex justify-end"><Button variant="primary" onClick={onDone}>{t("params.conn.done")}</Button></div>
      </div>
    );
  }
  return (
    <div className="text-sm">
      {c.description ? <p className="text-muted">{c.description}</p> : null}
      <div className="mt-4 grid gap-3 rounded-xl bg-page p-4 sm:grid-cols-2">
        <SelectField label={t("connections.step1")} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{t("connections.days", { count: d })}</option>)}
          <option value="custom">{t("connections.customDate")}</option>
          <option value="never">{t("connections.neverExpires")}</option>
        </SelectField>
        {preset === "custom" ? (
          <div className="space-y-1">
            <label htmlFor={`exp-${c.id}`} className="block text-sm font-medium">{t("connections.validUntilLabel")}</label>
            <input id={`exp-${c.id}`} type="date" min={today} value={custom} onChange={(e) => setCustom(e.target.value)} className={inputClass} />
          </div>
        ) : (
          <p className="self-end pb-2 text-sm text-muted">{never ? t("connections.noExpiryNotRecommended") : t("connections.validUntilShort", { date: formatDate(expires) })}</p>
        )}
        <p className="text-xs text-muted sm:col-span-2">{t("connections.expiryHint")}</p>
      </div>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 font-medium text-primary underline">
          {c.openUrl !== c.url ? t("connections.step2Prefilled") : t("connections.step2")}<Icon name="external" className="h-3.5 w-3.5" />
        </a>
      ) : null}
      {c.permissions.length > 0 ? <ul className="mt-3 flex flex-wrap gap-1.5">{c.permissions.map((r) => <li key={r} className="rounded-full bg-page px-2.5 py-0.5 text-xs text-muted">{r}</li>)}</ul> : null}
      {c.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      {!c.connected && c.hint ? <p className="mt-3 text-xs text-muted">{c.hint}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-5 space-y-2 border-t border-line pt-5">
        <label htmlFor={`tok-${c.id}`} className="block font-medium">{t("connections.step3")}</label>
        <input id={`tok-${c.id}`} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} font-mono`} />
        {mismatch ? <Notice tone="warn">{t(mismatch === "live" ? "connections.prefixLive" : "connections.prefixTest")}</Notice> : null}
        <p className="text-xs text-muted">{t("connections.memoryOnly")}</p>
        {c.canRemember ? (
          <div className="pt-1">
            <Checkbox checked={remember} onChange={setRemember}>{t("connections.remember")}</Checkbox>
            <p className="ml-8 mt-1 text-xs text-muted">{t("connections.rememberHint")}</p>
          </div>
        ) : null}
        {set.error ? <Notice tone="danger">{set.error.message}</Notice> : null}
        <Button type="submit" variant="primary" loading={set.pending} disabled={!valid}>{t("connections.connect")}</Button>
      </form>
    </div>
  );
}

function AddProviderDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const toast = useToast();
  const [f, setF] = useState({ id: "", label: "", url: "", steps: "" });
  const [localError, setLocalError] = useState<string | null>(null);
  const add = useMutation(async (body: unknown) => api<{ id: string; label: string }>("POST", "providers", body));
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const submit = async () => {
    setLocalError(null);
    if (!SLUG.test(f.id.trim())) return setLocalError(t("connections.slugError"));
    try {
      new URL(f.url.trim());
    } catch {
      return setLocalError(t("connections.urlError"));
    }
    const res = await add.run({ id: f.id.trim(), label: f.label.trim(), url: f.url.trim(), steps: f.steps.split("\n").map((s) => s.trim()).filter(Boolean) });
    if (res) {
      toast.success(t("connections.providerAdded", { label: res.label }));
      onAdded();
    }
  };
  return (
    <Dialog title={t("connections.addProviderTitle")} description={t("connections.addProviderDesc")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <TextField label={t("connections.fieldName")} required value={f.label} onChange={(e) => set("label", e.target.value)} autoComplete="off" data-autofocus />
        <TextField label={t("connections.fieldId")} hint={t("connections.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" />
        <TextField label={t("connections.fieldUrl")} hint={t("connections.fieldUrlHint")} required type="url" value={f.url} onChange={(e) => set("url", e.target.value)} autoComplete="off" />
        <TextAreaField label={t("connections.fieldSteps")} hint={t("connections.fieldStepsHint")} rows={5} value={f.steps} onChange={(e) => set("steps", e.target.value)} />
        {localError || add.error ? <Notice tone="danger">{localError ?? add.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("connections.cancel")}</Button>
          <Button type="submit" variant="primary" loading={add.pending} disabled={!f.label.trim() || !f.id.trim() || !f.url.trim()}>{t("connections.addProvider")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
