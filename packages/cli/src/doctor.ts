import { GitHubError, agentStageIds, placeToTarget, stageKind, type Place } from "@secret-desk/core";
import { listConnections, type Runtime } from "@secret-desk/runtime";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFinding {
  id: string;
  status: DoctorStatus;
  label: string;
  detail?: string;
}

const placeLabel = (p: Place): string => `${p.repo}/${p.scope === "environment" ? `env:${p.environment}` : p.scope === "organization" ? "org" : "repo"}`;

/**
 * Vorpruefung vor dem ersten echten Einsatz. Liest nur: Konfiguration, Verbindungen, GitHub-Ziele (nur der oeffentliche
 * Schluessel, ein Schreibrecht-Test ohne zu schreiben) und beim Anbieter den Zustand des Zugangs-Tokens.
 * Es wird nichts erzeugt, geschrieben oder widerrufen. Kein Befund enthaelt einen Wert.
 */
export async function runDoctor(rt: Runtime): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const inv = rt.inventory.data;
  out.push({ id: "inventory", status: "ok", label: `Inventar gelesen: ${inv.secrets.length} Secrets, ${inv.variables.length} Variablen, ${inv.envTemplates.length} Vorlagen` });

  const needed = new Set<string>(["github"]);
  for (const s of inv.secrets) {
    const p = rt.providers.get(s.provider);
    if (p?.connection) needed.add(p.connection);
    if (s.provider !== "manual" && !p) out.push({ id: `provider:${s.id}`, status: "fail", label: `Unbekannter Anbieter "${s.provider}" bei ${s.id}` });
  }
  const statuses = new Map((await listConnections(rt)).map((c) => [c.id, c]));
  for (const id of needed) {
    const c = statuses.get(id) ?? (await rt.connections.status(id));
    out.push({ id: `connection:${id}`, status: c.connected ? "ok" : id === "github" ? "fail" : "warn", label: `Verbindung ${id}: ${c.connected ? `verbunden (${c.source})` : "nicht verbunden"}`, ...(c.hint ? { detail: c.hint } : {}) });
  }

  const places = [...inv.secrets.flatMap((s) => s.places), ...inv.variables.flatMap((v) => v.places)];
  const seen = new Set<string>();
  const githubOk = (await rt.connections.status("github")).connected || (await rt.connections.status("github-app-key")).connected;
  if (githubOk) {
    for (const place of places) {
      const key = placeLabel(place);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await rt.github.publicKey(placeToTarget(rt.owner, place));
        out.push({ id: `target:${key}`, status: "ok", label: `Ziel erreichbar mit Schreibrecht auf Secrets: ${key}` });
      } catch (err) {
        const hint = err instanceof GitHubError && err.status === 404 ? "Repo oder Environment existiert nicht, oder der Token hat keinen Zugriff." : err instanceof GitHubError && err.status === 403 ? "Dem Token fehlt das Recht Secrets: Read and write (Environments: Read)." : (err as Error).message;
        out.push({ id: `target:${key}`, status: "fail", label: `Ziel nicht nutzbar: ${key}`, detail: hint });
      }
    }
  } else out.push({ id: "targets", status: "warn", label: "GitHub-Ziele nicht geprueft: keine GitHub-Verbindung" });

  const usesCloudflare = inv.secrets.some((s) => s.provider.startsWith("cloudflare-"));
  if (usesCloudflare && (await rt.connections.status("cloudflare")).connected) {
    try {
      const token = (await rt.connections.token("cloudflare")).reveal();
      const res = await rt.fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const body = (await res.json().catch(() => ({}))) as { result?: { status?: string; expires_on?: string } };
      const active = res.ok && body.result?.status === "active";
      out.push({ id: "cloudflare-token", status: active ? "ok" : "fail", label: `Cloudflare-Zugangs-Token: ${active ? "aktiv" : `nicht nutzbar (HTTP ${res.status})`}`, ...(body.result?.expires_on ? { detail: `laeuft ab: ${body.result.expires_on.slice(0, 10)}` } : {}) });
    } catch (err) {
      out.push({ id: "cloudflare-token", status: "warn", label: "Cloudflare-Zugangs-Token nicht pruefbar", detail: (err as Error).message.slice(0, 120) });
    }
  }
  const dev = inv.envTemplates.filter((t) => stageKind(inv.stages, t.stage) === "dev").length;
  const direct = agentStageIds(rt.config, inv.stages);
  const unknown = (rt.config.policy.agentStages ?? []).filter((id) => !inv.stages.some((d) => d.id === id));
  out.push({ id: "policy", status: unknown.length > 0 ? "warn" : "ok", label: `Richtlinie: Agenten direkt nur in [${direct.join(", ")}], ${dev} Dev-Vorlagen`, ...(unknown.length > 0 ? { detail: `policy.agentStages nennt unbekannte Stages: ${unknown.join(", ")}` } : {}) });
  return out;
}

export function doctorExitCode(findings: DoctorFinding[]): number {
  return findings.some((f) => f.status === "fail") ? 1 : 0;
}
