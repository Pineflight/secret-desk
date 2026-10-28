"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { SecretView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { MetaFields, TagPills, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { FilterRow, LIST_CELL_CLASS, LIST_ROW_CLASS, ListTable, TagFilterChip } from "@/components/ListTable";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Button, EmptyState, ErrorState, ListSkeleton, Notice, Pill, PageHeader, ProviderChip, SelectField, StageBadge, StatusBadge, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate, placeText } from "@/lib/format";
import { truncate } from "@/lib/tags";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { statusInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { usePersistedState } from "@/lib/persisted-state";
import { useStageDefs } from "@/lib/use-stages";
import { prefillRow, readPrefill, withoutPrefill, type Prefill } from "@/lib/prefill";
import { defaultStageId, environmentOf, kindOf, labelOf, stageOrder } from "@/lib/stages";

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  browser?: boolean;
}

const STATUSES = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;

export default function SecretsPage() {
  const t = useT();
  const defs = useStageDefs();
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
  // Filter bleiben beim Wechsel in einen Eintrag und zurueck erhalten (Browser-Sitzung).
  const [stage, setStage] = usePersistedState("secrets.stage", "");
  const [status, setStatus] = usePersistedState("secrets.status", "");
  const [kind, setKind] = usePersistedState("secrets.kind", "");
  const [browse, setBrowse] = usePersistedState<BrowseState>("secrets.browse", BROWSE_DEFAULT);
  // Link von der Repositories-Seite: /secrets?repo=<name> setzt den Repository-Filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
  const [live, setLive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  useEffect(() => {
    if (params.get("neu") === "1") {
      setPrefill(readPrefill(params));
      setCreating(true);
      const next = withoutPrefill(params);
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
    () => sortItems((secrets.data ?? []).filter((s) => (kind === "" || (kind === "auto" ? s.automatic : !s.automatic)) && (browse.repo === "" || repoNames(s.places).includes(browse.repo))), browse.sort, stageOrder(defs)),
    [secrets.data, kind, browse.repo, browse.sort, defs],
  );
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group, stageOrder(defs), (id) => labelOf(defs, id)) : []), [rows, browse.group, defs]);

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

      <FilterRow>
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("secrets.stage")} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
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
      </FilterRow>

      <TagFilterChip tag={tag} label={t("secrets.filteredByTag")} removeLabel={t("secrets.removeFilter", { tag })} onClear={() => setTag("")} />
      {secrets.error ? <ErrorState error={secrets.error} onRetry={secrets.reload} /> : null}
      {secrets.loading && !secrets.data ? <ListSkeleton rows={6} /> : null}
      {secrets.data && rows.length === 0 ? (
        <EmptyState title={t("secrets.emptyTitle")} icon="key">{q || tag || stage || status || kind || browse.repo ? t("secrets.emptyFiltered") : t("secrets.emptyFirst")}</EmptyState>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <ListTable columns={[t("secrets.colName"), t("secrets.colStage"), t("secrets.colProvider"), t("secrets.colExpiry"), t("secrets.colTargets"), t("secrets.colConfirmed")]}>
                {g.items.map((s) => (
                  <tr key={s.id} className={LIST_ROW_CLASS}>
                    <td className={LIST_CELL_CLASS}>
                      <Link href={`/secrets/${enc(s.id)}`} className="font-medium text-primary hover:underline">{s.name}</Link>
                      <p className="text-xs text-muted">{s.id}</p>
                      {s.description ? <p className="mt-1 max-w-xs truncate text-xs text-muted-text" title={s.description}>{truncate(s.description, 90)}</p> : null}
                      {s.tags.length > 0 ? <div className="mt-1"><TagPills tags={s.tags} onPick={setTag} active={tag} /></div> : null}
                    </td>
                    <td className={LIST_CELL_CLASS}><StageBadge stage={s.stage} /></td>
                    <td className={LIST_CELL_CLASS}><ProviderChip automatic={s.automatic} browser={s.browser} /></td>
                    <td className={LIST_CELL_CLASS}>
                      <div className="tabular">{formatDate(s.expires)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge level={s.status} /><span className="tabular text-xs text-muted-text">{daysLabel(s.daysLeft)}</span></div>
                    </td>
                    <td className={LIST_CELL_CLASS}>
                      <div className="flex flex-wrap gap-1">{s.places.length ? s.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>
                    </td>
                    <td className={`${LIST_CELL_CLASS} text-xs text-muted-text`}>{s.verifiedAt ? <><span className="tabular">{formatDate(s.verifiedAt)}</span><br />{s.verifiedBy ?? ""}</> : t("secrets.never")}</td>
                  </tr>
                ))}
          </ListTable>
        </div>
      ))}

      {creating ? <CreateSecretDialog initial={prefill} onClose={() => { setCreating(false); setPrefill(null); }} onCreated={() => { setCreating(false); setPrefill(null); secrets.reload(); }} /> : null}
    </>
  );
}

