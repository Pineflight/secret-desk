import { describe, expect, it } from "vitest";
import { NotConnectedError, validateEntryParams } from "@secret-desk/core";
import { cloudflareProviders, SAAS_CUSTOM_HOSTNAMES_PERMISSIONS, TERRAFORM_APPLY_PERMISSIONS, TERRAFORM_PLAN_PERMISSIONS } from "../src/cloudflare.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, connections, issueCtx, mockFetch, revokeCtx, routeFetch, verifyCtx, type Route } from "./helpers.js";

const token = cloudflareProviders.find((p) => p.id === "cloudflare-token")!;
const turnstile = cloudflareProviders.find((p) => p.id === "cloudflare-turnstile")!;
const GROUPS = { result: [{ id: "g1", name: "Workers Scripts Write" }, { id: "g2", name: "Account Settings Read" }] };
const params = { accountId: "acc1", permissions: ["Workers Scripts Write", "Account Settings Read"] };

describe("cloudflare-token", () => {
  it("queries groups and creates the token with expiry", async () => {
    const m = mockFetch({ body: GROUPS }, { body: { result: { id: "tok1", value: ISSUED, expires_on: "2026-12-01T10:00:00Z" } } });
    const r = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"], ttlDays: 30 }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/user/tokens/permission_groups", method: "GET" });
    expect(m.calls[1]!.url).toBe("https://api.cloudflare.com/client/v4/user/tokens");
    expect(m.calls[1]!.method).toBe("POST");
    expect(m.calls[1]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(m.calls[1]!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({
      name: "test-secret-2026-11-01",
      policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acc1": "*" }, permission_groups: [{ id: "g1" }, { id: "g2" }] }],
      expires_on: "2026-12-01T10:00:00Z",
    });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("tok1");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
  });
  it("sends no expires_on without ttlDays", async () => {
    const m = mockFetch({ body: GROUPS }, { body: { result: { id: "tok1", value: ISSUED } } });
    const r = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }));
    expect(JSON.parse(m.calls[1]!.body!)).not.toHaveProperty("expires_on");
    expect(r.expiresAt).toBeNull();
  });
  it("names unknown permission groups", async () => {
    const m = mockFetch({ body: GROUPS });
    await expect(token.issue!(issueCtx(m.fetch, { ...params, permissions: ["Gibt es nicht", "Auch nicht"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/Gibt es nicht, Auch nicht/);
    expect(m.calls).toHaveLength(1);
  });
  it("revokes via DELETE", async () => {
    const m = mockFetch({ body: { result: { id: "tok1" } } });
    await token.revoke!(revokeCtx(m.fetch, {}, "tok1", ["cloudflare"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/user/tokens/tok1", method: "DELETE" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
  });
  it("error 403 contains neither connection token nor issued value", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(403);
    expect(err.message).toContain("cloudflare-token");
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
  it("truncates long responses", async () => {
    const m = mockFetch({ status: 500, body: "x".repeat(5000) });
    const err = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err.message.length).toBeLessThan(300);
  });
  it("throws NotConnectedError without a connection", async () => {
    await expect(token.issue!(issueCtx(mockFetch().fetch, params))).rejects.toThrow(NotConnectedError);
  });
});

describe("cloudflare-turnstile", () => {
  it("returns the new secret", async () => {
    const m = mockFetch({ body: { result: { secret: ISSUED } } });
    const r = await turnstile.issue!(issueCtx(m.fetch, { accountId: "acc1", sitekey: "sk1" }, { conns: ["cloudflare-turnstile"] }));
    expect(m.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/challenges/widgets/sk1/rotate_secret");
    expect(m.calls[0]!.method).toBe("POST");
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ invalidate_immediately: false });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBeUndefined();
    expect(turnstile.revoke).toBeUndefined();
    expect(turnstile.label).toContain("experimentell");
  });
  it("error without values", async () => {
    const m = mockFetch({ status: 403, body: `nope ${CONN_TOKEN}` });
    const err = await turnstile.issue!(issueCtx(m.fetch, { accountId: "a", sitekey: "s" }, { conns: ["cloudflare-turnstile"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
});

describe("cloudflare-token with same-named groups per scope", () => {
  const DUP = {
    result: [
      { id: "a1", name: "Logs Read", scopes: ["com.cloudflare.api.account"] },
      { id: "z1", name: "Logs Read", scopes: ["com.cloudflare.api.account.zone"] },
      { id: "z2", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] },
    ],
  };
  it("lists one option per name with merged scopes", async () => {
    const m = mockFetch({ body: DUP });
    const options = await token.discover!("cloudflare.permissionGroups", { connections: issueCtx(m.fetch, {}, { conns: ["cloudflare"] }).connections, fetch: m.fetch, params: {}, hint: { repos: [], stage: "staging", stageKind: "test" } });
    expect(options.map((o) => [o.value, o.detail])).toEqual([["Logs Read", "account, zone"], ["Workers Routes Write", "zone"]]);
  });
  it("uses the account group for the account policy and the zone group for the zone policy", async () => {
    const m = mockFetch({ body: DUP }, { body: { result: { id: "tok1", value: ISSUED } } });
    await token.issue!(issueCtx(m.fetch, { accountId: "acc1", zoneId: "zone9", permissions: ["Logs Read", "Workers Routes Write"] }, { conns: ["cloudflare"] }));
    const body = JSON.parse(m.calls[1]!.body!);
    expect(body.policies).toEqual([
      { effect: "allow", resources: { "com.cloudflare.api.account.acc1": "*" }, permission_groups: [{ id: "a1" }] },
      { effect: "allow", resources: { "com.cloudflare.api.account.zone.zone9": "*" }, permission_groups: [{ id: "z2" }] },
    ]);
  });
});

describe("cloudflare-token across several zones", () => {
  const ZONE_GROUPS = {
    result: [
      { id: "a1", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
      { id: "z1", name: "DNS Write", scopes: ["com.cloudflare.api.account.zone"] },
    ],
  };
  const zoneRoutes = (): Route[] => [
    { url: "/user/tokens/permission_groups", reply: { body: ZONE_GROUPS } },
    { url: "/zones?name=acme.example&", reply: { body: { result: [{ id: "zone-a", name: "acme.example" }] } } },
    { url: "/zones?name=acme.test&", reply: { body: { result: [{ id: "zone-b", name: "acme.test" }] } } },
    { method: "POST", url: "/user/tokens", reply: { body: { result: { id: "tok1", value: ISSUED } } } },
  ];
  const create = (m: { calls: { method: string; body?: string | undefined }[] }) => JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
  const base = { accountId: "acc1", permissions: ["Account Settings Read", "DNS Write"] };

  it("resolves a list of zone names through the API and puts every zone into one policy", async () => {
    const m = routeFetch(...zoneRoutes());
    await token.issue!(issueCtx(m.fetch, { ...base, zones: ["Acme.Example", "acme.test", "acme.test"] }, { conns: ["cloudflare"] }));
    expect(m.calls.filter((c) => c.url.includes("/zones?name=")).map((c) => c.url)).toEqual([
      "https://api.cloudflare.com/client/v4/zones?name=acme.example&account.id=acc1&per_page=5",
      "https://api.cloudflare.com/client/v4/zones?name=acme.test&account.id=acc1&per_page=5",
    ]);
    expect(create(m).policies).toEqual([
      { effect: "allow", resources: { "com.cloudflare.api.account.acc1": "*" }, permission_groups: [{ id: "a1" }] },
      { effect: "allow", resources: { "com.cloudflare.api.account.zone.zone-a": "*", "com.cloudflare.api.account.zone.zone-b": "*" }, permission_groups: [{ id: "z1" }] },
    ]);
  });

  it("combines zoneId and zones", async () => {
    const m = routeFetch(...zoneRoutes());
    await token.issue!(issueCtx(m.fetch, { ...base, zoneId: "zone-x", zones: ["acme.test"] }, { conns: ["cloudflare"] }));
    expect(Object.keys(create(m).policies[1].resources)).toEqual(["com.cloudflare.api.account.zone.zone-x", "com.cloudflare.api.account.zone.zone-b"]);
  });

  it("fails closed when a zone name does not resolve and creates no token", async () => {
    const m = routeFetch(...zoneRoutes().map((r) => (String(r.url).includes("acme.test&") ? { ...r, reply: { body: { result: [] } } } : r)));
    await expect(token.issue!(issueCtx(m.fetch, { ...base, zones: ["acme.example", "acme.test"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/Zonen nicht gefunden.*acme\.test/);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
    // a different zone in the answer is not a match
    const other = routeFetch(...zoneRoutes().map((r) => (String(r.url).includes("acme.test&") ? { ...r, reply: { body: { result: [{ id: "zone-z", name: "other.test" }] } } } : r)));
    await expect(token.issue!(issueCtx(other.fetch, { ...base, zones: ["acme.test"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/acme\.test/);
  });

  it("allZones covers every zone of the account, also the ones created later, without calling the zone API", async () => {
    for (const flag of [true, "true"]) {
      const m = routeFetch(...zoneRoutes());
      await token.issue!(issueCtx(m.fetch, { ...base, allZones: flag }, { conns: ["cloudflare"] }));
      expect(create(m).policies[1]).toEqual({ effect: "allow", resources: { "com.cloudflare.api.account.acc1": { "com.cloudflare.api.account.zone.*": "*" } }, permission_groups: [{ id: "z1" }] });
      expect(m.calls.some((c) => c.url.includes("/zones?"))).toBe(false);
    }
  });

  it("rejects allZones together with zones or zoneId, zones without zone-bound permissions, and missing zones", async () => {
    const m = routeFetch(...zoneRoutes());
    await expect(token.issue!(issueCtx(m.fetch, { ...base, allZones: true, zones: ["acme.test"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/allZones/);
    await expect(token.issue!(issueCtx(m.fetch, { ...base, allZones: true, zoneId: "z" }, { conns: ["cloudflare"] }))).rejects.toThrow(/allZones/);
    await expect(token.issue!(issueCtx(m.fetch, { accountId: "acc1", permissions: ["Account Settings Read"], zones: ["acme.test"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/Zonen angegeben/);
    await expect(token.issue!(issueCtx(m.fetch, base, { conns: ["cloudflare"] }))).rejects.toThrow(/Pflichtparameter fehlen: zoneId/);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("accepts allZones as a YAML boolean and as an enum string, and offers zone names for discovery", async () => {
    const specs = token.params!;
    expect(validateEntryParams(token, { params: { ...base, allZones: true } }, undefined, { strict: true })).toEqual([]);
    expect(validateEntryParams(token, { params: { ...base, allZones: "false" } }, undefined, { strict: true })).toEqual([]);
    expect(validateEntryParams(token, { params: { ...base, allZones: "maybe" } }).map((p) => p.code)).toEqual(["not_in_options"]);
    expect(specs.find((s) => s.key === "zones")).toMatchObject({ type: "stringList", discover: "cloudflare.zoneName" });
    const m = routeFetch({ url: "/zones?per_page=50&account.id=acc1", reply: { body: { result: [{ id: "z1", name: "acme.example" }] } } });
    const options = await token.discover!("cloudflare.zoneName", { connections: connections("cloudflare"), fetch: m.fetch, params: { accountId: "acc1" }, hint: { repos: [] } });
    expect(options).toEqual([{ value: "acme.example", label: "acme.example", detail: "z1" }]);
  });

  it("verifies the scope of a multi-zone token and of an all-zones token", async () => {
    const policy = (resources: Record<string, unknown>) => ({ result: { status: "active", policies: [{ resources, permission_groups: [{ name: "Account Settings Read" }, { name: "DNS Write" }] }] } });
    const run = async (p: Record<string, unknown>, resources: Record<string, unknown>) => {
      const m = routeFetch({ url: "/user/tokens/verify", reply: { body: { result: { status: "active" } } } }, { url: "/user/tokens/tok1", reply: { body: policy(resources) } });
      return (await token.verify!(verifyCtx(m.fetch, p, { externalId: "tok1", conns: ["cloudflare"] }))).find((c) => c.id === "account-scope")!;
    };
    const acc = "com.cloudflare.api.account.acc1";
    const zone = (id: string) => `com.cloudflare.api.account.zone.${id}`;
    expect((await run({ ...base, zones: ["a.test", "b.test"] }, { [acc]: "*", [zone("1")]: "*", [zone("2")]: "*" })).status).toBe("pass");
    expect((await run({ ...base, zones: ["a.test", "b.test"] }, { [acc]: "*", [zone("1")]: "*" })).status).toBe("fail");
    expect((await run({ ...base, allZones: true }, { [acc]: { "com.cloudflare.api.account.zone.*": "*" } })).status).toBe("pass");
    expect((await run({ ...base, allZones: true }, { [acc]: "*", [zone("1")]: "*" })).status).toBe("fail");
    expect((await run({ ...base, zoneId: "1" }, { [acc]: "*", [zone("1")]: "*" })).status).toBe("pass");
    expect((await run({ ...base, zoneId: "1" }, { [acc]: "*", [zone("2")]: "*" })).status).toBe("fail");
  });
});

describe("cloudflare-token presets", () => {
  const preset = (id: string) => token.params!.find((s) => s.key === "permissions")!.presets!.find((p) => p.id === id)!;
  it("keeps the documented permission sets in code", () => {
    expect(preset("terraform-plan").values["permissions"]).toEqual([...TERRAFORM_PLAN_PERMISSIONS]);
    expect(preset("terraform-apply").values["permissions"]).toEqual([...TERRAFORM_APPLY_PERMISSIONS]);
    expect(preset("saas-custom-hostnames").values["permissions"]).toEqual([...SAAS_CUSTOM_HOSTNAMES_PERMISSIONS]);
    expect(preset("terraform-plan").needs).toEqual(["zones"]);
    expect(preset("saas-custom-hostnames").needs).toEqual(["zoneId"]);
  });
  it("is read-only for plan and covers the same resources for apply", () => {
    expect(TERRAFORM_PLAN_PERMISSIONS.every((n) => n.endsWith(" Read"))).toBe(true);
    const writes = TERRAFORM_APPLY_PERMISSIONS.filter((n) => n.endsWith(" Write")).map((n) => n.replace(/ Write$/, ""));
    const reads = TERRAFORM_PLAN_PERMISSIONS.map((n) => n.replace(/ Read$/, ""));
    for (const w of writes) expect(reads).toContain(w);
    for (const area of ["DNS", "Zone Settings", "Page Rules", "Workers Routes", "Workers Scripts", "Workers R2 Storage", "Access: Apps and Policies", "Turnstile Sites", "Cloudflare Pages"]) {
      expect(writes).toContain(area);
    }
  });
  it("fails closed with the missing group name when the account does not list a preset's group", async () => {
    const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: { result: [{ id: "g", name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] }] } } });
    await expect(token.issue!(issueCtx(m.fetch, { accountId: "acc1", zoneId: "z", permissions: [...SAAS_CUSTOM_HOSTNAMES_PERMISSIONS] }, { conns: ["cloudflare"] }))).rejects.toThrow(/SSL and Certificates Write/);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("issues the plan and apply presets as account and zone policies", async () => {
    for (const [perms, expectWrite] of [[TERRAFORM_PLAN_PERMISSIONS, false], [TERRAFORM_APPLY_PERMISSIONS, true]] as const) {
      const groups = [...new Set(perms)].flatMap((n) => [{ id: `a-${n}`, name: n, scopes: ["com.cloudflare.api.account"] }, { id: `z-${n}`, name: n, scopes: ["com.cloudflare.api.account.zone"] }]);
      // zone-only groups: names that exist in the zone scope only
      const zoneOnly = new Set(["DNS", "Zone Settings", "Zone", "Page Rules", "Config Settings", "Workers Routes"].flatMap((a) => [`${a} Read`, `${a} Write`]));
      const list = groups.filter((g) => !(zoneOnly.has(g.name) && g.scopes[0] === "com.cloudflare.api.account"));
      const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: { result: list } } }, { method: "POST", url: "/user/tokens", reply: { body: { result: { id: "t", value: ISSUED } } } });
      await token.issue!(issueCtx(m.fetch, { accountId: "acc1", allZones: true, permissions: [...perms] }, { conns: ["cloudflare"] }));
      const body = JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
      expect(body.policies).toHaveLength(2);
      expect(body.policies[1].resources).toEqual({ "com.cloudflare.api.account.acc1": { "com.cloudflare.api.account.zone.*": "*" } });
      expect(body.policies.flatMap((p: { permission_groups: { id: string }[] }) => p.permission_groups).length).toBe(perms.length);
      const ids: string[] = body.policies.flatMap((p: { permission_groups: { id: string }[] }) => p.permission_groups.map((g) => g.id));
      expect(ids.some((id) => id.endsWith(" Write"))).toBe(expectWrite);
      expect(perms.some((n) => n.endsWith("Write"))).toBe(expectWrite);
    }
  });
});
