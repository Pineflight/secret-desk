import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStore, NotConnectedError, SecretValue, SessionVault, VaultUnavailableError } from "../src/index.js";
import type { SourceSpec } from "../src/index.js";

const NOW = () => new Date("2026-03-01T12:00:00Z");
type FakeVault = { get?: (id: string) => Promise<SecretValue | null>; info?: (id: string) => Promise<unknown>; list?: () => Promise<{ id: string }[]> };
const store = (over: { specs?: Record<string, SourceSpec>; vault?: FakeVault; env?: NodeJS.ProcessEnv; exec?: (f: string, a: string[]) => Promise<string>; session?: SessionVault } = {}) =>
  new ConnectionStore({ now: NOW, ...over, ...(over.vault ? { vault: over.vault as never } : {}) });
const hintOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as NotConnectedError).hint;
  }
  throw new Error("expected a NotConnectedError");
};

afterEach(() => vi.unstubAllEnvs());

describe("SessionVault", () => {
  it("takes a SecretValue as it is, forgets everything on clear", () => {
    const vault = new SessionVault();
    const value = SecretValue.from("made-up");
    vault.set("a", value, "2026-04-01");
    vault.set("b", "plain");
    expect(vault.get("a")).toBe(value);
    expect(vault.expires("a")).toBe("2026-04-01");
    expect(vault.expires("b")).toBeUndefined();
    vault.set("a", value);
    expect(vault.expires("a")).toBeUndefined();
    expect(vault.ids()).toEqual(["a", "b"]);
    vault.clear();
    expect(vault.ids()).toEqual([]);
    expect(vault.has("a")).toBe(false);
  });
});

