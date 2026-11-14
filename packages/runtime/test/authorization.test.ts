import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, prepareIssuance, type ActorRef } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import {
  PolicyError,
  actorRef,
  addEnvEntry,
  addEnvTemplate,
  addManualProvider,
  addSecret,
  addVariable,
  adoptVariableFromGitHub,
  attachEvidence,
  authorize,
  confirmIssuance,
  exportEnv,
  getApproval,
  listApprovals,
  listEvidence,
  listIssuances,
  rejectIssuance,
  removeVariable,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  submitManualValue,
  updateSecretMeta,
  updateVariable,
  type Actor,
  type AuthorizationRequest,
  type Authorize,
  type IssuanceView,
} from "../src/agent-api.js";
import { runGitHubSync } from "../src/github-sync.js";
import { applyNormalizationChanges } from "../src/normalize.js";
import { exportEnvContent } from "../src/env-content.js";
import { CLAIM_GRACE_MS } from "../src/issuances.js";
import { createLocalRuntime, issuanceDeps, type Runtime, type RuntimeOptions } from "../src/runtime.js";

const INVENTORY = `version: 1
secrets:
  - id: stripe-webhook-acme-docs-staging
    name: STRIPE_WEBHOOK_SECRET
    stage: staging
    service: stripe
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    product: acme-app
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: cf-deploy-acme-app
    name: CLOUDFLARE_API_TOKEN
    stage: shared
    service: cloudflare
    provider: manual
    expiry: possible
    expires: "2026-11-10"
    places:
      - { repo: acme-app, scope: repository }
variables:
  - id: site-url-staging
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: acme-project
    name: ACME_PROJECT_ID
    stage: shared
    places:
      - { repo: acme-app, scope: repository }
envTemplates:
  - id: acme-docs-dev
    repo: acme-docs
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
`;

const PLACE = [{ repo: "acme-app", scope: "repository" as const }];
const MANUAL = "cf_made_up_manual_value_424242";
const REFUSAL = "refused by test hook";
const GENERIC = "Die Berechtigungspruefung hat die Aktion nicht zugelassen.";

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;
const aliceP = { kind: "human", name: "alice", principalId: "principal-a" } as const;
const bobP = { kind: "human", name: "bob", principalId: "principal-b" } as const;

