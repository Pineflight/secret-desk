import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDir, writePrivateFile, type Platform } from "./platform.js";
import { SecretValue } from "./secret.js";

/**
 * Lokaler Tresor fuer Zugangs-Tokens der Integrationen (GitHub, Cloudflare ...), damit man sie nicht bei jedem Start
 * neu eingeben muss. Verschluesselt (AES-256-GCM), nicht gehasht: ein Hash laesst sich nicht mehr als Token verwenden.
 * Der Schluessel liegt NIE neben den Daten, sondern im Schluesselbund des Betriebssystems (macOS Keychain, Linux
 * secret-tool, Windows DPAPI) oder in der Umgebungsvariable SECRET_DESK_VAULT_KEY. Verwaltete Secrets (die Werte in GitHub) kommen hier nie hinein.
 */
export interface KeySource {
  readonly label: string;
  /** 32 Byte Schluessel. Legt ihn an, falls es noch keinen gibt. */
  key(): Promise<Buffer>;
}

export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

export type VaultExec = (file: string, args: string[], input?: string) => Promise<string>;

const defaultExec: VaultExec = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (input !== undefined) child.stdin?.end(input);
  });

const SERVICE = "secret-desk";
const ACCOUNT = "vault-key";

const KEY_HELP = "Optionen: SECRET_DESK_VAULT_KEY setzen (32 Byte in Base64, z. B. `openssl rand -base64 32`), unter Linux libsecret/secret-tool installieren, oder vault.keyFile in der Konfiguration auf eine Schluesseldatei mit Modus 600 zeigen lassen.";

