import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionStore,
  InventoryStore,
  ProviderRegistry,
  SecretValue,
  addUnrevokedNotices,
  buildEnvFile,
  commitIssuance,
  entryHoldingId,
  forgetRunValues,
  prepareIssuance,
  revokeIssuedTokens,
  rotateSecret,
  unrevokedNotices,
  writeEnvFile,
} from "../src/index.js";
import type { EnvTemplate, Provider } from "../src/index.js";

// The rule behind these tests: revoking a value that is in use is worse than leaving an unconfirmed value valid. A provider that
// rotates in place hands back the identifier the entry already has, so "the new value" and "the old value" are one object there.

const LONG = "made-up-long-value-0123456789";

/** Rotates in place: the new value keeps the identifier of the entry. A new object otherwise. */
const issuer = (mode: "in-place" | "new-id", over: Partial<Provider> = {}) => {
  const issue = vi.fn(async (ctx: { secret: { externalId?: string } }) => ({ value: new SecretValue(LONG), externalId: mode === "in-place" ? (ctx.secret.externalId ?? "created-id") : "new-id", expiresAt: null as string | null }));
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue: issue as never, revoke, ...over };
  return { provider, issue, revoke };
};

describe("environment export: values are revoked only through the gate", () => {
  const YAML = (id: string) => `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none, externalId: same-id }
  - { id: dev-other, name: DEV_OTHER, stage: dev, service: x, provider: breaks, expiry: none${id} }
envTemplates:
  - id: tpl
    repo: acme-app
    stage: dev
    file: .env.local
    entries:
      - { key: TOKEN, from: { type: issue, secret: dev-token } }
      - { key: OTHER, from: { type: issue, secret: dev-other } }
`;
  const world = (mode: "in-place" | "new-id", extra = "") => {
    const first = issuer(mode);
    const breaks: Provider = { id: "breaks", label: "Breaks", kind: "automatic", issue: async () => Promise.reject(new Error("later entry failed")), revoke: vi.fn(async () => undefined) };
    const inventory = InventoryStore.fromText(YAML(extra));
    const providers = new ProviderRegistry().register(first.provider).register(breaks);
    const deps = { inventory, providers, connections: new ConnectionStore() };
    return { ...first, inventory, deps, template: inventory.data.envTemplates[0] as EnvTemplate };
  };

  it("a later entry failing does not delete a token whose identifier is the entry's current one (provider rotates in place)", async () => {
    const w = world("in-place");
    const err = await buildEnvFile(w.template, w.deps).catch((e: Error) => e);
    expect((err as Error).message).toContain("later entry failed");
    expect(w.revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toContain("Nicht widerrufen, weil die Kennung im Inventar noch die aktuelle ist");
    expect((err as Error).message).toContain("dev-token (same-id)");
    expect((err as Error).message).not.toContain("von Hand entfernen");
  });

  it("a later entry failing still deletes a token that has a new identifier", async () => {
    const w = world("new-id");
    const err = await buildEnvFile(w.template, w.deps).catch((e: Error) => e);
    expect(w.revoke).toHaveBeenCalledTimes(1);
    expect(w.revoke.mock.calls[0]![0]).toMatchObject({ externalId: "new-id" });
    expect((err as Error).message).toBe("later entry failed");
  });

  it("never deletes an identifier that is the current one of another entry of the same export", async () => {
    const w = world("new-id");
    w.inventory.patchSecret("dev-other", { externalId: "new-id" });
    const outcomes = await revokeIssuedTokens([{ secretId: "dev-token", provider: "acme", externalId: "new-id" }, { secretId: "dev-other", externalId: "other-new" }], w.deps);
    expect(outcomes).toEqual([
      { secretId: "dev-token", externalId: "new-id", result: "value-in-use" },
      { secretId: "dev-other", externalId: "other-new", result: "revoked" },
    ]);
    // The first provider was never asked; the second one, whose entry does not hold the identifier, was.
    expect(w.revoke).not.toHaveBeenCalled();
  });

  it("a failed export forgets the values it put into the run, so a later template cannot read them", async () => {
    const w = world("new-id");
    const runValues = new Map<string, string>([["tpl:EARLIER", "made-up-1"], ["other:KEEP", "made-up-2"]]);
    await buildEnvFile(w.template, { ...w.deps, runValues }).catch(() => undefined);
    expect([...runValues.keys()]).toEqual(["other:KEEP"]);
  });

  it("after the file write started nothing is revoked, and the notice says the token stays valid", async () => {
    const w = world("new-id");
    const outcomes = await revokeIssuedTokens([{ secretId: "dev-token", provider: "acme", externalId: "new-id" }], w.deps, { writeStarted: true });
    expect(outcomes).toEqual([{ secretId: "dev-token", externalId: "new-id", result: "write-started" }]);
    expect(w.revoke).not.toHaveBeenCalled();
    expect(unrevokedNotices(outcomes)).toEqual([expect.stringContaining("das Schreiben der Datei begonnen hatte")]);
  });

  it("names every kind of left-over value and adds the sentences to the error, one per line", async () => {
    const outcomes = await revokeIssuedTokens(
      [{ secretId: "gone" }, { secretId: "dev-token", externalId: "same-id" }, { secretId: "dev-other", externalId: "e2" }],
      { ...world("new-id").deps, providers: new ProviderRegistry().register(issuer("new-id", { revoke: async () => Promise.reject(new Error("no")) }).provider) },
    );
    // "dev-other" names the provider "breaks", which this registry does not have: the gate has nothing to call.
    expect(outcomes.map((o) => o.result)).toEqual(["no-id", "value-in-use", "no-revoke"]);
    const err = new Error("export failed");
    addUnrevokedNotices(err, outcomes);
    expect(err.message.split("\n")).toEqual([
      "export failed",
      "Nicht widerrufen (beim Anbieter von Hand entfernen): gone (ohne Kennung), dev-other (e2).",
      expect.stringContaining("dev-token (same-id)"),
    ]);
    expect(unrevokedNotices([])).toEqual([]);
    const notAnError = "plain";
    expect(() => addUnrevokedNotices(notAnError, outcomes)).not.toThrow();
  });

  it("a provider that fails the delete is named for removal by hand", async () => {
    const w = world("new-id");
    const failing = issuer("new-id", { revoke: async () => Promise.reject(new Error("refused")) });
    const outcomes = await revokeIssuedTokens([{ secretId: "dev-token", externalId: "new-id" }], { ...w.deps, providers: new ProviderRegistry().register(failing.provider) });
    expect(outcomes).toEqual([{ secretId: "dev-token", externalId: "new-id", result: "failed" }]);
    expect(unrevokedNotices(outcomes)).toEqual(["Nicht widerrufen (beim Anbieter von Hand entfernen): dev-token (new-id)."]);
  });

  it("forgetRunValues takes no map and leaves other templates alone", () => {
    expect(() => forgetRunValues(undefined, "tpl")).not.toThrow();
    const values = new Map([["tpl:A", "x"], ["tpl2:A", "y"]]);
    forgetRunValues(values, "tpl");
    expect([...values.keys()]).toEqual(["tpl2:A"]);
  });
});

describe("writeEnvFile: when the write counts as started", () => {
  const tmp = () => mkdtemp(join(tmpdir(), "sd-revoke-gate-"));

  it("not when the file exists, the path is outside the allowed roots or the folder cannot be made; yes right before the file is written", async () => {
    const dir = await tmp();
    const started = vi.fn();
    await writeFile(join(dir, ".env.a"), "X=1\n");
    await expect(writeEnvFile(join(dir, ".env.a"), "X=2\n", { onWriteStart: started })).rejects.toThrow("Datei existiert schon");
    await expect(writeEnvFile(join(dir, ".env.b"), "X=2\n", { allowedRoots: [join(dir, "elsewhere")], onWriteStart: started })).rejects.toThrow("ausserhalb");
    await writeFile(join(dir, "blocker"), "a file, not a folder");
    await expect(writeEnvFile(join(dir, "blocker", "sub", ".env"), "X=2\n", { onWriteStart: started })).rejects.toThrow();
    expect(started).not.toHaveBeenCalled();
    await mkdir(join(dir, "ok"));
    await writeEnvFile(join(dir, "ok", ".env"), "X=2\n", { checkIgnored: async () => null, onWriteStart: started });
    expect(started).toHaveBeenCalledTimes(1);
  });
});

describe("rotate flow: the old value", () => {
  const YAML = (extra = "", old = "same-id") => `version: 1
secrets:
  - { id: s1, name: API_KEY, stage: staging, service: x, provider: acme, expiry: possible, externalId: ${old}, places: [{ repo: web, scope: repository }] }
  - { id: s2, name: OTHER_KEY, stage: staging, service: x, provider: manual, expiry: none${extra}, places: [{ repo: api, scope: repository }] }
`;
  const world = (mode: "in-place" | "new-id", over: { yaml?: string; putSecret?: () => Promise<"created" | "updated">; provider?: Partial<Provider> } = {}) => {
    const first = issuer(mode, over.provider);
    const inventory = InventoryStore.fromText(over.yaml ?? YAML());
    const github = { putSecret: vi.fn(over.putSecret ?? (async () => "updated" as const)) };
    const deps = { inventory, github: github as never, providers: new ProviderRegistry().register(first.provider), connections: new ConnectionStore(), owner: "acme", fetch: vi.fn() as never, now: () => new Date("2026-03-01T10:00:00Z") };
    return { ...first, inventory, github, deps };
  };

  it("does not delete the old value when the identifier did not change (provider rotates in place)", async () => {
    const w = world("in-place");
    const r = await rotateSecret("s1", w.deps);
    expect(r).toMatchObject({ ok: true, revoked: false });
    expect(w.revoke).not.toHaveBeenCalled();
    expect(w.inventory.getSecret("s1")!.externalId).toBe("same-id");
  });

  it("still deletes the old value when the provider issued a new identifier", async () => {
    const w = world("new-id");
    const r = await rotateSecret("s1", w.deps);
    expect(r.revoked).toBe(true);
    expect(w.revoke.mock.calls[0]![0]).toMatchObject({ externalId: "same-id" });
    expect(w.inventory.getSecret("s1")!.externalId).toBe("new-id");
  });

  it("does not delete an old identifier that is still the current one of another entry", async () => {
    const w = world("new-id", { yaml: YAML(", externalId: same-id") });
    const r = await rotateSecret("s1", w.deps);
    expect(r).toMatchObject({ ok: true, revoked: false });
    expect(w.revoke).not.toHaveBeenCalled();
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("noch die aktuelle von Eintrag s2")]));
    expect(w.inventory.getSecret("s1")!.externalId).toBe("new-id");
  });
});

