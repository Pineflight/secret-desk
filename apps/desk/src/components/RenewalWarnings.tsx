"use client";
import Link from "next/link";
import { Badge, LinkButton, Notice } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { signInHref, type RenewalWarning } from "@/lib/renewal-warning";

/** Overview notice: entries whose renewal needs a browser sign-in that is missing, each with the action that opens the sign-in dialog. */
export function RenewalNotice({ warnings }: { warnings: readonly RenewalWarning[] }) {
  const t = useT();
  if (warnings.length === 0) return null;
  return (
    <Notice tone="warn" title={t("renewal.title", { count: warnings.length })}>
      <p>{t("renewal.hint")}</p>
      <ul className="mt-2 space-y-2">
        {warnings.map((w) => (
          <li key={w.secretId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <Link href={`/secrets/${encodeURIComponent(w.secretId)}`} className="min-w-0 break-words underline">{t("renewal.line", { name: w.title, provider: w.vendorLabel, date: formatDate(w.expires) })}</Link>
            <LinkButton href={signInHref(w.vendorId)} aria-label={t("renewal.signInAt", { provider: w.vendorLabel })}>{t("renewal.signIn")}</LinkButton>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** Badge on an entry: the sign-in is needed before the renewal on that day. */
export function RenewalBadge({ warning }: { warning: RenewalWarning }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge info={{ label: t(warning.state === "unknown" ? "renewal.badgeUnknown" : "renewal.badge", { date: formatDate(warning.expires) }), tone: "warn", icon: "alert" }} />
      <Link href={signInHref(warning.vendorId)} className="text-xs font-medium text-primary underline-offset-2 hover:underline" aria-label={t("renewal.signInAt", { provider: warning.vendorLabel })}>{t("renewal.signIn")}</Link>
    </span>
  );
}
