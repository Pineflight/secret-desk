import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InventoryStoreCore,
  MemoryEvidenceStore,
  MemoryInventoryBackend,
  SecretValue,
  SessionVault,
  parseConfig,
  type Provider,
} from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import * as nodeApi from "../src/agent-api.js";
import { translateDeep } from "../src/i18n-en.js";
import * as portable from "../src/portable.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

// The functions of `agent-api-core.ts` as an embedder gets them from the portable entry, on a runtime built by `createPortableRuntime`
// from memory parts and without a host. Each scenario runs on that runtime and on a local Node runtime (files on disk) with the same
// inputs, and the answers and the questions put to the authorisation hook are compared. Everything here is made up.
const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "bot" } as const;
const SEALED = "bWFkZS11cC1zZWFsZWQtb3V0cHV0";
/** The review points a person ticks before the commit writes. */
const TICKS = ["c1", "c2", "c3", "c4"];

const CONFIG = "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n";
const INVENTORY = `version: 1
secrets:
  - id: svc-token
    name: SVC_TOKEN
    stage: shared
    service: acme
    provider: double
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: dev-token
    name: DEV_TOKEN
    stage: dev
    service: acme
    provider: double
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
variables:
  - id: site-url
    name: NEXT_PUBLIC_SITE_URL
    stage: shared
    value: "https://staging.example.com"
    places:
      - { repo: acme-app, scope: repository }
providers:
  - { id: acme-portal, label: Acme Portal, url: "https://example.com/keys", steps: ["Open the page"] }
`;

interface Harness<R> {
  rt: R;
  hook: { actor: unknown; action: string; subject: unknown }[];
  /** Makes the next write of a GitHub secret fail (a write that was started and did not finish). */
  failPut: { on: boolean };
  double: { issued: number; revoked: string[] };
}

function makeFetch(failPut: { on: boolean }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: "made-up-public-key" }), { status: 200 });
    if (method === "PUT" && u.includes("/secrets/")) return failPut.on ? new Response("{}", { status: 500 }) : new Response(null, { status: 201 });
    if (method === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ secrets: ["SVC_TOKEN", "DEV_TOKEN", "NEW_TOKEN"].map((name) => ({ name, created_at: "c", updated_at: new Date(T0).toISOString() })) }), { status: 200 });
    if (method === "GET" && u.includes("/variables")) return new Response(JSON.stringify({ variables: [{ name: "NEXT_PUBLIC_SITE_URL", value: "https://live.example.com", created_at: "c", updated_at: "u" }] }), { status: 200 });
    return new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200 });
  }) as unknown as typeof fetch;
}

function makeDouble(state: Harness<unknown>["double"]): Provider {
  return {
    id: "double",
    label: "Double",
    kind: "automatic",
    issue: async () => {
      state.issued += 1;
      return { value: new SecretValue(`made-up-issued-value-${state.issued}`), externalId: `ext-${state.issued}` };
    },
    revoke: async (ctx) => {
      state.revoked.push(ctx.externalId);
    },
  };
}

/** The options both runtimes get: the same session token, sealer, clock and a recording hook. */
function sharedOptions(h: { hook: Harness<unknown>["hook"]; failPut: { on: boolean } }, refuse?: (action: string) => boolean, watchInventory = false) {
  const session = new SessionVault();
  session.set("github", "made-up-token");
  return {
    session,
    watchInventory,
    fetch: makeFetch(h.failPut),
    seal: async () => SEALED,
    now: () => new Date(clock),
    authorize: async (req: { actor: unknown; action: string; subject?: unknown }) => {
      h.hook.push({ actor: req.actor, action: req.action, subject: req.subject ?? null });
      if (refuse?.(req.action)) throw new nodeApi.PolicyError("made-up refusal");
    },
  };
}

let clock = T0;

async function portableHarness(refuse?: (action: string) => boolean, watchInventory = false) {
  clock = T0;
  const h = { hook: [], failPut: { on: false }, double: { issued: 0, revoked: [] } } as unknown as Harness<portable.RuntimeCore>;
  const backend = new MemoryInventoryBackend(INVENTORY);
  h.rt = await portable.createPortableRuntime({ config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(backend), evidence: new MemoryEvidenceStore() }, sharedOptions(h, refuse, watchInventory));
  h.rt.providers.register(makeDouble(h.double));
  return { ...h, backend };
}

