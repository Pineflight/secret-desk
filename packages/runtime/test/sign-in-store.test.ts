import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SignInStore } from "../src/sign-in-store.js";

const HOST = "platform.acme.test";
const at = (hours: number): Date => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + hours * 3_600_000);

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "sd-signin-store-")), "sign-in-state.json");
}

describe("sign-in store: persistence", () => {
  it("writes atomically with mode 600, reloads, and keeps no temporary file", async () => {
    const file = await tempFile();
    const a = new SignInStore(file);
    a.note(HOST, true, at(0), "connect");
    await a.flush();
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(file, ".."))).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const b = new SignInStore(file);
    await b.load();
    expect(b.checks()).toEqual([{ host: HOST, signedIn: true, checkedAt: at(0).toISOString(), source: "connect" }]);
  });

  it("keeps only a host, a yes/no, times and a source: no values, no URLs", async () => {
    const file = await tempFile();
    const s = new SignInStore(file);
    s.note(HOST, true, at(0));
    s.note("https://evil.test/path?token=abc123", true, at(0));
    s.note("has space.test", false, at(0));
    await s.flush();
    const text = await readFile(file, "utf8");
    expect(Object.keys(JSON.parse(text).hosts)).toEqual([HOST]);
    expect(text).not.toMatch(/token|abc123|http|\?/);
    expect(Object.keys(JSON.parse(text).hosts[HOST]).sort()).toEqual(["checkedAt", "host", "lastSignedInAt", "lifetimes", "signedIn", "signedInSince", "source"]);
  });

  it("ignores a missing, corrupt or foreign file, and replaces it on the next write", async () => {
    const file = await tempFile();
    const s = new SignInStore(file);
    await s.load();
    expect(s.checks()).toEqual([]);
    for (const text of ["{ not json", "[]", '{"version":2,"hosts":{}}', '{"version":1,"hosts":[1]}', "null"]) {
      await writeFile(file, text);
      const t = new SignInStore(file);
      await t.load();
      expect(t.checks()).toEqual([]);
    }
    await writeFile(file, "{ not json");
    const u = new SignInStore(file);
    await u.load();
    u.note(HOST, false, at(1));
    await u.flush();
    const v = new SignInStore(file);
    await v.load();
    expect(v.checks()).toMatchObject([{ host: HOST, signedIn: false }]);
  });

  it("drops invalid entries of an otherwise valid file", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        hosts: {
          [HOST]: { signedIn: true, checkedAt: at(0).toISOString(), source: "run" },
          "bad host": { signedIn: true, checkedAt: at(0).toISOString() },
          "no-time.test": { signedIn: true, checkedAt: "yesterday" },
          "no-flag.test": { signedIn: "yes", checkedAt: at(0).toISOString() },
        },
      }),
    );
    const s = new SignInStore(file);
    await s.load();
    expect(s.checks().map((c) => c.host)).toEqual([HOST]);
  });

  it("works in memory without a file", () => {
    const s = new SignInStore();
    s.note(HOST, true, at(0));
    expect(s.check(HOST)).toMatchObject({ signedIn: true });
  });

  it("survives a file that cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-signin-store-"));
    const s = new SignInStore(join(dir, "file-as-dir", "state.json"));
    await writeFile(join(dir, "file-as-dir"), "x");
    s.note(HOST, true, at(0));
    await expect(s.flush()).resolves.toBeUndefined();
    expect(s.check(HOST)).toMatchObject({ signedIn: true });
  });
});

describe("sign-in store: session lifetime", () => {
  it("measures from the start of a seen sign-in to the midpoint between the last yes and the first no", () => {
    const s = new SignInStore();
    s.note(HOST, false, at(0));
    s.note(HOST, true, at(1), "connect");
    s.note(HOST, true, at(7), "check");
    s.note(HOST, true, at(13), "check");
    expect(s.lifetimes()).toEqual([]);
    s.note(HOST, false, at(19), "check");
    // started at 1 h, last yes at 13 h, first no at 19 h: midpoint 16 h, so 15 h
    expect(s.lifetimes()).toEqual([{ host: HOST, averageMinutes: 15 * 60, samples: 1, measuredAt: at(19).toISOString() }]);
  });

  it("does not measure a streak whose start was not seen, and does not count repeated signed-out answers", () => {
    const s = new SignInStore();
    s.note(HOST, true, at(0), "check");
    s.note(HOST, false, at(10), "check");
    s.note(HOST, false, at(16), "check");
    expect(s.lifetimes()).toEqual([]);
    // After a seen sign-out the next streak is measurable.
    s.note(HOST, true, at(20), "run");
    s.note(HOST, false, at(30), "check");
    expect(s.lifetimes()).toMatchObject([{ averageMinutes: 5 * 60, samples: 1 }]);
  });

  it("averages the newest five measurements per host", () => {
    const s = new SignInStore();
    let t = 0;
    for (const hours of [2, 4, 6, 8, 10, 12]) {
      s.note(HOST, true, at(t), "connect");
      s.note(HOST, false, at(t + hours), "check");
      t += 100;
    }
    // Each streak: start, no yes in between, so midpoint is half of the gap: 1,2,3,4,5,6 h; the newest five are 2..6 h.
    expect(s.lifetimes()).toMatchObject([{ averageMinutes: 4 * 60, samples: 5 }]);
  });

  it("keeps hosts apart and survives a restart", async () => {
    const file = await tempFile();
    const a = new SignInStore(file);
    a.note(HOST, true, at(0), "connect");
    a.note("other.acme.test", true, at(0), "connect");
    a.note(HOST, false, at(8), "check");
    await a.flush();
    const b = new SignInStore(file);
    await b.load();
    expect(b.lifetimes()).toMatchObject([{ host: HOST, averageMinutes: 4 * 60 }]);
    // The open streak of the other host continues after the restart.
    b.note("other.acme.test", false, at(20), "check");
    expect(b.lifetimes().find((l) => l.host === "other.acme.test")).toMatchObject({ averageMinutes: 10 * 60 });
  });

  it("ignores a negative measurement (clock set back)", () => {
    const s = new SignInStore();
    s.note(HOST, true, at(10), "connect");
    s.note(HOST, false, at(-100), "check");
    expect(s.lifetimes()).toEqual([]);
  });
});
