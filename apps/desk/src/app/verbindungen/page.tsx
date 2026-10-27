"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, SectionLabel, ProviderChip, TextAreaField, TextField } from "@/components/ui";
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
  const [adding, setAdding] = useState(false);
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
  return (
    <>
      <PageHeader title="Integrationen" subtitle="Womit das Portal arbeiten darf. Zugangsdaten bleiben im Arbeitsspeicher und werden nie gespeichert." />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {conns.loading && !conns.data ? <ListSkeleton /> : null}
      {conns.data && conns.data.length === 0 ? <EmptyState title="Keine Verbindungen" icon="plug" /> : null}
      <div className="grid gap-4 md:grid-cols-2">{(conns.data ?? []).map((c) => <ConnectionCard key={c.id} c={c} onChanged={conns.reload} />)}</div>

      <Card className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Anbieter</SectionLabel>
          <Button onClick={() => setAdding(true)}><Icon name="plus" className="h-4 w-4" />Anbieter hinzufügen</Button>
        </div>
        <p className="mt-1 text-xs text-muted">Weitere Anbieter stehen im Inventar (<code>providers:</code>) und gehen wie alles andere per Pull Request ins Repo, damit auch andere sie ergänzen können.</p>
        {provs.error ? <div className="mt-3"><ErrorState error={provs.error} onRetry={provs.reload} /></div> : null}
        {provs.loading && !provs.data ? <div className="mt-3"><ListSkeleton rows={3} /></div> : null}
        <ul className="mt-3 divide-y divide-line">
          {(provs.data ?? []).map((p) => (
            <li key={p.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.label}</span><ProviderChip automatic={p.kind === "automatic"} />{p.connection ? <span className="text-xs text-muted">Verbindung: {NAMES[p.connection] ?? p.connection}</span> : null}</div>
              {p.guide ? (
                <div className="mt-1">
                  <a href={p.guide.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">Seite des Anbieters öffnen<Icon name="external" className="h-3.5 w-3.5" /></a>
                  {p.guide.steps.length > 0 ? <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">{p.guide.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {adding ? <AddProviderDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); provs.reload(); }} /> : null}
    </>
  );
}

function ConnectionCard({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const set = useMutation(async (v: string) => api<Connection>("POST", `connections/${enc(c.id)}/token`, { token: v }));
  const del = useMutation(async () => api<Connection>("DELETE", `connections/${enc(c.id)}/token`));
  const name = c.label || NAMES[c.id] || c.id;
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
    <Card>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{name}</p>
        <Badge info={c.connected ? { label: `Verbunden (${SOURCES[c.source] ?? c.source})`, tone: "success", icon: "check" } : { label: "Nicht verbunden", tone: "neutral", icon: "plug" }} />
      </div>
      {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
      {c.openUrl ? (
        <a href={c.openUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary underline">
          {c.openUrl !== c.url ? "Zugang anlegen (Felder sind vorausgefüllt)" : "Zugang beim Anbieter anlegen"}<Icon name="external" className="h-3.5 w-3.5" />
        </a>
      ) : null}
      {c.permissions.length > 0 ? <ul className="mt-2 flex flex-wrap gap-1.5">{c.permissions.map((r) => <li key={r} className="rounded-full bg-page px-2.5 py-0.5 text-xs text-muted">{r}</li>)}</ul> : null}
      {c.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      {!c.connected && c.hint ? <p className="mt-3 text-xs text-muted">{c.hint}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-4 space-y-2">
        <label htmlFor={`tok-${c.id}`} className="block text-sm font-medium">Zugangsschlüssel für diese Sitzung eingeben</label>
        <input id={`tok-${c.id}`} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className="w-full rounded-xl border border-line bg-card px-3 py-2 font-mono text-sm" />
        <p className="text-xs text-muted">Nur im Arbeitsspeicher, nie gespeichert.</p>
        {set.error || del.error ? <Notice tone="danger">{(set.error ?? del.error)?.message}</Notice> : null}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={set.pending} disabled={!value}>Verbinden</Button>
          {c.source === "session" && c.connected ? <Button loading={del.pending} onClick={async () => { if (await del.run()) { toast.success(`${name} getrennt.`); onChanged(); } }}>Trennen</Button> : null}
        </div>
      </form>
    </Card>
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