function CreateSecretDialog({ initial = null, onClose, onCreated }: { initial?: Prefill | null; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const defs = useStageDefs();
  const toast = useToast();
  const providers = useQuery<ProviderRow[]>("providers", () => api<ProviderRow[]>("GET", "providers"));
  const [f, setF] = useState({ id: initial?.id ?? "", name: initial?.name ?? "", title: "", product: "", stage: initial?.stage ?? "", service: initial ? "github-actions" : "", provider: "manual", expiry: "unknown", expires: "", ttlDays: "" });
  const [rows, setRows] = useState<PlaceRow[]>([initial ? prefillRow(defs, initial) : emptyPlaceRow()]);
  const [meta, setMeta] = useState<MetaValues>({ description: initial?.description ?? "", owner: "", link: "", tags: [] });
  const [localError, setLocalError] = useState<string | null>(null);
  const stageId = f.stage || defaultStageId(defs, "test");
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const create = useMutation(async (body: unknown) => api<SecretView>("POST", "secrets", body));

  const submit = async () => {
    setLocalError(null);
    const { places, error } = rowsToPlaces(rows, { stage: stageId, environment: environmentOf(defs, stageId) });
    if (error) return setLocalError(error);
    const metaError = validateMeta(meta);
    if (metaError) return setLocalError(metaError);
    if (kindOf(defs, stageId) !== "dev" && places.length === 0) return setLocalError(t("secrets.needTarget"));
    const ttl = f.ttlDays.trim() ? Number(f.ttlDays) : undefined;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) return setLocalError(t("secrets.ttlInvalid"));
    const res = await create.run({
      id: f.id.trim(),
      name: f.name.trim(),
      stage: stageId,
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
          <SelectField label={t("secrets.stage")} value={stageId} onChange={(e) => set("stage", e.target.value)}>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectField>
          <TextField label={t("secrets.fieldService")} hint={t("secrets.fieldServiceHint")} required value={f.service} onChange={(e) => set("service", e.target.value)} />
          <SelectField label={t("secrets.provider")} value={f.provider} onChange={(e) => set("provider", e.target.value)}>
            <option value="manual">{t("secrets.providerManual")}</option>
            {(providers.data ?? []).filter((p) => p.id !== "manual").map((p) => <option key={p.id} value={p.id}>{p.browser ? p.label : `${p.label} (${p.kind === "automatic" ? t("secrets.providerKindAuto") : t("secrets.providerKindManual")})`}</option>)}
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
        <PlacesEditor rows={rows} onChange={setRows} stage={stageId} />
        {kindOf(defs, stageId) === "dev" ? <p className="text-xs text-muted">{t("secrets.devNoTarget")}</p> : null}
        {localError || create.error ? <Notice tone="danger">{localError ?? create.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("secrets.cancel")}</Button>
          <Button type="submit" variant="primary" loading={create.pending}>{t("secrets.create")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
