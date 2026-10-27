"use client";
import { useT } from "@/lib/i18n";
import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import type { StatusLevel } from "@secret-desk/core";
import { ApiError } from "@/lib/api";
import { providerInfo, stageInfo, statusInfo, toneClass, type Info } from "@/lib/status";
import { Icon } from "./Icons";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-card p-5 shadow-sm ${className}`}>{children}</section>;
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-[11px] font-semibold uppercase tracking-wide text-muted ${className}`}>{children}</h2>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Badge({ info, className = "" }: { info: Info; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClass(info.tone)} ${className}`}>
      <Icon name={info.icon} className="h-3 w-3" />
      {info.label}
    </span>
  );
}

export const StatusBadge = ({ level }: { level: StatusLevel }) => <Badge info={statusInfo(level)} />;
export const StageBadge = ({ stage }: { stage: string }) => <Badge info={stageInfo(stage)} />;
export const ProviderChip = ({ automatic, browser = false }: { automatic: boolean; browser?: boolean }) => <Badge info={providerInfo(automatic, browser)} />;

export function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full bg-page px-2.5 py-0.5 text-xs text-ink ring-1 ring-inset ring-line">{children}</span>;
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-white hover:brightness-95",
  secondary: "border border-line bg-card text-ink hover:bg-page",
  danger: "bg-danger-fill text-white hover:brightness-95",
  ghost: "text-ink hover:bg-page",
};

export function Button({ variant = "secondary", loading = false, className = "", children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
    >
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary", className = "" }: { href: string; children: ReactNode; variant?: Variant; className?: string }) {
  return (
    <Link href={href} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${VARIANT[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export const selectClass = "sd-select w-full rounded-xl border border-line bg-card py-2 pl-3 pr-9 text-sm text-ink focus:border-primary disabled:opacity-60";
export const inputClass = "w-full rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-primary disabled:opacity-60";

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input id={id} {...rest} className={`${inputClass} ${className}`} />
    </Field>
  );
}

export function SelectField({ label, hint, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select id={id} {...rest} className={selectClass}>{children}</select>
    </Field>
  );
}

export function TextAreaField({ label, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea id={id} {...rest} className={inputClass} />
    </Field>
  );
}

export function Checkbox({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--sd-primary)]" />
      <label htmlFor={id} className="text-sm">{children}</label>
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`sd-skeleton ${className}`} aria-hidden="true" />;
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="space-y-3" role="status" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon = "inbox" }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <span className="rounded-full bg-page p-3 text-muted"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const t = useT();
  const api = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className="rounded-2xl border border-danger bg-danger-light p-5 text-danger-text">
      <p className="flex items-center gap-2 font-medium"><Icon name="alert" className="h-4 w-4" />{t("common.failed")}</p>
      <p className="mt-1 text-sm">{error.message}</p>
      {api?.code === "not-connected" ? (
        <p className="mt-2 text-sm">{t("common.missingConnection", { name: api.connection ?? "?" })} <Link href="/verbindungen" className="font-medium underline">{t("common.toIntegrations")}</Link></p>
      ) : null}
      {onRetry ? <Button variant="secondary" className="mt-3" onClick={onRetry}><Icon name="refresh" />{t("common.retry")}</Button> : null}
    </div>
  );
}

export function Notice({ tone = "info", title, children, icon }: { tone?: "info" | "warn" | "danger" | "success"; title?: string; children?: ReactNode; icon?: string }) {
  const cls = { info: "border-info bg-info-light text-info-text", warn: "border-warn bg-warn-light text-warn-text", danger: "border-danger bg-danger-light text-danger-text", success: "border-success bg-success-light text-success-text" }[tone];
  const ic = icon ?? { info: "info", warn: "alert", danger: "alert", success: "check" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${cls}`}>
      <Icon name={ic} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-xl bg-page p-1 ring-1 ring-inset ring-line">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${value === t.id ? "bg-card text-ink shadow-sm" : "text-muted-text hover:text-ink"}`}>
          {t.label}
          {t.count !== undefined ? <span className="tabular ml-1.5 text-xs text-muted">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "danger" | "warn" | "success" | "info" }) {
  const c = tone === "danger" ? "text-danger-text" : tone === "warn" ? "text-warn-text" : tone === "info" ? "text-info-text" : tone === "success" ? "text-success-text" : "text-ink";
  return (
    <Card>
      <SectionLabel>{label}</SectionLabel>
      <p className={`tabular mt-2 text-3xl font-semibold ${c}`}>{value}</p>
    </Card>
  );
}
