"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { SecretView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { MetaFields, TagPills, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, type BrowseState } from "@/components/BrowseControls";
import { allProducts, allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Pill, PageHeader, ProviderChip, SelectField, StageBadge, StatusBadge, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate, placeText } from "@/lib/format";
import { truncate } from "@/lib/tags";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { statusInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
}

const STATUSES = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;

export default function SecretsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const setTag = (t: string) => {
    const next = new URLSearchParams(params.toString());
    if (t) next.set("tag", t);
    else next.delete("tag");
    router.replace(next.toString() ? `/secrets?${next}` : "/secrets");
  };
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [browse, setBrowse] = useState<BrowseState>(BROWSE_DEFAULT);
  const [live, setLive] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (params.get("neu") === "1") {
      setCreating(true);
      const next = new URLSearchParams(params.toString());
      next.delete("neu");
      router.replace(next.toString() ? `/secrets?${next}` : "/secrets");
    }
  }, [params, router]);

  const qs = new URLSearchParams();
  if (stage) qs.set("stage", stage);
  if (status) qs.set("status", status);
  if (live) qs.set("live", "1");
  if (q.trim()) qs.set("q", q.trim());
  if (tag) qs.set("tag", tag);
  const secrets = useQuery<SecretView[]>(`secrets?${qs}`, () => api<SecretView[]>("GET", `secrets?${qs}`));

  const repos = useMemo(() => allRepos(secrets.data ?? []), [secrets.data]);
  const products = useMemo(() => allProducts(secrets.data ?? []), [secrets.data]);
  const rows = useMemo(
    () => sortItems((secrets.data ?? []).filter((s) => (kind === "" || (kind === "auto" ? s.automatic : !s.automatic)) && (browse.repo === "" || repoNames(s.places).includes(browse.repo)) && (browse.product === "" || s.product === browse.product)), browse.sort),
    [secrets.data, kind, browse.repo, browse.product, browse.sort],
  );
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group) : []), [rows, browse.group]);

  return (
    <>
      <PageHeader
        title="Secrets"
        subtitle="Nur Metadaten: Die Werte selbst liegen nie hier."
        actions={
          <>
            <Button variant="secondary" loading={secrets.loading && live} onClick={() => (live ? secrets.reload() : setLive(true))}>
              <Icon name="refresh" />Mit GitHub abgleichen
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" />Neuer Eintrag</Button>
          </>
        }
      />
      {live ? <div className="mb-4"><Notice tone="info">Die Stände wurden live mit GitHub abgeglichen. Fehlt ein Secret dort, steht „Fehlt in GitHub“.</Notice></div> : null}

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="w-40">
          <SelectField label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Alle</option>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
        </div>
        <div className="w-48">
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Alle</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusInfo(s).label}</option>)}
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField label="Anbieter" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Alle</option>
            <option value="auto">automatisch</option>
            <option value="manual">von Hand</option>
          </SelectField>
        </div>
        <BrowseControls value={browse} onChange={setBrowse} repos={repos} products={products} />
      </div>

      {tag ? (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-muted-text">Gefiltert nach Schlagwort</span>
          <button type="button" onClick={() => setTag("")} aria-label={`Filter ${tag} entfernen`} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2.5 py-0.5 text-xs font-medium text-primary">#{tag}<Icon name="x" className="h-3 w-3" /></button>
        </div>
      ) : null}
      {secrets.error ? <ErrorState error={secrets.error} onRetry={secrets.reload} /> : null}
      {secrets.loading && !secrets.data ? <ListSkeleton rows={6} /> : null}
      {secrets.data && rows.length === 0 ? (
        <EmptyState title="Keine Einträge gefunden" icon="key">{q || tag || stage || status || kind || browse.repo || browse.product ? "Mit diesen Filtern gibt es keinen Treffer." : "Lege den ersten Eintrag mit „Neuer Eintrag“ an."}</EmptyState>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <Card className="overflow-x-auto !p-0">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Stage</th>
                  <th className="px-4 py-3 font-semibold">Anbieter</th>
                  <th className="px-4 py-3 font-semibold">Ablauf</th>
                  <th className="px-4 py-3 font-semibold">Ziele</th>
                  <th className="px-4 py-3 font-semibold">Bestätigt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {g.items.map((s) => (
                  <tr key={s.id} className="align-top hover:bg-page">
                    <td className="px-4 py-3">
                      <Link href={`/secrets/${enc(s.id)}`} className="font-medium text-primary hover:underline">{s.name}</Link>
                      <p className="text-xs text-muted">{s.id}</p>
                      {s.description ? <p className="mt-1 max-w-xs truncate text-xs text-muted-text" title={s.description}>{truncate(s.description, 90)}</p> : null}
                      {s.tags.length > 0 ? <div className="mt-1"><TagPills tags={s.tags} onPick={setTag} active={tag} /></div> : null}
                    </td>
                    <td className="px-4 py-3"><StageBadge stage={s.stage} /></td>
                    <td className="px-4 py-3"><ProviderChip automatic={s.automatic} /></td>
                    <td className="px-4 py-3">
                      <div className="tabular">{formatDate(s.expires)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge level={s.status} /><span className="tabular text-xs text-muted-text">{daysLabel(s.daysLeft)}</span></div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">{s.places.length ? s.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-text">{s.verifiedAt ? <><span className="tabular">{formatDate(s.verifiedAt)}</span><br />{s.verifiedBy ?? ""}</> : "noch nie"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ))}

      {creating ? <CreateSecretDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); secrets.reload(); }} /> : null}
    </>
  );
}

function CreateSecretDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const providers = useQuery<ProviderRow[]>("providers", () => api<ProviderRow[]>("GET", "providers"));
  const [f, setF] = useState({ id: "", name: "", title: "", product: "", stage: "staging", service: "", provider: "manual", expiry: "unknown", expires: "", ttlDays: "" });
  const [rows, setRows] = useState<PlaceRow[]>([emptyPlaceRow()]);
  const [meta, setMeta] = useState<MetaValues>({ description: "", owner: "", link: "", tags: [] });
  const [localError, setLocalError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const create = useMutation(async (body: unknown) => api<SecretView>("POST", "secrets", body));

  const submit = async () => {
    setLocalError(null);
    const { places, error } = rowsToPlaces(rows);
    if (error) return setLocalError(error);
    const metaError = validateMeta(meta);
    if (metaError) return setLocalError(metaError);
    if (f.stage !== "dev" && places.length === 0) return setLocalError("Für staging, production und shared braucht der Eintrag mindestens ein Ziel. Nur dev darf ohne Ziel sein.");
    const ttl = f.ttlDays.trim() ? Number(f.ttlDays) : undefined;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) return setLocalError("Die Gültigkeit in Tagen muss eine ganze Zahl über 0 sein.");
    const res = await create.run({
      id: f.id.trim(),
      name: f.name.trim(),
      stage: f.stage,
      service: f.service.trim(),
      provider: f.provider,
      expiry: f.expiry,
      ...(f.title.trim() ? { title: f.title.trim() } : {}),
      ...(f.product.trim() ? { product: f.product.trim() } : {}),
      ...(f.expires && f.expiry !== "none" ? { expires: f.expires } : {}),
      ...(ttl !== undefined ? { ttlDays: ttl } : {}),
      places,
      ...metaBody(meta),
    });
    if (res) {
      toast.success(`„${res.name}“ wurde angelegt.`);
      onCreated();
    }
  };

  return (
    <Dialog title="Neuer Eintrag" description="Es wird nur beschrieben, wo ein Secret liegt. Einen Wert gibst du später ein oder lässt ihn erzeugen." onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <MetaFields value={meta} onChange={setMeta} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Kennung" hint="Kleinbuchstaben und Bindestriche, zum Beispiel stripe-key-web" required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" data-autofocus />
          <TextField label="Name im Ziel" hint="GROSS_MIT_UNTERSTRICH" required value={f.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoComplete="off" />
          <TextField label="Bezeichnung (optional)" value={f.title} onChange={(e) => set("title", e.target.value)} />
          <TextField label="Produkt (optional)" value={f.product} onChange={(e) => set("product", e.target.value)} />
          <SelectField label="Stage" value={f.stage} onChange={(e) => set("stage", e.target.value)}>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
          <TextField label="Dienst" hint="zum Beispiel stripe, cloudflare, intern" required value={f.service} onChange={(e) => set("service", e.target.value)} />
          <SelectField label="Anbieter" value={f.provider} onChange={(e) => set("provider", e.target.value)}>
            <option value="manual">von Hand (manual)</option>
            {(providers.data ?? []).filter((p) => p.id !== "manual").map((p) => <option key={p.id} value={p.id}>{p.label} ({p.kind === "automatic" ? "automatisch" : "von Hand"})</option>)}
          </SelectField>
          <SelectField label="Ablauf" value={f.expiry} onChange={(e) => set("expiry", e.target.value)}>
            <option value="none">Läuft nie ab</option>
            <option value="possible">Kann ablaufen</option>
            <option value="required">Läuft immer ab</option>
            <option value="unknown">Unklar</option>
          </SelectField>
          <TextField label="Läuft ab am (optional)" type="date" disabled={f.expiry === "none"} value={f.expires} onChange={(e) => set("expires", e.target.value)} />
          <TextField label="Gültigkeit in Tagen (optional)" inputMode="numeric" value={f.ttlDays} onChange={(e) => set("ttlDays", e.target.value.replace(/\D/g, ""))} />
        </div>
        <PlacesEditor rows={rows} onChange={setRows} />
        {f.stage === "dev" ? <p className="text-xs text-muted">dev-Einträge dürfen ohne Ziel angelegt werden.</p> : null}
        {localError || create.error ? <Notice tone="danger">{localError ?? create.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" loading={create.pending}>Anlegen</Button>
        </div>
      </form>
    </Dialog>
  );
}