async function nodeHarness(refuse?: (action: string) => boolean) {
  clock = T0;
  const h = { hook: [], failPut: { on: false }, double: { issued: 0, revoked: [] } } as unknown as Harness<Runtime>;
  const dir = await mkdtemp(join(tmpdir(), "sd-portable-routes-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), CONFIG);
  h.rt = await createRuntime(join(dir, "c.yaml"), { ...sharedOptions(h, refuse), vault: null });
  h.rt.providers.register(makeDouble(h.double));
  return h;
}

/** What differs between two runs only by chance: ids are random. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Approvals stamp the wall clock, not the injected one, so their times differ between two runs too.
function approvalTimes(this: unknown, key: string, value: unknown): unknown {
  return (key === "createdAt" || key === "decidedAt") && typeof this === "object" && this !== null && "targetId" in this ? "<time>" : value;
}
const norm = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null, approvalTimes).replace(UUID, "<id>"));
const outcome = async (fn: () => unknown): Promise<unknown> => {
  try {
    return { ok: norm(await fn()) };
  } catch (err) {
    return { threw: (err as Error).constructor.name, message: (err as Error).message.replace(UUID, "<id>"), code: (err as { code?: string }).code ?? null };
  }
};

type Api = typeof portable & typeof nodeApi;

/** One scenario on a runtime: every call is recorded with its normalised outcome. */
async function scenario(api: Api, h: Harness<portable.RuntimeCore>): Promise<unknown[]> {
  const rt = h.rt;
  clock = T0;
  const log: unknown[] = [];
  const step = async (name: string, fn: () => unknown) => log.push([name, await outcome(fn)]);

  // Inventory: lists, views and edits, for a human and for an agent.
  await step("overview", () => api.overview(rt, new Date(T0)));
  await step("listSecrets", () => api.listSecrets(rt, {}, new Date(T0)));
  await step("listSecrets filtered", () => api.listSecrets(rt, { stage: "dev", q: "dev" }, new Date(T0)));
  await step("getSecret", () => api.getSecret(rt, "svc-token", new Date(T0)));
  await step("getSecret missing", () => api.getSecret(rt, "nope"));
  // The local registry also holds the providers that need Node; the portable one is a subset, so compare on the shared ids.
  const shared = new Set([...createPortableRegistry().list().map((p) => p.id), "double", "acme-portal"]);
  await step("listProviders", () => api.listProviders(rt).filter((p) => shared.has(p.id)));
  await step("listVendors", () => api.listVendors());
  await step("preflightSecret", () => api.preflightSecret(rt, "svc-token"));
  await step("addSecret human", () => api.addSecret(rt, human, { id: "new-token", name: "NEW_TOKEN", stage: "shared", service: "acme", provider: "double", expiry: "none", places: [{ repo: "acme-app", scope: "repository" }] }));
  await step("addSecret agent in a stage that needs a person", () => api.addSecret(rt, agent, { id: "agent-shared", name: "AGENT_SHARED", stage: "shared", service: "acme", provider: "manual", expiry: "none", places: [] }));
  await step("addSecret agent in dev", () => api.addSecret(rt, agent, { id: "agent-dev", name: "AGENT_DEV", stage: "dev", service: "acme", provider: "manual", expiry: "none", places: [] }));
  await step("addSecret agent with an address", () => api.addSecret(rt, agent, { id: "agent-url", name: "AGENT_URL", stage: "dev", service: "acme", provider: "acme-portal", expiry: "none", params: { baseUrl: "https://example.com" }, places: [] }));
  await step("updateSecretMeta", () => api.updateSecretMeta(rt, human, "svc-token", { notes: "made-up note" }));
  await step("addManualProvider", () => api.addManualProvider(rt, human, { id: "second-portal", label: "Second Portal", url: "https://example.com/second", steps: ["Open"] }));
  await step("addManualProvider twice", () => api.addManualProvider(rt, human, { id: "second-portal", label: "Second Portal", url: "https://example.com/second", steps: ["Open"] }));
  await step("addEnvTemplate", () => api.addEnvTemplate(rt, agent, { id: "acme-dev", repo: "acme-app", stage: "dev", file: ".env.local", entries: [{ key: "SITE_URL", from: { type: "default", value: "http://localhost:3000" } }] }));
  await step("addEnvTemplate agent with a script file", () => api.addEnvTemplate(rt, agent, { id: "acme-dev-sh", repo: "acme-app", stage: "dev", file: "setup.sh", entries: [] }));
  await step("addEnvEntry", () => api.addEnvEntry(rt, agent, "acme-dev", { key: "OTHER", from: { type: "default", value: "x" } }));
  await step("teamExport", () => api.teamExport(rt));
  const connectionIds = new Set(["github", "github-app-key", "team-sync", "stripe-test", "stripe-live", ...createPortableRegistry().list().flatMap((p) => (p.connection ? [p.connection] : []))]);
  await step("listConnections", () => api.listConnections(rt).then((l) => l.filter((c) => connectionIds.has(c.id))));

  // Issuance by a person: request, confirm, evidence.
  const dry = await outcome(() => api.requestIssuance(rt, human, "svc-token", { dryRun: true }));
  log.push(["dry run", dry]);
  await step("dry run agent", () => api.requestIssuance(rt, agent, "svc-token", { dryRun: true }));
  await step("request missing", () => api.requestIssuance(rt, human, "nope"));
  const first = await api.requestIssuance(rt, human, "svc-token");
  log.push(["request", norm(first)]);
  const firstId = first.status === "awaiting-review" ? first.issuance.id : "";
  await step("listIssuances", () => api.listIssuances(rt));
  await step("getIssuance", () => api.getIssuance(rt, firstId));
  await step("confirm by an agent", () => api.confirmIssuance(rt, agent, firstId, { ticks: TICKS }));
  await step("confirm", () => api.confirmIssuance(rt, human, firstId, { ticks: TICKS }));
  await step("confirm again", () => api.confirmIssuance(rt, human, firstId, { ticks: TICKS }));
  await step("listIssuances after confirm", () => api.listIssuances(rt));
  const reports = await api.listEvidence(rt, "svc-token");
  log.push(["listEvidence", norm(reports)]);
  const reportId = reports[0]?.id ?? "";
  await step("getEvidence", () => api.getEvidence(rt, "svc-token", reportId));
  await step("getEvidence missing", () => api.getEvidence(rt, "svc-token", "nope"));
  await step("attachEvidence", () => api.attachEvidence(rt, human, "svc-token", reportId, new TextEncoder().encode("made-up-attachment"), "text/plain", "a note"));
  await step("attachEvidence agent", () => api.attachEvidence(rt, agent, "svc-token", reportId, new Uint8Array(), "text/plain"));
  await step("getEvidence with attachment", () => api.getEvidence(rt, "svc-token", reportId));

  // A person rejects a review; a manual value; the clock decides how long a review lives.
  const second = await api.requestIssuance(rt, human, "svc-token");
  const secondId = second.status === "awaiting-review" ? second.issuance.id : "";
  await step("reject", () => api.rejectIssuance(rt, human, secondId, "not needed"));
  await step("reject gone", () => api.rejectIssuance(rt, human, secondId));
  await step("manual value by an agent", () => api.submitManualValue(rt, agent, "svc-token", "made-up-manual-value"));
  const manual = await outcome(() => api.submitManualValue(rt, human, "svc-token", " made-up-manual-value "));
  log.push(["manual value", manual]);
  const third = await api.requestIssuance(rt, human, "dev-token");
  const thirdId = third.status === "awaiting-review" ? third.issuance.id : "";
  clock = T0 + 24 * 3_600_000;
  await step("expired review is gone", () => api.getIssuance(rt, thirdId));
  await step("expired reviews are not listed", () => api.listIssuances(rt));
  await step("confirm after the deadline", () => api.confirmIssuance(rt, human, thirdId, { ticks: TICKS }));
  clock = T0 + 24 * 3_600_000 + 60_000;

  // A write that was started and did not finish: reject needs the acknowledgement.
  const fourth = await api.requestIssuance(rt, human, "svc-token");
  const fourthId = fourth.status === "awaiting-review" ? fourth.issuance.id : "";
  h.failPut.on = true;
  await step("confirm with a failing write", () => api.confirmIssuance(rt, human, fourthId, { ticks: TICKS }));
  h.failPut.on = false;
  await step("reject without the acknowledgement", () => api.rejectIssuance(rt, human, fourthId));
  await step("reject with the acknowledgement", () => api.rejectIssuance(rt, human, fourthId, undefined, { acknowledgeWritten: true }));
  log.push(["revoked at the provider", [...h.double.revoked].sort()]);

  // Approvals: an agent asks, a person decides; a changed entry voids the approval.
  const asked = await api.requestIssuance(rt, agent, "svc-token", { reason: "rotation due" });
  log.push(["agent request", norm(asked)]);
  const approvalId = asked.status === "pending-approval" ? asked.approvalId : "";
  await step("listApprovals", () => api.listApprovals(rt).map((a) => ({ ...a, createdAt: "t" })));
  await step("getApproval", () => api.getApproval(rt, approvalId));
  await step("getApproval missing", () => api.getApproval(rt, "nope"));
  await step("resolve by an agent", () => api.resolveApproval(rt, agent, approvalId, "approve"));
  await step("approve", () => api.resolveApproval(rt, human, approvalId, "approve"));
  await step("approve again", () => api.resolveApproval(rt, human, approvalId, "approve"));
  await step("issuances after the approval", () => api.listIssuances(rt).then((l) => l.map((i) => ({ ...i, report: undefined }))));
  const again = await api.requestIssuance(rt, agent, "svc-token");
  const againId = again.status === "pending-approval" ? again.approvalId : "";
  rt.inventory.patchSecret("svc-token", { ttlDays: 14 });
  await step("approve after the entry changed", () => api.resolveApproval(rt, human, againId, "approve"));
  const denied = await api.requestIssuance(rt, agent, "svc-token");
  await step("deny", () => api.resolveApproval(rt, human, denied.status === "pending-approval" ? denied.approvalId : "", "deny"));
  await step("resolve missing", () => api.resolveApproval(rt, human, "nope", "approve"));

  // Variables.
  await step("listVariables", () => api.listVariables(rt, { q: "next" }));
  await step("getVariable", () => api.getVariable(rt, "site-url"));
  await step("getVariable missing", () => api.getVariable(rt, "nope"));
  await step("inspectVariableLive", () => api.inspectVariableLive(rt, "site-url"));
  await step("addVariable", () => api.addVariable(rt, human, { id: "api-url", name: "API_URL", stage: "shared", value: "https://api.example.com", places: [{ repo: "acme-app", scope: "repository" }] }));
  await step("addVariable agent in shared", () => api.addVariable(rt, agent, { id: "api-url-2", name: "API_URL_2", stage: "shared", value: "https://api.example.com", places: [] }));
  await step("updateVariable", () => api.updateVariable(rt, human, "api-url", { description: "made-up" }));
  await step("updateVariable missing", () => api.updateVariable(rt, human, "nope", {}));
  await step("requestApplyVariable human", () => api.requestApplyVariable(rt, human, "site-url"));
  const applied = await api.requestApplyVariable(rt, agent, "api-url", { reason: "needed" });
  log.push(["requestApplyVariable agent", norm(applied)]);
  await step("approve the variable", () => api.resolveApproval(rt, human, applied.status === "pending-approval" ? applied.approvalId : "", "approve"));
  await step("adoptVariableFromGitHub", () => api.adoptVariableFromGitHub(rt, human, "site-url"));
  await step("removeVariable by an agent", () => api.removeVariable(rt, agent, "api-url"));
  await step("removeVariable", () => api.removeVariable(rt, human, "api-url"));

  // The sheet as an image.
  await step("evidenceSvg", () => api.evidenceSvg(rt, "svc-token", reportId));
  // The portable function takes the translate function as a fifth argument; the local one binds the English catalogue itself and ignores it.
  const withCatalogue = api.evidenceSvg as unknown as (...args: unknown[]) => Promise<string>;
  await step("evidenceSvg en", () => withCatalogue(rt, "svc-token", reportId, "en", (text: string) => translateDeep(text, "en")));
  await step("readAttachment", () => api.readAttachment(rt, "svc-token", reportId, "none"));
  log.push(["hook", norm(h.hook)]);
  return log;
}

describe("the route functions on a runtime from createPortableRuntime, without a host", () => {
  it("answer like the local runtime and ask the authorisation hook the same questions in the same order", async () => {
    const onPortable = await portableHarness();
    const onNode = await nodeHarness();
    // The local runtime has a host-less Node runtime too: no environment, no process is involved on either side.
    expect(onPortable.rt.host).toBeUndefined();
    const fromPortable = await scenario(portable as unknown as Api, onPortable);
    const fromNode = await scenario(nodeApi as unknown as Api, onNode);
    expect(fromPortable).toEqual(fromNode);
    // The comparison is not between two sets of errors: the paths that matter ended the way they should.
    const byName = new Map(fromPortable.map((entry) => [(entry as [string, unknown])[0], (entry as [string, unknown])[1] as Record<string, any>]));
    expect(byName.get("confirm")!.ok).toMatchObject({ ok: true, partial: false, places: [{ place: "acme-app/repo", outcome: "created" }] });
    expect(byName.get("reject")!.ok).toEqual({ revokedNew: true });
    expect(byName.get("expired review is gone")!).toMatchObject({ threw: "IssuanceGoneError", code: "issuance-gone" });
    expect(byName.get("reject without the acknowledgement")!).toMatchObject({ threw: "IssuanceWrittenError", code: "write-started" });
    expect(byName.get("reject with the acknowledgement")!.ok).toEqual({ revokedNew: true });
    expect(byName.get("approve")!.ok).toMatchObject({ state: "approved" });
    expect(byName.get("approve after the entry changed")!.ok).toMatchObject({ state: "stale" });
    expect(byName.get("deny")!.ok).toMatchObject({ state: "denied" });
    expect(byName.get("approve the variable")!.ok).toMatchObject({ state: "approved" });
    expect(byName.get("requestApplyVariable human")!.ok).toMatchObject({ status: "applied" });    // The scenario really did the work: a value was written, approvals were decided, the hook was asked for the sensitive actions.
    const asked = (onPortable.hook as { action: string }[]).map((c) => c.action);
    for (const action of ["inventory.edit", "issuance.prepare", "issuance.confirm", "issuance.reject", "issuance.manual-value", "approval.resolve", "variable.apply", "evidence.attach"]) expect(asked, action).toContain(action);
    expect(onPortable.double.issued).toBe(onNode.double.issued);
    expect(onPortable.double.revoked.length).toBeGreaterThan(0);
  });

  it("every refusal of the hook stops the action on the portable runtime exactly where it stops on the local one", async () => {
    for (const action of ["inventory.edit", "issuance.prepare", "issuance.confirm", "issuance.reject", "approval.resolve", "variable.apply", "evidence.attach", "issuance.manual-value"]) {
      const onPortable = await portableHarness((a) => a === action);
      const onNode = await nodeHarness((a) => a === action);
      const run = async (h: Harness<portable.RuntimeCore>, api: Api) => {
        const rt = h.rt;
        const log: unknown[] = [];
        log.push(await outcome(() => api.updateSecretMeta(rt, human, "svc-token", { notes: "n" })));
        // A fresh review for each of the two actions on it (a refused request leaves none, and the action then finds nothing).
        const review = async (): Promise<string> => {
          const req = await outcome(() => api.requestIssuance(rt, human, "svc-token"));
          log.push(req);
          return (await api.listIssuances(rt))[0]?.id ?? "";
        };
        const toConfirm = await review();
        log.push(await outcome(() => api.confirmIssuance(rt, human, toConfirm, { ticks: TICKS })));
        const toReject = await review();
        log.push(await outcome(() => api.rejectIssuance(rt, human, toReject)));
        log.push(await outcome(() => api.submitManualValue(rt, human, "svc-token", "made-up-manual-value")));
        const ask = await outcome(() => api.requestIssuance(rt, agent, "svc-token"));
        log.push(ask);
        const approvalId = rt.approvals.list()[0]?.id ?? "";
        log.push(await outcome(() => api.resolveApproval(rt, human, approvalId, "approve")));
        log.push(await outcome(() => api.requestApplyVariable(rt, human, "site-url")));
        log.push(await outcome(() => api.attachEvidence(rt, human, "svc-token", "r", new Uint8Array(), "text/plain")));
        log.push(await outcome(() => api.listIssuances(rt).then((l) => l.length)));
        return log;
      };
      const a = await run(onPortable, portable as unknown as Api);
      const b = await run(onNode, nodeApi as unknown as Api);
      expect(a, action).toEqual(b);
      expect(JSON.stringify(a), action).toContain("made-up refusal");
    }
  });

  it("a refusal by the hook that is not a PolicyError is one generic refusal, and a value returned by the hook refuses too", async () => {
    const faults: unknown[] = [];
    const backend = new MemoryInventoryBackend(INVENTORY);
    const kinds = [
      async () => {
        throw new Error("made-up internal detail");
      },
      async () => "allowed" as unknown as undefined,
    ];
    for (const hook of kinds) {
      const rt = await portable.createPortableRuntime(
        { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(backend.text!)), evidence: new MemoryEvidenceStore() },
        { authorize: hook, onAuthorizeFault: (f) => faults.push(f) },
      );
      const err = await portable.updateSecretMeta(rt, human, "svc-token", { notes: "n" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(portable.PolicyError);
      expect(String((err as Error).message)).not.toContain("made-up internal detail");
    }
    expect(faults).toEqual([{ action: "inventory.edit", reason: "threw", errorName: "Error" }, { action: "inventory.edit", reason: "returned-value" }]);
  });

  it("a forged actor kind never reaches the hook, and a routine of the process is asked as the system", async () => {
    const hook = vi.fn(async () => undefined);
    const rt = await portable.createPortableRuntime({ config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY)), evidence: new MemoryEvidenceStore() }, { authorize: hook });
    await expect(portable.authorize(rt, { actor: { kind: "system", name: "x" } as never, action: "inventory.edit" })).rejects.toBeInstanceOf(portable.PolicyError);
    expect(hook).not.toHaveBeenCalled();
    expect(await portable.authorizeSystem(rt, "team-sync-startup", "team.sync.apply")).toBe(true);
    expect(hook).toHaveBeenCalledWith({ actor: { kind: "system", name: "team-sync-startup" }, action: "team.sync.apply" });
    expect(portable.SYSTEM_ROUTINES).toContain("team-sync-startup");
    expect(portable.DEFAULT_AUTHORIZE_TIMEOUT_MS).toBe(10_000);
  });

  it("without browser automation an agent's request for a browser provider cannot arise, the status is idle and a cancel is refused", async () => {
    const { rt } = await portableHarness();
    expect(await portable.getAutomation(rt, human)).toMatchObject({ enabled: false, runs: [], recipes: [] });
    expect(portable.getAutomationRun(rt, human, "svc-token")).toMatchObject({ status: "idle", secretId: "svc-token" });
    expect(() => portable.cancelAutomationRun(rt, human, "svc-token")).toThrow(portable.AutomationUnavailableError);
    await expect(portable.getAutomation(rt, agent)).rejects.toBeInstanceOf(portable.PolicyError);
    expect(() => portable.getAutomationRun(rt, agent, "svc-token")).toThrow(portable.PolicyError);
    expect(() => portable.cancelAutomationRun(rt, agent, "svc-token")).toThrow(portable.PolicyError);
    expect(portable.listProviders(rt).every((p) => p.browser === false)).toBe(true);
  });

  it("an approval is voided by a change of the inventory that arrives from outside", async () => {
    const { rt, backend } = await portableHarness(undefined, true);
    const asked = await portable.requestIssuance(rt, agent, "svc-token");
    if (asked.status !== "pending-approval") throw new Error("expected an approval");
    expect(portable.listApprovals(rt).map((a) => [a.id, a.state])).toEqual([[asked.approvalId, "pending"]]);
    // Another writer changes the entry (a ttl): the queue revalidates what it holds.
    backend.replaceExternally(INVENTORY.replace("    expiry: none\n    places:\n      - { repo: acme-app, scope: repository }\n  - id: dev-token", "    expiry: none\n    ttlDays: 14\n    places:\n      - { repo: acme-app, scope: repository }\n  - id: dev-token"));
    await vi.waitFor(() => expect(portable.getApproval(rt, asked.approvalId).state).toBe("stale"));
    await expect(portable.resolveApproval(rt, human, asked.approvalId, "approve")).rejects.toThrow("Anfrage ist schon erledigt: stale");
    expect(rt.issuances.list()).toEqual([]);
  });

  it("the pending deadline follows the injected clock, with no sweep needed", async () => {
    const { rt, double } = await portableHarness();
    const asked = await portable.requestIssuance(rt, human, "svc-token");
    if (asked.status !== "awaiting-review") throw new Error("expected a review");
    const { id, expiresAt } = asked.issuance;
    expect(Date.parse(expiresAt)).toBeGreaterThan(T0);
    clock = Date.parse(expiresAt) - 1;
    expect((await portable.getIssuance(rt, id)).id).toBe(id);
    clock = Date.parse(expiresAt) + 1;
    await expect(portable.getIssuance(rt, id)).rejects.toBeInstanceOf(portable.IssuanceGoneError);
    expect(await portable.listIssuances(rt)).toEqual([]);
    // The next sweep deletes the value this process issued but nobody confirmed, at the provider.
    await rt.sweep();
    expect(double.revoked).toEqual(["ext-1"]);
  });

  it("evidenceSvg translates the check texts only when the caller passes a translate function", async () => {
    const { rt } = await portableHarness();
    const asked = await portable.requestIssuance(rt, human, "svc-token");
    if (asked.status !== "awaiting-review") throw new Error("expected a review");
    await portable.confirmIssuance(rt, human, asked.issuance.id, { ticks: TICKS });
    const reportId = (await portable.listEvidence(rt, "svc-token"))[0]!.id;
    const marked = (text: string): string => `[en] ${text}`;
    const de = await portable.evidenceSvg(rt, "svc-token", reportId);
    const enPlain = await portable.evidenceSvg(rt, "svc-token", reportId, "en");
    const enTranslated = await portable.evidenceSvg(rt, "svc-token", reportId, "en", marked);
    const deIgnoresIt = await portable.evidenceSvg(rt, "svc-token", reportId, "de", marked);
    expect(deIgnoresIt).toBe(de);
    expect(enTranslated).not.toBe(enPlain);
    expect(enTranslated).toContain("[en] ");
    expect(enPlain).not.toContain("[en] ");
    // The local edition binds the English catalogue: the same function with that translate function gives the same sheet.
    const node = await nodeHarness();
    const nodeAsked = await nodeApi.requestIssuance(node.rt, human, "svc-token");
    if (nodeAsked.status !== "awaiting-review") throw new Error("expected a review");
    await nodeApi.confirmIssuance(node.rt, human, nodeAsked.issuance.id, { ticks: TICKS });
    const nodeReport = (await nodeApi.listEvidence(node.rt, "svc-token"))[0]!.id;
    const local = await nodeApi.evidenceSvg(node.rt, "svc-token", nodeReport, "en");
    const bound = await portable.evidenceSvg(node.rt, "svc-token", nodeReport, "en", (t) => translateDeep(t, "en"));
    expect(local).toBe(bound);
    expect(await nodeApi.evidenceSvg(node.rt, "svc-token", nodeReport)).toBe(await portable.evidenceSvg(node.rt, "svc-token", nodeReport));
  });

  it("the portable entry exports the functions by name and nothing that marks a write as started or skips the revoke gate", () => {
    for (const name of [
      "authorize", "authorizeSystem", "listSecrets", "getSecret", "overview", "listVendors", "listProviders", "listConnections", "addSecret", "preflightSecret", "updateSecretMeta",
      "addManualProvider", "addEnvTemplate", "addEnvEntry", "teamExport", "requestIssuance", "submitManualValue", "listIssuances", "getIssuance", "confirmIssuance", "rejectIssuance",
      "listEvidence", "getEvidence", "evidenceSvg", "attachEvidence", "readAttachment", "listVariables", "getVariable", "inspectVariableLive", "addVariable", "updateVariable",
      "removeVariable", "requestApplyVariable", "adoptVariableFromGitHub", "listApprovals", "getApproval", "resolveApproval", "getAutomation", "getAutomationRun", "cancelAutomationRun",
      "PolicyError", "IssuanceGoneError", "IssuanceWrittenError", "requireHuman", "actorRef", "SYSTEM_ROUTINES", "DEFAULT_AUTHORIZE_TIMEOUT_MS", "AGENT_ENV_FILENAME",
    ]) expect(portable, name).toHaveProperty(name);
    // Node-bound: stays on the root entry only.
    for (const name of ["exportEnv", "agentMayWriteEnvFile", "revokeNewValue", "commitIssuance", "prepareIssuance", "discardIssuance", "markWriteStarted", "buildRuntime"]) expect(portable, name).not.toHaveProperty(name);
    expect(portable.evidenceSvg).not.toBe(nodeApi.evidenceSvg);
  });
});
