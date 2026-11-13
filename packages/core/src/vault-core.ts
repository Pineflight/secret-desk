import { SecretValue } from "./secret.js";

/**
 * Portable core of the vault: key source contract, storage contract and the encryption (AES-256-GCM through Web Crypto).
 * This module must not import Node built-ins, so it can run in any standards runtime. A guard test enforces that.
 * Stored format: { version: 1, entries: { id: { iv, tag, ct, savedAt, fingerprint, expires? } } }, all binary parts in Base64.
 */
export interface KeySource {
  readonly label: string;
  /** 32 Byte Schluessel. Legt ihn an, falls es noch keinen gibt. */
  key(): Promise<Uint8Array>;
}

export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

export interface VaultEntry {
  iv: string;
  tag: string;
  ct: string;
  savedAt: string;
  /** Die ersten 12 Hex-Zeichen von SHA-256 des Tokens: erkennt den Token wieder, verraet ihn nicht. */
  fingerprint: string;
  /** Tag, bis zu dem der Token gilt, null = laeuft nie ab, fehlt = nicht angegeben. */
  expires?: string | null;
}

export interface VaultDocument {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export interface VaultInfo {
  id: string;
  savedAt: string;
  fingerprint: string;
  expires?: string | null;
}

/** Where the encrypted document lives. Implementations throw `VaultUnavailableError` when it cannot be read safely. */
export interface VaultStore {
  readonly label: string;
  /** A missing document is an empty vault. */
  read(): Promise<VaultDocument>;
  write(doc: VaultDocument): Promise<void>;
}

/** Keeps the document in memory (tests, reference implementation). Stores deep copies. */
export class MemoryVaultStore implements VaultStore {
  readonly label = "memory";
  #doc: VaultDocument = { version: 1, entries: {} };

  async read(): Promise<VaultDocument> {
    return structuredClone(this.#doc);
  }

  async write(doc: VaultDocument): Promise<void> {
    this.#doc = structuredClone(doc);
  }
}

const TAG_BYTES = 16;
const KEY_BYTES = 32;
const encoder = new TextEncoder();
// Keep a leading U+FEFF: the previous implementation (Buffer.toString) did, the default decoder strips it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Web Crypto also accepts 16 and 24 byte keys (AES-128/192); the vault format is AES-256 only. */
async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== KEY_BYTES) throw new VaultUnavailableError("Der Tresor-Schluessel muss genau 32 Byte lang sein.");
  // Copy: a Node Buffer may be a view into a shared pool, and the copy has a plain ArrayBuffer type.
  return globalThis.crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export class Vault {
  readonly #store: VaultStore;
  readonly #keys: KeySource;
  #key: CryptoKey | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: { store: VaultStore; keySource: KeySource }) {
    this.#store = options.store;
    this.#keys = options.keySource;
  }

  get label(): string {
    return this.#keys.label;
  }

  /** Schreibende Zugriffe nacheinander: lesen-aendern-schreiben darf sich im selben Prozess nicht ueberlappen. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #masterKey(): Promise<CryptoKey> {
    this.#key ??= await importKey(await this.#keys.key());
    return this.#key;
  }

  /** Metadaten ohne Wert, ohne den Schluessel zu holen. */
  async list(): Promise<VaultInfo[]> {
    const doc = await this.#store.read();
    return Object.entries(doc.entries).map(([id, e]) => ({ id, savedAt: e.savedAt, fingerprint: e.fingerprint, ...(e.expires !== undefined ? { expires: e.expires } : {}) }));
  }

  async has(id: string): Promise<boolean> {
    return id in (await this.#store.read()).entries;
  }

  async info(id: string): Promise<VaultInfo | null> {
    return (await this.list()).find((i) => i.id === id) ?? null;
  }

  async set(id: string, value: SecretValue | string, expires?: string | null, now: Date = new Date()): Promise<void> {
    const key = await this.#masterKey();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = typeof value === "string" ? value : value.reveal();
    const plainBytes = encoder.encode(plain);
    const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id), tagLength: TAG_BYTES * 8 }, key, plainBytes));
    const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", plainBytes));
    const entry: VaultEntry = { iv: toBase64(iv), tag: toBase64(tag), ct: toBase64(ct), savedAt: now.toISOString(), fingerprint: toHex(digest).slice(0, 12), ...(expires !== undefined ? { expires } : {}) };
    await this.#locked(async () => {
      const doc = await this.#store.read();
      doc.entries[id] = entry;
      await this.#store.write(doc);
    });
  }

  async get(id: string): Promise<SecretValue | null> {
    const e = (await this.#store.read()).entries[id];
    if (!e) return null;
    const key = await this.#masterKey();
    try {
      const sealed = concat(fromBase64(e.ct), fromBase64(e.tag));
      const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(e.iv), additionalData: encoder.encode(id), tagLength: TAG_BYTES * 8 }, key, sealed);
      return new SecretValue(decoder.decode(plain));
    } catch {
      throw new VaultUnavailableError("Der Tresor-Eintrag laesst sich nicht entschluesseln (anderer Schluessel oder beschaedigt).");
    }
  }

  async delete(id: string): Promise<void> {
    await this.#locked(async () => {
      const doc = await this.#store.read();
      if (!(id in doc.entries)) return;
      delete doc.entries[id];
      await this.#store.write(doc);
    });
  }
}
