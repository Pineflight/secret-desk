"use client";
import type { AboutInfo } from "@secret-desk/runtime";
import { useMemo, useState } from "react";
import { Card, ErrorState, ListSkeleton, PageHeader, SectionLabel, TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";

/** Ueber secret-desk: nur lokale Daten (Version, LICENSE, Drittlizenzen), keine externen Ressourcen. */
export default function AboutPage() {
  const t = useT();
  const q = useQuery<AboutInfo>("about", () => api<AboutInfo>("GET", "about"));
  const [filter, setFilter] = useState("");
  const parts = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data?.thirdParty ?? []).filter((c) => !f || `${c.name} ${c.license}`.toLowerCase().includes(f));
  }, [q.data, filter]);
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return <ListSkeleton rows={4} />;
  const a = q.data;
  return (
    <>
      <PageHeader title={t("about.title")} subtitle={t("about.subtitle")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" width={48} height={48} className="h-12 w-12 rounded-2xl" />
            <div>
              <p className="text-lg font-semibold">{a.name}</p>
              <p className="text-sm text-muted-text">{a.description}</p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-text">{t("about.version")}</dt><dd className="tabular">{a.version}</dd>
            {a.buildTag || a.commit ? <><dt className="text-muted-text">{t("about.build")}</dt><dd className="tabular break-all">{[a.buildTag, a.commit].filter(Boolean).join(" · ")}</dd></> : null}
            <dt className="text-muted-text">{t("about.createdBy")}</dt><dd>{t("about.createdByValue")}</dd>
            <dt className="text-muted-text">{t("about.license")}</dt><dd>{a.license}</dd>
          </dl>
          <ul className="mt-4 space-y-1 text-sm">
            <li><a className="text-primary underline" href={a.links.source} target="_blank" rel="noopener noreferrer">{t("about.source")}</a></li>
            <li><a className="text-primary underline" href={a.links.security} target="_blank" rel="noopener noreferrer">{t("about.security")}</a></li>
            <li><a className="text-primary underline" href={a.links.issues} target="_blank" rel="noopener noreferrer">{t("about.issues")}</a></li>
            <li><a className="text-primary underline" href={a.links.support} target="_blank" rel="noopener noreferrer">{t("about.support")}</a></li>
          </ul>
        </Card>
        <Card>
          <SectionLabel>{t("about.privacyTitle")}</SectionLabel>
          <p className="mt-3 text-sm">{t("about.privacy")}</p>
        </Card>
      </div>
      <Card className="mt-6">
        <SectionLabel>{t("about.licenseText")}</SectionLabel>
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-page p-4 text-xs leading-relaxed" tabIndex={0} aria-label={t("about.licenseText")}>{a.licenseText.replace(/(?<!\n)\n(?!\n)/g, " ")}</pre>
      </Card>
      <Card className="mt-6">
        <SectionLabel>{t("about.thirdTitle")}</SectionLabel>
        <p className="mt-3 text-sm text-muted-text">{t("about.thirdIntro")} ({t("about.thirdCount", { count: a.thirdParty.length })})</p>
        <div className="mt-3 max-w-sm"><TextField label={t("about.thirdFilter")} value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" /></div>
        <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-card"><tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted"><th className="px-3 py-2 font-semibold">{t("about.colName")}</th><th className="px-3 py-2 font-semibold">{t("about.colVersion")}</th><th className="px-3 py-2 font-semibold">{t("about.colLicense")}</th></tr></thead>
            <tbody className="divide-y divide-line">
              {parts.map((c) => (
                <tr key={`${c.name}@${c.version}`}>
                  <td className="px-3 py-1.5 break-all">{c.name}</td>
                  <td className="tabular px-3 py-1.5">{c.version}</td>
                  <td className="px-3 py-1.5">{c.license}{c.status !== "allowed" ? <span className="ml-2 rounded-full bg-warn-light px-2 py-0.5 text-[11px] text-warn-text">{t("about.review")}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {a.platformFamilies.length > 0 ? <p className="mt-3 text-xs text-muted-text">{t("about.platformFamilies", { names: a.platformFamilies.join(", ") })}</p> : null}
      </Card>
    </>
  );
}
