import { readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "@secret-desk/core";

/**
 * The portal's memory of the browser sign-in per recipe host: the last answer, and how long sessions at that host lasted.
 * Kept in a small file in the data directory (mode 600, written atomically). It holds a host name, a yes/no, times and where the
 * answer came from. No cookies, no credentials, no URLs.
 */

/** Where an answer came from: a check (manual or scheduled), a recipe run that worked, or a finished guided sign-in. */
export type SignInSource = "check" | "run" | "connect";

/** The last time the browser was seen signed in or out at a host. */
export interface SignInCheck {
  host: string;
  signedIn: boolean;
  /** ISO time of the answer. */
  checkedAt: string;
  source: SignInSource;
}

/** What is known about how long a sign-in at one host lasts. */
export interface SessionLifetime {
  host: string;
  /** Average of the measurements, in whole minutes. */
  averageMinutes: number;
  /** Number of measurements (at most {@link MAX_SAMPLES} are kept). */
  samples: number;
  /** ISO time of the newest measurement. */
  measuredAt: string;
}

interface HostRecord extends SignInCheck {
  /** Start of the current "signed in" streak, only when the sign-in itself was seen (not when the first answer was already "yes"). */
  signedInSince: string | null;
  /** Newest "signed in" answer of the current streak. */
  lastSignedInAt: string | null;
  /** Newest measurements in minutes, oldest first. */
  lifetimes: { minutes: number; measuredAt: string }[];
}

const MAX_SAMPLES = 5;
const FILE_VERSION = 1;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SOURCES: readonly SignInSource[] = ["check", "run", "connect"];

const validTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const orNull = (v: unknown): string | null => (validTime(v) ? v : null);

function parseRecord(host: string, raw: unknown): HostRecord | null {
  if (!HOST_RE.test(host) || typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["signedIn"] !== "boolean" || !validTime(r["checkedAt"])) return null;
  const source = SOURCES.find((s) => s === r["source"]) ?? "check";
  const lifetimes: HostRecord["lifetimes"] = [];
  if (Array.isArray(r["lifetimes"])) {
    for (const l of r["lifetimes"].slice(-MAX_SAMPLES)) {
      const o = l as { minutes?: unknown; measuredAt?: unknown } | null;
      if (o && typeof o.minutes === "number" && Number.isFinite(o.minutes) && o.minutes >= 0 && validTime(o.measuredAt)) lifetimes.push({ minutes: Math.round(o.minutes), measuredAt: o.measuredAt });
    }
  }
  return { host, signedIn: r["signedIn"], checkedAt: r["checkedAt"], source, signedInSince: orNull(r["signedInSince"]), lastSignedInAt: orNull(r["lastSignedInAt"]), lifetimes };
}

/**
 * Remembers the sign-in answers. Without a file it stays in memory. A missing or damaged file is ignored (a damaged one is
 * replaced by the next write): the memory only saves a few browser runs, nothing depends on it.
 */
export class SignInStore {
  readonly #file: string | null;
  readonly #hosts = new Map<string, HostRecord>();
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string | null = null) {
    this.#file = file;
  }

  /** Reads the file. Never throws. */
  async load(): Promise<void> {
    if (!this.#file) return;
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(this.#file, "utf8"));
    } catch {
      return;
    }
    const hosts = (doc as { version?: unknown; hosts?: unknown } | null)?.hosts;
    if ((doc as { version?: unknown } | null)?.version !== FILE_VERSION || typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) return;
    for (const [host, raw] of Object.entries(hosts)) {
      const rec = parseRecord(host, raw);
      if (rec && !this.#hosts.has(host)) this.#hosts.set(host, rec);
    }
  }

  /**
   * Records an answer. A "signed out" answer that follows a "signed in" streak whose start was seen ends the streak and adds a
   * measurement: the session lasted from the start of the streak to somewhere between the last "yes" and this "no", so the
   * midpoint is taken.
   */
  note(host: string, signedIn: boolean, at: Date, source: SignInSource = "check"): void {
    const key = host.trim().toLowerCase();
    if (!HOST_RE.test(key)) return;
    const prev = this.#hosts.get(key);
    const now = at.toISOString();
    const rec: HostRecord = { host: key, signedIn, checkedAt: now, source, signedInSince: prev?.signedInSince ?? null, lastSignedInAt: prev?.lastSignedInAt ?? null, lifetimes: prev?.lifetimes ?? [] };
    if (signedIn) {
      if (!prev?.signedIn) {
        // A streak starts. Its start is known when the sign-in was done through the portal, or when the host was signed out before.
        rec.signedInSince = source === "connect" || prev?.signedIn === false ? now : null;
      }
      rec.lastSignedInAt = now;
    } else {
      if (prev?.signedIn && prev.signedInSince && prev.lastSignedInAt) {
        const start = Date.parse(prev.signedInSince);
        const mid = (Date.parse(prev.lastSignedInAt) + at.getTime()) / 2;
        const minutes = Math.round((mid - start) / 60_000);
        if (minutes >= 0) rec.lifetimes = [...prev.lifetimes, { minutes, measuredAt: now }].slice(-MAX_SAMPLES);
      }
      rec.signedInSince = null;
      rec.lastSignedInAt = null;
    }
    this.#hosts.set(key, rec);
    this.#persist();
  }

  checks(): SignInCheck[] {
    return [...this.#hosts.values()].map(({ host, signedIn, checkedAt, source }) => ({ host, signedIn, checkedAt, source }));
  }

  check(host: string): SignInCheck | undefined {
    return this.checks().find((c) => c.host === host);
  }

  lifetimes(): SessionLifetime[] {
    const out: SessionLifetime[] = [];
    for (const r of this.#hosts.values()) {
      const last = r.lifetimes[r.lifetimes.length - 1];
      if (!last) continue;
      const sum = r.lifetimes.reduce((a, l) => a + l.minutes, 0);
      out.push({ host: r.host, averageMinutes: Math.round(sum / r.lifetimes.length), samples: r.lifetimes.length, measuredAt: last.measuredAt });
    }
    return out;
  }

  /** Waits until everything noted so far is on disk. Never rejects. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #persist(): void {
    const file = this.#file;
    if (!file) return;
    const doc = { version: FILE_VERSION, hosts: Object.fromEntries([...this.#hosts].map(([h, r]) => [h, r])) };
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    this.#writing = this.#writing.then(async () => {
      try {
        await ensurePrivateDir(dirname(file));
        const tmp = `${file}.${process.pid}.tmp`;
        await writePrivateFile(tmp, body);
        await rename(tmp, file);
      } catch {
        // The memory is a convenience: a full disk or a read-only folder must not break a check.
      }
    });
  }
}
