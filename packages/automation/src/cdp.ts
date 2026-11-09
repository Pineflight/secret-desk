import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseCdpEndpoint, redactCdpEndpoint } from "@secret-desk/core";

/** Name of the environment variable that selects a remote browser. It wins over `automation.cdpEndpoint`. */
export const CDP_ENV = "SECRET_DESK_BROWSER_CDP";

export type HostLookup = (host: string) => Promise<string>;

const defaultLookup: HostLookup = async (host) => (await lookup(host)).address;

/** The configured endpoint: the environment variable wins over the configuration; blank values count as unset. */
export function cdpEndpointFrom(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[CDP_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return configured?.trim() || undefined;
}

/**
 * Chromium answers its DevTools HTTP and WebSocket endpoints only when the Host header is an IP address or "localhost"
 * (DNS-rebinding protection). A compose service name such as "browser" is therefore resolved to an IP address first.
 */
export async function resolveCdpEndpoint(raw: string, resolveHost: HostLookup = defaultLookup): Promise<string> {
  const url = parseCdpEndpoint(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || isIP(host) !== 0) return url.toString();
  let address: string;
  try {
    address = await resolveHost(host);
  } catch {
    throw new Error(`Cannot resolve the browser host ${host}.`);
  }
  url.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return url.toString();
}

export interface CdpProbe {
  reachable: boolean;
  /** Browser product and version ("Chrome/..."), when reachable. */
  browser: string | null;
  /** Short reason when not reachable. Never contains the endpoint. */
  detail: string | null;
}

/** Asks the DevTools endpoint for /json/version (no page content, no credentials in the output). */
export async function probeCdp(raw: string, options: { timeoutMs?: number; fetch?: typeof fetch; resolveHost?: HostLookup } = {}): Promise<CdpProbe> {
  const doFetch = options.fetch ?? fetch;
  let target: URL;
  try {
    target = new URL(await resolveCdpEndpoint(raw, options.resolveHost));
  } catch (err) {
    return { reachable: false, browser: null, detail: (err as Error).message.split("\n")[0]! };
  }
  if (target.protocol === "ws:" || target.protocol === "wss:") {
    // A WebSocket address cannot be asked over HTTP; the connection itself is tested at the first run.
    return { reachable: false, browser: null, detail: "Not checked: the endpoint is a WebSocket address. Use http://host:port to check it." };
  }
  const url = new URL("json/version", target.toString().endsWith("/") ? target : `${target.toString()}/`);
  url.username = "";
  url.password = "";
  const headers: Record<string, string> = {};
  if (target.username) headers["authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}`;
  try {
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
    if (!res.ok) return { reachable: false, browser: null, detail: `The browser answered with HTTP ${res.status}.` };
    const body = (await res.json()) as { Browser?: unknown };
    return { reachable: true, browser: typeof body.Browser === "string" ? body.Browser.slice(0, 80) : null, detail: null };
  } catch (err) {
    const name = (err as Error).name;
    return { reachable: false, browser: null, detail: name === "TimeoutError" || name === "AbortError" ? "No answer within the time limit." : "The browser endpoint is not reachable." };
  }
}

export { redactCdpEndpoint };
