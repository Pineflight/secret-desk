import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { ConfigSchema } from "../src/config.js";
import { SecretVault, VaultUnavailableError, defaultKeySource, fileKeySource, macKeychainKeySource, windowsDpapiKeySource, type KeySource } from "../src/vault.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sd-vault-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const fixedKey = (k = randomBytes(32)): KeySource => ({ label: "test", key: async () => k });

describe("SecretVault", () => {
  it("encrypted: plaintext is never in the file, file has mode 600", async () => {
    const dir = await tmp();
    const file = join(dir, "vault.json");
    const v = new SecretVault({ file, keySource: fixedKey() });
    await v.set("github", "ghp_super_geheimer_token_123", "2027-01-25");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("ghp_super");
    if (process.platform !== "win32") expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600"); // Windows kennt keine POSIX-Modi
    expect((await v.get("github"))!.reveal()).toBe("ghp_super_geheimer_token_123");
    expect(await v.info("github")).toMatchObject({ id: "github", expires: "2027-01-25" });
  });
  it("fingerprint recognizes the token without revealing it", async () => {
    const v = new SecretVault({ file: join(await tmp(), "v.json"), keySource: fixedKey() });
    await v.set("a", "wert-1");
    const f1 = (await v.info("a"))!.fingerprint;
    await v.set("a", "wert-2");
    expect((await v.info("a"))!.fingerprint).not.toBe(f1);
    expect(f1).toMatch(/^[0-9a-f]{12}$/);
  });
  it("wrong key or swapped entry is rejected", async () => {
    const file = join(await tmp(), "v.json");
    await new SecretVault({ file, keySource: fixedKey() }).set("github", "abc");
    await expect(new SecretVault({ file, keySource: fixedKey() }).get("github")).rejects.toBeInstanceOf(VaultUnavailableError);
  });
  it("deletes entries and returns null for unknown ones", async () => {
    const v = new SecretVault({ file: join(await tmp(), "v.json"), keySource: fixedKey() });
    await v.set("x", "1");
    await v.delete("x");
    expect(await v.get("x")).toBeNull();
    expect(await v.list()).toEqual([]);
  });
  it("ConnectionStore uses the vault, session takes precedence", async () => {
    const vault = new SecretVault({ file: join(await tmp(), "v.json"), keySource: fixedKey() });
    await vault.set("github", "aus-tresor", "2027-01-01");
    const store = new ConnectionStore({ vault });
    expect((await store.token("github")).reveal()).toBe("aus-tresor");
    expect(await store.status("github")).toMatchObject({ connected: true, source: "vault", expires: "2027-01-01" });
    store.session.set("github", "aus-sitzung");
    expect((await store.token("github")).reveal()).toBe("aus-sitzung");
  });
});

