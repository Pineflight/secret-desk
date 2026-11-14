import { dirname, join, resolve } from "node:path";
import { agentStageIds } from "@secret-desk/core";
import { expandHomeFor, hostHome } from "./host.js";
import type { Runtime } from "./runtime.js";

/**
 * Text fuer die Anzeige: ein Home-Praefix (/Users/<name>, /home/<name>, C:\Users\<name>, das Home des Hosts) wird zu ~, auch mitten im Text.
 * Ohne `home` (kein Host oder kein Home-Ordner) greifen nur die allgemeinen Muster; der Home-Ordner des Prozesses wird nicht abgefragt.
 */
export function shortenHome(p: string, home?: string): string {
  let out = p;
  // Nur an Pfadgrenzen: /Users/alice2/x darf mit dem Home /Users/alice nicht zu ~2/x werden.
  if (home && home.length > 1) out = out.replace(new RegExp(`(?<![\\w.~/-])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\\\\\s"'),:;]|$)`, "g"), "~");
  return out
    .replace(/(?<![\w.~/-])\/Users\/[^/\\\s]+(?=[/\\\s]|$)/g, "~")
    .replace(/(?<![\w.~/-])\/home\/[^/\\\s]+(?=[/\\\s]|$)/g, "~")
    .replace(/(?<![\w.~/-])[A-Za-z]:[\\/]Users[\\/][^\\/\s]+(?=[\\/\s]|$)/g, "~");
}

export interface SettingsStage {
  id: string;
  kind: "dev" | "test" | "live" | "shared";
  /** direct: Agenten duerfen direkt arbeiten. approval: nur mit Freigabe durch einen Menschen. */
  agentAccess: "direct" | "approval";
}

/** Reine Metadaten der Konfiguration: keine Werte, keine Tokens, keine Umgebungsvariablen-Inhalte. */
export interface SettingsInfo {
  configFile: string;
  policy: {
    /** Aufgeloeste Stage-Ids, die Agenten ohne Freigabe anfassen duerfen (nie live). */
    agentStages: string[];
    /** policy: ausdruecklich in der Konfiguration, default: alle Stages der Art dev. */
    agentStagesSource: "policy" | "default";
    envRoots: string[];
  };
  stages: SettingsStage[];
  vault: { enabled: boolean; file: string; keySourceLabel: string | null };
  linksFile: string;
  evidenceDir: string;
  automation: { enabled: boolean; chromeFound: boolean };
  server: { port: number };
}

/** Zusammenfassung der Konfiguration fuer die Einstellungsseite. */
export function getSettings(rt: Runtime): SettingsInfo {
  const cfg = rt.config;
  const dir = dirname(rt.configPath);
  const defs = rt.inventory.stages;
  const direct = new Set(agentStageIds(cfg, defs));
  const vault = rt.connections.vault;
  // Display only. The home folder is the host's; without one a `~` path or a default location shows as configured (or empty).
  const home = hostHome(rt.host);
  const short = (p: string): string => shortenHome(p, home);
  const show = (p: string | undefined, fallback: string | undefined, base?: string): string => {
    const raw = p ?? fallback;
    if (raw === undefined) return "";
    try {
      const expanded = expandHomeFor(rt.host, raw);
      return short(base ? resolve(base, expanded) : resolve(expanded));
    } catch {
      return short(raw);
    }
  };
  return {
    configFile: short(rt.configPath),
    policy: {
      agentStages: defs.filter((d) => direct.has(d.id)).map((d) => d.id),
      agentStagesSource: cfg.policy.agentStages ? "policy" : "default",
      envRoots: cfg.policy.envRoots.map((p) => short(p)),
    },
    stages: defs.map((d) => ({ id: d.id, kind: d.kind, agentAccess: direct.has(d.id) ? "direct" : "approval" })),
    vault: { enabled: Boolean(vault), file: show(cfg.vault.file, home ? join(home, ".secret-desk", "vault.json") : undefined), keySourceLabel: vault ? short(vault.label) : null },
    linksFile: show(cfg.linksFile, home ? join(home, ".secret-desk", "repo-links.json") : undefined),
    evidenceDir: show(cfg.evidenceDir, undefined, dir),
    automation: { enabled: rt.automation.enabled, chromeFound: rt.automation.info().chrome.found },
    server: { port: cfg.server.port },
  };
}