async function setup(hook?: Authorize | undefined, extra: Partial<RuntimeOptions> = {}, gate?: (method: string, url: string) => Promise<void>) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const calls: string[] = [];
  const written: string[] = [];
  const live: Record<string, string> = { "/acme-docs/environments/staging/variables": "https://alt.example.com", "/acme-app/actions/variables": "proj_1" };
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    await gate?.(method, u);
    if (method === "PUT" && typeof init?.body === "string") {
      const enc = (JSON.parse(init.body) as { encrypted_value?: string }).encrypted_value;
      if (enc) written.push(sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(enc, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)));
    }
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (method === "GET" && u.includes("/variables")) {
      const key = Object.keys(live).find((k) => u.includes(k));
      const names: Record<string, string> = { "/acme-docs/environments/staging/variables": "NEXT_PUBLIC_SITE_URL", "/acme-app/actions/variables": "ACME_PROJECT_ID" };
      return new Response(JSON.stringify({ variables: key ? [{ name: names[key], value: live[key], created_at: "c", updated_at: "u" }] : [] }), { status: 200 });
    }
    if (method === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ secrets: [{ name: "ARTIFACT_HMAC_SECRET", created_at: "c", updated_at: new Date().toISOString() }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-authz-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml
github:
  owner: acme
  auth: { type: pat, source: { type: env, name: GH_TEST } }
policy:
  agentStages: [dev]
  envRoots: [${JSON.stringify(dir)}]
`,
  );
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock, ...(hook !== undefined ? { authorize: hook } : {}), ...extra });
  return { rt, dir, calls, written };
}

/** A hook that records every request and delegates the decision. */
function recorder(decide: (request: AuthorizationRequest) => void | Promise<void> = () => undefined) {
  const seen: AuthorizationRequest[] = [];
  const hook: Authorize = (request) => {
    seen.push(request);
    return decide(request);
  };
  return { seen, hook };
}

const refuse = (): never => {
  throw new PolicyError(REFUSAL);
};

const writes = (calls: string[]): string[] => calls.filter((c) => !c.startsWith("GET"));
const ticksOf = (view: IssuanceView): string[] => view.report.checklist.map((c) => c.id);
const summary = (seen: AuthorizationRequest[]) => seen.map((r) => [r.action, r.subject]);

async function prepared(rt: Runtime, actor: Actor = human): Promise<IssuanceView> {
  const r = await requestIssuance(rt, actor, "hmac-acme-app");
  if (r.status !== "awaiting-review") throw new Error("expected a review");
  return r.issuance;
}

async function pendingApproval(rt: Runtime, secretId = "hmac-acme-app"): Promise<string> {
  const r = await requestIssuance(rt, agent, secretId);
  if (r.status !== "pending-approval") throw new Error("expected an approval request");
  return r.approvalId;
}

describe("the authorisation hook itself", () => {
  it("is kept on the runtime when given, and absent otherwise", async () => {
    const { hook } = recorder();
    expect((await setup(hook)).rt.authorize).toBe(hook);
    expect("authorize" in (await setup()).rt).toBe(false);
  });

  it("without a hook the helper returns at once", async () => {
    const { rt } = await setup();
    await expect(authorize(rt, { actor: human, action: "inventory.edit" })).resolves.toBeUndefined();
  });

  it("hands the hook a copy: what the hook changes does not reach the action", async () => {
    const { hook } = recorder((request) => {
      request.actor.name = "mallory";
    });
    const { rt } = await setup(hook);
    const view = await prepared(rt);
    expect(view.preparedBy?.name).toBe("alice");
    await confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) });
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBe("alice");
  });

  it("passes a PolicyError of the hook on unchanged", async () => {
    const refusal = new PolicyError("only with a second person");
    const { rt } = await setup(() => {
      throw refusal;
    });
    await expect(authorize(rt, { actor: human, action: "inventory.edit" })).rejects.toBe(refusal);
  });

  it("turns any other failure into one generic refusal that shows nothing of the hook", async () => {
    const detail = "hook-internal-detail-for-test";
    const failures: (() => void | Promise<void>)[] = [
      () => {
        throw new Error(`${detail} ghp_x`);
      },
      () => Promise.reject(new Error(detail, { cause: new Error(detail) })),
      () => {
        throw `${detail} as a plain string`;
      },
    ];
    for (const fail of failures) {
      const { rt, calls } = await setup(fail);
      const error = await authorize(rt, { actor: human, action: "inventory.edit" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).message).toBe(GENERIC);
      expect((error as PolicyError).cause).toBeUndefined();
      expect(String((error as PolicyError).stack)).not.toContain(detail);
      // Through a real action: the action does not happen and the response carries nothing of the hook.
      const real = await requestIssuance(rt, human, "hmac-acme-app").catch((e: unknown) => e);
      expect((real as PolicyError).message).toBe(GENERIC);
      expect(calls).toEqual([]);
      expect(rt.issuances.list()).toEqual([]);
    }
  });
});

describe("built-in rules come first", () => {
  it("the hook is not asked when a built-in check refuses, and it cannot allow what the built-in rules refuse", async () => {
    const { seen, hook } = recorder();
    const { rt, calls } = await setup(hook);
    const view = await prepared(rt);
    const approvalId = await pendingApproval(rt, "stripe-webhook-acme-docs-staging");
    seen.length = 0;
    const humanOnly = /darf nur ein Mensch/;
    await expect(confirmIssuance(rt, agent, view.id, { ticks: ticksOf(view) })).rejects.toThrow(humanOnly);
    await expect(rejectIssuance(rt, agent, view.id)).rejects.toThrow(humanOnly);
    await expect(submitManualValue(rt, agent, "cf-deploy-acme-app", MANUAL)).rejects.toThrow(humanOnly);
    await expect(attachEvidence(rt, agent, "hmac-acme-app", view.id, new Uint8Array([1]), "image/png")).rejects.toThrow(humanOnly);
    await expect(resolveApproval(rt, agent, approvalId, "approve")).rejects.toThrow(humanOnly);
    await expect(removeVariable(rt, agent, "acme-project")).rejects.toThrow(humanOnly);
    await expect(adoptVariableFromGitHub(rt, agent, "acme-project")).rejects.toThrow(humanOnly);
    await expect(runGitHubSync(rt, agent, { keys: [] })).rejects.toThrow(humanOnly);
    await expect(applyNormalizationChanges(rt, agent, { changeIds: ["x"] })).rejects.toThrow(/nur ein Mensch/);
    // Stage policy: an agent may only create entries in dev stages.
    await expect(addSecret(rt, agent, { id: "a-staging", name: "A_STAGING", service: "x", stage: "staging", places: [{ repo: "acme-docs", scope: "environment", environment: "staging" }] })).rejects.toThrow(PolicyError);
    expect(seen).toEqual([]);
    expect(writes(calls)).toEqual([]);
    // An allowing hook does not turn an agent's staging apply into an immediate one: it still ends in an approval request.
    const result = await requestApplyVariable(rt, agent, "site-url-staging");
    expect(result.status).toBe("pending-approval");
    expect(writes(calls)).toEqual([]);
    expect(summary(seen)).toEqual([["variable.apply", { variableId: "site-url-staging", stage: "staging" }]]);
  });
});

describe("a refusing hook stops each action before any side effect", () => {
  it("issuance.prepare: before any approval, review, evidence or GitHub call; a dry run has no effect and is not asked", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, calls } = await setup(hook);
    await expect(requestIssuance(rt, human, "hmac-acme-app")).rejects.toThrow(REFUSAL);
    await expect(requestIssuance(rt, agent, "stripe-webhook-acme-docs-staging")).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([
      { actor: human, action: "issuance.prepare", subject: { secretId: "hmac-acme-app", stage: "shared" } },
      { actor: agent, action: "issuance.prepare", subject: { secretId: "stripe-webhook-acme-docs-staging", stage: "staging" } },
    ]);
    expect(calls).toEqual([]);
    expect(rt.issuances.list()).toEqual([]);
    expect(rt.approvals.list()).toEqual([]);
    expect(await listEvidence(rt, "hmac-acme-app")).toEqual([]);
    seen.length = 0;
    expect((await requestIssuance(rt, agent, "hmac-acme-app", { dryRun: true })).status).toBe("dry-run");
    expect(seen).toEqual([]);
  });

  it("automation.run: a human browser run is asked for after issuance.prepare and stops before it starts; an agent only gets an approval request", async () => {
    const { seen, hook } = recorder((request) => {
      if (request.action === "automation.run") throw new PolicyError(REFUSAL);
    });
    const { rt, calls } = await setup(hook);
    vi.spyOn(rt.automation, "isBrowserProvider").mockReturnValue(true);
    await expect(requestIssuance(rt, human, "hmac-acme-app")).rejects.toThrow(REFUSAL);
    expect(summary(seen)).toEqual([
      ["issuance.prepare", { secretId: "hmac-acme-app", stage: "shared" }],
      ["automation.run", { secretId: "hmac-acme-app", stage: "shared" }],
    ]);
    expect(rt.issuances.list()).toEqual([]);
    expect(calls).toEqual([]);
    seen.length = 0;
    expect((await requestIssuance(rt, agent, "hmac-acme-app")).status).toBe("pending-approval");
    expect(seen.map((r) => r.action)).toEqual(["issuance.prepare"]);
  });

  it("issuance.manual-value: nothing is prepared, saved or attached; an unknown entry has no stage in the subject", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, calls } = await setup(hook);
    await expect(submitManualValue(rt, aliceP, "cf-deploy-acme-app", MANUAL)).rejects.toThrow(REFUSAL);
    await expect(submitManualValue(rt, aliceP, "no-such-secret", MANUAL)).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([
      { actor: aliceP, action: "issuance.manual-value", subject: { secretId: "cf-deploy-acme-app", stage: "shared" } },
      { actor: aliceP, action: "issuance.manual-value", subject: { secretId: "no-such-secret" } },
    ]);
    expect(rt.issuances.list()).toEqual([]);
    expect(await listEvidence(rt, "cf-deploy-acme-app")).toEqual([]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(MANUAL);
  });

  it("issuance.confirm and issuance.reject: the review stays, its value is not consumed, nothing is written; the subject names who prepared it", async () => {
    let refusing = false;
    const { seen, hook } = recorder(() => {
      if (refusing) refuse();
    });
    const { rt, calls, written } = await setup(hook);
    const view = await prepared(rt, aliceP);
    seen.length = 0;
    refusing = true;
    const preparedBy = { name: "alice", kind: "human", principalId: "principal-a" };
    await expect(confirmIssuance(rt, bobP, view.id, { ticks: ticksOf(view) })).rejects.toThrow(REFUSAL);
    await expect(rejectIssuance(rt, bobP, view.id, "no")).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([
      { actor: bobP, action: "issuance.confirm", subject: { secretId: "hmac-acme-app", stage: "shared", preparedBy } },
      { actor: bobP, action: "issuance.reject", subject: { secretId: "hmac-acme-app", stage: "shared", preparedBy } },
    ]);
    expect(writes(calls)).toEqual([]);
    expect(rt.issuances.get(view.id)).toBeDefined();
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBeUndefined();
    expect((await listEvidence(rt, "hmac-acme-app"))[0]!.confirmation).toBeUndefined();
    // The review is still intact and can be confirmed once the hook allows it.
    refusing = false;
    expect((await confirmIssuance(rt, bobP, view.id, { ticks: ticksOf(view) })).ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(written[0]!);
  });

  it("a review that was prepared without an actor reference has no preparedBy in the view or the subject", async () => {
    const { seen, hook } = recorder();
    const { rt } = await setup(hook);
    const dropped = await prepareIssuance("hmac-acme-app", issuanceDeps(rt));
    rt.issuances.add(dropped);
    rt.issuances.add(await prepareIssuance("hmac-acme-app", issuanceDeps(rt)));
    const views = await listIssuances(rt);
    expect(views).toHaveLength(2);
    for (const v of views) expect("preparedBy" in v).toBe(false);
    seen.length = 0;
    await rejectIssuance(rt, human, dropped.id);
    const other = views.find((v) => v.id !== dropped.id)!;
    await confirmIssuance(rt, human, other.id, { ticks: ticksOf(other) });
    expect(summary(seen)).toEqual([
      ["issuance.reject", { secretId: "hmac-acme-app", stage: "shared" }],
      ["issuance.confirm", { secretId: "hmac-acme-app", stage: "shared" }],
    ]);
  });

  it("evidence.attach: no attachment is stored", async () => {
    let refusing = false;
    const { seen, hook } = recorder(() => {
      if (refusing) refuse();
    });
    const { rt } = await setup(hook);
    const view = await prepared(rt);
    seen.length = 0;
    refusing = true;
    await expect(attachEvidence(rt, human, "hmac-acme-app", view.id, new Uint8Array([137, 80, 78, 71]), "image/png")).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([{ actor: human, action: "evidence.attach", subject: { secretId: "hmac-acme-app" } }]);
    expect((await listEvidence(rt, "hmac-acme-app"))[0]!.attachments).toEqual([]);
  });

  it("approval.resolve: the request stays open, no review is created, no variable is set; the subject names who asked", async () => {
    let refusing = false;
    const { seen, hook } = recorder(() => {
      if (refusing) refuse();
    });
    const { rt, calls } = await setup(hook);
    const issueId = await pendingApproval(rt);
    const applied = await requestApplyVariable(rt, agent, "site-url-staging");
    if (applied.status !== "pending-approval") throw new Error("expected an approval request");
    seen.length = 0;
    refusing = true;
    await expect(resolveApproval(rt, aliceP, issueId, "approve")).rejects.toThrow(REFUSAL);
    await expect(resolveApproval(rt, aliceP, issueId, "deny")).rejects.toThrow(REFUSAL);
    await expect(resolveApproval(rt, aliceP, applied.approvalId, "approve")).rejects.toThrow(REFUSAL);
    const by = { requestedBy: "claude", requestedByRef: { name: "claude", kind: "agent" } };
    expect(seen).toEqual([
      { actor: aliceP, action: "approval.resolve", subject: { approvalId: issueId, secretId: "hmac-acme-app", ...by } },
      { actor: aliceP, action: "approval.resolve", subject: { approvalId: issueId, secretId: "hmac-acme-app", ...by } },
      { actor: aliceP, action: "approval.resolve", subject: { approvalId: applied.approvalId, variableId: "site-url-staging", ...by } },
    ]);
    for (const id of [issueId, applied.approvalId]) {
      expect(getApproval(rt, id).state).toBe("pending");
      expect(getApproval(rt, id).decidedBy).toBeUndefined();
      expect(getApproval(rt, id).decidedAt).toBeUndefined();
    }
    expect(rt.issuances.list()).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });

  it("variable.apply: no GitHub write and no approval request", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, calls } = await setup(hook);
    await expect(requestApplyVariable(rt, human, "site-url-staging")).rejects.toThrow(REFUSAL);
    await expect(requestApplyVariable(rt, agent, "site-url-staging")).rejects.toThrow(REFUSAL);
    expect(seen.map((r) => [r.actor.kind, r.action, r.subject])).toEqual([
      ["human", "variable.apply", { variableId: "site-url-staging", stage: "staging" }],
      ["agent", "variable.apply", { variableId: "site-url-staging", stage: "staging" }],
    ]);
    expect(calls).toEqual([]);
    expect(rt.approvals.list()).toEqual([]);
  });

  it("inventory.edit: the inventory in memory and on disk stays as it was", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, dir, calls } = await setup(hook);
    const fileBefore = await readFile(join(dir, "inventory.yaml"), "utf8");
    const dataBefore = JSON.stringify(rt.inventory.data);
    const edits: [string, () => Promise<unknown>][] = [
      ["human adds a secret", () => addSecret(rt, human, { id: "new-secret", name: "NEW_SECRET", service: "x", stage: "shared", provider: "manual", expiry: "none", places: PLACE })],
      ["entry without id and stage", () => addSecret(rt, human, {})],
      ["not an entry at all", () => addSecret(rt, human, "not an entry")],
      ["agent edits metadata", () => updateSecretMeta(rt, agent, "cf-deploy-acme-app", { title: "T" })],
      ["human edits metadata", () => updateSecretMeta(rt, human, "cf-deploy-acme-app", { title: "T" })],
      ["provider", () => addManualProvider(rt, human, { id: "acme-api", label: "Acme API", url: "https://acme.example.com", steps: ["Open"] })],
      ["env template", () => addEnvTemplate(rt, human, { id: "t", repo: "acme-docs", stage: "dev", entries: [{ key: "A", from: { type: "default", value: "1" } }] } as never)],
      ["env entry", () => addEnvEntry(rt, human, "acme-docs-dev", { key: "B", from: { type: "default", value: "2" } })],
      ["new variable", () => addVariable(rt, human, { id: "new-var", name: "NEW_VAR", stage: "shared", value: "v", places: PLACE })],
      ["variable value", () => updateVariable(rt, human, "site-url-staging", { value: "https://neu.example.com" })],
      ["variable removal", () => removeVariable(rt, human, "acme-project")],
      ["variable adoption", () => adoptVariableFromGitHub(rt, human, "acme-project")],
      ["normalization", () => applyNormalizationChanges(rt, human, { changeIds: ["rename:secret:cf-deploy-acme-app"] })],
    ];
    for (const [label, edit] of edits) await expect(edit(), label).rejects.toThrow(REFUSAL);
    expect(seen.every((r) => r.action === "inventory.edit")).toBe(true);
    expect(seen.map((r) => [r.actor.kind, r.subject])).toEqual([
      ["human", { secretId: "new-secret", stage: "shared" }],
      ["human", {}],
      ["human", {}],
      ["agent", { secretId: "cf-deploy-acme-app" }],
      ["human", { secretId: "cf-deploy-acme-app" }],
      ["human", undefined],
      ["human", undefined],
      ["human", undefined],
      ["human", { variableId: "new-var", stage: "shared" }],
      ["human", { variableId: "site-url-staging", stage: "staging" }],
      ["human", { variableId: "acme-project" }],
      ["human", { variableId: "acme-project" }],
      ["human", undefined],
    ]);
    expect(JSON.stringify(rt.inventory.data)).toBe(dataBefore);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(fileBefore);
    expect(calls).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("https://neu.example.com");
  });

  it("github.sync: nothing is planned or written", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, calls } = await setup(hook);
    await expect(runGitHubSync(rt, human, { keys: [] })).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([{ actor: human, action: "github.sync" }]);
    expect(calls).toEqual([]);
  });
});

/** The same steps with no hook and with an allowing hook must end identically. */
type Family = (rt: Runtime, calls: string[]) => Promise<unknown>;
const FAMILIES: Record<string, Family> = {
  "issuance: request, confirm, reject": async (rt, calls) => {
    const first = await prepared(rt);
    const done = await confirmIssuance(rt, human, first.id, { ticks: ticksOf(first), note: "ok" });
    const second = await prepared(rt);
    const rejected = await rejectIssuance(rt, human, second.id, "no");
    return { kind: first.kind, overall: first.overall, ok: done.ok, places: done.places, rejected, writes: writes(calls).length, pending: rt.issuances.list().length, verifiedBy: rt.inventory.getSecret("hmac-acme-app")!.verifiedBy };
  },
  "manual value and evidence": async (rt) => {
    const view = await submitManualValue(rt, human, "cf-deploy-acme-app", MANUAL);
    await attachEvidence(rt, human, "cf-deploy-acme-app", view.id, new Uint8Array([137, 80, 78, 71]), "image/png", "note");
    const stored = await listEvidence(rt, "cf-deploy-acme-app");
    return { kind: view.kind, overall: view.overall, attachments: stored[0]!.attachments.map((a) => [a.mime, a.note]) };
  },
  "approvals: approve and deny": async (rt, calls) => {
    const issueId = await pendingApproval(rt);
    const apply = await requestApplyVariable(rt, agent, "site-url-staging");
    if (apply.status !== "pending-approval") throw new Error("expected an approval request");
    const approved = await resolveApproval(rt, human, issueId, "approve");
    const denied = await resolveApproval(rt, human, apply.approvalId, "deny");
    return { approved: approved.state, denied: denied.state, issuances: rt.issuances.list().length, writes: writes(calls).length };
  },
  "inventory edits": async (rt) => {
    await addSecret(rt, human, { id: "new-secret", name: "NEW_SECRET", service: "x", stage: "shared", provider: "manual", expiry: "none", places: PLACE });
    await updateSecretMeta(rt, agent, "cf-deploy-acme-app", { title: "T" });
    await addManualProvider(rt, human, { id: "acme-api", label: "Acme API", url: "https://acme.example.com", steps: ["Open"] });
    await addEnvTemplate(rt, human, { id: "t", repo: "acme-docs", stage: "dev", entries: [{ key: "A", from: { type: "default", value: "1" } }] } as never);
    await addEnvEntry(rt, human, "acme-docs-dev", { key: "B", from: { type: "default", value: "2" } });
    await addVariable(rt, human, { id: "new-var", name: "NEW_VAR", stage: "shared", value: "v", places: PLACE });
    await updateVariable(rt, human, "site-url-staging", { value: "https://neu.example.com" });
    await adoptVariableFromGitHub(rt, human, "acme-project");
    await removeVariable(rt, human, "new-var");
    return JSON.stringify(rt.inventory.data);
  },
  "variable apply": async (rt, calls) => {
    const human1 = await requestApplyVariable(rt, human, "site-url-staging");
    const agent1 = await requestApplyVariable(rt, agent, "site-url-staging");
    return { human: human1, agentStatus: agent1.status, writes: writes(calls) };
  },
};

describe("without a hook, and with one that allows, every action family ends the same", () => {
  for (const [name, family] of Object.entries(FAMILIES)) {
    it(name, async () => {
      const plain = await setup();
      const { seen, hook } = recorder();
      const hooked = await setup(hook);
      expect(await family(hooked.rt, hooked.calls)).toEqual(await family(plain.rt, plain.calls));
      expect(seen.length).toBeGreaterThan(0);
    });
  }
});

describe("a second-person rule written as a hook", () => {
  const secondPerson: Authorize = (request) => {
    const preparer = request.subject?.preparedBy?.principalId;
    if (request.action === "issuance.confirm" && request.actor.principalId !== undefined && request.actor.principalId === preparer) {
      throw new PolicyError("Bestaetigen darf nicht dieselbe Person, die vorbereitet hat.");
    }
  };

  it("the preparer cannot confirm, another principal can, and the confirmation records who did", async () => {
    const { rt, calls, written } = await setup(secondPerson);
    const view = await prepared(rt, aliceP);
    expect(view.preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    const error = await confirmIssuance(rt, aliceP, view.id, { ticks: ticksOf(view) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).message).toContain("nicht dieselbe Person");
    expect(writes(calls)).toEqual([]);
    expect(rt.issuances.get(view.id)).toBeDefined();
    const done = await confirmIssuance(rt, bobP, view.id, { ticks: ticksOf(view) });
    expect(done.ok).toBe(true);
    expect(writes(calls).filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBe("bob");
    const [report] = await listEvidence(rt, "hmac-acme-app");
    expect(report!.confirmation).toMatchObject({ decision: "confirmed", by: "bob", principalId: "principal-b" });
    expect(JSON.stringify([report, view, done, (error as Error).message])).not.toContain(written[0]!);
  });

  it("also holds for a review that started as an agent's request: the approving person prepared it", async () => {
    const { rt } = await setup(secondPerson);
    const approvalId = await pendingApproval(rt);
    const approved = await resolveApproval(rt, aliceP, approvalId, "approve");
    expect(approved.state).toBe("approved");
    const [view] = await listIssuances(rt);
    expect(view!.preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    await expect(confirmIssuance(rt, aliceP, view!.id, { ticks: ticksOf(view!) })).rejects.toThrow(/nicht dieselbe Person/);
    expect((await confirmIssuance(rt, bobP, view!.id, { ticks: ticksOf(view!) })).ok).toBe(true);
  });

  it("without principal ids (portal and CLI today) the rule never triggers and nothing changes", async () => {
    const { rt } = await setup(secondPerson);
    const view = await prepared(rt, human);
    expect((await confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) })).ok).toBe(true);
  });
});

describe("what is recorded", () => {
  it("preparedBy on pending reviews: name and kind always, the principal id only when there is one", async () => {
    const { rt } = await setup();
    const withId = await prepared(rt, aliceP);
    const without = await prepared(rt, human);
    const manual = await submitManualValue(rt, bobP, "cf-deploy-acme-app", MANUAL);
    const views = await listIssuances(rt);
    const byId = (id: string) => views.find((v) => v.id === id)!;
    expect(byId(withId.id).preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    expect(byId(without.id).preparedBy).toEqual({ name: "alice", kind: "human" });
    expect("principalId" in byId(without.id).preparedBy!).toBe(false);
    expect(byId(manual.id).preparedBy).toEqual({ name: "bob", kind: "human", principalId: "principal-b" });
    expect(rt.issuances.get(withId.id)!.preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    expect(actorRef(agent)).toEqual({ name: "claude", kind: "agent" });
    expect(JSON.stringify(views)).not.toContain(MANUAL);
  });

  it("decidedBy and decidedAt on approvals, for approve, deny and a request that went stale", async () => {
    const { rt } = await setup();
    const approveId = await pendingApproval(rt);
    const apply = await requestApplyVariable(rt, agent, "site-url-staging");
    if (apply.status !== "pending-approval") throw new Error("expected an approval request");
    const staleId = await pendingApproval(rt, "stripe-webhook-acme-docs-staging");
    for (const approval of listApprovals(rt)) {
      expect(approval.decidedBy).toBeUndefined();
      expect(approval.decidedAt).toBeUndefined();
    }
    const approved = await resolveApproval(rt, aliceP, approveId, "approve");
    const denied = await resolveApproval(rt, bobP, apply.approvalId, "deny");
    rt.inventory.getSecret("stripe-webhook-acme-docs-staging")!.places = [{ repo: "other", scope: "repository" }] as never;
    const stale = await resolveApproval(rt, human, staleId, "approve");
    expect([approved.state, denied.state, stale.state]).toEqual(["approved", "denied", "stale"]);
    expect(approved.decidedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    expect(denied.decidedBy).toEqual({ name: "bob", kind: "human", principalId: "principal-b" });
    expect(stale.decidedBy).toEqual({ name: "alice", kind: "human" });
    for (const approval of [approved, denied, stale]) expect(new Date(approval.decidedAt!).toISOString()).toBe(approval.decidedAt);
    expect(getApproval(rt, approveId).requestedBy).toBe("claude");
    expect(listApprovals(rt).find((a) => a.id === approveId)!.decidedBy).toEqual(approved.decidedBy);
  });

  it("the confirmation carries a principal id when the actor has one and none when not; the inventory keeps the display name", async () => {
    const { rt } = await setup();
    const first = await prepared(rt, aliceP);
    await confirmIssuance(rt, bobP, first.id, { ticks: ticksOf(first) });
    const second = await prepared(rt, aliceP);
    await rejectIssuance(rt, bobP, second.id);
    const third = await prepared(rt, aliceP);
    await rejectIssuance(rt, human, third.id);
    const reports = await listEvidence(rt, "hmac-acme-app");
    const decided = (id: string) => reports.find((r) => r.id === id)!.confirmation!;
    expect(decided(first.id)).toMatchObject({ decision: "confirmed", by: "bob", principalId: "principal-b" });
    expect(decided(second.id)).toMatchObject({ decision: "rejected", by: "bob", principalId: "principal-b" });
    expect(decided(third.id)).toMatchObject({ decision: "rejected", by: "alice" });
    expect("principalId" in decided(third.id)).toBe(false);
    expect(rt.inventory.getSecret("hmac-acme-app")!.verifiedBy).toBe("bob");
  });

  it("no new field, request or message carries a value", async () => {
    const { seen, hook } = recorder();
    const { rt, written } = await setup(hook);
    const manual = await submitManualValue(rt, aliceP, "cf-deploy-acme-app", MANUAL);
    const view = await prepared(rt, aliceP);
    const approvalId = await pendingApproval(rt, "stripe-webhook-acme-docs-staging");
    await resolveApproval(rt, bobP, approvalId, "deny");
    await confirmIssuance(rt, bobP, view.id, { ticks: ticksOf(view) });
    const refused = await setup(() => {
      throw new Error(`hook detail ${MANUAL}`);
    });
    const message = await requestIssuance(refused.rt, human, "hmac-acme-app").catch((e: Error) => e.message);
    const everything = JSON.stringify([seen, manual, view, await listIssuances(rt), listApprovals(rt), await listEvidence(rt, "hmac-acme-app"), await listEvidence(rt, "cf-deploy-acme-app"), message]);
    expect(written).toHaveLength(1);
    for (const value of [written[0]!, MANUAL, "ghp_x"]) expect(everything).not.toContain(value);
    expect(message).toBe(GENERIC);
  });
});

/** A hook that waits until the test opens the gate (only for the listed actions). */
function slowFor(actions: string[]) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const { seen, hook } = recorder(async (request) => {
    if (actions.includes(request.action)) await opened;
  });
  return { seen, hook, open };
}
const settle = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const CLAIMED = "Die Pruefung wird gerade bearbeitet oder ist schon erledigt.";

/** A review whose provider can revoke: lets a test see whether the new value was revoked. */
async function revocable(rt: Runtime): Promise<ReturnType<typeof vi.fn>> {
  const revoke = vi.fn(async () => undefined);
  rt.providers.register({ id: "fake-revoking", label: "Fake", kind: "automatic", issue: async () => ({ value: new SecretValue("fake-issued-value-0123456789"), externalId: "new-external-id" }), revoke });
  rt.inventory.data.secrets.find((s) => s.id === "hmac-acme-app")!.provider = "fake-revoking";
  return revoke;
}

describe("confirm and reject cannot overlap while the hook is pending", () => {
  it("confirm first: the reject is refused, the value is written once and never revoked", async () => {
    const { hook, open } = slowFor(["issuance.confirm", "issuance.reject"]);
    const { rt, calls, written } = await setup(hook);
    const revoke = await revocable(rt);
    const view = await prepared(rt);
    const confirming = confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) });
    await settle();
    await expect(rejectIssuance(rt, human, view.id)).rejects.toThrow(CLAIMED);
    open();
    expect((await confirming).ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(written).toHaveLength(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("reject first: the confirm is refused, nothing is written and the new value is revoked once", async () => {
    const { hook, open } = slowFor(["issuance.confirm", "issuance.reject"]);
    const { rt, calls } = await setup(hook);
    const revoke = await revocable(rt);
    const view = await prepared(rt);
    const rejecting = rejectIssuance(rt, human, view.id);
    await settle();
    await expect(confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) })).rejects.toThrow(CLAIMED);
    open();
    expect(await rejecting).toEqual({ revokedNew: true });
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(rt.issuances.list()).toEqual([]);
  });

  it("started together: exactly one of them wins, never both the write and the revoke", async () => {
    const { hook, open } = slowFor(["issuance.confirm", "issuance.reject"]);
    const { rt, calls } = await setup(hook);
    const revoke = await revocable(rt);
    const view = await prepared(rt);
    const both = Promise.allSettled([confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) }), rejectIssuance(rt, human, view.id)]);
    await settle();
    open();
    const results = await both;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(PolicyError);
    expect((lost.reason as Error).message).toBe(CLAIMED);
    expect(calls.some((c) => c.startsWith("PUT")) !== (revoke.mock.calls.length > 0)).toBe(true);
  });

  it("two rejects: one discard, one revoke", async () => {
    const { hook, open } = slowFor(["issuance.reject"]);
    const { rt } = await setup(hook);
    const revoke = await revocable(rt);
    const view = await prepared(rt);
    const both = Promise.allSettled([rejectIssuance(rt, human, view.id), rejectIssuance(rt, bobP, view.id)]);
    await settle();
    open();
    const results = await both;
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("two confirms: one write", async () => {
    const { hook, open } = slowFor(["issuance.confirm"]);
    const { rt, calls } = await setup(hook);
    const view = await prepared(rt);
    const both = Promise.allSettled([confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) }), confirmIssuance(rt, bobP, view.id, { ticks: ticksOf(view) })]);
    await settle();
    open();
    const results = await both;
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
  });

  it("the claim is released after a refusing hook and after a failed commit: a later confirm works", async () => {
    let refusals = 1;
    const { hook } = recorder((request) => {
      if (request.action === "issuance.confirm" && refusals-- > 0) refuse();
    });
    const { rt } = await setup(hook);
    const view = await prepared(rt);
    await expect(confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) })).rejects.toThrow(REFUSAL);
    await expect(confirmIssuance(rt, human, view.id, { ticks: [] })).rejects.toThrow(/Pruefpunkte/);
    expect((await confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) })).ok).toBe(true);
  });

  it("an item that disappears while the hook is pending is not committed or discarded", async () => {
    let dropId: string | null = null;
    const holder: { rt?: Runtime } = {};
    const { hook } = recorder((request) => {
      if (dropId !== null && (request.action === "issuance.confirm" || request.action === "issuance.reject")) holder.rt!.issuances.delete(dropId);
    });
    const { rt, calls } = await setup(hook);
    holder.rt = rt;
    const revoke = await revocable(rt);
    const first = await prepared(rt);
    dropId = first.id;
    await expect(confirmIssuance(rt, human, first.id, { ticks: ticksOf(first) })).rejects.toThrow(/nicht gefunden/);
    dropId = null;
    const second = await prepared(rt);
    dropId = second.id;
    await expect(rejectIssuance(rt, human, second.id)).rejects.toThrow(/nicht gefunden/);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("the sweep leaves a claimed item alone, and an unknown item cannot be claimed", async () => {
    const { hook, open } = slowFor(["issuance.confirm"]);
    const { rt } = await setup(hook);
    const view = await prepared(rt);
    expect(rt.issuances.claim("no-such-review")).toBe(false);
    const confirming = confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) });
    await settle();
    // Just expired: within the grace a claimed review is left to its operation.
    rt.issuances.get(view.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await rt.issuances.sweep(issuanceDeps(rt))).toEqual([]);
    open();
    await expect(confirming).rejects.toThrow(/abgelaufen/);
    expect(await rt.issuances.sweep(issuanceDeps(rt))).toEqual([view.id]);
  });

  it("a claimed item is left to its operation while the sweep awaits an earlier discard, and so is an item that vanished", async () => {
    const { rt } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => gate);
    rt.providers.register({ id: "slow-revoking", label: "Slow", kind: "automatic", issue: async () => ({ value: new SecretValue("slow-issued-value-0123456789"), externalId: "slow-ext" }), revoke });
    rt.inventory.data.secrets.find((s) => s.id === "hmac-acme-app")!.provider = "slow-revoking";
    for (let i = 0; i < 3; i++) await prepared(rt);
    const items = rt.issuances.list();
    const [first, second, third] = items.map((p) => p.id) as [string, string, string];
    // An operation took the second item while it was still valid; then all three run out.
    expect(rt.issuances.claim(second)).toBe(true);
    for (const p of items) p.expiresAt = new Date(Date.now() - 1000).toISOString();
    const sweeping = rt.issuances.sweep(issuanceDeps(rt));
    // The sweep is now waiting for the first discard: remove the third item.
    rt.issuances.delete(third);
    release();
    expect(await sweeping).toEqual([first]);
    expect(revoke).toHaveBeenCalledTimes(1);
    // The claimed item is hidden (it is past its deadline) but not touched; once its operation lets go, the next sweep settles it.
    expect(rt.issuances.get(second)).toBeUndefined();
    rt.issuances.release(second);
    expect(await rt.issuances.sweep(issuanceDeps(rt))).toEqual([second]);
    expect(revoke).toHaveBeenCalledTimes(2);
    // An expired item cannot be claimed any more.
    expect(rt.issuances.claim(second)).toBe(false);
  });

  it("a commit that never settles is cut off at the hard bound: the value is gone and the late commit writes nothing", async () => {
    let t = Date.parse("2026-11-14T10:00:00.000Z");
    // The first write to GitHub hangs until the test lets it go; the review has two places to write, so a second write would follow.
    let letGo!: () => void;
    const hang = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let armed = false;
    let hung = false;
    const { rt, calls } = await setup(undefined, { now: () => new Date(t) }, async (method) => {
      if (armed && !hung && method === "PUT") {
        hung = true;
        await hang;
      }
    });
    rt.inventory.data.secrets.find((s) => s.id === "hmac-acme-app")!.places.push({ repo: "acme-docs", scope: "repository" } as never);
    const view = await prepared(rt);
    const pending = rt.issuances.get(view.id)!;
    const deadline = Date.parse(pending.expiresAt);
    armed = true;
    const confirming = confirmIssuance(rt, human, view.id, { ticks: ticksOf(view) });
    await settle();
    expect(hung).toBe(true);
    // Within the grace the claimed review is hidden but still held.
    t = deadline + 60_000;
    expect(rt.issuances.get(view.id)).toBeUndefined();
    expect(rt.issuances.signal(view.id)?.aborted).toBe(false);
    // Past deadline plus grace the queue takes it back whatever the operation is doing.
    t = deadline + CLAIM_GRACE_MS;
    expect(rt.issuances.list()).toEqual([]);
    expect(rt.issuances.signal(view.id)).toBeUndefined();
    expect(pending.value.reveal()).toBe("");
    expect(rt.issuances.claim(view.id)).toBe(false);
    // A sweep while the commit is still in flight keeps the record and revokes nothing (ordering one) ...
    await rt.sweep();
    expect(rt.issuances.orphans()).toEqual([]);
    letGo();
    // The write that was in flight went through; the second place was never written, and the commit reports it as failed.
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    const result = await confirming;
    expect(result.ok).toBe(false);
    expect(result.places.map((p) => p.outcome)).toEqual(["updated", "failed"]);
    expect(result.places[1]!.error).toMatch(/Abgebrochen/);
    // ... and once it ended partial, the next sweep flags the record for a person's decision instead of revoking (ordering two).
    t = deadline + CLAIM_GRACE_MS + 3_600_000;
    await rt.sweep();
    expect(rt.issuances.orphans()).toEqual([expect.objectContaining({ id: view.id, needsDecision: true })]);
    const report = (await listEvidence(rt, "hmac-acme-app")).find((r) => r.id === view.id)!;
    expect(report.checks.find((c) => c.id === "partial-write")?.label).toContain("nicht widerrufen");
  });
});

describe("the approval path asks for what an approval causes", () => {
  const refusingOnly = (actions: string[]) =>
    recorder((request) => {
      if (actions.includes(request.action)) refuse();
    });
  const origin = (approvalId: string) => ({ approvalId, requestedBy: "claude", requestedByRef: { name: "claude", kind: "agent" } });

  it("issue approval: issuance.prepare is asked on behalf of the approver; a refusal leaves the request open", async () => {
    let armed = false;
    const { seen, hook } = recorder((request) => {
      if (armed && request.action === "issuance.prepare") refuse();
    });
    const { rt, calls } = await setup(hook);
    const id = await pendingApproval(rt);
    armed = true;
    seen.length = 0;
    await expect(resolveApproval(rt, aliceP, id, "approve")).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([
      { actor: aliceP, action: "approval.resolve", subject: { secretId: "hmac-acme-app", ...origin(id) } },
      { actor: aliceP, action: "issuance.prepare", subject: { secretId: "hmac-acme-app", stage: "shared", ...origin(id) } },
    ]);
    expect(getApproval(rt, id).state).toBe("pending");
    expect(getApproval(rt, id).decidedBy).toBeUndefined();
    expect(rt.issuances.list()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a browser run is asked as automation.run too, before it starts", async () => {
    const { seen, hook } = refusingOnly(["automation.run"]);
    const { rt, calls } = await setup(hook);
    const id = await pendingApproval(rt);
    vi.spyOn(rt.automation, "isBrowserProvider").mockReturnValue(true);
    seen.length = 0;
    await expect(resolveApproval(rt, aliceP, id, "approve")).rejects.toThrow(REFUSAL);
    expect(seen.map((r) => r.action)).toEqual(["approval.resolve", "issuance.prepare", "automation.run"]);
    expect(seen[2]!.subject).toEqual({ secretId: "hmac-acme-app", stage: "shared", ...origin(id) });
    expect(getApproval(rt, id).state).toBe("pending");
    expect(rt.issuances.list()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("variable approval: variable.apply is asked, a refusal writes nothing and leaves the request open", async () => {
    let armed = false;
    const { seen, hook } = recorder((request) => {
      if (armed && request.action === "variable.apply") refuse();
    });
    const { rt, calls } = await setup(hook);
    const applied = await requestApplyVariable(rt, agent, "site-url-staging");
    if (applied.status !== "pending-approval") throw new Error("expected an approval request");
    armed = true;
    seen.length = 0;
    await expect(resolveApproval(rt, aliceP, applied.approvalId, "approve")).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([
      { actor: aliceP, action: "approval.resolve", subject: { variableId: "site-url-staging", ...origin(applied.approvalId) } },
      { actor: aliceP, action: "variable.apply", subject: { variableId: "site-url-staging", stage: "staging", ...origin(applied.approvalId) } },
    ]);
    expect(getApproval(rt, applied.approvalId).state).toBe("pending");
    expect(writes(calls)).toEqual([]);
    armed = false;
    expect((await resolveApproval(rt, aliceP, applied.approvalId, "approve")).state).toBe("approved");
    expect(writes(calls).some((c) => c.startsWith("PATCH"))).toBe(true);
  });

  it("approved: the review remembers who prepared it, who asked and which approval it belongs to", async () => {
    const { seen, hook } = recorder();
    const { rt } = await setup(hook);
    const id = await pendingApproval(rt);
    seen.length = 0;
    await resolveApproval(rt, aliceP, id, "approve");
    expect(seen.map((r) => r.action)).toEqual(["approval.resolve", "issuance.prepare"]);
    const [view] = await listIssuances(rt);
    expect(view).toMatchObject({ preparedBy: { name: "alice", kind: "human", principalId: "principal-a" }, requestedBy: { name: "claude", kind: "agent" }, approvalId: id });
    expect(getApproval(rt, id).requestedByRef).toEqual({ name: "claude", kind: "agent" });
    seen.length = 0;
    await confirmIssuance(rt, bobP, view!.id, { ticks: ticksOf(view!) });
    expect(seen[0]).toEqual({
      actor: bobP,
      action: "issuance.confirm",
      subject: { secretId: "hmac-acme-app", stage: "shared", preparedBy: { name: "alice", kind: "human", principalId: "principal-a" }, requestedBy: "claude", requestedByRef: { name: "claude", kind: "agent" }, approvalId: id },
    });
  });

  it("deny and a vanished target ask only for the decision", async () => {
    const { seen, hook } = recorder();
    const { rt } = await setup(hook);
    const denied = await pendingApproval(rt);
    const vanished = await pendingApproval(rt, "stripe-webhook-acme-docs-staging");
    const variable = await requestApplyVariable(rt, agent, "site-url-staging");
    if (variable.status !== "pending-approval") throw new Error("expected an approval request");
    rt.inventory.data.secrets.splice(rt.inventory.data.secrets.findIndex((s) => s.id === "stripe-webhook-acme-docs-staging"), 1);
    rt.inventory.data.variables.splice(rt.inventory.data.variables.findIndex((v) => v.id === "site-url-staging"), 1);
    seen.length = 0;
    await resolveApproval(rt, aliceP, denied, "deny");
    expect((await resolveApproval(rt, aliceP, vanished, "approve")).state).toBe("stale");
    expect((await resolveApproval(rt, aliceP, variable.approvalId, "approve")).state).toBe("stale");
    expect(seen.map((r) => r.action)).toEqual(["approval.resolve", "approval.resolve", "approval.resolve"]);
  });
});

describe("identities for second-person rules", () => {
  const agentAlice = { kind: "agent", name: "alice", principalId: "agent-1" } as const;
  /** Same person only when kind and principal id both match; display names are never compared. */
  const same = (a: ActorRef, b: ActorRef): boolean => a.kind === b.kind && a.principalId !== undefined && a.principalId === b.principalId;
  const rule: Authorize = (request) => {
    const { subject, actor } = request;
    if (request.action === "issuance.confirm" && subject?.preparedBy && same(actorRef(actor), subject.preparedBy)) throw new PolicyError("Der Bestaetiger muss sich vom Vorbereiter unterscheiden.");
    if (request.action === "approval.resolve" && subject?.requestedByRef && actor.principalId !== undefined && actor.principalId === subject.requestedByRef.principalId) throw new PolicyError("Niemand gibt die eigene Anfrage frei.");
  };

  it("the human who approved an agent's request cannot confirm it, a second principal can", async () => {
    const { rt } = await setup(rule);
    const id = await pendingApproval(rt);
    await resolveApproval(rt, aliceP, id, "approve");
    const [view] = await listIssuances(rt);
    await expect(confirmIssuance(rt, aliceP, view!.id, { ticks: ticksOf(view!) })).rejects.toThrow(/unterscheiden/);
    expect((await confirmIssuance(rt, bobP, view!.id, { ticks: ticksOf(view!) })).ok).toBe(true);
  });

  it("an agent and a human with the same display name differ by kind and principal id", async () => {
    const { seen, hook } = recorder(rule);
    const { rt } = await setup(hook);
    const requested = await requestIssuance(rt, agentAlice, "hmac-acme-app");
    if (requested.status !== "pending-approval") throw new Error("expected an approval request");
    expect(getApproval(rt, requested.approvalId).requestedByRef).toEqual({ name: "alice", kind: "agent", principalId: "agent-1" });
    await resolveApproval(rt, aliceP, requested.approvalId, "approve");
    const [view] = await listIssuances(rt);
    expect(view!.preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a" });
    expect(view!.requestedBy).toEqual({ name: "alice", kind: "agent", principalId: "agent-1" });
    // Equal names, different kind and principal: the rule treats them as two parties.
    const subject = seen.find((r) => r.action === "approval.resolve")!.subject!;
    expect(subject.requestedBy).toBe(aliceP.name);
    expect(same(subject.requestedByRef!, actorRef(aliceP))).toBe(false);
  });

  it("a principal cannot approve its own request, even as another kind of caller", async () => {
    const { rt } = await setup(rule);
    const requested = await requestIssuance(rt, agentAlice, "hmac-acme-app");
    if (requested.status !== "pending-approval") throw new Error("expected an approval request");
    const sameIdHuman = { kind: "human", name: "someone", principalId: "agent-1" } as const;
    await expect(resolveApproval(rt, sameIdHuman, requested.approvalId, "approve")).rejects.toThrow(/eigene Anfrage/);
    expect(getApproval(rt, requested.approvalId).state).toBe("pending");
  });
});

describe("what the hook returns and how it fails", () => {
  const faults = () => {
    const seen: { action: string; reason: string; errorName?: string }[] = [];
    return { seen, onAuthorizeFault: (fault: { action: string; reason: string; errorName?: string }) => void seen.push(fault) };
  };
  class CustomHookFailure extends Error {}

  const closedGate = async (hook: unknown, extra: Partial<RuntimeOptions> = {}) => {
    const { seen, onAuthorizeFault } = faults();
    const world = await setup(hook as Authorize, { onAuthorizeFault, ...extra });
    await expect(requestIssuance(world.rt, human, "hmac-acme-app")).rejects.toThrow(GENERIC);
    expect(world.calls).toEqual([]);
    expect(world.rt.issuances.list()).toEqual([]);
    return seen;
  };

  it("anything but undefined is a refusal: false, an object, a promise of either", async () => {
    expect(await closedGate(() => false)).toEqual([{ action: "issuance.prepare", reason: "returned-value" }]);
    expect(await closedGate(() => ({ allowed: true }))).toEqual([{ action: "issuance.prepare", reason: "returned-value" }]);
    expect(await closedGate(async () => false)).toEqual([{ action: "issuance.prepare", reason: "returned-value" }]);
    expect(await closedGate(() => null)).toEqual([{ action: "issuance.prepare", reason: "returned-value" }]);
  });

  it("a hook that never settles fails closed after authorizeTimeoutMs", async () => {
    const seen = await closedGate(() => new Promise<void>(() => undefined), { authorizeTimeoutMs: 20 });
    expect(seen).toEqual([{ action: "issuance.prepare", reason: "timeout" }]);
  });

  it("a hook that is not a function fails closed", async () => {
    expect(await closedGate("allow")).toEqual([{ action: "issuance.prepare", reason: "not-a-function" }]);
  });

  it("a foreign error is reported by class name only, never by message", async () => {
    const seen = await closedGate(() => {
      throw new CustomHookFailure(`internal detail ${MANUAL}`);
    });
    expect(seen).toEqual([{ action: "issuance.prepare", reason: "threw", errorName: "CustomHookFailure" }]);
    expect(JSON.stringify(seen)).not.toContain("internal detail");
    expect(await closedGate(() => Promise.reject("plain text"))).toEqual([{ action: "issuance.prepare", reason: "threw", errorName: "string" }]);
  });

  it("a PolicyError is a normal refusal: its text passes, nothing is reported as a fault", async () => {
    const { seen, onAuthorizeFault } = faults();
    const { rt } = await setup(() => {
      throw new PolicyError("only with a second person");
    }, { onAuthorizeFault });
    await expect(requestIssuance(rt, human, "hmac-acme-app")).rejects.toThrow("only with a second person");
    expect(seen).toEqual([]);
  });

  it("a callback that throws changes nothing, and so does a missing one", async () => {
    const { rt } = await setup(() => false, {
      onAuthorizeFault: () => {
        throw new Error("callback broke");
      },
    });
    await expect(requestIssuance(rt, human, "hmac-acme-app")).rejects.toThrow(GENERIC);
    const { rt: bare } = await setup(() => false);
    await expect(requestIssuance(bare, human, "hmac-acme-app")).rejects.toThrow(GENERIC);
  });

  it("a fast hook is not cut off by the timeout, and the timer does not linger", async () => {
    const { rt } = await setup(async () => undefined, { authorizeTimeoutMs: 5000 });
    expect((await requestIssuance(rt, human, "hmac-acme-app")).status).toBe("awaiting-review");
  });

  it("authorizeTimeoutMs must be an integer from 1 to 2147483647; the default needs no setting", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2147483648, "10", null]) {
      await expect(setup(() => undefined, { authorizeTimeoutMs: bad as never }), String(bad)).rejects.toThrow("Konfiguration ungueltig: authorizeTimeoutMs");
    }
    expect((await setup(() => undefined, { authorizeTimeoutMs: 1 })).rt.authorizeTimeoutMs).toBe(1);
    expect((await setup(() => undefined, { authorizeTimeoutMs: 2147483647 })).rt.authorizeTimeoutMs).toBe(2147483647);
    expect("authorizeTimeoutMs" in (await setup(() => undefined)).rt).toBe(false);
  });

  it("the timer is unref'd when the runtime offers it, and a plain number timer is fine", async () => {
    const { rt } = await setup(() => undefined);
    const unref = vi.fn();
    vi.stubGlobal("setTimeout", () => ({ unref }));
    try {
      await authorize(rt, { actor: human, action: "inventory.edit" });
      expect(unref).toHaveBeenCalledTimes(1);
      vi.stubGlobal("setTimeout", () => 7);
      await authorize(rt, { actor: human, action: "inventory.edit" });
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("env export is asked before values are produced or written", () => {
  it("exportEnvContent: built-in policy first, then the hook with repository and stage ids; a refusal returns nothing", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt } = await setup(hook);
    await expect(exportEnvContent(rt, agent, { repo: "acme-docs", stage: "staging" })).rejects.toThrow(/keine .env exportieren/);
    await expect(exportEnvContent(rt, human, { repo: "acme-docs", stage: "nope" })).rejects.toThrow(/Unbekannte Stage/);
    expect(seen).toEqual([]);
    const error = await exportEnvContent(rt, human, { repo: "acme-docs", stage: "dev", include: "all" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe(REFUSAL);
    expect(seen).toEqual([{ actor: human, action: "env.export", subject: { repo: "acme-docs", stage: "dev" } }]);
    expect(JSON.stringify(seen)).not.toContain("localhost:3000");
    const open = await setup(recorder().hook);
    expect(await exportEnvContent(open.rt, human, { repo: "acme-docs", stage: "dev" })).toMatchObject({ repo: "acme-docs", stage: "dev", filename: ".env.local" });
  });

  it("exportEnv: no file is written when the hook refuses; an allowing hook changes nothing", async () => {
    const { seen, hook } = recorder(refuse);
    const { rt, dir } = await setup(hook);
    const target = join(dir, ".env.authz");
    await expect(exportEnv(rt, agent, { repo: "acme-docs", path: target, overwrite: true })).rejects.toThrow(/nur ein Mensch/);
    expect(seen).toEqual([]);
    await expect(exportEnv(rt, human, { repo: "acme-docs", path: target })).rejects.toThrow(REFUSAL);
    expect(seen).toEqual([{ actor: human, action: "env.export", subject: { repo: "acme-docs", stage: "dev" } }]);
    await expect(readFile(target, "utf8")).rejects.toThrow();
    const open = await setup(recorder().hook);
    const written = await exportEnv(open.rt, human, { repo: "acme-docs", path: join(open.dir, ".env.authz") });
    expect(written).toMatchObject({ status: "written", keys: ["SITE_URL"] });
    expect(await readFile(join(open.dir, ".env.authz"), "utf8")).toContain("SITE_URL");
  });
});
