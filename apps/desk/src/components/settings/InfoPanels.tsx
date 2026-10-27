"use client";
import type { SettingsInfo } from "@secret-desk/runtime";
import { Badge, Card, ErrorState, ListSkeleton, Notice, SectionLabel } from "@/components/ui";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { LOCALES, LOCALE_NAMES, useI18n, useT } from "@/lib/i18n";
import { KIND_TONES, stageLook, type StageDefLite } from "@/lib/stages";
import { useStageDefs } from "@/lib/use-stages";

function useSettings() {
  return useQuery<SettingsInfo>("settings", () => api<SettingsInfo>("GET", "settings"));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-text">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

const Path = ({ children }: { children: string }) => <code className="break-all rounded bg-page px-1.5 py-0.5 font-mono text-xs">{children}</code>;

function Loading({ state }: { state: ReturnType<typeof useSettings> }) {
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return <ListSkeleton rows={4} />;
}

/** Richtlinie der Agenten (nur lesen): aufgeloeste Stages und Ordner fuer Env-Dateien. */
export function PolicyPanel() {
  const t = useT();
  const s = useSettings();
  const defs = useStageDefs();
  if (!s.data) return <Loading state={s} />;
  const d = s.data;
  const lite: StageDefLite[] = defs;
  return (
    <div className="space-y-4">
      <Notice tone="info">{t("settings.policy.where", { file: d.configFile })}</Notice>
      <Card>
        <SectionLabel>{t("settings.policy.title")}</SectionLabel>
        <dl className="mt-1 divide-y divide-line">
          <Row label={t("settings.policy.directTitle")}>
            {d.policy.agentStages.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">{d.policy.agentStages.map((id) => <Badge key={id} info={stageLook(lite, id)} />)}</div>
            ) : (
              <span className="text-muted-text">{t("settings.policy.noDirect")}</span>
            )}
            <p className="mt-2 text-xs text-muted">{d.policy.agentStagesSource === "policy" ? t("settings.policy.sourcePolicy") : t("settings.policy.sourceDefault")}</p>
          </Row>
          <Row label={t("settings.policy.envRoots")}>
            {d.policy.envRoots.length > 0 ? <ul className="space-y-1">{d.policy.envRoots.map((p) => <li key={p}><Path>{p}</Path></li>)}</ul> : <span className="text-muted-text">{t("settings.policy.envRootsNone")}</span>}
          </Row>
        </dl>
      </Card>
      <Card>
        <SectionLabel>{t("settings.policy.access")}</SectionLabel>
        <ul className="mt-2 divide-y divide-line">
          {d.stages.map((st) => (
            <li key={st.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="flex items-center gap-2">
                <Badge info={stageLook(lite, st.id)} />
                <span className="font-mono text-xs text-muted">{st.id}</span>
              </span>
              <span className="flex items-center gap-2 text-sm">
                <Badge info={{ label: t(`settings.kind.${st.kind}`), tone: KIND_TONES[st.kind], icon: "dot" }} />
                <span className={st.agentAccess === "direct" ? "text-success-text" : "text-muted-text"}>{st.agentAccess === "direct" ? t("settings.policy.direct") : t("settings.policy.approval")}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <SectionLabel>{t("settings.policy.rulesTitle")}</SectionLabel>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-text">
          {[1, 2, 3, 4].map((n) => <li key={n}>{t(`settings.policy.rule${n}`)}</li>)}
        </ul>
      </Card>
    </div>
  );
}

/** Tresor, Dateien und Browser-Automatisierung (nur lesen, nur Metadaten). */
export function StoragePanel() {
  const t = useT();
  const s = useSettings();
  if (!s.data) return <Loading state={s} />;
  const d = s.data;
  const onOff = (v: boolean) => <Badge info={{ label: v ? t("settings.on") : t("settings.off"), tone: v ? "success" : "neutral", icon: v ? "check" : "dot" }} />;
  return (
    <div className="space-y-4">
      <Notice tone="info">{t("settings.readOnlyNote")}</Notice>
      <Card>
        <SectionLabel>{t("settings.storage.vault")}</SectionLabel>
        <dl className="mt-1 divide-y divide-line">
          <Row label={t("settings.storage.vault")}>{onOff(d.vault.enabled)}{d.vault.enabled ? null : <p className="mt-2 text-xs text-muted">{t("settings.storage.vaultOff")}</p>}</Row>
          {d.vault.enabled ? <Row label={t("settings.storage.vaultFile")}><Path>{d.vault.file}</Path></Row> : null}
          {d.vault.enabled && d.vault.keySourceLabel ? <Row label={t("settings.storage.keySource")}>{d.vault.keySourceLabel}</Row> : null}
        </dl>
      </Card>
      <Card>
        <SectionLabel>{t("settings.storage.files")}</SectionLabel>
        <dl className="mt-1 divide-y divide-line">
          <Row label={t("settings.storage.linksFile")}><Path>{d.linksFile}</Path></Row>
          <Row label={t("settings.storage.evidenceDir")}><Path>{d.evidenceDir}</Path></Row>
        </dl>
      </Card>
      <Card>
        <SectionLabel>{t("settings.storage.automation")}</SectionLabel>
        <dl className="mt-1 divide-y divide-line">
          <Row label={t("settings.storage.automation")}>{onOff(d.automation.enabled)}</Row>
          {d.automation.enabled ? <Row label={t("settings.storage.chrome")}>{d.automation.chromeFound ? t("settings.yes") : t("settings.no")}</Row> : null}
        </dl>
      </Card>
      <Card>
        <SectionLabel>{t("settings.storage.server")}</SectionLabel>
        <dl className="mt-1"><Row label={t("settings.storage.port")}><span className="tabular">{d.server.port}</span></Row></dl>
      </Card>
    </div>
  );
}

/** Sprache der Oberflaeche. Der Umschalter in der Seitenleiste bleibt bestehen. */
export function LanguagePanel() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  return (
    <Card>
      <SectionLabel>{t("settings.language.title")}</SectionLabel>
      <div role="group" aria-label={t("settings.language.title")} className="mt-3 flex flex-wrap gap-2">
        {LOCALES.map((l) => (
          <button key={l} type="button" lang={l} aria-pressed={locale === l} onClick={() => setLocale(l)} className={`rounded-xl px-4 py-2 text-sm font-medium ring-1 ring-inset ring-line ${locale === l ? "bg-primary text-white" : "bg-card text-ink hover:bg-page"}`}>{LOCALE_NAMES[l]}</button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">{t("settings.language.hint")}</p>
    </Card>
  );
}
