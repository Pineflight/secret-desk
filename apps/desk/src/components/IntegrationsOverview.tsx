"use client";
import Link from "next/link";
import type { SecretView, VariableView } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Card, ErrorState, LinkButton, SectionLabel, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { daysLabel } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { isDueSoon, summarize, type ConnectionLike, type IntegrationRow } from "@/lib/integration-summary";
import { writeStored } from "@/lib/persisted-state";

/** Abschnitt "Angebunden" der Uebersicht: was verbunden ist und was daran haengt. Nutzt nur vorhandene Listen, keine Anbieter-Abfrage. */
export function IntegrationsOverview() {
  const t = useT();
  const conns = useQuery<ConnectionLike[]>("overview-connections", () => api<ConnectionLike[]>("GET", "connections"));
  const secrets = useQuery<SecretView[]>("overview-secrets", () => api<SecretView[]>("GET", "secrets"));
  const vars = useQuery<VariableView[]>("overview-variables", () => api<VariableView[]>("GET", "variables"));
  const error = conns.error ?? secrets.error ?? vars.error;
  const ready = conns.data && secrets.data && vars.data;
  const s = ready ? summarize(conns.data!, secrets.data!, vars.data!) : null;

  return (
    <Card className="mb-8">
      <SectionLabel>{t("home.linked")}</SectionLabel>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("home.linkedHint")}</p>
      {error ? <div className="mt-4"><ErrorState error={error} onRetry={() => { conns.reload(); secrets.reload(); vars.reload(); }} /></div> : null}
      {!s && !error ? <div className="mt-4 space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : null}
      {s ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
            <Figure label={t("home.linkedAutomatic")} value={s.automatic} hint={t("home.linkedAutomaticHint")} />
            <Figure label={t("home.linkedManual")} value={s.manual} hint={t("home.linkedManualHint")} />
            <Figure label={t("home.linkedRepos")} value={s.repos} hint={t("home.linkedReposHint")} />
            <div>
              <dt className="text-muted">{t("home.linkedParams")}</dt>
              <dd className="tabular mt-0.5 font-medium">
                {t("home.linkedParamsValue", { complete: s.paramsComplete, missing: s.paramsMissing })}
                {s.paramsMissing > 0 ? (
                  <>
                    {" "}
                    <Link href="/entries?kind=secret" onClick={() => writeStored("entries.params", "missing", "")} className="text-sm font-normal underline">{t("home.linkedParamsShow")}</Link>
                  </>
                ) : null}
              </dd>
            </div>
          </dl>
          {s.rows.length === 0 ? <p className="mt-4 text-sm text-muted">{t("home.linkedNone")}</p> : null}
          {s.rows.length > 0 ? <ul className="mt-4 divide-y divide-line">{s.rows.map((r) => <IntegrationLine key={r.id} r={r} />)}</ul> : null}
        </>
      ) : null}
    </Card>
  );
}

function Figure({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="tabular mt-0.5 font-medium">{value} <span className="text-sm font-normal text-muted">{hint}</span></dd>
    </div>
  );
}

function IntegrationLine({ r }: { r: IntegrationRow }) {
  const t = useT();
  const attached = r.secrets > 0 || r.variables > 0;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <Icon name="plug" className="h-4 w-4 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{r.label}</span>
        <span className="block text-xs text-muted">
          {r.connected
            ? attached ? t("home.linkedAttached", { secrets: r.secrets, auto: r.autoSecrets, variables: r.variables }) : t("home.linkedNothingAttached")
            : r.autoSecrets > 0 ? t("home.linkedInvite", { name: r.label, count: r.autoSecrets }) : t("home.linkedInviteGeneric", { name: r.label })}
        </span>
      </span>
      {r.connected ? (
        <>
          {r.daysLeft !== null ? <span className={`tabular text-sm ${isDueSoon(r) ? "font-medium text-warn-text" : "text-muted-text"}`}>{t("home.linkedExpires", { when: daysLabel(r.daysLeft) })}</span> : <span className="text-sm text-muted-text">{t("connections.neverExpires")}</span>}
          <Badge info={isDueSoon(r) ? { label: t("home.linkedDueSoon"), tone: "warn", icon: "clock" } : { label: t("home.linkedConnected"), tone: "success", icon: "check" }} />
        </>
      ) : (
        <LinkButton href="/connections">{t("connections.connect")}</LinkButton>
      )}
    </li>
  );
}
