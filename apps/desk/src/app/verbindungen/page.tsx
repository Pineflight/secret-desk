"use client";
import { useState } from "react";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, SectionLabel, ProviderChip } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

interface Connection {
  id: string;
  connected: boolean;
  source: "session" | "env" | "op" | "none" | string;
  hint?: string;
}
interface Provider {
  id: string;
  label: string;
  kind: string;
  connection: string | null;
  guide: { url: string; steps: string[] } | null;
}

const NAMES: Record<string, string> = { github: "GitHub", cloudflare: "Cloudflare", supabase: "Supabase", stripe: "Stripe", resend: "Resend", grafana: "Grafana" };
const SOURCES: Record<string, string> = { session: "Sitzung", env: "Umgebungsvariable", op: "1Password", none: "keine" };

export default function ConnectionsPage() {
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
  return (
    <>
      <PageHeader title="Verbindungen" subtitle="Womit das Portal arbeiten darf. Zugangsdaten bleiben im Arbeitsspeicher und werden nie gespeichert." />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {conns.loading && !conns.data ? <ListSkeleton /> : null}
      {conns.data && conns.data.length === 0 ? <EmptyState title="Keine Verbindungen" icon="plug" /> : null}
      <div className="grid gap-4 md:grid-cols-2">{(conns.data ?? []).map((c) => <ConnectionCard key={c.id} c={c} onChanged={conns.reload} />)}</div>

      <Card className="mt-8">
        <SectionLabel>Anbieter</SectionLabel>
        {provs.error ? <div className="mt-3"><ErrorState error={provs.error} onRetry={provs.reload} /></div> : null}
        {provs.loading && !provs.data ? <div className="mt-3"><ListSkeleton rows={3} /></div> : null}
        <ul className="mt-3 divide-y divide-line">
          {(provs.data ?? []).map((p) => (
            <li key={p.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.label}</span><ProviderChip automatic={p.kind === "automatic"} />{p.connection ? <span className="text-xs text-muted">Verbindung: {NAMES[p.connection] ?? p.connection}</span> : null}</div>
              {p.guide ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-primary">Anleitung</summary>
                  <a href={p.guide.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-primary underline">Seite des Anbieters öffnen<Icon name="external" className="h-3.5 w-3.5" /></a>
                  {p.guide.steps.length > 0 ? <ol className="mt-2 list-decimal space-y-1 pl-5">{p.guide.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function ConnectionCard({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const set = useMutation(async (v: string) => api<Connection>("POST", `connections/${enc(c.id)}/token`, { token: v }));
  const del = useMutation(async () => api<Connection>("DELETE", `connections/${enc(c.id)}/token`));
  const name = NAMES[c.id] ?? c.id;
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
      {!c.connected && c.hint ? <p className="mt-1 text-xs text-muted">{c.hint}</p> : null}
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
