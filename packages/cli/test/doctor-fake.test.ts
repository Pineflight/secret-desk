import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError, WorkerSecretsError } from "@secret-desk/core";

const m = vi.hoisted(() => ({ listConnections: vi.fn() }));
vi.mock("@secret-desk/runtime", async (importOriginal) => ({ ...(await importOriginal<typeof import("@secret-desk/runtime")>()), listConnections: m.listConnections }));

import { runDoctor } from "../src/doctor.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const secret = (id: string, provider: string, places: unknown[]) => ({ id, provider, places });
const variable = (places: unknown[]) => ({ places });
const repoPlace = { repo: "web", scope: "repository" };
const envPlace = { repo: "web", scope: "environment", environment: "staging" };
const orgPlace = { repo: "acme", scope: "organization" };
const workerPlace = { scope: "cloudflare-worker", accountId: ACCOUNT, script: "portal" };

interface Opts {
  secrets?: unknown[];
  variables?: unknown[];
  connected?: Record<string, { source?: string; hint?: string }>;
  listed?: unknown[];
  providers?: Record<string, { connection?: string }>;
  agentStages?: string[];
  stages?: { id: string; kind: string }[];
  fetch?: () => Promise<unknown>;
  publicKey?: (target: unknown) => Promise<unknown>;
  check?: () => Promise<unknown>;
}

function fakeRuntime(o: Opts = {}) {
  const connected = o.connected ?? {};
  m.listConnections.mockResolvedValue(o.listed ?? []);
  return {
    owner: "acme",
    config: { policy: { agentStages: o.agentStages } },
    inventory: { data: { stages: o.stages ?? [{ id: "dev", kind: "dev" }, { id: "staging", kind: "test" }], secrets: o.secrets ?? [], variables: o.variables ?? [], envTemplates: [{ stage: "dev" }, { stage: "staging" }] } },
    providers: { get: (id: string) => o.providers?.[id] },
    connections: {
      status: async (id: string) => ({ id, connected: id in connected, source: connected[id]?.source ?? "env", ...(connected[id]?.hint ? { hint: connected[id]!.hint } : {}) }),
      token: async () => ({ reveal: () => "made-up-token" }),
    },
    github: { publicKey: vi.fn(o.publicKey ?? (async () => ({}))) },
    workers: { check: vi.fn(o.check ?? (async () => ({}))) },
    fetch: vi.fn(o.fetch ?? (async () => new Response("{}", { status: 200 }))),
  } as never;
}
const find = (list: { id: string }[], id: string) => list.find((f) => f.id === id);

beforeEach(() => m.listConnections.mockReset());

