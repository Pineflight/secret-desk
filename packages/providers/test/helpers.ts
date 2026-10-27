import { vi } from "vitest";
import { ConnectionStore, SecretSchema, SecretValue, type IssueContext, type RevokeContext, type Stage, type StageKind, type VerifyContext } from "@secret-desk/core";

export const CONN_TOKEN = "CONN-TOKEN-1234567890";
export const ISSUED = "ISSUED-VALUE-ABCDEFGH";

/** Fehlerantwort, die beide Werte enthaelt. */
export const LEAK = JSON.stringify({ message: `denied ${CONN_TOKEN}`, value: ISSUED });

export type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | undefined };
export type Reply = { status?: number; body?: unknown };

/** Gemocktes fetch: antwortet der Reihe nach, merkt sich alle Aufrufe. */
export function mockFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
      signal: init?.signal ?? undefined,
    });
    const r = replies[Math.min(i++, replies.length - 1)] ?? { status: 204 };
    const status = r.status ?? 200;
    const text = r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(status === 204 ? null : text, { status });
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export function connections(...ids: string[]): ConnectionStore {
  const store = new ConnectionStore();
  for (const id of ids) store.session.set(id, CONN_TOKEN);
  return store;
}

export function secretEntry(extra: Record<string, unknown> = {}) {
  return SecretSchema.parse({ id: "test-secret", name: "TEST_SECRET", service: "test", stage: "dev", ...extra });
}

export function issueCtx(f: typeof fetch, params: Record<string, unknown>, opts: { conns?: string[]; ttlDays?: number } = {}): IssueContext {
  return {
    secret: secretEntry(opts.ttlDays ? { ttlDays: opts.ttlDays } : {}),
    params,
    stage: "dev",
    connections: connections(...(opts.conns ?? [])),
    fetch: f,
    now: new Date("2026-11-01T10:00:00Z"),
    label: "test-secret-2026-11-01",
  };
}

export function revokeCtx(f: typeof fetch, params: Record<string, unknown>, externalId: string, conns: string[]): RevokeContext {
  return { externalId, secret: secretEntry(), params, connections: connections(...conns), fetch: f };
}

export function verifyCtx(
  f: typeof fetch,
  params: Record<string, unknown>,
  opts: { value?: string; stage?: Stage; stageKind?: StageKind; conns?: string[]; ttlDays?: number; externalId?: string; expiresAt?: string | null } = {},
): VerifyContext {
  return {
    secret: secretEntry(opts.ttlDays ? { ttlDays: opts.ttlDays } : {}),
    params,
    stage: opts.stage ?? "dev",
    ...(opts.stageKind ? { stageKind: opts.stageKind } : {}),
    value: new SecretValue(opts.value ?? ISSUED),
    ...(opts.externalId ? { externalId: opts.externalId } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    connections: connections(...(opts.conns ?? [])),
    fetch: f,
    now: new Date("2026-11-01T10:00:00Z"),
  };
}

/** Beleg: weder Wert noch Verbindungs-Token in den Befunden. */
export function expectNoLeak(checks: unknown, extra: string[] = []): void {
  const s = JSON.stringify(checks);
  for (const bad of [ISSUED, CONN_TOKEN, ...extra]) if (s.includes(bad)) throw new Error(`Befunde enthalten einen Wert: ${bad.slice(0, 4)}...`);
}

export const byId = (checks: { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