describe("token", () => {
  it("a valid session token wins; an expired one is no longer used and the reason is named", async () => {
    const session = new SessionVault();
    session.set("gh", "made-up", "2026-03-02");
    expect((await store({ session }).token("gh")).reveal()).toBe("made-up");
    session.set("gh", "made-up", "2026-02-01");
    expect(await hintOf(store({ session }).token("gh"))).toBe("Token abgelaufen. Im Portal unter Verbindungen ein neues Token eingeben.");
  });

  it("a vault token is used; an expired one is not; a failing info lookup does not matter", async () => {
    const value = SecretValue.from("from-vault");
    expect((await store({ vault: { get: async () => value, info: async () => ({ expires: "2026-04-01" }) } }).token("gh")).reveal()).toBe("from-vault");
    expect((await store({ vault: { get: async () => value, info: async () => { throw new Error("x"); } } }).token("gh")).reveal()).toBe("from-vault");
    expect((await store({ vault: { get: async () => value, info: async () => null } }).token("gh")).reveal()).toBe("from-vault");
    expect(await hintOf(store({ vault: { get: async () => value, info: async () => ({ expires: "2026-01-01" }) } }).token("gh"))).toContain("Token abgelaufen");
  });

  it("keeps the first reason when session and vault are both expired", async () => {
    const session = new SessionVault();
    session.set("gh", "x", "2026-01-01");
    const vault = { get: async () => SecretValue.from("v"), info: async () => ({ expires: "2026-01-02" }) };
    expect(await hintOf(store({ session, vault }).token("gh"))).toContain("Token abgelaufen");
  });

  it("an empty vault falls back; an unreadable vault says so; any other vault error is thrown", async () => {
    expect(await hintOf(store({ vault: { get: async () => null } }).token("gh"))).toBe("Im Portal unter Verbindungen ein Token fuer diese Sitzung eingeben.");
    expect(await hintOf(store({ vault: { get: async () => { throw new VaultUnavailableError("locked"); } } }).token("gh"))).toBe("Tresor-Eintrag nicht lesbar. Im Portal unter Verbindungen ein neues Token eingeben.");
    await expect(store({ vault: { get: async () => { throw new Error("disk full"); } } }).token("gh").catch((e) => { throw e; })).rejects.toThrow("disk full");
  });

  it("a connection without a spec, or with the session spec, needs the portal", async () => {
    expect(await hintOf(store().token("gh"))).toContain("Token fuer diese Sitzung eingeben");
    expect(await hintOf(store({ specs: { gh: { type: "session" } } }).token("gh"))).toContain("Token fuer diese Sitzung eingeben");
  });

  it("an env spec reads the variable", async () => {
    const specs: Record<string, SourceSpec> = { gh: { type: "env", name: "GH_TOKEN_X" } };
    expect((await store({ specs, env: { GH_TOKEN_X: "from-env" } }).token("gh")).reveal()).toBe("from-env");
    expect(await hintOf(store({ specs, env: {} }).token("gh"))).toBe("Umgebungsvariable GH_TOKEN_X ist nicht gesetzt.");
  });

  it("an op spec reads through the 1Password CLI; an empty answer or a failure is a not-connected error", async () => {
    const specs: Record<string, SourceSpec> = { gh: { type: "op", ref: "op://vault/item/field" } };
    const calls: unknown[][] = [];
    const ok = store({ specs, exec: async (f, a) => { calls.push([f, a]); return "  from-op\n"; } });
    expect((await ok.token("gh")).reveal()).toBe("from-op");
    expect(calls).toEqual([["op", ["read", "op://vault/item/field"]]]);
    expect(await hintOf(store({ specs, exec: async () => "  " }).token("gh"))).toContain("konnte nicht gelesen werden");
    expect(await hintOf(store({ specs, exec: async () => { throw new Error("not signed in"); } }).token("gh"))).toContain("op://vault/item/field");
  });

  it.skipIf(process.platform === "win32")("without an injected exec it runs the real op binary", async () => {
    const bin = await mkdtemp(join(tmpdir(), "sd-cov-op-"));
    await writeFile(join(bin, "op"), '#!/bin/sh\nif [ "$2" = "op://good" ]; then echo from-real-op; else exit 1; fi\n', { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    expect((await new ConnectionStore({ specs: { gh: { type: "op", ref: "op://good" } } }).token("gh")).reveal()).toBe("from-real-op");
    expect(await hintOf(new ConnectionStore({ specs: { gh: { type: "op", ref: "op://bad" } } }).token("gh"))).toContain("konnte nicht gelesen werden");
  });

  it("uses the process environment and clock by default", async () => {
    vi.stubEnv("SD_COV_DEFAULT_TOKEN", "from-process-env");
    const s = new ConnectionStore({ specs: { gh: { type: "env", name: "SD_COV_DEFAULT_TOKEN" } } });
    expect((await s.token("gh")).reveal()).toBe("from-process-env");
    s.session.set("x", "y", "2000-01-01");
    expect((await s.status("x")).connected).toBe(false);
  });
});

describe("status", () => {
  it("a valid session token, with and without a date", async () => {
    const session = new SessionVault();
    session.set("a", "x", "2026-04-01");
    session.set("b", "x", null);
    session.set("c", "x");
    const s = store({ session });
    expect(await s.status("a")).toEqual({ id: "a", connected: true, source: "session", expires: "2026-04-01" });
    expect(await s.status("b")).toEqual({ id: "b", connected: true, source: "session", expires: null });
    expect(await s.status("c")).toEqual({ id: "c", connected: true, source: "session" });
  });

  it("an expired session token without any other source names the reason", async () => {
    const session = new SessionVault();
    session.set("a", "x", "2026-01-01");
    expect(await store({ session }).status("a")).toEqual({ id: "a", connected: false, source: "none", hint: "Token abgelaufen" });
  });

  it("a readable vault entry is connected, with fingerprint and date when there is one", async () => {
    const vault = { info: async () => ({ id: "a", fingerprint: "abc123", expires: "2026-05-01" }), get: async () => SecretValue.from("x") };
    expect(await store({ vault }).status("a")).toEqual({ id: "a", connected: true, source: "vault", fingerprint: "abc123", expires: "2026-05-01" });
    const noDate = { info: async () => ({ id: "a", fingerprint: "abc123" }), get: async () => SecretValue.from("x") };
    expect(await store({ vault: noDate }).status("a")).toEqual({ id: "a", connected: true, source: "vault", fingerprint: "abc123" });
  });

  it("an expired vault entry is not connected and says why; a session reason is kept", async () => {
    const expired = { info: async () => ({ id: "a", fingerprint: "f", expires: "2026-01-01" }), get: async () => SecretValue.from("x") };
    expect(await store({ vault: expired }).status("a")).toMatchObject({ connected: false, hint: "Token abgelaufen" });
    const session = new SessionVault();
    session.set("a", "x", "2026-01-01");
    expect(await store({ session, vault: expired }).status("a")).toMatchObject({ connected: false, hint: "Token abgelaufen" });
  });

  it("an unreadable vault entry is reported; other vault errors only drop the entry", async () => {
    const info = async () => ({ id: "a", fingerprint: "f" });
    expect(await store({ vault: { info, get: async () => { throw new VaultUnavailableError("locked"); } } }).status("a")).toMatchObject({ connected: false, hint: "Tresor-Eintrag nicht lesbar" });
    const session = new SessionVault();
    session.set("a", "x", "2026-01-01");
    expect(await store({ session, vault: { info, get: async () => { throw new VaultUnavailableError("locked"); } } }).status("a")).toMatchObject({ hint: "Token abgelaufen" });
    expect(await store({ vault: { info, get: async () => { throw new Error("disk"); } } }).status("a")).toMatchObject({ connected: false, hint: "Nicht konfiguriert" });
    expect(await store({ vault: { info: async () => null } }).status("a")).toMatchObject({ connected: false, hint: "Nicht konfiguriert" });
  });

  it("env specs: set or missing; session spec: needs input", async () => {
    const specs: Record<string, SourceSpec> = { e: { type: "env", name: "X_VAR" }, s: { type: "session" } };
    expect(await store({ specs, env: { X_VAR: "v" } }).status("e")).toEqual({ id: "e", connected: true, source: "env" });
    expect(await store({ specs, env: {} }).status("e")).toEqual({ id: "e", connected: false, source: "env", hint: "X_VAR fehlt" });
    expect(await store({ specs }).status("s")).toEqual({ id: "s", connected: false, source: "session", hint: "Token fuer diese Sitzung eingeben" });
  });

  it("op specs: readable, not signed in, or an unexpected failure", async () => {
    const specs: Record<string, SourceSpec> = { o: { type: "op", ref: "op://a/b" } };
    expect(await store({ specs, exec: async () => "v" }).status("o")).toEqual({ id: "o", connected: true, source: "op" });
    expect((await store({ specs, exec: async () => "" }).status("o")).hint).toContain("konnte nicht gelesen werden");
    const failing = store({ specs, exec: async () => { throw new Error("x"); } });
    expect((await failing.status("o")).hint).toContain("op://a/b");
    // A programming error inside token() is reported as a failed op, not thrown.
    const broken = store({ specs, exec: async () => { throw new Error("x"); } });
    vi.spyOn(broken, "token").mockRejectedValue(new Error("unexpected"));
    expect(await broken.status("o")).toEqual({ id: "o", connected: false, source: "op", hint: "op fehlgeschlagen" });
  });

  it("statuses asks for every id; ids lists session, specs and vault, without internal entries, and survives an unreadable vault", async () => {
    const session = new SessionVault();
    session.set("stripe:acct_A:live", "x");
    session.set("stripe:acct_A:live#label", "x");
    const vault = { list: async () => [{ id: "stripe:acct_B:live" }, { id: "x#meta" }, { id: "x#value" }] };
    const s = store({ session, vault, specs: { "stripe:acct_C:live": { type: "session" } } });
    expect(await s.ids("stripe:")).toEqual(["stripe:acct_A:live", "stripe:acct_B:live", "stripe:acct_C:live"]);
    expect(await store({ vault: { list: async () => { throw new Error("locked"); } }, specs: { a: { type: "session" } } }).ids()).toEqual(["a"]);
    expect((await s.statuses(["a", "b"])).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
