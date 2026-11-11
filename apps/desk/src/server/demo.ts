import { dirname, join } from "node:path";
import { SecretSchema, exportTeamBundle, parseTeamBundle, readTeamSyncState, textHash, writeTeamSyncState } from "@secret-desk/core";
import type { Runtime } from "@secret-desk/runtime";
import sodium from "libsodium-wrappers";
import { createDemoRepos, type DemoRepoOptions } from "./demo-github-repos";

/**
 * Demo-Modus (SECRET_DESK_DEMO=1): ein simuliertes GitHub im Arbeitsspeicher, damit sich das Portal ohne Konten
 * ausprobieren laesst. Es werden nirgends echte Anfragen gesendet.
 */
interface Store {
  secrets: Map<string, Map<string, string>>;
  variables: Map<string, Map<string, string>>;
}

/** Request body as an object; anything that is not a JSON object (empty, malformed, not a string) counts as no body. */
function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const key = (path: string): string => path.replace(/\/(actions\/)?(secrets|variables).*$/, "");

export async function createDemoFetch(options: DemoRepoOptions = {}): Promise<typeof fetch> {
  await sodium.ready;
  const repos = createDemoRepos(options);
  const kp = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const now = (): string => new Date().toISOString();
  const store: Store = {
    secrets: new Map([
      ["/repos/acme/acme-app", new Map([["CLOUDFLARE_API_TOKEN", "2026-08-12T09:00:00Z"], ["VAPID_PRIVATE_KEY", "2026-08-12T09:00:00Z"]])],
      ["/repos/acme/acme-app/environments/staging", new Map([["ACME_API_KEY", "2026-09-02T10:00:00Z"], ["ARTIFACT_HMAC_SECRET", "2026-09-02T10:00:00Z"]])],
      ["/repos/acme/acme-web/environments/staging", new Map([["STRIPE_WEBHOOK_SECRET", "2026-09-29T08:00:00Z"]])],
      ["/repos/acme/acme-docs/environments/staging", new Map()],
    ]),
    variables: new Map([
      ["/repos/acme/acme-app", new Map([["ACME_PROJECT_ID", "proj_demo_123"]])],
      ["/repos/acme/acme-web/environments/staging", new Map([["NEXT_PUBLIC_SITE_URL", "https://app-staging.example.com"]])],
      ["/repos/acme/acme-docs/environments/staging", new Map([["NEXT_PUBLIC_SITE_URL", "https://alt.example.com"]])],
    ]),
  };

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const method = init?.method ?? "GET";
    const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.hostname !== "api.github.com") return ok({ message: "Demo: only GitHub is simulated" }, 501);

    if (method === "GET" && /^\/orgs\/[^/]+\/repos$/.test(path)) {
      return ok(["acme-app", "acme-web", "acme-docs", "acme-lab", "acme-tools"].map((name) => ({ name, private: true, archived: false, default_branch: "main", pushed_at: now() })));
    }
    if (path.endsWith("/secrets/public-key")) return ok({ key_id: "demo-key", key: publicKey });
    const secretMatch = /^(.*)\/(?:actions\/)?secrets\/([^/]+)$/.exec(path);
    if (method === "PUT" && secretMatch) {
      const bucket = store.secrets.get(key(path)) ?? new Map<string, string>();
      const existed = bucket.has(secretMatch[2]!);
      bucket.set(secretMatch[2]!, now());
      store.secrets.set(key(path), bucket);
      return new Response(null, { status: existed ? 204 : 201 });
    }
    if (method === "GET" && /\/(?:actions\/)?secrets$/.test(path)) {
      const bucket = store.secrets.get(key(path));
      if (!bucket) return ok({ message: "Not Found" }, 404);
      return ok({ total_count: bucket.size, secrets: [...bucket].map(([name, updated]) => ({ name, created_at: updated, updated_at: updated })) });
    }
    if (method === "GET" && /\/(?:actions\/)?variables$/.test(path)) {
      const bucket = store.variables.get(key(path));
      if (!bucket) return ok({ message: "Not Found" }, 404);
      return ok({ total_count: bucket.size, variables: [...bucket].map(([name, value]) => ({ name, value, created_at: now(), updated_at: now() })) });
    }
    const varMatch = /^(.*)\/(?:actions\/)?variables\/([^/]+)$/.exec(path);
    if (method === "PATCH" && varMatch) {
      const bucket = store.variables.get(key(path));
      if (!bucket?.has(varMatch[2]!)) return ok({ message: "Not Found" }, 404);
      bucket.set(varMatch[2]!, (JSON.parse(String(init?.body)) as { value: string }).value);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && /\/(?:actions\/)?variables$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { name: string; value: string };
      const bucket = store.variables.get(key(path)) ?? new Map<string, string>();
      bucket.set(body.name, body.value);
      store.variables.set(key(path), bucket);
      return new Response(null, { status: 201 });
    }
    // Team sync and its discovery: repositories, branches, refs, files and pull requests of the simulated team repository.
    const body = parseJsonObject(init?.body);
    const repoResponse = repos(method, url, path, body);
    if (repoResponse) return repoResponse;
    return ok({ message: "Demo: nicht simuliert" }, 404);
  }) as typeof fetch;
}

/**
 * The team file the simulated team repository holds: the local team file with one changed description and one added secret
 * (made-up metadata, no values), so a first sync shows a difference. The secret appears only when the demo inventory does not hold it.
 */
export function deriveDemoTeamFile(localTeamText: string): string {
  const inv = parseTeamBundle(localTeamText);
  const secrets = inv.secrets.map((s, i) => (i === 0 ? { ...s, description: `${s.description ?? s.name} Reviewed by the platform team.` } : s));
  const added = SecretSchema.parse({
    id: "mailer-key-acme-web-staging",
    name: "MAILER_API_KEY",
    product: "acme-web",
    description: "Key for the transactional mail service of Acme Web (staging).",
    owner: "alice",
    tags: ["mail", "acme-web"],
    stage: "staging",
    service: "mailer",
    provider: "random-hex",
    expiry: "none",
    places: [{ repo: "acme-web", scope: "environment", environment: "staging" }],
  });
  return exportTeamBundle({ ...inv, secrets: secrets.some((s) => s.id === added.id) ? secrets : [...secrets, added] });
}

/** The last blob SHA the seeded team sync state remembers: the simulated repository has moved on since, so a first check shows "changed in the repository". */
export const DEMO_LAST_SYNCED_SHA = "0000000000000000000000000000000000000000";

/**
 * Demo with team sync configured: pretends the last sync happened a few days ago, when the repository still matched the local team
 * file. Without it a first check would report a conflict (both sides new). Does nothing when a state exists already.
 * Seeds only for the throw-away demo copy (`scripts/demo.mjs`, `scripts/screenshots.mjs` set SECRET_DESK_DEMO_SEED=1): a configuration
 * the user supplied themselves never gets a state file written next to it.
 */
export async function seedDemoTeamSync(rt: Runtime, now: Date = new Date()): Promise<void> {
  if (process.env.SECRET_DESK_DEMO_SEED !== "1" || !rt.config.teamSync) return;
  const file = join(dirname(rt.configPath), ".secret-desk-team-sync.json");
  const state = await readTeamSyncState(file);
  if (state.remoteSha !== null || state.localHash !== null) return;
  await writeTeamSyncState(file, { ...state, remoteSha: DEMO_LAST_SYNCED_SHA, localHash: textHash(exportTeamBundle(rt.inventory.data)), lastSyncAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(), setupDismissed: true });
}
