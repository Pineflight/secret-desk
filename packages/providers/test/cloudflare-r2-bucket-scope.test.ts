import { describe, expect, it } from "vitest";
import { ParamsInvalidError, validateEntryParams, type ConnectionStore } from "@secret-desk/core";
import { cloudflareProviders } from "../src/cloudflare.js";
import { byId, connections, expectNoLeak, issueCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const token = cloudflareProviders.find((p) => p.id === "cloudflare-token")!;
const ACCOUNT = "com.cloudflare.api.account";
const BUCKET = "com.cloudflare.edge.r2.bucket";
const ACC = "0123456789abcdef0123456789abcdef";
const GROUPS = [
  { id: "item-read", name: "Workers R2 Storage Bucket Item Read", scopes: [BUCKET] },
  { id: "item-write", name: "Workers R2 Storage Bucket Item Write", scopes: [BUCKET] },
  { id: "r2-write", name: "Workers R2 Storage Write", scopes: [ACCOUNT] },
  { id: "settings", name: "Account Settings Read", scopes: [ACCOUNT] },
];
const groupsRoute: Route = { url: "/user/tokens/permission_groups", reply: { body: { result: GROUPS } } };
const createRoute: Route = { method: "POST", url: "/user/tokens", reply: { body: { result: { id: "tok1", value: "ISSUED-VALUE-ABCDEFGH" } } } };
const RW = ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"];
const base = { accountId: ACC, permissions: RW, r2Buckets: ["example-bucket"] };
const key = (j: string, b: string) => `${BUCKET}.${ACC}_${j}_${b}`;

async function policiesOf(params: Record<string, unknown>) {
  const m = routeFetch(groupsRoute, createRoute);
  await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }));
  return JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).policies as { effect: string; resources: Record<string, unknown>; permission_groups: { id: string }[] }[];
}