function isMissingBinary(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

function parseKey(text: string): Buffer | null {
  const buf = Buffer.from(text.trim(), "base64");
  return buf.length === 32 ? buf : null;
}

export function envKeySource(env: NodeJS.ProcessEnv = process.env): KeySource {
  return {
    label: "Umgebungsvariable SECRET_DESK_VAULT_KEY",
    async key() {
      const v = env["SECRET_DESK_VAULT_KEY"];
      const k = v ? parseKey(v) : null;
      if (!k) throw new VaultUnavailableError("SECRET_DESK_VAULT_KEY fehlt oder ist kein 32-Byte-Schluessel in Base64.");
      return k;
    },
  };
}

/** Exit-Code von `security find-generic-password`, wenn es den Eintrag nicht gibt. */
const MAC_ITEM_NOT_FOUND = 44;

/**
 * macOS: nur wenn der Eintrag sicher fehlt (Exit-Code 44), wird ein neuer Schluessel angelegt. Jeder andere Fehler
 * (gesperrter Schluesselbund, verweigerter Zugriff) wirft und ueberschreibt nichts: ein neuer Schluessel wuerde alle Tresor-Eintraege unlesbar machen.
 * Der neue Schluessel geht ueber `security -i` (Befehle ueber stdin), nie als Argument, das in der Prozessliste stuende.
 */
export function macKeychainKeySource(exec: VaultExec = defaultExec): KeySource {
  return {
    label: "macOS-Schluesselbund",
    async key() {
      try {
        const k = parseKey(await exec("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]));
        if (k) return k;
        throw new VaultUnavailableError("Der Schluesselbund-Eintrag secret-desk/vault-key enthaelt keinen gueltigen Schluessel. Er wird nicht ueberschrieben.");
      } catch (err) {
        if (err instanceof VaultUnavailableError) throw err;
        if ((err as { code?: unknown } | null)?.code !== MAC_ITEM_NOT_FOUND) throw new VaultUnavailableError("Der macOS-Schluesselbund ist nicht erreichbar, gesperrt oder wurde verweigert. Es wird nichts ueberschrieben.");
      }
      const fresh = randomBytes(32);
      try {
        await exec("security", ["-i"], `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${fresh.toString("base64")}\n`);
      } catch {
        throw new VaultUnavailableError("Der macOS-Schluesselbund ist nicht erreichbar oder wurde verweigert.");
      }
      return fresh;
    },
  };
}

export function secretToolKeySource(exec: VaultExec = defaultExec): KeySource {
  const unavailable = (why: string): VaultUnavailableError => new VaultUnavailableError(`${why} Es wird kein Schluessel im Klartext gespeichert. ${KEY_HELP}`);
  return {
    label: "Schluesselbund (secret-tool)",
    async key() {
      try {
        const k = parseKey(await exec("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]));
        if (k) return k;
      } catch (err) {
        if (isMissingBinary(err)) throw unavailable("secret-tool (libsecret-tools) ist nicht installiert.");
        /* noch kein Eintrag */
      }
      const fresh = randomBytes(32);
      try {
        await exec("secret-tool", ["store", "--label=secret-desk", "service", SERVICE, "account", ACCOUNT], fresh.toString("base64"));
      } catch (err) {
        throw unavailable(isMissingBinary(err) ? "secret-tool (libsecret-tools) ist nicht installiert." : "secret-tool kann den Schluesselbund nicht erreichen (laeuft ein Secret Service wie GNOME Keyring oder KWallet, und gibt es eine D-Bus-Sitzung?).");
      }
      return fresh;
    },
  };
}

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"];
const PS_HEAD = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes('secret-desk-vault-key'); $s=[Security.Cryptography.DataProtectionScope]::CurrentUser";

/**
 * Windows: ein zufaelliger 32-Byte-Schluessel wird mit DPAPI (Scope CurrentUser) geschuetzt und als Blob in `keyFile` abgelegt.
 * Nur dasselbe Windows-Benutzerkonto auf demselben Rechner kann ihn wieder oeffnen. Die Daten gehen ueber stdin an PowerShell,
 * nie ueber Argumente (die in der Prozessliste stuenden).
 */
export function windowsDpapiKeySource(options: { keyFile: string; exec?: VaultExec; powershell?: string }): KeySource {
  const exec = options.exec ?? defaultExec;
  const ps = options.powershell ?? "powershell.exe";
  const run = (script: string): Promise<string> => exec(ps, PS_ARGS, `${PS_HEAD}\n${script}\n`);
  const fail = (why: string): VaultUnavailableError => new VaultUnavailableError(`${why} ${KEY_HELP}`);
  return {
    label: "Windows DPAPI (Benutzerkonto)",
    async key() {
      let blob: string | null = null;
      try {
        blob = (await readFile(options.keyFile, "utf8")).trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw fail(`Die Schluesseldatei ${options.keyFile} ist nicht lesbar.`);
      }
      if (blob !== null) {
        if (!/^[A-Za-z0-9+/=]+$/.test(blob)) throw fail(`Die Schluesseldatei ${options.keyFile} ist beschaedigt. Sie wird nicht ueberschrieben.`);
        let k: Buffer | null = null;
        try {
          k = parseKey(await run(`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $e, $s))`));
        } catch (err) {
          if (isMissingBinary(err)) throw fail("PowerShell (powershell.exe) wurde nicht gefunden.");
          throw fail(`Die Schluesseldatei ${options.keyFile} laesst sich mit DPAPI nicht oeffnen (anderes Windows-Konto oder anderer Rechner?). Sie wird nicht ueberschrieben.`);
        }
        if (!k) throw fail(`Die Schluesseldatei ${options.keyFile} enthaelt keinen gueltigen Schluessel. Sie wird nicht ueberschrieben.`);
        return k;
      }
      const fresh = randomBytes(32);
      let protectedBlob: string;
      try {
        protectedBlob = (await run(`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${fresh.toString("base64")}'), $e, $s))`)).trim();
      } catch (err) {
        throw fail(isMissingBinary(err) ? "PowerShell (powershell.exe) wurde nicht gefunden." : "DPAPI ist nicht erreichbar.");
      }
      if (!/^[A-Za-z0-9+/=]{16,}$/.test(protectedBlob)) throw fail("DPAPI lieferte keinen gueltigen Blob.");
      await ensurePrivateDir(dirname(options.keyFile), "win32");
      const tmp = `${options.keyFile}.${process.pid}.tmp`;
      await writePrivateFile(tmp, `${protectedBlob}\n`, "win32");
      await rename(tmp, options.keyFile);
      return fresh;
    },
  };
}

/**
 * Schluesseldatei (nur wenn ausdruecklich konfiguriert, vault.keyFile): Base64 eines 32-Byte-Schluessels. Liegt Schluessel
 * neben Daten auf demselben Datentraeger, schuetzt nur das Dateisystem. POSIX: Modus muss 600 sein, sonst wird sie abgelehnt.
 */
export function fileKeySource(file: string, platform: Platform = process.platform): KeySource {
  return {
    label: `Schluesseldatei ${file}`,
    async key() {
      let text: string | null = null;
      try {
        if (platform !== "win32") {
          const mode = (await stat(file)).mode & 0o777;
          if ((mode & 0o077) !== 0) throw new VaultUnavailableError(`Die Schluesseldatei ${file} ist fuer andere lesbar (Modus ${mode.toString(8)}). Bitte \`chmod 600\`.`);
        }
        text = await readFile(file, "utf8");
      } catch (err) {
        if (err instanceof VaultUnavailableError) throw err;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new VaultUnavailableError(`Die Schluesseldatei ${file} ist nicht lesbar.`);
      }
      if (text !== null) {
        const k = parseKey(text);
        if (!k) throw new VaultUnavailableError(`Die Schluesseldatei ${file} enthaelt keinen 32-Byte-Schluessel in Base64.`);
        return k;
      }
      const fresh = randomBytes(32);
      await ensurePrivateDir(dirname(file), platform);
      try {
        await writePrivateFile(file, `${fresh.toString("base64")}\n`, platform, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return this.key();
        throw err;
      }
      return fresh;
    },
  };
}

export interface KeySourceOptions {
  /** Tresordatei: bestimmt unter Windows den Ablageort des DPAPI-Blobs (`<tresordatei>.key`). */
  vaultFile?: string;
  /** vault.keyFile: ausdruecklich gewaehlte Schluesseldatei. Unter Windows der Ort des DPAPI-Blobs, sonst eine Klartext-Schluesseldatei (Modus 600). */
  keyFile?: string;
}

/**
 * Reihenfolge: Umgebungsvariable, ausdruecklich konfigurierte Schluesseldatei (nicht Windows), dann der Schluesselbund des
 * Systems (macOS Keychain, Linux secret-tool, Windows DPAPI). Ohne verfuegbaren Speicher gibt es einen Fehler mit den Optionen.
 */
export function defaultKeySource(env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform, exec?: VaultExec, options: KeySourceOptions = {}): KeySource {
  if (env["SECRET_DESK_VAULT_KEY"]) return envKeySource(env);
  if (platform === "win32") return windowsDpapiKeySource({ keyFile: options.keyFile ?? `${options.vaultFile ?? DEFAULT_VAULT_FILE}.key`, ...(exec ? { exec } : {}) });
  if (options.keyFile) return fileKeySource(options.keyFile, platform);
  if (platform === "darwin") return macKeychainKeySource(exec);
  if (platform === "linux") return secretToolKeySource(exec);
  return envKeySource(env);
}

interface Entry {
  iv: string;
  tag: string;
  ct: string;
  savedAt: string;
  /** Die ersten 12 Hex-Zeichen von SHA-256 des Tokens: erkennt den Token wieder, verraet ihn nicht. */
  fingerprint: string;
  /** Tag, bis zu dem der Token gilt, null = laeuft nie ab, fehlt = nicht angegeben. */
  expires?: string | null;
}

interface Doc {
  version: 1;
  entries: Record<string, Entry>;
}

export interface VaultInfo {
  id: string;
  savedAt: string;
  fingerprint: string;
  expires?: string | null;
}

export const DEFAULT_VAULT_FILE = join(homedir(), ".secret-desk", "vault.json");

export class SecretVault {
  readonly #file: string;
  readonly #keys: KeySource;
  #key: Buffer | null = null;

  constructor(options: { file?: string; keySource?: KeySource; keyFile?: string } = {}) {
    this.#file = options.file ?? DEFAULT_VAULT_FILE;
    this.#keys = options.keySource ?? defaultKeySource(process.env, process.platform, undefined, { vaultFile: this.#file, ...(options.keyFile ? { keyFile: options.keyFile } : {}) });
  }

  get label(): string {
    return this.#keys.label;
  }

  #backup: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  /** Schreibende Zugriffe nacheinander: lesen-aendern-schreiben darf sich im selben Prozess nicht ueberlappen. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Nur eine fehlende Datei ist ein leerer Tresor. Alles andere wirft; eine kaputte Datei wird vorher als `.corrupt-<zeit>` gesichert. */
  async #read(): Promise<Doc> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw new VaultUnavailableError(`Die Tresordatei ${this.#file} ist nicht lesbar. Sie wird nicht ueberschrieben.`);
    }
    let parsed: Doc | null = null;
    try {
      const doc = JSON.parse(text) as Doc;
      if (doc && doc.version === 1 && typeof doc.entries === "object" && doc.entries !== null && !Array.isArray(doc.entries)) parsed = doc;
    } catch {
      /* unten behandelt */
    }
    if (parsed) return parsed;
    // Kopie, nicht Verschieben: die Originaldatei bleibt, jeder weitere Zugriff scheitert weiter, bis ein Mensch entscheidet.
    this.#backup ??= `${this.#file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(this.#file, this.#backup).catch(() => undefined);
    throw new VaultUnavailableError(`Die Tresordatei ${this.#file} ist beschaedigt oder hat ein unbekanntes Format. Eine Kopie liegt als ${this.#backup}; nichts wurde ueberschrieben.`);
  }

  async #write(doc: Doc): Promise<void> {
    await ensurePrivateDir(dirname(this.#file));
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await writePrivateFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, this.#file);
  }

  async #masterKey(): Promise<Buffer> {
    this.#key ??= await this.#keys.key();
    return this.#key;
  }

  /** Metadaten ohne Wert, ohne den Schluessel zu holen. */
  async list(): Promise<VaultInfo[]> {
    const doc = await this.#read();
    return Object.entries(doc.entries).map(([id, e]) => ({ id, savedAt: e.savedAt, fingerprint: e.fingerprint, ...(e.expires !== undefined ? { expires: e.expires } : {}) }));
  }

  async has(id: string): Promise<boolean> {
    return id in (await this.#read()).entries;
  }

  async info(id: string): Promise<VaultInfo | null> {
    return (await this.list()).find((i) => i.id === id) ?? null;
  }

  async set(id: string, value: SecretValue | string, expires?: string | null, now: Date = new Date()): Promise<void> {
    const key = await this.#masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(id));
    const plain = typeof value === "string" ? value : value.reveal();
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const entry: Entry = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), savedAt: now.toISOString(), fingerprint: createHash("sha256").update(plain).digest("hex").slice(0, 12), ...(expires !== undefined ? { expires } : {}) };
    await this.#locked(async () => {
      const doc = await this.#read();
      doc.entries[id] = entry;
      await this.#write(doc);
    });
  }

  async get(id: string): Promise<SecretValue | null> {
    const e = (await this.#read()).entries[id];
    if (!e) return null;
    const key = await this.#masterKey();
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
      d.setAAD(Buffer.from(id));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      return new SecretValue(Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8"));
    } catch {
      throw new VaultUnavailableError("Der Tresor-Eintrag laesst sich nicht entschluesseln (anderer Schluessel oder beschaedigt).");
    }
  }

  async delete(id: string): Promise<void> {
    await this.#locked(async () => {
      const doc = await this.#read();
      if (!(id in doc.entries)) return;
      delete doc.entries[id];
      await this.#write(doc);
    });
  }
}
