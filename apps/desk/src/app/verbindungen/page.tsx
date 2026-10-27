"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, TextAreaField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

interface Connection {
  id: string;
  connected: boolean;
  source: "session" | "env" | "op" | "none" | string;
  hint?: string;
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
const SOURCES: Record<string, string> = { session: "Sitzung", env: "Umgebungsvariable", op: "1Password", none: "keine" };

export default function ConnectionsPage() {
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
        title="Integrationen"
        subtitle="Womit das Portal arbeiten darf. Zugangsdaten bleiben im Arbeitsspeicher und werden nie gespeichert."
        actions={<Button variant="primary" onClick={() => setPicking(null)}><Icon name="plus" className="h-4 w-4" />Integration hinzufügen</Button>}
      />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {conns.loading && !conns.data ? <ListSkeleton rows={2} /> : null}
      {conns.data && connected.length === 0 ? (
        <EmptyState title="Noch keine Integration verbunden" icon="plug">
          <Button variant="primary" onClick={() => setPicking(null)}>Integration hinzufügen</Button>
        </EmptyState>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {connected.map((c) => (
          <Card key={c.id}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">{labelOf(c)}</p>
              <Badge info={{ label: `Verbunden (${SOURCES[c.source] ?? c.source})`, tone: "success", icon: "check" }} />
            </div>
            {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => setPicking(c.id)}>Anleitung</Button>
              {c.source === "session" ? <Button loading={del.pending} onClick={async () => { if (await del.run(c.id)) { toast.success(`${labelOf(c)} getrennt.`); conns.reload(); } }}>Trennen</Button> : null}
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

const labelOf = (c: Connection) => c.label || NAMES[c.id] || c.id;

function IntegrationPicker({ initial, conns, provs, onClose, onChanged, onNewProvider }: { initial: string | null; conns: Connection[]; provs: Provider[]; onClose: () => void; onChanged: () => void; onNewProvider: () => void }) {
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
        <button type="button" onClick={() => setSelected(null)} className="mb-4 inline-flex items-center gap-1 text-sm text-primary">← Zurück zur Auswahl</button>
        {sel ? <ConnectionDetail c={sel} onChanged={onChanged} /> : <ProviderDetail p={selProv!} />}
      </Dialog>
    );
  }
  return (
    <Dialog title="Integration hinzufügen" description="Suche oder blättere. Verbundene Integrationen stehen danach auf der Seite." onClose={onClose}>
      <input type="search" autoComplete="off" placeholder="Integration suchen" aria-label="Integration suchen" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} className={`${inputClass} mb-4`} />
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Mit Verbindung</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {connItems.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setSelected(c.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-page">
              <span><span className="block text-sm font-medium">{labelOf(c)}</span>{c.description ? <span className="block text-xs text-muted">{c.description}</span> : null}</span>
              {c.connected ? <span className="shrink-0 text-xs text-success">Verbunden</span> : <Icon name="plug" className="h-4 w-4 shrink-0 text-muted" />}
            </button>
          </li>
        ))}
        {connItems.length === 0 ? <li className="px-4 py-3 text-sm text-muted">Keine Treffer.</li> : null}
      </ul>
      <p className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted">Anbieter ohne API (Wert von Hand)</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {provItems.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => setSelected(`provider:${p.id}`)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-page">
              <span className="font-medium">{p.label}</span><Icon name="external" className="h-4 w-4 shrink-0 text-muted" />
            </button>
          </li>
        ))}
        {provItems.length === 0 ? <li className="px-4 py-3 text-sm text-muted">Keine Treffer.</li> : null}
      </ul>
      <button type="button" onClick={onNewProvider} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary"><Icon name="plus" className="h-4 w-4" />Eigenen Anbieter anlegen</button>
    </Dialog>
  );
}