describe("cloudflare-token R2 bucket scope: issue", () => {
  it("offers r2Buckets and r2Jurisdiction with German and English labels", () => {
    for (const k of ["r2Buckets", "r2Jurisdiction"]) {
      const spec = token.params!.find((s) => s.key === k)!;
      expect(spec.required).toBe(false);
      expect(spec.label && spec.labelEn && spec.help && spec.helpEn).toBeTruthy();
    }
    expect(token.params!.find((s) => s.key === "r2Buckets")!.type).toBe("stringList");
    const j = token.params!.find((s) => s.key === "r2Jurisdiction")!;
    expect(j).toMatchObject({ type: "enum", defaultValue: "default" });
    expect(j.options!.map((o) => o.value)).toEqual(["default", "eu", "fedramp"]);
    expect(validateEntryParams(token, { params: { ...base, r2Jurisdiction: "eu" } }, undefined, { strict: true })).toEqual([]);
    expect(validateEntryParams(token, { params: { ...base, r2Jurisdiction: "moon" } }).map((p) => p.code)).toEqual(["not_in_options"]);
  });

  it("puts bucket-bound permissions into their own policy on the default jurisdiction", async () => {
    expect(await policiesOf(base)).toEqual([{ effect: "allow", resources: { [key("default", "example-bucket")]: "*" }, permission_groups: [{ id: "item-read" }, { id: "item-write" }] }]);
  });

  it("uses the eu jurisdiction in the resource key", async () => {
    const p = await policiesOf({ ...base, r2Jurisdiction: "eu" });
    expect(p).toHaveLength(1);
    expect(p[0]!.resources).toEqual({ "com.cloudflare.edge.r2.bucket.0123456789abcdef0123456789abcdef_eu_example-bucket": "*" });
  });

  it("adds one resource per bucket and drops duplicates and blanks", async () => {
    const p = await policiesOf({ ...base, r2Jurisdiction: "fedramp", r2Buckets: ["example-bucket", " other-bucket ", "example-bucket", "  "] });
    expect(p[0]!.resources).toEqual({ [key("fedramp", "example-bucket")]: "*", [key("fedramp", "other-bucket")]: "*" });
  });

  it("keeps account-wide R2 groups on the account in a mixed token", async () => {
    const p = await policiesOf({ ...base, permissions: ["Workers R2 Storage Write", "Account Settings Read", ...RW] });
    expect(p).toEqual([
      { effect: "allow", resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: [{ id: "r2-write" }, { id: "settings" }] },
      { effect: "allow", resources: { [key("default", "example-bucket")]: "*" }, permission_groups: [{ id: "item-read" }, { id: "item-write" }] },
    ]);
  });

  it("leaves tokens without r2Buckets unchanged (no jurisdiction needed)", async () => {
    expect(await policiesOf({ accountId: ACC, permissions: ["Workers R2 Storage Write"] })).toEqual([{ effect: "allow", resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: [{ id: "r2-write" }] }]);
  });

  it("keeps a group with account and bucket scope account-wide without r2Buckets, and uses the bucket variant with r2Buckets", async () => {
    const dual = { ...groupsRoute, reply: { body: { result: [...GROUPS, { id: "dual-acc", name: "Dual Group", scopes: [ACCOUNT] }, { id: "dual-bucket", name: "Dual Group", scopes: [BUCKET] }] } } } satisfies Route;
    const issue = async (params: Record<string, unknown>) => {
      const m = routeFetch(dual, createRoute);
      await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }));
      return JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).policies;
    };
    expect(await issue({ accountId: ACC, permissions: ["Dual Group"] })).toEqual([{ effect: "allow", resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: [{ id: "dual-acc" }] }]);
    expect(await issue({ accountId: ACC, permissions: ["Dual Group"], r2Buckets: ["example-bucket"] })).toEqual([{ effect: "allow", resources: { [key("default", "example-bucket")]: "*" }, permission_groups: [{ id: "dual-bucket" }] }]);
  });

  it("requires a real account id for bucket resources", async () => {
    for (const bad of ["acc1", ACC.toUpperCase(), `${ACC}0`]) {
      const m = routeFetch(groupsRoute, createRoute);
      const err = await token.issue!(issueCtx(m.fetch, { ...base, accountId: bad }, { conns: ["cloudflare"] })).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(ParamsInvalidError);
      expect((err as ParamsInvalidError).problems[0]).toMatchObject({ key: "accountId", code: "not_in_options" });
      expect(m.calls.some((c) => c.method === "POST")).toBe(false);
    }
    // without bucket-bound permissions the account id keeps its old, unchecked form
    expect(await policiesOf({ accountId: "acc1", permissions: ["Workers R2 Storage Write"] })).toHaveLength(1);
  });

  it("rejects bucket-bound permissions without r2Buckets and creates no token", async () => {
    for (const p of [{ ...base, r2Buckets: undefined }, { ...base, r2Buckets: [] }]) {
      const m = routeFetch(groupsRoute, createRoute);
      const err = await token.issue!(issueCtx(m.fetch, p, { conns: ["cloudflare"] })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParamsInvalidError);
      expect((err as ParamsInvalidError).problems[0]).toMatchObject({ key: "r2Buckets", code: "missing" });
      expect(m.calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("rejects r2Buckets without a bucket-bound permission", async () => {
    const m = routeFetch(groupsRoute, createRoute);
    await expect(token.issue!(issueCtx(m.fetch, { ...base, permissions: ["Workers R2 Storage Write"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/keine bucketgebundene Berechtigung/);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects bucket names that break the R2 rules and an unknown jurisdiction", async () => {
    for (const bad of ["ab", "a".repeat(64), "Example-Bucket", "example_bucket", "-example", "example-", "exa mple"]) {
      const m = routeFetch(groupsRoute, createRoute);
      const err = await token.issue!(issueCtx(m.fetch, { ...base, r2Buckets: ["example-bucket", bad] }, { conns: ["cloudflare"] })).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(ParamsInvalidError);
      expect((err as ParamsInvalidError).problems[0]).toMatchObject({ key: "r2Buckets", code: "not_in_options" });
      expect(m.calls.some((c) => c.method === "POST")).toBe(false);
    }
    for (const ok of ["abc", "a".repeat(63), "a-1-b"]) expect((await policiesOf({ ...base, r2Buckets: [ok] }))[0]!.resources).toEqual({ [key("default", ok)]: "*" });
    const m = routeFetch(groupsRoute, createRoute);
    const err = await token.issue!(issueCtx(m.fetch, { ...base, r2Jurisdiction: "moon" }, { conns: ["cloudflare"] })).catch((e: unknown) => e);
    expect((err as ParamsInvalidError).problems[0]).toMatchObject({ key: "r2Jurisdiction", code: "not_in_options" });
  });
});

describe("cloudflare-token R2 bucket scope: verify", () => {
  const run = async (params: Record<string, unknown>, policies: unknown[], groups: Route = groupsRoute) => {
    const m = routeFetch(
      { url: "/user/tokens/verify", reply: { body: { result: { status: "active" } } } },
      { url: "/user/tokens/tok1", reply: { body: { result: { status: "active", policies } } } },
      groups,
    );
    return token.verify!(verifyCtx(m.fetch, params, { externalId: "tok1", conns: ["cloudflare"] }));
  };
  const names = RW.map((name) => ({ name }));
  const eu = { ...base, r2Jurisdiction: "eu" };

  it("passes when the policy resources are exactly the expected bucket keys", async () => {
    const checks = await run(eu, [{ resources: { [key("eu", "example-bucket")]: "*" }, permission_groups: names }]);
    expect(byId(checks)).toMatchObject({ permissions: "pass", "account-scope": "pass", "r2-buckets": "pass" });
    expect(checks.find((c) => c.id === "r2-buckets")).toMatchObject({ expected: key("eu", "example-bucket") });
    expectNoLeak(checks);
  });

  it("fails on account-wide access to the bucket permissions", async () => {
    const checks = await run(eu, [{ resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: names }]);
    expect(byId(checks)["r2-buckets"]).toBe("fail");
    expect(checks.find((c) => c.id === "r2-buckets")!.detail).toContain(`Zusaetzlich: ${ACCOUNT}.0123456789abcdef0123456789abcdef`);
  });

  it("fails when a bucket is missing, an extra bucket is present or the jurisdiction differs", async () => {
    const two = { ...eu, r2Buckets: ["example-bucket", "other-bucket"] };
    expect(byId(await run(two, [{ resources: { [key("eu", "example-bucket")]: "*" }, permission_groups: names }]))["r2-buckets"]).toBe("fail");
    expect(byId(await run(eu, [{ resources: { [key("eu", "example-bucket")]: "*", [key("eu", "other-bucket")]: "*" }, permission_groups: names }]))["r2-buckets"]).toBe("fail");
    expect(byId(await run(eu, [{ resources: { [key("default", "example-bucket")]: "*" }, permission_groups: names }]))["r2-buckets"]).toBe("fail");
    expect(byId(await run(eu, [{ permission_groups: names }, { resources: "x", permission_groups: "x" }]))["r2-buckets"]).toBe("fail");
  });

  it("accepts a mixed token: the account policy stays account-wide, the bucket policy exact", async () => {
    const mixed = { ...eu, permissions: ["Workers R2 Storage Write", ...RW] };
    const policies = [
      { resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: [{ name: "Workers R2 Storage Write" }] },
      { resources: { [key("eu", "example-bucket")]: "*" }, permission_groups: names },
    ];
    expect(byId(await run(mixed, policies))).toMatchObject({ "account-scope": "pass", "r2-buckets": "pass" });
    // the same account policy also carrying the bucket permissions is account-wide access
    const wide = [{ resources: { [`${ACCOUNT}.${ACC}`]: "*", [key("eu", "example-bucket")]: "*" }, permission_groups: [...names, { name: "Workers R2 Storage Write" }] }];
    expect(byId(await run(mixed, wide))["r2-buckets"]).toBe("fail");
  });

  it("fails the account scope for a bucket key of another account, with the same bucket name", async () => {
    const foreign = `${BUCKET}.${"f".repeat(32)}_eu_example-bucket`;
    const checks = await run(eu, [{ resources: { [key("eu", "example-bucket")]: "*", [foreign]: "*" }, permission_groups: names }]);
    expect(byId(checks)["account-scope"]).toBe("fail");
    expect(checks.find((c) => c.id === "account-scope")!.detail).toContain(foreign);
  });

  it("compares per policy: two partial policies for two buckets fail", async () => {
    const two = { ...eu, r2Buckets: ["example-bucket", "other-bucket"] };
    const partial = [
      { resources: { [key("eu", "example-bucket")]: "*" }, permission_groups: [names[0]] },
      { resources: { [key("eu", "other-bucket")]: "*" }, permission_groups: [names[1]] },
    ];
    const checks = await run(two, partial);
    expect(byId(checks)["r2-buckets"]).toBe("fail");
    expect(checks.find((c) => c.id === "r2-buckets")!.detail).toContain("Fehlt:");
    const whole = partial.map((p) => ({ ...p, resources: { [key("eu", "example-bucket")]: "*", [key("eu", "other-bucket")]: "*" } }));
    expect(byId(await run(two, whole))["r2-buckets"]).toBe("pass");
  });

  it("warns instead of passing when the account id is not a real id", async () => {
    expect(byId(await run({ ...eu, accountId: "acc1" }, []))).toMatchObject({ permissions: "warn" });
  });

  it("fails the account scope for foreign resources next to the buckets, and without any resource", async () => {
    expect(byId(await run(eu, [{ resources: { [key("eu", "example-bucket")]: "*", "com.cloudflare.api.account.other": "*" }, permission_groups: names }]))["account-scope"]).toBe("fail");
    expect(byId(await run(eu, []))).toMatchObject({ "account-scope": "fail", "r2-buckets": "fail" });
  });

  it("warns when the permission groups cannot be read or no wanted group is bucket-bound", async () => {
    const policies = [{ resources: { [key("eu", "example-bucket")]: "*" }, permission_groups: names }];
    expect(byId(await run(eu, policies, { url: "/user/tokens/permission_groups", reply: { status: 403, body: "no" } }))["r2-buckets"]).toBe("warn");
    expect(byId(await run(eu, policies, { url: "/user/tokens/permission_groups", reply: { body: { result: "x" } } }))["r2-buckets"]).toBe("warn");
    expect(byId(await run(eu, policies, { url: "/user/tokens/permission_groups", reply: { body: { result: [{ name: 5, scopes: [BUCKET] }, { name: "x", scopes: "y" }, ...GROUPS] } } }))["r2-buckets"]).toBe("pass");
    expect(byId(await run({ ...eu, permissions: undefined }, policies))["r2-buckets"]).toBe("warn");
  });

  it("warns without accountId and ignores r2Buckets-free tokens", async () => {
    expect(byId(await run({ permissions: RW, r2Buckets: ["example-bucket"] }, []))["r2-buckets"]).toBe("warn");
    const plain = await run({ accountId: ACC, permissions: ["Account Settings Read"] }, [{ resources: { [`${ACCOUNT}.${ACC}`]: "*" }, permission_groups: [{ name: "Account Settings Read" }] }]);
    expect(plain.some((c) => c.id === "r2-buckets")).toBe(false);
  });

  it("warns instead of throwing when r2Buckets holds an invalid name", async () => {
    expect(byId(await run({ ...base, r2Buckets: ["Bad_Name"] }, []))).toMatchObject({ permissions: "warn" });
  });
});

describe("cloudflare-token R2 bucket scope: preflight", () => {
  const acc = { url: "/accounts?per_page=50", reply: { body: { result: [{ id: "0123456789abcdef0123456789abcdef", name: "Example" }] } } } satisfies Route;
  const pre = async (params: Record<string, unknown>, conns: ConnectionStore = connections("cloudflare")) => {
    const m = routeFetch(acc, groupsRoute);
    return token.preflight!({ secret: secretEntry(), params, stage: "dev", connections: conns, fetch: m.fetch, now: new Date("2026-11-01T10:00:00Z") } as never);
  };
  const r2 = (r: { findings: { id: string }[] }) => r.findings.find((f) => f.id === "r2-buckets");

  it("shows the planned resources", async () => {
    const r = await pre({ ...base, r2Jurisdiction: "eu", r2Buckets: ["example-bucket", "other-bucket"] });
    expect(r.resource).toBe("Cloudflare-Konto Example (0123456789abcdef0123456789abcdef), R2-Buckets eu/example-bucket, other-bucket");
    expect(r2(r)).toMatchObject({ level: "ok", detail: `Ressourcen: ${key("eu", "example-bucket")}, ${key("eu", "other-bucket")}` });
    expect((await pre(base)).resource).toContain("R2-Buckets default/example-bucket");
  });

  it("fails for each mismatch and for invalid names, and stays silent without R2 buckets", async () => {
    expect(r2(await pre({ ...base, r2Buckets: [] }))).toMatchObject({ level: "fail", label: expect.stringContaining("R2-Buckets fehlen") });
    expect(r2(await pre({ ...base, permissions: ["Workers R2 Storage Write"] }))).toMatchObject({ level: "fail", label: expect.stringContaining("keine bucketgebundene") });
    expect(r2(await pre({ ...base, r2Buckets: ["No_Good"] }))).toMatchObject({ level: "fail", label: expect.stringContaining("No_Good") });
    const quiet = await pre({ accountId: ACC, permissions: ["Workers R2 Storage Write"] });
    expect(r2(quiet)).toBeUndefined();
    expect(quiet.resource).toBe("Cloudflare-Konto Example (0123456789abcdef0123456789abcdef)");
  });

  it("fails the preflight for an account id that is not a real id", async () => {
    expect(r2(await pre({ ...base, accountId: "acc1" }))).toMatchObject({ level: "fail", label: expect.stringContaining("32 Hex-Zeichen") });
  });

  it("treats a group with account and bucket scope as account-wide unless buckets are named", async () => {
    const dualGroups = { ...groupsRoute, reply: { body: { result: [{ id: "d1", name: "Dual Group", scopes: [ACCOUNT, BUCKET] }] } } } satisfies Route;
    const dual = async (params: Record<string, unknown>) => token.preflight!({ secret: secretEntry(), params, stage: "dev", connections: connections("cloudflare"), fetch: routeFetch(acc, dualGroups).fetch, now: new Date() } as never);
    expect(r2(await dual({ accountId: ACC, permissions: ["Dual Group"] }))).toBeUndefined();
    expect(r2(await dual({ accountId: ACC, permissions: ["Dual Group"], r2Buckets: ["example-bucket"] }))).toMatchObject({ level: "ok" });
  });

  it("labels bucket-bound groups in discovery", async () => {
    const m = routeFetch(groupsRoute);
    const opts = await token.discover!("cloudflare.permissionGroups", { connections: connections("cloudflare"), fetch: m.fetch, params: {}, hint: { repos: [] } });
    expect(opts.find((o) => o.value === "Workers R2 Storage Bucket Item Read")!.detail).toBe("r2-bucket");
    expect(opts.find((o) => o.value === "Workers R2 Storage Write")!.detail).toBe("account");
  });
});
