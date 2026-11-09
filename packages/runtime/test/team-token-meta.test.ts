import { SessionVault, SecretValue, type ConnectionStore } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { metaFits, readTeamTokenMeta, readTeamTokenRecord, retireTeamToken, writeTeamTokenRecord, type TeamTokenMeta } from "../src/team-token-meta.js";

const ENTRY = "team-sync#meta";

const meta = (over: Partial<TeamTokenMeta> = {}): TeamTokenMeta => ({ repo: "acme/team-config", mode: "pull", strategy: "pull-request", tokenName: "secret-desk team sync", createdAt: "2026-11-01T00:00:00.000Z", expires: "2027-01-30", ...over });

/** A vault stand-in that keeps entries in a map; `failGet` makes reads throw like an unreadable vault. */
function fakeVault(failGet = false) {
  const entries = new Map<string, string>();
  return {
    entries,
    vault: {
      get: async (id: string) => {
        if (failGet) throw new Error("vault unreadable");
        const v = entries.get(id);
        return v === undefined ? null : new SecretValue(v);
      },
      set: async (id: string, value: string | SecretValue) => {
        entries.set(id, typeof value === "string" ? value : value.reveal());
      },
    },
  };
}

function connections(opts: { vault?: ReturnType<typeof fakeVault>["vault"] } = {}) {
  const session = new SessionVault();
  return { connections: { session, vault: opts.vault } as unknown as ConnectionStore, session };
}

describe("team token record storage", () => {
  it("without a vault the record lives in the session; with a vault it goes there", async () => {
    const s = connections();
    await writeTeamTokenRecord(s, { active: meta(), pendingRevocation: null });
    expect(s.session.get(ENTRY)).toBeDefined();
    expect(await readTeamTokenMeta(s)).toEqual(meta());

    const fv = fakeVault();
    const v = connections({ vault: fv.vault });
    await writeTeamTokenRecord(v, { active: meta({ strategy: "direct", mode: "pull-push" }), pendingRevocation: null });
    expect(fv.entries.has(ENTRY)).toBe(true);
    expect(v.session.get(ENTRY)).toBeUndefined();
    expect(await readTeamTokenMeta(v)).toMatchObject({ strategy: "direct", mode: "pull-push" });
  });

  it("nothing stored: empty record", async () => {
    expect(await readTeamTokenRecord(connections())).toEqual({ active: null, pendingRevocation: null });
    expect(await readTeamTokenRecord(connections({ vault: fakeVault().vault }))).toEqual({ active: null, pendingRevocation: null });
  });

  it("an unreadable vault or a damaged record reads as empty", async () => {
    expect(await readTeamTokenRecord(connections({ vault: fakeVault(true).vault }))).toEqual({ active: null, pendingRevocation: null });
    const s = connections();
    s.session.set(ENTRY, "{ not json", null);
    expect(await readTeamTokenRecord(s)).toEqual({ active: null, pendingRevocation: null });
  });

  it("drops invalid fields instead of trusting them", async () => {
    const s = connections();
    const valid = meta();
    const stored = (active: unknown, pendingRevocation: unknown = null) => s.session.set(ENTRY, JSON.stringify({ active, pendingRevocation }), null);
    stored({ ...valid, expires: "soon" });
    expect((await readTeamTokenRecord(s)).active).toEqual({ ...valid, expires: null });
    stored({ ...valid, expires: 5 });
    expect((await readTeamTokenRecord(s)).active?.expires).toBeNull();
    for (const broken of [{ ...valid, repo: "no-slash" }, { ...valid, mode: "write" }, { ...valid, strategy: "magic" }, { ...valid, tokenName: "" }, { ...valid, createdAt: "x".repeat(41) }, { ...valid, tokenName: "bad\nname" }, { ...valid, repo: 5 }]) {
      stored(broken);
      expect((await readTeamTokenRecord(s)).active).toBeNull();
    }
    stored(null, { tokenName: "old token", repo: "acme/team-config", since: "2026-11-02T00:00:00.000Z", reason: "delete failed" });
    expect((await readTeamTokenRecord(s)).pendingRevocation).toEqual({ tokenName: "old token", repo: "acme/team-config", since: "2026-11-02T00:00:00.000Z", reason: "delete failed" });
    stored(null, { tokenName: "old token", repo: "acme/team-config", since: "2026-11-02T00:00:00.000Z", reason: "" });
    expect((await readTeamTokenRecord(s)).pendingRevocation).toEqual({ tokenName: "old token", repo: "acme/team-config", since: "2026-11-02T00:00:00.000Z" });
    stored(null, { tokenName: "old token", repo: "nope", since: "2026-11-02T00:00:00.000Z" });
    expect((await readTeamTokenRecord(s)).pendingRevocation).toBeNull();
  });
});

describe("metaFits", () => {
  it("no meta means no restriction", () => {
    expect(metaFits(null, {})).toBe(true);
  });

  it("a portal-made token is valid for its repository only, and needs covering rights", () => {
    expect(metaFits(meta(), {})).toBe(false);
    expect(metaFits(meta(), { repo: "acme/other" })).toBe(false);
    expect(metaFits(meta(), { repo: "acme/team-config" })).toBe(true);
    expect(metaFits(meta(), { repo: "acme/team-config", mode: "pull" })).toBe(true);
    expect(metaFits(meta(), { repo: "acme/team-config", mode: "pull-push" })).toBe(false);
    expect(metaFits(meta({ mode: "pull-push", strategy: "direct" }), { repo: "acme/team-config", mode: "pull-push", strategy: "direct" })).toBe(true);
    expect(metaFits(meta({ mode: "pull-push", strategy: "direct" }), { repo: "acme/team-config", mode: "pull" })).toBe(true);
  });
});

describe("retireTeamToken", () => {
  it("does nothing when the portal never made a token", async () => {
    const s = connections();
    await retireTeamToken(s);
    expect(s.session.get(ENTRY)).toBeUndefined();
  });

  it("forgets the meta and keeps the token name for deletion at GitHub", async () => {
    const s = connections();
    await writeTeamTokenRecord(s, { active: meta(), pendingRevocation: null });
    await retireTeamToken(s, new Date("2026-11-09T12:00:00Z"));
    expect(await readTeamTokenRecord(s)).toEqual({ active: null, pendingRevocation: { tokenName: "secret-desk team sync", repo: "acme/team-config", since: "2026-11-09T12:00:00.000Z" } });
  });

  it("uses the current time by default", async () => {
    const s = connections();
    await writeTeamTokenRecord(s, { active: meta(), pendingRevocation: null });
    await retireTeamToken(s);
    expect(Date.parse((await readTeamTokenRecord(s)).pendingRevocation!.since)).not.toBeNaN();
  });
});
