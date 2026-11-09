import { vi } from "vitest";
import { resetSessionForTests } from "@/lib/api";

/** Reply of a fake route: a plain value becomes a 200 JSON answer, `{ status, body }` sets the status. */
export type FakeReply = unknown | { status: number; body?: unknown };
export type FakeHandler = FakeReply | ((call: PortalCall) => FakeReply | Promise<FakeReply>);

export interface PortalCall {
  method: string;
  /** Path below `/api/ui/`, with the query string, e.g. `entries?kind=secret`. */
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body, the FormData itself, or undefined. */
  body: unknown;
}

export interface FakePortal {
  calls: PortalCall[];
  /** Calls to one route, e.g. `portal.callsTo("POST", "entries")`. */
  callsTo(method: string, path: string): PortalCall[];
}

export const FAKE_CSRF = "csrf-for-tests";

const isReply = (v: unknown): v is { status: number; body?: unknown } =>
  typeof v === "object" && v !== null && "status" in v && typeof (v as { status: unknown }).status === "number";

/**
 * Replaces `fetch` for the portal API client (`src/lib/api.ts`). `/api/session` always succeeds with a fake CSRF value.
 * Routes are keyed `"METHOD path"` (path without the `/api/ui/` prefix, query string included); a key ending in `*` matches a
 * path prefix, so `"GET providers/acme/params*"` takes any query. An unknown route answers 404 so the test fails loudly.
 * Restored by `vi.unstubAllGlobals()` in test/setup-dom.ts.
 */
export function fakePortal(routes: Record<string, FakeHandler> = {}): FakePortal {
  resetSessionForTests();
  const calls: PortalCall[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return json(200, { csrf: FAKE_CSRF, user: "tester", demo: false, owner: "tester" });
      const path = url.replace(/^\/api\/ui\//, "");
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const call: PortalCall = { method, path, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
      calls.push(call);
      const wanted = `${method} ${path}`;
      const handler = routes[wanted] ?? routes[Object.keys(routes).find((k) => k.endsWith("*") && wanted.startsWith(k.slice(0, -1))) ?? ""];
      if (handler === undefined) return json(404, { error: `no fake route for ${method} ${path}` });
      const reply = typeof handler === "function" ? await (handler as (c: PortalCall) => FakeReply | Promise<FakeReply>)(call) : handler;
      return isReply(reply) ? json(reply.status, reply.body ?? {}) : json(200, reply);
    }),
  );
  return { calls, callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path) };
}
