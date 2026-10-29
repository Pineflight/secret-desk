import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Zugriffsschutz fuer das lokale Portal. Es lauscht nur auf 127.0.0.1, schuetzt aber auch vor fremden Webseiten im Browser. */

export interface SecurityConfig {
  port: number;
  /** Erlaubte Host-Namen (Schutz gegen DNS-Rebinding). */
  hosts?: string[];
}

export function allowedHosts(port: number, extra: string[] = []): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extra]);
}

/** Zusaetzliche Hosts aus SECRET_DESK_ALLOWED_HOSTS (kommagetrennt, mit Port). Leere Eintraege entfallen. */
export function extraHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env["SECRET_DESK_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
}

export function checkHost(req: Request, hosts: Set<string>): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return hosts.has(host);
}

/**
 * Browser-Metadaten: Aufrufe von fremden Webseiten (cross-site) und anderen Ursprungen derselben Maschine (same-site, z. B. ein
 * anderer localhost-Port) werden abgelehnt. Fehlt der Header (kein Browser, z. B. Agenten-Aufruf), gilt die uebrige Pruefung.
 */
export function checkFetchSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** Bei Aenderungen muss der Ursprung die eigene Adresse sein (kein fremder Webseiten-Aufruf). */
export function checkOrigin(req: Request, hosts: Set<string>): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return hosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

const safeEqual = (a: string, b: string): boolean => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

export function bearerMatches(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  return Boolean(m && safeEqual(m[1]!, token));
}

export function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Portal-Sitzung: Cookie (HttpOnly, SameSite=Strict) plus CSRF-Token, den die Seite mitsendet. */
export class PortalSession {
  readonly cookie = randomBytes(32).toString("base64url");
  readonly csrf = randomBytes(32).toString("base64url");
  /** Startgeheimnis (256 Bit), nur im Terminal sichtbar. null = abgeschaltet (SECRET_DESK_NO_LAUNCH_SECRET=1). */
  readonly launchSecret: string | null;

  constructor(options: { launchSecret?: string | null; env?: Record<string, string | undefined> } = {}) {
    const env = options.env ?? process.env;
    this.launchSecret = options.launchSecret !== undefined ? options.launchSecret : env["SECRET_DESK_NO_LAUNCH_SECRET"] === "1" ? null : randomBytes(32).toString("base64url");
  }

  /** Startadresse fuer das Terminal. */
  launchUrl(port: number): string | null {
    return this.launchSecret ? `http://127.0.0.1:${port}/?launch=${this.launchSecret}` : null;
  }

  /** Darf diese Anfrage eine Sitzung bekommen? Mit Startgeheimnis (Header oder Query), mit gueltigem Cookie, oder wenn abgeschaltet. */
  mayIssue(req: Request): boolean {
    if (this.launchSecret === null) return true;
    if (this.validCookie(req)) return true;
    const given = req.headers.get("x-secret-desk-launch") ?? new URL(req.url).searchParams.get("launch");
    return Boolean(given && safeEqual(given, this.launchSecret));
  }

  cookieHeader(): string {
    return `sd_session=${this.cookie}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /** Nur das Cookie (fuer reine Lese-Aufrufe von Bildern, die keinen eigenen Header senden koennen). */
  validCookie(req: Request): boolean {
    const c = cookieValue(req, "sd_session");
    return Boolean(c && safeEqual(c, this.cookie));
  }

  valid(req: Request): boolean {
    const c = cookieValue(req, "sd_session");
    const h = req.headers.get("x-secret-desk-csrf");
    return Boolean(c && h && safeEqual(c, this.cookie) && safeEqual(h, this.csrf));
  }
}

export function agentTokenPath(home = homedir()): string {
  return join(home, ".secret-desk", "agent-token");
}

/** Liest den Agenten-Token oder legt ihn an (Modus 600). Ist die Datei zu offen, wird sie auf 600 gesetzt (Windows: nur Warnung). */
export async function loadOrCreateAgentToken(path = agentTokenPath(), rotate = false, platform: NodeJS.Platform = process.platform, warn: (msg: string) => void = (m) => console.warn(m)): Promise<string> {
  if (!rotate) {
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing.length >= 32) {
        if (platform === "win32") {
          warn(`Hinweis: Dateirechte der Agenten-Token-Datei ${path} lassen sich unter Windows nicht pruefen; sie sollte nur in Ihrem Benutzerprofil liegen.`);
        } else if (((await stat(path)).mode & 0o077) !== 0) {
          await chmod(path, 0o600);
          warn(`Die Agenten-Token-Datei ${path} war fuer andere lesbar und wurde auf Modus 600 gesetzt. Token erneuern, falls andere Benutzer Zugriff hatten.`);
        }
        return existing;
      }
    } catch {
      /* neu anlegen */
    }
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}