describe("doctor with a fake runtime", () => {
  it("lists inventory counts and the policy; an unknown provider fails, manual passes", async () => {
    const f = await runDoctor(fakeRuntime({ secrets: [secret("s1", "manual", []), secret("s2", "ghost", [])], agentStages: ["dev"] }));
    expect(f[0]).toMatchObject({ id: "inventory", status: "ok", label: "Inventar gelesen: 2 Secrets, 0 Variablen, 2 Vorlagen" });
    expect(find(f, "provider:s2")).toMatchObject({ status: "fail", label: 'Unbekannter Anbieter "ghost" bei s2' });
    expect(find(f, "provider:s1")).toBeUndefined();
    expect(find(f, "policy")).toMatchObject({ status: "ok", label: "Richtlinie: Agenten direkt nur in [dev], 1 Dev-Vorlagen" });
    expect(find(f, "policy")).not.toHaveProperty("detail");
  });

  it("a policy that names unknown stages is a warning with the names", async () => {
    const f = await runDoctor(fakeRuntime({ agentStages: ["dev", "typo"] }));
    expect(find(f, "policy")).toMatchObject({ status: "warn", detail: "policy.agentStages nennt unbekannte Stages: typo" });
  });

  it("the connection a provider needs is checked; the status list wins over a fresh lookup; hints become details", async () => {
    const f = await runDoctor(
      fakeRuntime({
        secrets: [secret("s1", "acme-token", [])],
        providers: { "acme-token": { connection: "acme" } },
        listed: [{ id: "github", connected: true, source: "vault" }],
        connected: { acme: { source: "env", hint: "Token laeuft bald ab" } },
      }),
    );
    expect(find(f, "connection:github")).toMatchObject({ status: "ok", label: "Verbindung github: verbunden (vault)" });
    expect(find(f, "connection:acme")).toMatchObject({ status: "ok", label: "Verbindung acme: verbunden (env)", detail: "Token laeuft bald ab" });
  });

  it("an unconnected provider is a warning, an unconnected GitHub is a failure", async () => {
    const f = await runDoctor(fakeRuntime({ secrets: [secret("s1", "acme-token", [])], providers: { "acme-token": { connection: "acme" } } }));
    expect(find(f, "connection:github")).toMatchObject({ status: "fail", label: "Verbindung github: nicht verbunden" });
    expect(find(f, "connection:acme")).toMatchObject({ status: "warn" });
    expect(find(f, "targets")).toMatchObject({ status: "warn" });
  });

  describe("GitHub targets", () => {
    it("checks each distinct place once and labels repository, environment and organization places", async () => {
      const rt = fakeRuntime({ connected: { github: {} }, secrets: [secret("s1", "manual", [repoPlace, envPlace])], variables: [variable([repoPlace, orgPlace])] });
      const f = await runDoctor(rt);
      expect(f.filter((x) => x.id.startsWith("target:")).map((x) => [x.id, x.status])).toEqual([
        ["target:web/repo", "ok"],
        ["target:web/env:staging", "ok"],
        ["target:acme/org", "ok"],
      ]);
      expect((rt as unknown as { github: { publicKey: unknown } }).github.publicKey).toHaveBeenCalledTimes(3);
      expect((rt as unknown as { github: { publicKey: { mock: { calls: unknown[][] } } } }).github.publicKey.mock.calls[1]![0]).toEqual({ owner: "acme", repo: "web", scope: "environment", environment: "staging" });
    });

    it("a GitHub App key counts as a GitHub connection", async () => {
      const f = await runDoctor(fakeRuntime({ connected: { "github-app-key": {} }, secrets: [secret("s1", "manual", [repoPlace])] }));
      expect(find(f, "target:web/repo")).toMatchObject({ status: "ok" });
      expect(find(f, "targets")).toBeUndefined();
    });

    it("explains 404, 403 and any other error", async () => {
      const errors = new Map<string, Error>([
        ["web", new GitHubError(404, "Not Found")],
        ["denied", new GitHubError(403, "Forbidden")],
        ["other", new Error("socket hang up")],
        ["server", new GitHubError(500, "Internal Server Error")],
      ]);
      const places = [...errors.keys()].map((repo) => ({ repo, scope: "repository" }));
      const f = await runDoctor(fakeRuntime({ connected: { github: {} }, secrets: [secret("s1", "manual", places)], publicKey: async (t) => { throw errors.get((t as { repo: string }).repo)!; } }));
      expect(find(f, "target:web/repo")).toMatchObject({ status: "fail", label: "Ziel nicht nutzbar: web/repo", detail: "Repo oder Environment existiert nicht, oder der Token hat keinen Zugriff." });
      expect(find(f, "target:denied/repo")!).toMatchObject({ status: "fail", detail: "Dem Token fehlt das Recht Secrets: Read and write (Environments: Read)." });
      expect(find(f, "target:other/repo")).toMatchObject({ detail: "socket hang up" });
      expect(find(f, "target:server/repo")).toMatchObject({ detail: "Internal Server Error" });
    });
  });

  describe("Cloudflare Worker places", () => {
    const withWorker = (o: Opts = {}) => fakeRuntime({ secrets: [secret("s1", "manual", [workerPlace, workerPlace])], ...o });

    it("a connected Cloudflare account checks each Worker once", async () => {
      const rt = withWorker({ connected: { cloudflare: {} } });
      const f = await runDoctor(rt);
      expect(find(f, "target:worker:portal")).toMatchObject({ status: "ok", label: "Worker erreichbar, Secrets lesbar: worker:portal" });
      expect((rt as unknown as { workers: { check: unknown } }).workers.check).toHaveBeenCalledTimes(1);
    });

    it("reports a Worker that cannot be used, with the error message", async () => {
      const f = await runDoctor(withWorker({ connected: { cloudflare: {} }, check: async () => { throw new WorkerSecretsError(404, "Worker nicht gefunden"); } }));
      expect(find(f, "target:worker:portal")).toMatchObject({ status: "fail", detail: "Worker nicht gefunden" });
      const g = await runDoctor(withWorker({ connected: { cloudflare: {} }, check: async () => { throw new Error("timeout"); } }));
      expect(find(g, "target:worker:portal")).toMatchObject({ status: "fail", detail: "timeout" });
    });

    it("without a Cloudflare connection only a hint", async () => {
      const f = await runDoctor(withWorker());
      expect(find(f, "worker-targets")).toMatchObject({ status: "warn" });
      expect(find(f, "connection:cloudflare")).toMatchObject({ status: "warn" });
    });
  });

  describe("Cloudflare access token", () => {
    const cf = (o: Opts = {}) => fakeRuntime({ secrets: [secret("s1", "cloudflare-token", [])], providers: { "cloudflare-token": { connection: "cloudflare" } }, connected: { cloudflare: {} }, ...o });

    it("is active; the expiry date is shown", async () => {
      const rt = cf({ fetch: async () => new Response(JSON.stringify({ result: { status: "active", expires_on: "2027-05-06T00:00:00Z" } }), { status: 200 }) });
      const f = await runDoctor(rt);
      expect(find(f, "cloudflare-token")).toMatchObject({ status: "ok", label: "Cloudflare-Zugangs-Token: aktiv", detail: "laeuft ab: 2027-05-06" });
      expect((rt as unknown as { fetch: { mock: { calls: unknown[][] } } }).fetch.mock.calls[0]![0]).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
      expect(JSON.stringify(f)).not.toContain("made-up-token");
    });

    it("an inactive token or an HTTP error fails; a body that is not JSON counts as no answer", async () => {
      const inactive = await runDoctor(cf({ fetch: async () => new Response(JSON.stringify({ result: { status: "disabled" } }), { status: 200 }) }));
      expect(find(inactive, "cloudflare-token")).toMatchObject({ status: "fail", label: "Cloudflare-Zugangs-Token: nicht nutzbar (HTTP 200)" });
      expect(find(inactive, "cloudflare-token")).not.toHaveProperty("detail");
      const unauthorized = await runDoctor(cf({ fetch: async () => new Response("<html>", { status: 401 }) }));
      expect(find(unauthorized, "cloudflare-token")).toMatchObject({ status: "fail", label: "Cloudflare-Zugangs-Token: nicht nutzbar (HTTP 401)" });
    });

    it("a network error is a warning with a shortened message", async () => {
      const f = await runDoctor(cf({ fetch: async () => { throw new Error("x".repeat(300)); } }));
      expect(find(f, "cloudflare-token")).toMatchObject({ status: "warn", label: "Cloudflare-Zugangs-Token nicht pruefbar", detail: "x".repeat(120) });
    });

    it("is skipped without a Cloudflare connection", async () => {
      const f = await runDoctor(cf({ connected: {} }));
      expect(find(f, "cloudflare-token")).toBeUndefined();
    });
  });
});