describe("rotate flow: the new value after failed writes", () => {
  const YAML = `version: 1
secrets:
  - { id: s1, name: API_KEY, stage: staging, service: x, provider: acme, expiry: possible, externalId: same-id, places: [{ repo: web, scope: repository }, { repo: api, scope: repository }] }
`;
  const timedOut = async (): Promise<never> => Promise.reject(new Error("time-out after the write landed"));
  const world = (mode: "in-place" | "new-id", over: { putSecret?: () => Promise<"created" | "updated">; provider?: Partial<Provider> } = {}) => {
    const first = issuer(mode, over.provider);
    const inventory = InventoryStore.fromText(YAML);
    const github = { putSecret: vi.fn(over.putSecret ?? timedOut) };
    const deps = { inventory, github: github as never, providers: new ProviderRegistry().register(first.provider), connections: new ConnectionStore(), owner: "acme", fetch: vi.fn() as never, now: () => new Date("2026-03-01T10:00:00Z") };
    return { ...first, inventory, github, deps };
  };

  it("all writes failed, provider rotates in place: the token is not deleted, the warning says the identifier is in use", async () => {
    const w = world("in-place");
    const r = await rotateSecret("s1", w.deps);
    expect(r).toMatchObject({ ok: false, partial: false });
    expect(w.revoke).not.toHaveBeenCalled();
    expect(r.newTokenRevoked).toBeUndefined();
    expect(r.orphanExternalId).toBeUndefined();
    expect(r.warnings).toEqual([expect.stringContaining("unter derselben Kennung (same-id) rotiert")]);
  });

  it("all writes failed, new identifier: a write that reported failure may have landed, so the token is not deleted", async () => {
    const w = world("new-id");
    const r = await rotateSecret("s1", w.deps);
    expect(w.revoke).not.toHaveBeenCalled();
    expect(r.newTokenRevoked).toBeUndefined();
    expect(r.orphanExternalId).toBe("new-id");
    expect(r.warnings).toEqual([expect.stringContaining("wurde nicht widerrufen: Schreibvorgaenge wurden gesendet")]);
  });

  it("a person who acknowledged the written places may have it deleted", async () => {
    const w = world("new-id");
    const r = await rotateSecret("s1", w.deps, { acknowledgeWritten: true });
    expect(w.revoke).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ newTokenRevoked: true });
    expect(r.warnings).toEqual([expect.stringContaining("obwohl Schreibvorgaenge gesendet wurden")]);
  });

  it("acknowledged, but the provider fails the delete or cannot delete: named for removal by hand", async () => {
    const failing = world("new-id", { provider: { revoke: async () => Promise.reject(new Error("refused")) } });
    const a = await rotateSecret("s1", failing.deps, { acknowledgeWritten: true });
    expect(a.orphanExternalId).toBe("new-id");
    expect(a.warnings).toEqual([expect.stringContaining("konnte beim Anbieter nicht widerrufen werden")]);
    const none = world("new-id", { provider: { revoke: undefined } });
    const b = await rotateSecret("s1", none.deps, { acknowledgeWritten: true });
    expect(b.orphanExternalId).toBe("new-id");
    expect(b.warnings).toEqual([expect.stringContaining("bleibt beim Anbieter bestehen")]);
  });

  it("all writes failed and the provider named no identifier", async () => {
    const w = world("new-id", { provider: { issue: (async () => ({ value: new SecretValue(LONG) })) as never } });
    const r = await rotateSecret("s1", w.deps);
    expect(r.warnings).toEqual([expect.stringContaining("nennt keine Kennung")]);
    expect(r.orphanExternalId).toBeUndefined();
  });

  it("some writes failed, provider rotates in place: nothing to delete by hand, rewrite the failed places", async () => {
    let n = 0;
    const w = world("in-place", { putSecret: async () => (++n === 1 ? "updated" : Promise.reject(new Error("time-out"))) });
    const r = await rotateSecret("s1", w.deps);
    expect(r).toMatchObject({ ok: false, partial: true });
    expect(w.revoke).not.toHaveBeenCalled();
    expect(r.orphanExternalId).toBeUndefined();
    expect(r.warnings).toEqual([expect.stringContaining("nicht beim Anbieter loeschen")]);
  });
});