describe("SecretVault file access", () => {
  it("parallel set calls lose nothing", async () => {
    const v = new SecretVault({ file: join(await tmp(), "v.json"), keySource: fixedKey() });
    await Promise.all(Array.from({ length: 25 }, (_, i) => v.set(`id-${i}`, `wert-${i}`)));
    expect((await v.list()).map((e) => e.id).sort()).toHaveLength(25);
    await Promise.all(Array.from({ length: 10 }, (_, i) => v.delete(`id-${i}`)));
    expect(await v.list()).toHaveLength(15);
  });
  it("broken JSON throws, backs up the file and overwrites nothing", async () => {
    const dir = await tmp();
    const file = join(dir, "v.json");
    await writeFile(file, "{kaputt");
    const v = new SecretVault({ file, keySource: fixedKey() });
    await expect(v.set("a", "x")).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(v.list()).rejects.toThrow(/Kopie/);
    const { readdirSync } = await import("node:fs");
    const backups = readdirSync(dir).filter((n) => n.includes(".corrupt-"));
    expect(backups.length).toBeGreaterThan(0);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe("{kaputt");
  });
  it("missing file is an empty vault", async () => {
    const v = new SecretVault({ file: join(await tmp(), "gibt-es-nicht.json"), keySource: fixedKey() });
    expect(await v.list()).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("nicht lesbare Datei wirft statt zu ueberschreiben", async () => {
    const dir = await tmp();
    const file = join(dir, "v.json");
    await writeFile(file, '{"version":1,"entries":{}}');
    await chmod(file, 0o000);
    const v = new SecretVault({ file, keySource: fixedKey() });
    if (process.getuid?.() !== 0) await expect(v.set("a", "x")).rejects.toBeInstanceOf(VaultUnavailableError);
    await chmod(file, 0o600);
  });
});

describe("KeySource", () => {
  it("macOS: creates the key only on exit code 44, via stdin instead of arguments, and reads it afterwards", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    let stored = "";
    const exec = async (_f: string, args: string[], input?: string) => {
      calls.push({ args, ...(input !== undefined ? { input } : {}) });
      if (args[0] === "find-generic-password") {
        if (!stored) throw Object.assign(new Error("not found"), { code: 44 });
        return stored;
      }
      stored = /-w (\S+)/.exec(input ?? "")![1]!;
      return "";
    };
    const src = macKeychainKeySource(exec);
    const k1 = await src.key();
    const k2 = await src.key();
    expect(k1.length).toBe(32);
    expect(k2.equals(k1)).toBe(true);
    const add = calls.find((c) => c.args[0] === "-i")!;
    expect(add.input).toContain("add-generic-password");
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(k1.toString("base64"));
  });
  it("macOS: locked keychain or other error creates nothing new", async () => {
    for (const code of [36, 51, 1, undefined]) {
      const calls: string[][] = [];
      const exec = async (_f: string, args: string[]) => {
        calls.push(args);
        throw Object.assign(new Error("fehler"), code !== undefined ? { code } : {});
      };
      await expect(macKeychainKeySource(exec).key()).rejects.toBeInstanceOf(VaultUnavailableError);
      expect(calls.some((a) => a[0] === "-i" || a[0] === "add-generic-password")).toBe(false);
    }
  });
  it("macOS: invalid entry is not overwritten", async () => {
    const calls: string[][] = [];
    const exec = async (_f: string, args: string[]) => (calls.push(args), "kein-schluessel");
    await expect(macKeychainKeySource(exec).key()).rejects.toThrow(/nicht ueberschrieben/);
    expect(calls).toHaveLength(1);
  });
  it("takes the environment variable before the keychain", async () => {
    const key = randomBytes(32).toString("base64");
    const src = defaultKeySource({ SECRET_DESK_VAULT_KEY: key } as unknown as NodeJS.ProcessEnv, "darwin");
    expect((await src.key()).toString("base64")).toBe(key);
  });
});

/** Faelscht powershell.exe: Protect/Unprotect als umkehrbare Verpackung, merkt sich alle Aufrufe. */
function fakePowerShell(opts: { failUnprotect?: boolean; missing?: boolean } = {}) {
  const calls: { file: string; args: string[]; input: string }[] = [];
  const exec = async (file: string, args: string[], input = ""): Promise<string> => {
    calls.push({ file, args, input });
    if (opts.missing) throw Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    const b64 = /FromBase64String\('([^']+)'\)/.exec(input)?.[1] ?? "";
    if (input.includes("::Protect(")) return `${Buffer.from(`DPAPI:${b64}`).toString("base64")}\r\n`;
    if (input.includes("::Unprotect(")) {
      if (opts.failUnprotect) throw new Error("Key not valid for use in specified state.");
      return `${Buffer.from(b64, "base64").toString().replace(/^DPAPI:/, "")}\r\n`;
    }
    throw new Error("unerwartetes Skript");
  };
  return { exec, calls };
}

