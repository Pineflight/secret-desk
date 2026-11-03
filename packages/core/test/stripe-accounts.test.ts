import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectionStore,
  SecretVault,
  deleteConnectionLabel,
  listStripeAccounts,
  parseStripeConnectionId,
  readConnectionLabel,
  stripeConnectionId,
  stripeKeyMode,
  stripeModeForStage,
  writeConnectionLabel,
} from "../src/index.js";

describe("stripe connection ids", () => {
  it("builds and parses stripe:<acct>:<mode>", () => {
    expect(stripeConnectionId("acct_1AbC", "sandbox")).toBe("stripe:acct_1AbC:sandbox");
    expect(parseStripeConnectionId("stripe:acct_1AbC:live")).toEqual({ account: "acct_1AbC", mode: "live" });
  });
  it("leaves the fixed connections and malformed ids alone", () => {
    for (const id of ["stripe", "stripe-test", "stripe-live", "stripe:acct_1:test", "stripe:1AbC:live", "stripe:acct_1:live:x", "xstripe:acct_1:live", "stripe:acct_1:live#label"]) expect(parseStripeConnectionId(id), id).toBeNull();
  });
  it("maps stage kinds to modes; shared names none", () => {
    expect(stripeModeForStage("live")).toBe("live");
    expect(stripeModeForStage("test")).toBe("sandbox");
    expect(stripeModeForStage("dev")).toBe("sandbox");
    expect(stripeModeForStage("shared")).toBeNull();
  });
  it("reads the mode of a key by its prefix", () => {
    expect(stripeKeyMode("rk_test_abc")).toBe("sandbox");
    expect(stripeKeyMode(" sk_live_abc")).toBe("live");
    expect(stripeKeyMode("whsec_abc")).toBeUndefined();
  });
});

describe("connection store ids and labels", () => {
  it("lists session ids by prefix without label entries", async () => {
    const c = new ConnectionStore();
    c.session.set("stripe:acct_1:sandbox", "k");
    c.session.set("stripe:acct_1:sandbox#label", "Acme Studio");
    c.session.set("github", "t");
    expect(await c.ids("stripe:")).toEqual(["stripe:acct_1:sandbox"]);
    expect(await c.ids()).toEqual(["github", "stripe:acct_1:sandbox"]);
  });
  it("lists vault ids and configured sources too, and keeps a label in the vault", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-"));
    const key = randomBytes(32);
    const vault = new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => key } });
    const c = new ConnectionStore({ vault, specs: { "stripe:acct_C:live": { type: "env", name: "X" } } });
    await vault.set("stripe:acct_1:live", "k", null);
    await writeConnectionLabel(c, "stripe:acct_1:live", "Acme Studio");
    expect(await c.ids("stripe:")).toEqual(["stripe:acct_1:live", "stripe:acct_C:live"]);
    expect(await readConnectionLabel(c, "stripe:acct_1:live")).toBe("Acme Studio");
    await deleteConnectionLabel(c, "stripe:acct_1:live");
    expect(await readConnectionLabel(c, "stripe:acct_1:live")).toBeUndefined();
  });
  it("round-trips a label in the session and deletes it", async () => {
    const c = new ConnectionStore();
    await writeConnectionLabel(c, "stripe:acct_1:live", "  Acme\nStudio  ");
    expect(await readConnectionLabel(c, "stripe:acct_1:live")).toBe("Acme Studio");
    await deleteConnectionLabel(c, "stripe:acct_1:live");
    expect(await readConnectionLabel(c, "stripe:acct_1:live")).toBeUndefined();
  });
  it("ignores an empty label", async () => {
    const c = new ConnectionStore();
    await writeConnectionLabel(c, "stripe:acct_1:live", "  ");
    expect(await readConnectionLabel(c, "stripe:acct_1:live")).toBeUndefined();
  });
});

describe("listStripeAccounts", () => {
  it("groups the connected modes per account and carries the name", async () => {
    const c = new ConnectionStore();
    c.session.set("stripe:acct_B:live", "k");
    c.session.set("stripe:acct_A:live", "k");
    c.session.set("stripe:acct_A:sandbox", "k");
    c.session.set("stripe-test", "k");
    await writeConnectionLabel(c, "stripe:acct_A:live", "Alpha");
    expect(await listStripeAccounts(c)).toEqual([
      { id: "acct_A", name: "Alpha", modes: ["sandbox", "live"] },
      { id: "acct_B", name: null, modes: ["live"] },
    ]);
  });
  it("skips an expired key", async () => {
    const c = new ConnectionStore({ now: () => new Date("2026-11-03T00:00:00Z") });
    c.session.set("stripe:acct_A:live", "k", "2026-11-01");
    expect(await listStripeAccounts(c)).toEqual([]);
  });
});
