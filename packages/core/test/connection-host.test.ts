import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStore, ConnectionStoreCore, MemoryVaultStore, NotConnectedError, SessionVault, Vault, nodeConnectionHost } from "../src/index.js";
import type { ConnectionHost, SourceSpec } from "../src/index.js";

const NOW = () => new Date("2026-03-01T12:00:00Z");
const UNAVAILABLE = "Diese Quelle ist in dieser Umgebung nicht verfuegbar. Im Portal unter Verbindungen ein Token eingeben.";
const ENV_SPEC: Record<string, SourceSpec> = { svc: { type: "env", name: "MADE_UP_HOST_VAR" } };
const OP_SPEC: Record<string, SourceSpec> = { svc: { type: "op", ref: "op://made-up-vault/made-up-item/made-up-field" } };

const newVault = () => new Vault({ store: new MemoryVaultStore(), keySource: { label: "test", key: async () => new Uint8Array(32).fill(7) } });

async function failure(p: Promise<unknown>): Promise<NotConnectedError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(NotConnectedError);
    return err as NotConnectedError;
  }
  throw new Error("expected a NotConnectedError");
}

afterEach(() => vi.unstubAllEnvs());

describe("ConnectionStoreCore without a host", () => {
  it("an env source is not available and names no value", async () => {
    const store = new ConnectionStoreCore({ specs: ENV_SPEC, now: NOW });
    const err = await failure(store.token("svc"));
    expect(err.hint).toBe(UNAVAILABLE);
    expect(err.message).toBe(`Verbindung "svc" ist nicht hergestellt. ${UNAVAILABLE}`);
  });

  it("an op source is not available and does not repeat the reference", async () => {
    const store = new ConnectionStoreCore({ specs: OP_SPEC, now: NOW });
    const err = await failure(store.token("svc"));
    expect(err.hint).toBe(UNAVAILABLE);
    expect(err.message).not.toContain("made-up-field");
    expect(err.message).not.toContain("made-up-item");
  });

  it("status reports not connected with the reason and does not throw", async () => {
    const store = new ConnectionStoreCore({ specs: { ...ENV_SPEC, other: OP_SPEC["svc"]! }, now: NOW });
    expect(await store.status("svc")).toEqual({ id: "svc", connected: false, source: "env", hint: UNAVAILABLE });
    const op = await store.status("other");
    expect(op).toEqual({ id: "other", connected: false, source: "op", hint: UNAVAILABLE });
    expect(JSON.stringify(op)).not.toContain("made-up-field");
  });

  it("a session token and a vault token still win", async () => {
    const session = new SessionVault();
    session.set("svc", "session-made-up");
    const vault = newVault();
    await vault.set("svc", "vault-made-up");
    const withSession = new ConnectionStoreCore({ specs: ENV_SPEC, session, vault, now: NOW });
    expect((await withSession.token("svc")).reveal()).toBe("session-made-up");
    expect(await withSession.status("svc")).toMatchObject({ connected: true, source: "session" });
    const vaultOnly = new ConnectionStoreCore({ specs: OP_SPEC, vault, now: NOW });
    expect((await vaultOnly.token("svc")).reveal()).toBe("vault-made-up");
    expect(await vaultOnly.status("svc")).toMatchObject({ connected: true, source: "vault" });
  });

  it("an expired session token falls through to the unavailable source", async () => {
    const session = new SessionVault();
    session.set("svc", "session-made-up", "2026-02-01");
    const store = new ConnectionStoreCore({ specs: ENV_SPEC, session, now: NOW });
    expect((await failure(store.token("svc"))).hint).toBe(UNAVAILABLE);
    expect(await store.status("svc")).toMatchObject({ connected: false, hint: UNAVAILABLE });
  });

  it("never reads the process environment", async () => {
    vi.stubEnv("MADE_UP_HOST_VAR", "env-made-up-value");
    const store = new ConnectionStoreCore({ specs: ENV_SPEC, now: NOW });
    const err = await failure(store.token("svc"));
    expect(err.message).not.toContain("env-made-up-value");
    expect(await store.status("svc")).toMatchObject({ connected: false });
    const restricted = new ConnectionStore({ specs: ENV_SPEC, host: null, now: NOW });
    expect((await failure(restricted.token("svc"))).hint).toBe(UNAVAILABLE);
    expect(await restricted.status("svc")).toEqual({ id: "svc", connected: false, source: "env", hint: UNAVAILABLE });
  });

  it("a host with only one capability reports the other as unavailable", async () => {
    const onlyEnv: ConnectionHost = { label: "t", env: () => "env-made-up-value" };
    const onlyRead: ConnectionHost = { label: "t", readReference: async () => " read-made-up-value \n" };
    expect((await new ConnectionStoreCore({ specs: ENV_SPEC, host: onlyEnv, now: NOW }).token("svc")).reveal()).toBe("env-made-up-value");
    expect((await failure(new ConnectionStoreCore({ specs: OP_SPEC, host: onlyEnv, now: NOW }).token("svc"))).hint).toBe(UNAVAILABLE);
    expect((await failure(new ConnectionStoreCore({ specs: ENV_SPEC, host: onlyRead, now: NOW }).token("svc"))).hint).toBe(UNAVAILABLE);
    expect((await new ConnectionStoreCore({ specs: OP_SPEC, host: onlyRead, now: NOW }).token("svc")).reveal()).toBe("read-made-up-value");
  });
});