describe("Windows DPAPI (PowerShell mocked)", () => {
  it("creates a key, protects it via DPAPI and reads it again with the same blob", async () => {
    const dir = await tmp();
    const vaultFile = join(dir, "vault.json");
    const ps = fakePowerShell();
    const src = defaultKeySource({} as NodeJS.ProcessEnv, "win32", ps.exec, { vaultFile });
    expect(src.label).toMatch(/DPAPI/);
    const k1 = await src.key();
    expect(k1.length).toBe(32);
    const blob = await readFile(`${vaultFile}.key`, "utf8");
    expect(blob).not.toContain(k1.toString("base64"));
    const k2 = await defaultKeySource({} as NodeJS.ProcessEnv, "win32", ps.exec, { vaultFile }).key();
    expect(k2.equals(k1)).toBe(true);
    // PowerShell wird ohne Profil und nicht interaktiv gestartet, Schluessel und Blob gehen nur ueber stdin.
    for (const c of ps.calls) {
      expect(c.file).toBe("powershell.exe");
      expect(c.args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive"]));
      expect(c.args.join(" ")).not.toContain(k1.toString("base64"));
      expect(c.input).toContain("DataProtectionScope]::CurrentUser");
    }
  });
  it("vault.keyFile determines the location of the blob", async () => {
    const dir = await tmp();
    const ps = fakePowerShell();
    await defaultKeySource({} as NodeJS.ProcessEnv, "win32", ps.exec, { vaultFile: join(dir, "v.json"), keyFile: join(dir, "eigener.blob") }).key();
    expect((await stat(join(dir, "eigener.blob"))).isFile()).toBe(true);
  });
  it("never overwrites an existing key file, even if it cannot be opened (other account)", async () => {
    const dir = await tmp();
    const vaultFile = join(dir, "vault.json");
    await defaultKeySource({} as NodeJS.ProcessEnv, "win32", fakePowerShell().exec, { vaultFile }).key();
    const before = await readFile(`${vaultFile}.key`, "utf8");
    await expect(defaultKeySource({} as NodeJS.ProcessEnv, "win32", fakePowerShell({ failUnprotect: true }).exec, { vaultFile }).key()).rejects.toThrow(/DPAPI.*nicht oeffnen/);
    expect(await readFile(`${vaultFile}.key`, "utf8")).toBe(before);
  });
  it("reports missing PowerShell and damaged files clearly", async () => {
    const dir = await tmp();
    await expect(windowsDpapiKeySource({ keyFile: join(dir, "a.key"), exec: fakePowerShell({ missing: true }).exec }).key()).rejects.toThrow(/PowerShell/);
    await writeFile(join(dir, "b.key"), "kein base64 !!!");
    await expect(windowsDpapiKeySource({ keyFile: join(dir, "b.key"), exec: fakePowerShell().exec }).key()).rejects.toThrow(/beschaedigt/);
  });
  it("the environment variable takes precedence on Windows too", async () => {
    const key = randomBytes(32).toString("base64");
    const ps = fakePowerShell();
    expect((await defaultKeySource({ SECRET_DESK_VAULT_KEY: key } as unknown as NodeJS.ProcessEnv, "win32", ps.exec).key()).toString("base64")).toBe(key);
    expect(ps.calls).toHaveLength(0);
  });
});

describe("Linux without keyring", () => {
  const missing = async (): Promise<string> => {
    throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
  };
  it("names the options and never stores in plaintext", async () => {
    const dir = await tmp();
    const err = await defaultKeySource({} as NodeJS.ProcessEnv, "linux", missing, { vaultFile: join(dir, "v.json") }).key().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(VaultUnavailableError);
    expect((err as Error).message).toMatch(/secret-tool.*nicht installiert/);
    expect((err as Error).message).toMatch(/SECRET_DESK_VAULT_KEY/);
    expect((err as Error).message).toMatch(/keyFile/);
    expect((err as Error).message).toMatch(/Klartext/);
  });
  it("secret-tool without D-Bus: different message, same options", async () => {
    const exec = async (_f: string, args: string[]): Promise<string> => {
      throw new Error(`exit 1 (${args[0]})`);
    };
    await expect(defaultKeySource({} as NodeJS.ProcessEnv, "linux", exec).key()).rejects.toThrow(/D-Bus.*SECRET_DESK_VAULT_KEY/s);
  });
  it("secret-tool: stores key via stdin, not via arguments", async () => {
    let stored = "";
    const exec = async (_f: string, args: string[], input?: string): Promise<string> => {
      if (args[0] === "lookup") {
        if (!stored) throw new Error("leer");
        return `${stored}\n`;
      }
      stored = input ?? "";
      expect(args.join(" ")).not.toContain(stored);
      return "";
    };
    const src = defaultKeySource({} as NodeJS.ProcessEnv, "linux", exec);
    const k = await src.key();
    expect((await src.key()).equals(k)).toBe(true);
  });
});

describe("vault.keyFile", () => {
  it("is used only when set: creates file with mode 600 and reads it again", async () => {
    const dir = await tmp();
    const keyFile = join(dir, "sub", "vault.key");
    const src = defaultKeySource({} as NodeJS.ProcessEnv, "linux", missingExecThrows, { keyFile });
    const k = await src.key();
    if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await fileKeySource(keyFile).key()).equals(k)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("lehnt eine fuer andere lesbare Schluesseldatei ab", async () => {
    const keyFile = join(await tmp(), "vault.key");
    await writeFile(keyFile, `${randomBytes(32).toString("base64")}\n`);
    await chmod(keyFile, 0o644);
    await expect(fileKeySource(keyFile).key()).rejects.toThrow(/chmod 600/);
  });
  it("rejects broken content and does not overwrite it", async () => {
    const keyFile = join(await tmp(), "vault.key");
    await writeFile(keyFile, "zu kurz", { mode: 0o600 });
    await expect(fileKeySource(keyFile).key()).rejects.toThrow(/32-Byte/);
    expect(await readFile(keyFile, "utf8")).toBe("zu kurz");
  });
  it("is in the config schema", () => {
    const base = { inventory: "i.yaml", github: { owner: "x", auth: { type: "pat" } } };
    expect(ConfigSchema.parse({ ...base, vault: { keyFile: "~/k" } }).vault.keyFile).toBe("~/k");
    expect(ConfigSchema.parse(base).vault.keyFile).toBeUndefined();
  });
});

const missingExecThrows = async (): Promise<string> => {
  throw new Error("darf nicht aufgerufen werden");
};
