import sodium from "libsodium-wrappers";

/**
 * Demo-Modus (SECRET_DESK_DEMO=1): ein simuliertes GitHub im Arbeitsspeicher, damit sich das Portal ohne Konten
 * ausprobieren laesst. Es werden nirgends echte Anfragen gesendet.
 */
interface Store {
  secrets: Map<string, Map<string, string>>;
  variables: Map<string, Map<string, string>>;
}

const key = (path: string): string => path.replace(/\/(actions\/)?(secrets|variables).*$/, "");

export async function createDemoFetch(): Promise<typeof fetch> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const now = (): string => new Date().toISOString();
  const store: Store = {
    secrets: new Map([
      ["/repos/acme/acme-app", new Map([["CLOUDFLARE_API_TOKEN", "2026-08-12T09:00:00Z"], ["VAPID_PRIVATE_KEY", "2026-08-12T09:00:00Z"]])],
      ["/repos/acme/acme-app/environments/staging", new Map([["VESSELAPI_API_KEY", "2026-09-02T10:00:00Z"], ["ARTIFACT_HMAC_SECRET", "2026-09-02T10:00:00Z"]])],
      ["/repos/acme/acme-web/environments/staging", new Map([["STRIPE_WEBHOOK_SECRET", "2026-09-29T08:00:00Z"]])],
      ["/repos/acme/acme-docs/environments/staging", new Map()],
    ]),
    variables: new Map([
      ["/repos/acme/acme-app", new Map([["REVENUECAT_PROJECT_ID", "proj_demo_123"]])],
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
    return ok({ message: "Demo: nicht simuliert" }, 404);
  }) as typeof fetch;
}
