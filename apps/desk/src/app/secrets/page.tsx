"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { SecretView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { MetaFields, TagPills, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Pill, PageHeader, ProviderChip, SelectField, StageBadge, StatusBadge, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate, placeText } from "@/lib/format";
import { truncate } from "@/lib/tags";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { statusInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  browser?: boolean;
}

const STATUSES = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;

export default function SecretsPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const setTag = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set("tag", v);
    else next.delete("tag");
    router.replace(next.toString() ? `/secrets?${next}` : "/secrets");
  };
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [browse, setBrowse] = useState<BrowseState>(BROWSE_DEFAULT);
  // Link von der Repositories-Seite: /secrets?repo=<name> setzt den Repository-Filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
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
  const rows = useMemo(
    () => sortItems((secrets.data ?? []).filter((s) => (kind === "" || (kind === "auto" ? s.automatic : !s.automatic)) && (browse.repo === "" || repoNames(s.places).includes(browse.repo))), browse.sort),
    [secrets.data, kind, browse.repo, browse.sort],
  );
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group) : []), [rows, browse.group]);

  return (
    <>
      <PageHeader
        title={t("secrets.title")}
        subtitle={t("secrets.subtitle")}
        actions={
          <>
            <Button variant="secondary" loading={secrets.loading && live} onClick={() => (live ? secrets.reload() : setLive(true))}>
              <Icon name="refresh" />{t("secrets.syncGithub")}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" />{t("secrets.newEntry")}</Button>
          </>
        }
      />
      {live ? <div className="mb-4"><Notice tone="info">{t("secrets.liveNotice")}</Notice></div> : null}

      <div className="mb-4 flex flex-wrap gap-3">
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("secrets.stage")} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
        </div>
        <div className="w-48">
          <SelectField label={t("secrets.status")} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusInfo(s).label}</option>)}
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField label={t("secrets.provider")} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            <option value="auto">{t("secrets.automatic")}</option>
            <option value="manual">{t("secrets.manual")}</option>
          </SelectField>
        </div>
        <BrowseControls value={browse} onChange={setBrowse} />
      </div>

      {tag ? (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-muted-text">{t("secrets.filteredByTag")}</span>
          <button type="button" onClick={() => setTag("")} aria-label={t("secrets.removeFilter", { tag })} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2.5 py-0.5 text-xs font-medium text-primary">#{tag}<Icon name="x" className="h-3 w-3" /></button>
        </div>
      ) : null}
      {secrets.error ? <ErrorState error={secrets.error} onRetry={secrets.reload} /> : null}
      {secrets.loading && !secrets.data ? <ListSkeleton rows={6} /> : null}
      {secrets.data && rows.length === 0 ? (
        <EmptyState title={t("secrets.emptyTitle")} icon="key">{q || tag || stage || status || kind || browse.repo ? t("secrets.emptyFiltered") : t("secrets.emptyFirst")}</EmptyState>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <Card className="overflow-x-auto !p-0">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-semibold">{t("secrets.colName")}</th>
                  <th className="px-4 py-3 font-semibold">{t("secrets.colStage")}</th>
                  <th className="px-4 py-3 font-semibold">{t("secrets.colProvider")}</th>
                  <th className="px-4 py-3 font-semibold">{t("secrets.colExpiry")}</th>
                  <th className="px-4 py-3 font-semibold">{t("secrets.colTargets")}</th>
                  <th className="px-4 py-3 font-semibold">{t("secrets.colConfirmed")}</th>
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
                    <td className="px-4 py-3"><ProviderChip automatic={s.automatic} browser={s.browser} /></td>
                    <td className="px-4 py-3">
                      <div className="tabular">{formatDate(s.expires)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge level={s.status} /><span className="tabular text-xs text-muted-text">{daysLabel(s.daysLeft)}</span></div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">{s.places.length ? s.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-text">{s.verifiedAt ? <><span className="tabular">{formatDate(s.verifiedAt)}</span><br />{s.verifiedBy ?? ""}</> : t("secrets.never")}</td>
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
  const t = useT();
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
    if (f.stage !== "dev" && places.length === 0) return setLocalError(t("secrets.needTarget"));
    const ttl = f.ttlDays.trim() ? Number(f.ttlDays) : undefined;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) return setLocalError(t("secrets.ttlInvalid"));
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
      toast.success(t("secrets.created", { name: res.name }));
      onCreated();
    }
  };

  return (
    <Dialog title={t("secrets.dialogTitle")} description={t("secrets.dialogDesc")} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <MetaFields value={meta} onChange={setMeta} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t("secrets.fieldId")} hint={t("secrets.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" data-autofocus />
          <TextField label={t("secrets.fieldName")} hint={t("secrets.fieldNameHint")} required value={f.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoComplete="off" />
          <TextField label={t("secrets.fieldTitle")} value={f.title} onChange={(e) => set("title", e.target.value)} />
          <TextField label={t("secrets.fieldProduct")} value={f.product} onChange={(e) => set("product", e.target.value)} />
          <SelectField label={t("secrets.stage")} value={f.stage} onChange={(e) => set("stage", e.target.value)}>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
          <TextField label={t("secrets.fieldService")} hint={t("secrets.fieldServiceHint")} required value={f.service} onChange={(e) => set("service", e.target.value)} />
          <SelectField label={t("secrets.provider")} value={f.provider} onChange={(e) => set("provider", e.target.value)}>
            <option value="manual">{t("secrets.providerManual")}</option>
            {(providers.data ?? []).filter((p) => p.id !== "manual").map((p) => <option key={p.id} value={p.id}>{p.label} ({p.browser ? t("secrets.providerKindBrowser") : p.kind === "automatic" ? t("secrets.providerKindAuto") : t("secrets.providerKindManual")})</option>)}
          </SelectField>
          <SelectField label={t("secrets.expiry")} value={f.expiry} onChange={(e) => set("expiry", e.target.value)}>
            <option value="none">{t("secrets.expNone")}</option>
            <option value="possible">{t("secrets.expPossible")}</option>
            <option value="required">{t("secrets.expRequired")}</option>
            <option value="unknown">{t("secrets.expUnknown")}</option>
          </SelectField>
          <TextField label={t("secrets.expiresOn")} type="date" disabled={f.expiry === "none"} value={f.expires} onChange={(e) => set("expires", e.target.value)} />
          <TextField label={t("secrets.ttlDays")} inputMode="numeric" value={f.ttlDays} onChange={(e) => set("ttlDays", e.target.value.replace(/\D/g, ""))} />
        </div>
        <PlacesEditor rows={rows} onChange={setRows} />
        {f.stage === "dev" ? <p className="text-xs text-muted">{t("secrets.devNoTarget")}</p> : null}
        {localError || create.error ? <Notice tone="danger">{localError ?? create.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("secrets.cancel")}</Button>
          <Button type="submit" variant="primary" loading={create.pending}>{t("secrets.create")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