describe("issuance flow: the old value", () => {
  const YAML = (extra: string) => `version: 1
secrets:
  - { id: main, name: MAIN_KEY, stage: staging, service: x, provider: acme, expiry: possible, externalId: old-id, places: [{ repo: web, scope: repository }] }
  - { id: lookalike, name: LOOKALIKE, stage: staging, service: x, provider: manual, expiry: none${extra}, places: [{ repo: api, scope: repository }] }
`;
  const run = async (extra: string) => {
    const w = issuer("new-id");
    const inventory = InventoryStore.fromText(YAML(extra));
    const github = { publicKey: vi.fn(async () => ({})), listSecrets: vi.fn(async () => [{ name: "MAIN_KEY", updatedAt: "2026-03-01T10:00:00Z" }]), putSecret: vi.fn(async () => "updated" as const) };
    const deps = { inventory, github: github as never, providers: new ProviderRegistry().register(w.provider), connections: new ConnectionStore(), owner: "acme", fetch: vi.fn() as never, now: () => new Date("2026-03-01T10:00:00Z") };
    const pending = await prepareIssuance("main", deps);
    const result = await commitIssuance(pending, deps, { by: "me", ticks: pending.report.checklist.map((c) => c.id) });
    return { ...w, pending, result };
  };

  it("does not delete the old identifier while another entry still has it as its current one", async () => {
    const w = await run(", externalId: old-id");
    expect(w.result).toMatchObject({ ok: true, revokedOld: false });
    expect(w.revoke).not.toHaveBeenCalled();
    expect(w.pending.report.checks.find((c) => c.id === "revoke-old")).toMatchObject({ status: "warn", label: expect.stringContaining("Eintrag lookalike") });
  });

  it("still deletes it when no other entry has it", async () => {
    const w = await run(", externalId: unrelated");
    expect(w.result.revokedOld).toBe(true);
    expect(w.revoke).toHaveBeenCalledTimes(1);
  });

  it("entryHoldingId names the first entry outside the exceptions", () => {
    const inventory = InventoryStore.fromText(YAML(", externalId: old-id"));
    expect(entryHoldingId(inventory, "old-id", [])).toBe("main");
    expect(entryHoldingId(inventory, "old-id", ["main"])).toBe("lookalike");
    expect(entryHoldingId(inventory, "old-id", ["main", "lookalike"])).toBeUndefined();
  });
});
