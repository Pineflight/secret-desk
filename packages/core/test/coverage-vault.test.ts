import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretValue, SecretVault, VaultUnavailableError, defaultKeySource, envKeySource, fileKeySource, macKeychainKeySource, secretToolKeySource, windowsDpapiKeySource } from "../src/index.js";
import type { KeySource, VaultExec } from "../src/index.js";

const tmp = (prefix = "vault") => mkdtemp(join(tmpdir(), `sd-cov-${prefix}-`));
const fixedKey = (k = randomBytes(32)): KeySource => ({ label: "test", key: async () => k });
const posixOnly = process.platform === "win32";

afterEach(() => vi.unstubAllEnvs());

describe("env key source", () => {
  it("rejects a missing key and one that is not 32 bytes", async () => {
    await expect(envKeySource({}).key()).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(envKeySource({ SECRET_DESK_VAULT_KEY: Buffer.from("short").toString("base64") }).key()).rejects.toThrow("kein 32-Byte-Schluessel");
  });
});

describe("macOS keychain source", () => {
  const notFound = Object.assign(new Error("not found"), { code: 44 });
  it("creates a key through stdin when the entry is missing, and fails when the store refuses", async () => {
    const calls: unknown[][] = [];
    const exec: VaultExec = async (...args) => {
      calls.push(args);
      if (args[1]![0] === "find-generic-password") throw notFound;
      return "";
    };
    const key = await macKeychainKeySource(exec).key();
    expect(key).toHaveLength(32);
    expect(calls[1]![2]).toContain(key.toString("base64"));
    expect(calls[1]![1]).toEqual(["-i"]);
    const refusing: VaultExec = async (_f, args) => {
      if (args[0] === "find-generic-password") throw notFound;
      throw new Error("denied");
    };
    await expect(macKeychainKeySource(refusing).key()).rejects.toThrow("nicht erreichbar oder wurde verweigert");
  });
});

describe("secret-tool source", () => {
  it("a stored entry that is not a key is replaced by a fresh one", async () => {
    const calls: string[][] = [];
    const exec: VaultExec = async (_f, args) => {
      calls.push(args);
      return args[0] === "lookup" ? "garbage" : "";
    };
    expect(await secretToolKeySource(exec).key()).toHaveLength(32);
    expect(calls.map((c) => c[0])).toEqual(["lookup", "store"]);
  });
  it("names a missing binary when storing, and an unreachable keyring otherwise", async () => {
    const missing = Object.assign(new Error("x"), { code: "ENOENT" });
    const lookupEmpty = (storeError: Error): VaultExec => async (_f, args) => {
      if (args[0] === "lookup") return "";
      throw storeError;
    };
    await expect(secretToolKeySource(lookupEmpty(missing)).key()).rejects.toThrow("nicht installiert");
    await expect(secretToolKeySource(lookupEmpty(new Error("no dbus"))).key()).rejects.toThrow("kann den Schluesselbund nicht erreichen");
  });
});

