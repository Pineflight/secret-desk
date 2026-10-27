import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime, issuanceDeps, type Runtime, type RuntimeOptions } from "@secret-desk/runtime";
import { PortalSession, allowedHosts, loadOrCreateAgentToken } from "./security";

export interface Desk {
  rt: Runtime;
  session: PortalSession;
  agentToken: string;
  hosts: Set<string>;
  demo: boolean;
}

const g = globalThis as { __secretDesk?: Promise<Desk> };

async function init(): Promise<Desk> {
  const demo = process.env.SECRET_DESK_DEMO === "1";
  const configPath = process.env.SECRET_DESK_CONFIG ?? resolve(process.cwd(), "../../secret-desk.config.yaml");
  // Demo: simuliertes GitHub, eigener Agenten-Token im Temp-Ordner, keine echten Anfragen.
  const options: RuntimeOptions = demo ? { fetch: await (await import("./demo")).createDemoFetch(), env: { GITHUB_DEMO_TOKEN: "demo" } as unknown as NodeJS.ProcessEnv } : {};
  const rt = await createRuntime(configPath, options);
  const desk: Desk = {
    rt,
    session: new PortalSession(),
    agentToken: await loadOrCreateAgentToken(demo ? join(tmpdir(), "secret-desk-demo", "agent-token") : undefined),
    hosts: allowedHosts(rt.config.server.port),
    demo,
  };
  // Abgelaufene, nicht bestaetigte Werte verwerfen (der neue Wert wird beim Anbieter wieder geloescht).
  setInterval(() => void rt.issuances.sweep(issuanceDeps(rt)).catch(() => undefined), 60_000).unref();
  return desk;
}

/** Ein Portal-Zustand je Prozess (Laufzeit, Sitzung, Agenten-Token). Nur im Arbeitsspeicher. */
export function getDesk(): Promise<Desk> {
  g.__secretDesk ??= init();
  return g.__secretDesk;
}