function ProviderDetail({ p }: { p: Provider }) {
  return (
    <div className="text-sm">
      <a href={p.guide!.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline">Seite des Anbieters öffnen<Icon name="external" className="h-3.5 w-3.5" /></a>
      {p.guide!.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{p.guide!.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      <p className="mt-4 text-xs text-muted">Der Wert wird an einem Secret mit diesem Anbieter eingefügt und dort geprüft.</p>
    </div>
  );
}

function ConnectionDetail({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const set = useMutation(async (v: string) => api<Connection>("POST", `connections/${enc(c.id)}/token`, { token: v }));
  const name = labelOf(c);
  const submit = async () => {
    const v = value;
    setValue("");
    if (!v) return;
    if (await set.run(v)) {
      toast.success(`${name} ist für diese Sitzung verbunden.`);
      onChanged();
    }
  };
  return (
    <div className="text-sm">
      {c.description ? <p className="text-muted">{c.description}</p> : null}
      {c.openUrl ? (
        <a href={c.openUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 font-medium text-primary underline">
          {c.openUrl !== c.url ? "Zugang anlegen (Felder sind vorausgefüllt)" : "Zugang beim Anbieter anlegen"}<Icon name="external" className="h-3.5 w-3.5" />
        </a>
      ) : null}
      {c.permissions.length > 0 ? <ul className="mt-3 flex flex-wrap gap-1.5">{c.permissions.map((r) => <li key={r} className="rounded-full bg-page px-2.5 py-0.5 text-xs text-muted">{r}</li>)}</ul> : null}
      {c.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      {!c.connected && c.hint ? <p className="mt-3 text-xs text-muted">{c.hint}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-5 space-y-2 border-t border-line pt-5">
        <label htmlFor={`tok-${c.id}`} className="block font-medium">Zugangsschlüssel für diese Sitzung eingeben</label>
        <input id={`tok-${c.id}`} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} font-mono`} />
        <p className="text-xs text-muted">Nur im Arbeitsspeicher, nie gespeichert.</p>
        {set.error ? <Notice tone="danger">{set.error.message}</Notice> : null}
        <Button type="submit" variant="primary" loading={set.pending} disabled={!value}>Verbinden</Button>
      </form>
    </div>
  );
}

function AddProviderDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ id: "", label: "", url: "", steps: "" });
  const [localError, setLocalError] = useState<string | null>(null);
  const add = useMutation(async (body: unknown) => api<{ id: string; label: string }>("POST", "providers", body));
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const submit = async () => {
    setLocalError(null);
    if (!SLUG.test(f.id.trim())) return setLocalError("Kennung: Kleinbuchstaben, Ziffern und Bindestriche.");
    try {
      new URL(f.url.trim());
    } catch {
      return setLocalError("Die Adresse ist keine gültige URL.");
    }
    const res = await add.run({ id: f.id.trim(), label: f.label.trim(), url: f.url.trim(), steps: f.steps.split("\n").map((s) => s.trim()).filter(Boolean) });
    if (res) {
      toast.success(`„${res.label}“ wurde ins Inventar eingetragen.`);
      onAdded();
    }
  };
  return (
    <Dialog title="Anbieter hinzufügen" description="Für Dienste ohne API: das Portal zeigt die Seite und die Schritte, der Wert wird von Hand eingefügt und geprüft. Die Änderung steht danach im Inventar und kann per Pull Request geteilt werden." onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <TextField label="Name" required value={f.label} onChange={(e) => set("label", e.target.value)} autoComplete="off" data-autofocus />
        <TextField label="Kennung" hint="Kleinbuchstaben und Bindestriche" required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" />
        <TextField label="Seite, auf der man den Zugang anlegt" hint="Link zur Token-Seite des Anbieters" required type="url" value={f.url} onChange={(e) => set("url", e.target.value)} autoComplete="off" />
        <TextAreaField label="Schritte" hint="Ein Schritt pro Zeile, in der Reihenfolge des Anlegens" rows={5} value={f.steps} onChange={(e) => set("steps", e.target.value)} />
        {localError || add.error ? <Notice tone="danger">{localError ?? add.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" loading={add.pending} disabled={!f.label.trim() || !f.id.trim() || !f.url.trim()}>Hinzufügen</Button>
        </div>
      </form>
    </Dialog>
  );
}
