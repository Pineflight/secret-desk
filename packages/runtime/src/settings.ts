import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentStageIds, expandHome } from "@secret-desk/core";
import type { Runtime } from "./runtime.js";

/** Text fuer die Anzeige: ein Home-Praefix (/Users/<name>, /home/<name>, C:\Users\<name>, das echte Home) wird zu ~, auch mitten im Text. */
export function shortenHome(p: string): string {
  const home = homedir();
  let out = p;
  // Nur an Pfadgrenzen: /Users/niklas2/x darf mit dem Home /Users/niklas nicht zu ~2/x werden.
  if (home.length > 1) out = out.replace(new RegExp(`(?<![\\w.~/-])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\\\\\s"'),:;]|$)`, "g"), "~");
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
  const vaultFile = resolve(expandHome(cfg.vault.file ?? join(homedir(), ".secret-desk", "vault.json")));
  return {
    configFile: shortenHome(rt.configPath),
    policy: {
      agentStages: defs.filter((d) => direct.has(d.id)).map((d) => d.id),
      agentStagesSource: cfg.policy.agentStages ? "policy" : "default",
      envRoots: cfg.policy.envRoots.map((p) => shortenHome(p)),
    },
    stages: defs.map((d) => ({ id: d.id, kind: d.kind, agentAccess: direct.has(d.id) ? "direct" : "approval" })),
    vault: { enabled: Boolean(vault), file: shortenHome(vaultFile), keySourceLabel: vault ? shortenHome(vault.label) : null },
    linksFile: shortenHome(resolve(expandHome(cfg.linksFile ?? join(homedir(), ".secret-desk", "repo-links.json")))),
    evidenceDir: shortenHome(resolve(dir, expandHome(cfg.evidenceDir))),
    automation: { enabled: rt.automation.enabled, chromeFound: rt.automation.info().chrome.found },
    server: { port: cfg.server.port },
  };
}
