import type { StatusLevel } from "@secret-desk/core";

export type Tone = "success" | "warn" | "warn-strong" | "danger" | "neutral" | "info" | "ki" | "primary" | "stage-prod";
export type IconName =
  | "check" | "clock" | "alert" | "x" | "info" | "help" | "calendar" | "dot" | "shield" | "bolt" | "plug" | "key" | "wrench" | "hand";

export interface Info {
  label: string;
  tone: Tone;
  icon: IconName;
}

const STATUS: Record<StatusLevel, Info> = {
  ok: { label: "In Ordnung", tone: "success", icon: "check" },
  soon: { label: "Läuft bald ab", tone: "warn", icon: "clock" },
  due: { label: "Fällig", tone: "warn-strong", icon: "alert" },
  expired: { label: "Abgelaufen", tone: "danger", icon: "x" },
  missing: { label: "Fehlt in GitHub", tone: "danger", icon: "alert" },
  "no-date": { label: "Datum fehlt", tone: "warn", icon: "calendar" },
  unknown: { label: "Ablauf unklar", tone: "neutral", icon: "help" },
};

export function statusInfo(level: StatusLevel): Info {
  return STATUS[level] ?? STATUS.unknown;
}

const STAGE: Record<string, Info> = {
  dev: { label: "dev", tone: "info", icon: "dot" },
  staging: { label: "staging", tone: "ki", icon: "dot" },
  production: { label: "production", tone: "stage-prod", icon: "shield" },
  shared: { label: "shared", tone: "neutral", icon: "dot" },
};

export function stageInfo(stage: string): Info {
  return STAGE[stage] ?? { label: stage, tone: "neutral", icon: "dot" };
}

export function providerInfo(automatic: boolean): Info {
  return automatic ? { label: "automatisch", tone: "primary", icon: "bolt" } : { label: "von Hand", tone: "neutral", icon: "hand" };
}

export function checkInfo(status: "pass" | "warn" | "fail" | "info"): Info {
  switch (status) {
    case "pass":
      return { label: "Bestanden", tone: "success", icon: "check" };
    case "warn":
      return { label: "Hinweis", tone: "warn", icon: "alert" };
    case "fail":
      return { label: "Fehlgeschlagen", tone: "danger", icon: "x" };
    default:
      return { label: "Info", tone: "info", icon: "info" };
  }
}

export function overallInfo(overall: "pass" | "warn" | "fail"): Info {
  switch (overall) {
    case "pass":
      return { label: "bestanden", tone: "success", icon: "check" };
    case "warn":
      return { label: "mit Hinweisen", tone: "warn", icon: "alert" };
    default:
      return { label: "fehlgeschlagen", tone: "danger", icon: "x" };
  }
}

export type DriftState = "in-sync" | "missing" | "different" | "unknown-expected" | "unreachable";

export function driftInfo(state: DriftState): Info {
  switch (state) {
    case "in-sync":
      return { label: "Stimmt überein", tone: "success", icon: "check" };
    case "different":
      return { label: "Weicht ab", tone: "warn-strong", icon: "alert" };
    case "missing":
      return { label: "Fehlt in GitHub", tone: "danger", icon: "alert" };
    case "unknown-expected":
      return { label: "Sollwert unbekannt", tone: "neutral", icon: "help" };
    default:
      return { label: "Nicht erreichbar", tone: "danger", icon: "plug" };
  }
}

export function approvalStateInfo(state: string): Info {
  switch (state) {
    case "pending":
      return { label: "Wartet auf Freigabe", tone: "warn", icon: "clock" };
    case "approved":
      return { label: "Freigegeben", tone: "success", icon: "check" };
    case "denied":
      return { label: "Abgelehnt", tone: "neutral", icon: "x" };
    default:
      return { label: "Fehlgeschlagen", tone: "danger", icon: "alert" };
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
