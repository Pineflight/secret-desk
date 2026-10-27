"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, SelectField, TextAreaField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate } from "@/lib/format";
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
  label: string;
  description: string | null;
  url: string | null;
  openUrl: string | null;
  steps: string[];
  permissions: string[];
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
const SOURCE_KEYS: Record<string, string> = { session: "connections.srcSession", env: "connections.srcEnv", op: "connections.srcOp", none: "connections.srcNone" };

export default function ConnectionsPage() {
  const t = useT();
  const toast = useToast();
  const [picking, setPicking] = useState<string | null | false>(false);
  const [adding, setAdding] = useState(false);
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
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
          <Card key={c.id}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">{labelOf(c)}</p>
              <Badge info={{ label: t("connections.connectedBadge", { source: SOURCE_KEYS[c.source] ? t(SOURCE_KEYS[c.source]!) : c.source }), tone: "success", icon: "check" }} />
            </div>
            {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
            <p className={`mt-2 text-sm ${c.daysLeft != null && c.daysLeft <= 7 ? "font-medium text-danger" : "text-muted"}`}>
              {c.expires === undefined ? t("connections.expiryUnknown") : c.expires === null ? t("connections.neverExpires") : t("connections.validUntil", { date: formatDate(c.expires), days: daysLabel(c.daysLeft ?? null) })}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => setPicking(c.id)}>{t("connections.guide")}</Button>
              {c.source === "session" ? <Button loading={del.pending} onClick={async () => { if (await del.run(c.id)) { toast.success(t("connections.disconnected", { name: labelOf(c) })); conns.reload(); } }}>{t("connections.disconnect")}</Button> : null}
            </div>
          </Card>
        ))}
      </div>
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
  const set = useMutation(async (body: unknown) => api<Connection>("POST", `connections/${enc(c.id)}/token`, body));
  const name = labelOf(c);
  const today = new Date().toISOString().slice(0, 10);
  const never = preset === "never";
  const expires = never ? "" : preset === "custom" ? custom : addDays(today, Number(preset));
  const days = never ? null : Math.max(1, Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  const link = c.openUrl ? withExpiry(c.openUrl, days) : null;
  const valid = Boolean(value) && (never || (expires !== "" && expires >= today));
  const submit = async () => {
    const v = value;
    if (!valid) return;
    setValue("");
    if (await set.run({ token: v, ...(never ? { neverExpires: true } : { expires }) })) {
      toast.success(t("connections.connectedSession", { name }));
      onChanged();
      onDone();
    }
  };
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
        <p className="text-xs text-muted">{t("connections.memoryOnly")}</p>
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