describe.skipIf(posixOnly)("default exec runs a real process (a fake secret-tool on the PATH)", () => {
  async function fakeSecretTool(script: string): Promise<string> {
    const bin = await tmp("bin");
    await writeFile(join(bin, "secret-tool"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  }

  it("lookup output becomes the key", async () => {
    const key = randomBytes(32).toString("base64");
    const bin = await fakeSecretTool(`echo "${key}"`);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    expect((await secretToolKeySource().key()).toString("base64")).toBe(key);
  });

  it("a missing entry is created: the new key goes to the tool through stdin", async () => {
    const out = join(await tmp("out"), "stored");
    const bin = await fakeSecretTool(`if [ "$1" = lookup ]; then exit 1; fi\ncat > "${out}"`);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    const key = await secretToolKeySource().key();
    expect(await readFile(out, "utf8")).toBe(key.toString("base64"));
  });

  it("a tool that is not installed is reported", async () => {
    vi.stubEnv("PATH", await tmp("empty"));
    await expect(secretToolKeySource().key()).rejects.toThrow("nicht installiert");
  });
});

describe("Windows DPAPI source", () => {
  const BLOB = "QUJDREVGR0hJSktMTU5PUA==";
  const base = async () => join(await tmp("dpapi"), "vault.json.key");
  const missing = Object.assign(new Error("x"), { code: "ENOENT" });

  it("without an injected exec it asks the real PowerShell, which is not there on this machine", async () => {
    if (process.platform === "win32") return;
    vi.stubEnv("PATH", await tmp("empty"));
    await expect(windowsDpapiKeySource({ keyFile: await base() }).key()).rejects.toThrow("PowerShell (powershell.exe) wurde nicht gefunden");
  });

  it("an unreadable key file (a directory) is reported", async () => {
    const dir = await tmp("dpapi");
    await expect(windowsDpapiKeySource({ keyFile: dir, exec: async () => "" }).key()).rejects.toThrow("ist nicht lesbar");
  });

  it("a corrupt blob is refused without calling PowerShell", async () => {
    const file = await base();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "not base64 !!!");
    const exec = vi.fn();
    await expect(windowsDpapiKeySource({ keyFile: file, exec }).key()).rejects.toThrow("beschaedigt");
    expect(exec).not.toHaveBeenCalled();
  });

  it("opening an existing blob: PowerShell missing, DPAPI refusing, an answer that is no key, and the key itself", async () => {
    const file = await base();
    await writeFile(file, `${BLOB}\n`);
    await expect(windowsDpapiKeySource({ keyFile: file, exec: async () => { throw missing; } }).key()).rejects.toThrow("PowerShell (powershell.exe) wurde nicht gefunden");
    await expect(windowsDpapiKeySource({ keyFile: file, exec: async () => { throw new Error("denied"); } }).key()).rejects.toThrow("laesst sich mit DPAPI nicht oeffnen");
    await expect(windowsDpapiKeySource({ keyFile: file, exec: async () => "short" }).key()).rejects.toThrow("enthaelt keinen gueltigen Schluessel");
    const key = randomBytes(32);
    expect((await windowsDpapiKeySource({ keyFile: file, exec: async () => key.toString("base64") }).key()).equals(key)).toBe(true);
  });

  it("creating a key: protect failures and a bad blob are reported; a good blob is stored", async () => {
    await expect(windowsDpapiKeySource({ keyFile: await base(), exec: async () => { throw missing; } }).key()).rejects.toThrow("PowerShell (powershell.exe) wurde nicht gefunden");
    await expect(windowsDpapiKeySource({ keyFile: await base(), exec: async () => { throw new Error("denied"); } }).key()).rejects.toThrow("DPAPI ist nicht erreichbar");
    await expect(windowsDpapiKeySource({ keyFile: await base(), exec: async () => "!" }).key()).rejects.toThrow("keinen gueltigen Blob");
    const file = await base();
    const key = await windowsDpapiKeySource({ keyFile: file, exec: async () => `${BLOB}\n` }).key();
    expect(key).toHaveLength(32);
    expect((await readFile(file, "utf8")).trim()).toBe(BLOB);
  });
});

describe("key file source", () => {
  it.skipIf(posixOnly)("an unreadable key file (a directory with a private mode) is reported", async () => {
    const dir = await tmp("keyfile");
    await chmod(dir, 0o700);
    await expect(fileKeySource(dir).key()).rejects.toThrow("ist nicht lesbar");
  });

  it("on Windows the mode check is skipped and a missing file is created", async () => {
    const file = join(await tmp("keyfile"), "sub", "key");
    const key = await fileKeySource(file, "win32").key();
    expect((await readFile(file, "utf8")).trim()).toBe(key.toString("base64"));
    expect((await fileKeySource(file, "win32").key()).equals(key)).toBe(true);
  });

  it("two first uses at once end up with the same key", async () => {
    const file = join(await tmp("keyfile"), "key");
    const source = fileKeySource(file);
    const [a, b] = await Promise.all([source.key(), source.key()]);
    expect(a.equals(b)).toBe(true);
  });
});

describe("default key source", () => {
  const exec: VaultExec = async () => "";
  it("picks the source by platform", () => {
    expect(defaultKeySource({}, "darwin", exec).label).toBe("macOS-Schluesselbund");
    expect(defaultKeySource({}, "linux", exec).label).toBe("Schluesselbund (secret-tool)");
    expect(defaultKeySource({}, "freebsd" as never, exec).label).toBe("Umgebungsvariable SECRET_DESK_VAULT_KEY");
    expect(defaultKeySource({ SECRET_DESK_VAULT_KEY: "x" }, "linux", exec).label).toBe("Umgebungsvariable SECRET_DESK_VAULT_KEY");
    expect(defaultKeySource({}, "linux", exec, { keyFile: "/some/key" }).label).toBe("Schluesseldatei /some/key");
  });
  it("on Windows the key file defaults to <vault file>.key, or to the key file given", () => {
    expect(defaultKeySource({}, "win32", exec, { vaultFile: "/v/vault.json" }).label).toBe("Windows DPAPI (Benutzerkonto)");
    expect(defaultKeySource({}, "win32", exec, { keyFile: "/v/k" }).label).toBe("Windows DPAPI (Benutzerkonto)");
    expect(defaultKeySource({}, "win32", undefined).label).toBe("Windows DPAPI (Benutzerkonto)");
  });
});

describe("SecretVault", () => {
  it("the default key source comes from the environment; the label tells which one", async () => {
    vi.stubEnv("SECRET_DESK_VAULT_KEY", randomBytes(32).toString("base64"));
    const file = join(await tmp(), "vault.json");
    const vault = new SecretVault({ file, keyFile: "/ignored/because/the/env/wins" });
    expect(vault.label).toBe("Umgebungsvariable SECRET_DESK_VAULT_KEY");
    await vault.set("a", "value-1");
    expect((await new SecretVault({ file }).get("a"))!.reveal()).toBe("value-1");
  });

  it("without a file it uses the default vault location (only constructed here, never read)", () => {
    expect(new SecretVault({ keySource: fixedKey() }).label).toBe("test");
  });

  it("has, info and delete: unknown ids are no problem; a SecretValue can be stored", async () => {
    const file = join(await tmp(), "vault.json");
    const vault = new SecretVault({ file, keySource: fixedKey() });
    expect(await vault.has("a")).toBe(false);
    expect(await vault.info("a")).toBeNull();
    await vault.delete("a");
    await expect(readFile(file)).rejects.toThrow();
    await vault.set("a", SecretValue.from("made-up"), null);
    expect(await vault.has("a")).toBe(true);
    expect(await vault.info("a")).toMatchObject({ id: "a", expires: null });
    await vault.delete("a");
    expect(await vault.has("a")).toBe(false);
  });

  it.skipIf(posixOnly || process.getuid?.() === 0)("a corrupt vault is reported even when no copy can be made", async () => {
    const dir = await tmp();
    const file = join(dir, "vault.json");
    await writeFile(file, "{ corrupt");
    await chmod(dir, 0o500);
    try {
      await expect(new SecretVault({ file, keySource: fixedKey() }).list()).rejects.toThrow("beschaedigt");
      expect((await readdir(dir)).filter((f) => f.includes("corrupt-"))).toEqual([]);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