describe("nodeConnectionHost", () => {
  it("looks variables up in the given environment object", () => {
    const host = nodeConnectionHost({ MADE_UP_HOST_VAR: "value-made-up" });
    expect(host.env?.("MADE_UP_HOST_VAR")).toBe("value-made-up");
    expect(host.env?.("MISSING_VAR")).toBeUndefined();
    expect(host.label).not.toBe("");
  });

  it("defaults to the process environment", () => {
    vi.stubEnv("MADE_UP_HOST_VAR", "process-made-up");
    expect(nodeConnectionHost().env?.("MADE_UP_HOST_VAR")).toBe("process-made-up");
  });

  it("readReference calls exec with op read and the reference", async () => {
    const calls: [string, string[]][] = [];
    const host = nodeConnectionHost({}, async (file, args) => {
      calls.push([file, args]);
      return "  out-made-up\n";
    });
    expect(await host.readReference?.("op://a/b/c")).toBe("  out-made-up\n");
    expect(calls).toEqual([["op", ["read", "op://a/b/c"]]]);
  });

  it("the default exec rejects when the op binary is missing", async () => {
    vi.stubEnv("PATH", await mkdtemp(join(tmpdir(), "no-op-")));
    await expect(nodeConnectionHost().readReference?.("op://a/b/c")).rejects.toBeDefined();
  });

  it("a rejection or empty output becomes the existing hint, without a value", async () => {
    const ref = "op://made-up-vault/made-up-item/made-up-field";
    const failing = new ConnectionStore({ specs: OP_SPEC, host: nodeConnectionHost({}, async () => Promise.reject(new Error("boom"))), now: NOW });
    const err = await failure(failing.token("svc"));
    expect(err.hint).toBe(`1Password-Referenz ${ref} konnte nicht gelesen werden (op angemeldet?).`);
    expect(await failing.status("svc")).toEqual({ id: "svc", connected: false, source: "op", hint: err.hint });
    const empty = new ConnectionStore({ specs: OP_SPEC, host: nodeConnectionHost({}, async () => " \n"), now: NOW });
    expect((await failure(empty.token("svc"))).hint).toBe(err.hint);
  });
});

describe("ConnectionStore keeps its old options", () => {
  it("env source: value, missing variable and status", async () => {
    const store = new ConnectionStore({ specs: ENV_SPEC, env: { MADE_UP_HOST_VAR: "value-made-up" }, now: NOW });
    expect((await store.token("svc")).reveal()).toBe("value-made-up");
    expect(await store.status("svc")).toEqual({ id: "svc", connected: true, source: "env" });
    const empty = new ConnectionStore({ specs: ENV_SPEC, env: {}, now: NOW });
    expect((await failure(empty.token("svc"))).hint).toBe("Umgebungsvariable MADE_UP_HOST_VAR ist nicht gesetzt.");
    expect(await empty.status("svc")).toEqual({ id: "svc", connected: false, source: "env", hint: "MADE_UP_HOST_VAR fehlt" });
  });

  it("op source: trimmed value through exec, arguments as before", async () => {
    const calls: [string, string[]][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args]);
      return "out-made-up\n";
    };
    const store = new ConnectionStore({ specs: OP_SPEC, exec, now: NOW });
    expect((await store.token("svc")).reveal()).toBe("out-made-up");
    expect(await store.status("svc")).toEqual({ id: "svc", connected: true, source: "op" });
    expect(calls[0]).toEqual(["op", ["read", "op://made-up-vault/made-up-item/made-up-field"]]);
  });

  it("an explicit host wins over env and exec", async () => {
    const store = new ConnectionStore({ specs: ENV_SPEC, env: { MADE_UP_HOST_VAR: "from-env" }, host: { label: "t", env: () => "from-host" }, now: NOW });
    expect((await store.token("svc")).reveal()).toBe("from-host");
  });
});
