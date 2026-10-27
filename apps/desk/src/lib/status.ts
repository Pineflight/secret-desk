import type { StatusLevel } from "@secret-desk/core";
import { translate } from "./i18n";
import { FALLBACK_STAGES, stageLook, type StageDefLite } from "./stages";

export type Tone = "success" | "warn" | "warn-strong" | "danger" | "neutral" | "info" | "ki" | "primary" | "stage-prod";
export type IconName =
  | "check" | "clock" | "alert" | "x" | "info" | "help" | "calendar" | "dot" | "shield" | "bolt" | "plug" | "key" | "wrench" | "hand";

export interface Info {
  label: string;
  tone: Tone;
  icon: IconName;
}

const STATUS: Record<StatusLevel, Info> = {
  ok: { label: "common.status.ok", tone: "success", icon: "check" },
  soon: { label: "common.status.soon", tone: "warn", icon: "clock" },
  due: { label: "common.status.due", tone: "warn-strong", icon: "alert" },
  expired: { label: "common.status.expired", tone: "danger", icon: "x" },
  missing: { label: "common.status.missing", tone: "danger", icon: "alert" },
  "no-date": { label: "common.status.no-date", tone: "warn", icon: "calendar" },
  unknown: { label: "common.status.unknown", tone: "neutral", icon: "help" },
};

export function statusInfo(level: StatusLevel): Info {
  const i = STATUS[level] ?? STATUS.unknown;
  return { ...i, label: translate(i.label) };
}

/** Anzeigename, Farbe und Symbol einer Stage aus den Definitionen (Farbe: tone, sonst Standard der Art). */
export function stageInfo(stage: string, defs: readonly StageDefLite[] = FALLBACK_STAGES): Info {
  return stageLook(defs, stage);
}

export function providerInfo(automatic: boolean, browser = false): Info {
  if (browser) return { label: translate("common.provider.browser"), tone: "primary", icon: "plug" };
  return automatic ? { label: translate("common.provider.auto"), tone: "primary", icon: "bolt" } : { label: translate("common.provider.manual"), tone: "neutral", icon: "hand" };
}

export function checkInfo(status: "pass" | "warn" | "fail" | "info"): Info {
  switch (status) {
    case "pass":
      return { label: translate("common.check.pass"), tone: "success", icon: "check" };
    case "warn":
      return { label: translate("common.check.warn"), tone: "warn", icon: "alert" };
    case "fail":
      return { label: translate("common.check.fail"), tone: "danger", icon: "x" };
    default:
      return { label: translate("common.check.info"), tone: "info", icon: "info" };
  }
}

export function overallInfo(overall: "pass" | "warn" | "fail"): Info {
  switch (overall) {
    case "pass":
      return { label: translate("common.overall.pass"), tone: "success", icon: "check" };
    case "warn":
      return { label: translate("common.overall.warn"), tone: "warn", icon: "alert" };
    default:
      return { label: translate("common.overall.fail"), tone: "danger", icon: "x" };
  }
}

export type DriftState = "in-sync" | "missing" | "different" | "unknown-expected" | "unreachable";

export function driftInfo(state: DriftState): Info {
  switch (state) {
    case "in-sync":
      return { label: translate("common.drift.in-sync"), tone: "success", icon: "check" };
    case "different":
      return { label: translate("common.drift.different"), tone: "warn-strong", icon: "alert" };
    case "missing":
      return { label: translate("common.drift.missing"), tone: "danger", icon: "alert" };
    case "unknown-expected":
      return { label: translate("common.drift.unknown-expected"), tone: "neutral", icon: "help" };
    default:
      return { label: translate("common.drift.unreachable"), tone: "danger", icon: "plug" };
  }
}

export function approvalStateInfo(state: string): Info {
  switch (state) {
    case "pending":
      return { label: translate("common.approval.pending"), tone: "warn", icon: "clock" };
    case "approved":
      return { label: translate("common.approval.approved"), tone: "success", icon: "check" };
    case "denied":
      return { label: translate("common.approval.denied"), tone: "neutral", icon: "x" };
    default:
      return { label: translate("common.approval.failed"), tone: "danger", icon: "alert" };
  }
}

/** Statische Klassen, damit Tailwind sie findet. */
const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success-light text-success-text",
  warn: "bg-warn-light text-warn-text",
  "warn-strong": "bg-warn-text text-white",
  danger: "bg-danger-light text-danger-text",
  neutral: "bg-page text-muted-text ring-1 ring-inset ring-line",
  info: "bg-info-light text-info-text",
  ki: "bg-ki-light text-ki-text",
  primary: "bg-primary-light text-primary",
  "stage-prod": "bg-danger-fill text-white",
};

export function toneClass(tone: Tone): string {
  return TONE_CLASS[tone];
}

/** Hinweis, ob eine Servermeldung zu einem Geheimnis in einer Variable gehoert. */
export function classifyVariableError(message: string): "secret" | "acknowledge" | "other" {
  if (message.includes("acknowledgedPublic")) return "acknowledge";
  if (/stripe|github-token|service-role|schl(ü|ue)ssel|privater/i.test(message)) return "secret";
  return "other";
}
