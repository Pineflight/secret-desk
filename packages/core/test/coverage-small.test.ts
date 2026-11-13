import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  ConnectionStore,
  EvidenceError,
  FileEvidenceStore,
  GitHubError,
  InventoryError,
  ProviderRegistry,
  SecretValue,
  VariablePatchSchema,
  WorkerSecretsError,
  analyzeName,
  computeStatus,
  errorMatchesPlace,
  findings,
  hashOf,
  listStripeAccounts,
  loadConfig,
  looksSecret,
  parseInput,
  placeErrorStatus,
  readConnectionLabel,
  redactCdpEndpoint,
  secretApprovalSnapshot,
  snapshotPlaces,
  stageIds,
  stageTone,
  stripeKeyCarriesAccount,
  variableApprovalSnapshot,
  writeConnectionLabel,
  deleteConnectionLabel,
  SecretVault,
} from "../src/index.js";
import type { Inventory, Place, SecretEntry, VerificationReport } from "../src/index.js";

const BASE = { inventory: "./inventory.yaml", github: { owner: "acme", auth: { type: "pat" } } };
const tmp = (prefix: string) => mkdtemp(join(tmpdir(), `sd-cov-${prefix}-`));

describe("config", () => {
  it("redactCdpEndpoint accepts an already parsed URL and drops credentials, query and a root path", () => {
    expect(redactCdpEndpoint(new URL("http://user:pw@host:9222/?token=x#f"))).toBe("http://host:9222");
    expect(redactCdpEndpoint(new URL("ws://host/devtools/browser"))).toBe("ws://host/devtools/browser");
  });

  it("viewerUrl takes a portal path or an http(s) URL without credentials", () => {
    const ok = (viewerUrl: string) => ConfigSchema.safeParse({ ...BASE, automation: { viewerUrl } }).success;
    expect(ok("/browser/vnc.html?autoconnect=1")).toBe(true);
    expect(ok("https://desk.example.com/vnc.html")).toBe(true);
    expect(ok("//evil.example.com/x")).toBe(false);
    expect(ok("/with space")).toBe(false);
    expect(ok("/back\\slash")).toBe(false);
    expect(ok("https://user:pw@desk.example.com/")).toBe(false);
    expect(ok("ftp://desk.example.com/")).toBe(false);
    expect(ok("relative/path")).toBe(false);
  });

  it("loadConfig names every invalid field", async () => {
    const dir = await tmp("config");
    await writeFile(join(dir, "c.yaml"), "inventory: ./i.yaml\ngithub: { owner: acme, auth: { type: nope } }\nserver: { port: 80 }\n");
    await expect(loadConfig(join(dir, "c.yaml"))).rejects.toThrow(/Konfiguration ungueltig: .*github\.auth.*; .*server\.port/);
  });
});

describe("evidence store", () => {
  const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({ id: "rep-1", secretId: "api-key", createdAt: "2026-03-01T10:00:00Z", attachments: [], ...over }) as VerificationReport;
  const PNG = new Uint8Array([1, 2, 3]);

  it("lists nothing for a secret without reports", async () => {
    expect(await new FileEvidenceStore(await tmp("ev")).list("unknown-secret")).toEqual([]);
  });

  it("lists the reports of a secret, newest first, and ignores other files", async () => {
    const dir = await tmp("ev");
    const store = new FileEvidenceStore(dir);
    await store.save(report({ id: "old", createdAt: "2026-01-01T00:00:00Z" }));
    await store.save(report({ id: "new", createdAt: "2026-02-01T00:00:00Z" }));
    await writeFile(join(dir, "api-key", "notes.txt"), "not a report");
    expect((await store.list("api-key")).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("get returns null for a report that does not exist", async () => {
    const dir = await tmp("ev");
    const store = new FileEvidenceStore(dir);
    await store.save(report());
    expect(await store.get("api-key", "missing")).toBeNull();
  });

  it("get passes on errors other than a missing file", async () => {
    const dir = await tmp("ev");
    const store = new FileEvidenceStore(dir);
    await mkdir(join(dir, "api-key", "rep-1.json"), { recursive: true });
    await expect(store.get("api-key", "rep-1")).rejects.toThrow(/EISDIR/);
  });

  it("attach: refuses a report that does not exist", async () => {
    const store = new FileEvidenceStore(await tmp("ev"));
    await expect(store.attach("api-key", "nope", PNG, "image/png")).rejects.toThrow(new EvidenceError("Bericht nicht gefunden"));
  });

  it("attach: stores the image with or without a note and numbers the files", async () => {
    const store = new FileEvidenceStore(await tmp("ev"));
    await store.save(report());
    const first = await store.attach("api-key", "rep-1", PNG, "image/png", "Screenshot", new Date("2026-03-02T00:00:00Z"));
    const second = await store.attach("api-key", "rep-1", PNG, "image/jpeg");
    expect(first).toEqual({ file: "anlage-1.png", mime: "image/png", addedAt: "2026-03-02T00:00:00.000Z", note: "Screenshot" });
    expect(second.file).toBe("anlage-2.jpg");
    expect(second).not.toHaveProperty("note");
    expect((await store.get("api-key", "rep-1"))!.attachments).toHaveLength(2);
  });

  it("readAttachment returns bytes and mime, or null when the report or the file is unknown", async () => {
    const store = new FileEvidenceStore(await tmp("ev"));
    await store.save(report());
    await store.attach("api-key", "rep-1", PNG, "image/png");
    const r = await store.readAttachment("api-key", "rep-1", "anlage-1.png");
    expect(r!.mime).toBe("image/png");
    expect([...r!.bytes]).toEqual([1, 2, 3]);
    expect(await store.readAttachment("api-key", "rep-1", "anlage-9.png")).toBeNull();
    expect(await store.readAttachment("api-key", "nope", "anlage-1.png")).toBeNull();
  });
});

describe("looksSecret", () => {
  const jwt = (payload: unknown) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  it("a JWT without a role claim is a warning with the empty role", () => {
    expect(looksSecret("SITE_KEY", jwt({ iss: "x" }))).toMatchObject({ level: "warn" });
  });
  it("a JWT with a service role blocks, one with another role warns", () => {
    expect(looksSecret("K", jwt({ role: "service_role" }))).toMatchObject({ level: "block" });
    expect(looksSecret("K", jwt({ role: "anon" }))).toMatchObject({ level: "warn" });
  });
  it("a JWT-shaped value whose payload is not JSON is judged by the other rules", () => {
    expect(looksSecret("SITE_URL", "eyJhbGciOiJIUzI1NiJ9.!!!.sig")).toBeNull();
  });
  it("public SDK keys are fine", () => {
    expect(looksSecret("REVENUECAT_KEY", `appl_${"a1B2".repeat(5)}`)).toBeNull();
  });
});

describe("naming", () => {
  it("a framework prefix alone is not stripped to nothing", () => {
    expect(analyzeName("NEXT_PUBLIC").suggested).toBe("NEXT_PUBLIC");
  });
  it("a workspace rename that maps a name to itself is accepted as is", () => {
    expect(analyzeName("LEGACY_NAME", { renames: { LEGACY_NAME: "LEGACY_NAME" } })).toEqual({ suggested: "LEGACY_NAME", findings: [], removedStageTokens: [] });
  });
  it("a name without any token is returned unchanged", () => {
    expect(analyzeName("___").suggested).toBe("___");
  });
});

describe("parseInput", () => {
  it("names unknown fields", () => {
    expect(() => parseInput(VariablePatchSchema.strict(), { nope: 1 })).toThrow(new InventoryError("Feld nicht erlaubt: nope"));
  });
  it("names the root when the input is no object", () => {
    expect(() => parseInput(VariablePatchSchema, "text")).toThrow(/^\(Wurzel\): /);
  });
  it("names the path of an invalid field", () => {
    expect(() => parseInput(VariablePatchSchema, { owner: "x".repeat(81) })).toThrow(/^owner: /);
  });
});

describe("place errors", () => {
  const repoPlace: Place = { repo: "web", scope: "repository" };
  const envPlace: Place = { repo: "web", scope: "environment", environment: "staging" };
  const workerPlace: Place = { scope: "cloudflare-worker", accountId: "a".repeat(32), script: "portal" };

  it("placeErrorStatus reads the status of GitHub and Worker errors and gives 0 otherwise", () => {
    expect(placeErrorStatus(new GitHubError(404, "x"))).toBe(404);
    expect(placeErrorStatus(new WorkerSecretsError(403, "x"))).toBe(403);
    expect(placeErrorStatus(new Error("x"))).toBe(0);
    expect(placeErrorStatus("x")).toBe(0);
  });

  it("errorMatchesPlace compares store identity", () => {
    const e = { repo: "web", scope: "environment" as const, environment: "staging", status: 500, message: "" };
    expect(errorMatchesPlace(e, envPlace)).toBe(true);
    expect(errorMatchesPlace(e, { ...envPlace, environment: "production" })).toBe(false);
    expect(errorMatchesPlace(e, { ...envPlace, repo: "api" })).toBe(false);
    expect(errorMatchesPlace(e, repoPlace)).toBe(false);
    expect(errorMatchesPlace({ ...e, scope: "repository" as const, environment: undefined as never }, repoPlace)).toBe(true);
    const w = { repo: "", scope: "cloudflare-worker" as const, accountId: workerPlace.scope === "cloudflare-worker" ? workerPlace.accountId : "", script: "portal", status: 500, message: "" };
    expect(errorMatchesPlace(w, workerPlace)).toBe(true);
    expect(errorMatchesPlace({ ...w, script: "other" }, workerPlace)).toBe(false);
    expect(errorMatchesPlace({ ...w, accountId: "b".repeat(32) }, workerPlace)).toBe(false);
    expect(errorMatchesPlace(e, workerPlace)).toBe(false);
  });

  it("snapshotPlaces reports unreadable stores (repository, environment, Worker, non-Error) and skips 404", async () => {
    const failures: Record<string, unknown> = { web: new GitHubError(403, "forbidden"), api: "plain string", gone: new GitHubError(404, "missing") };
    const clients = {
      owner: "acme",
      github: {
        listSecrets: async (t: { repo: string; environment?: string }) => {
          if (t.repo === "ok") return [{ name: "A", updatedAt: "2026-03-01T00:00:00Z" }, { name: "B" }];
          throw failures[t.repo];
        },
      },
      workers: { listSecretNames: async () => { throw new WorkerSecretsError(500, "cloudflare down"); } },
    };
    const places: Place[] = [{ repo: "ok", scope: "repository" }, { repo: "web", scope: "repository" }, { repo: "web", scope: "repository" }, { repo: "api", scope: "environment", environment: "staging" }, { repo: "gone", scope: "repository" }, workerPlace];
    const { snapshot, errors } = await snapshotPlaces(clients as never, places);
    expect([...snapshot.values()]).toEqual([{ name: "A", updatedAt: "2026-03-01T00:00:00Z" }, { name: "B", updatedAt: "" }]);
    expect(errors).toEqual([
      { repo: "web", scope: "repository", status: 403, message: "forbidden" },
      { repo: "api", scope: "environment", environment: "staging", status: 0, message: "plain string" },
      { repo: "", scope: "cloudflare-worker", accountId: "a".repeat(32), script: "portal", status: 500, message: "cloudflare down" },
    ]);
  });
});

describe("small helpers", () => {
  it("ProviderRegistry lists the registered providers", () => {
    const registry = new ProviderRegistry().register({ id: "a", label: "A", kind: "manual" } as never).register({ id: "b", label: "B", kind: "manual" } as never);
    expect(registry.list().map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("SecretValue.from wraps a value", () => {
    expect(SecretValue.from("made-up").reveal()).toBe("made-up");
  });
  it("stageIds and stageTone", () => {
    const defs = [{ id: "dev", kind: "dev" as const }, { id: "qa", kind: "test" as const, tone: "warn" as const }];
    expect(stageIds(defs as never)).toEqual(["dev", "qa"]);
    expect(stageTone(defs as never, "qa")).toBe("warn");
    expect(stageTone(defs as never, "dev")).toBe("info");
    expect(stageTone(defs as never, "nope")).toBe("neutral");
  });
  it("hashOf treats an undefined value like null", () => {
    expect(hashOf(undefined)).toBe(hashOf(null));
  });
});

describe("approval snapshots", () => {
  const base = { id: "s1", name: "API_KEY", stage: "production", service: "x", provider: "manual", expiry: "none", params: {} } as unknown as SecretEntry;
  it("describes every kind of place for the human and carries the time to live when there is one", () => {
    const snap = secretApprovalSnapshot({
      ...base,
      ttlDays: 30,
      places: [
        { repo: "web", scope: "environment", environment: "production", name: "API" },
        { repo: "web", scope: "environment" },
        { repo: "acme", scope: "organization" },
        { repo: "web", scope: "repository" },
        { scope: "cloudflare-worker", accountId: "acc", script: "portal", name: "KEY" },
        { scope: "cloudflare-worker", accountId: "acc", script: "portal" },
      ],
    } as never);
    expect(snap.view.ttlDays).toBe(30);
    expect(snap.view.places).toEqual([
      "web (environment production) als API",
      "web (environment ?)",
      "acme (organization)",
      "web (repository)",
      "Cloudflare Worker portal (acc) als KEY",
      "Cloudflare Worker portal (acc)",
    ]);
  });
  it("a secret without a time to live shows null; the hash changes when a place changes", () => {
    const a = secretApprovalSnapshot({ ...base, places: [{ repo: "web", scope: "repository" }] } as never);
    const b = secretApprovalSnapshot({ ...base, places: [{ repo: "api", scope: "repository" }] } as never);
    expect(a.view.ttlDays).toBeNull();
    expect(a.hash).not.toBe(b.hash);
  });
  it("variable snapshots show the target value", () => {
    const snap = variableApprovalSnapshot({ id: "v1", name: "SITE_URL", value: null, stage: "staging", places: [{ repo: "web", scope: "repository" }] } as never);
    expect(snap.view).toMatchObject({ variable: "v1", value: null, places: ["web (repository)"] });
  });
});

describe("status", () => {
  const secret = (over: Record<string, unknown>) => ({ id: "s1", name: "API_KEY", stage: "production", service: "x", provider: "manual", expiry: "none", places: [{ repo: "web", scope: "repository" }], ...over }) as unknown as SecretEntry;
  const inventory = (secrets: SecretEntry[], thresholds: number[] = [30, 14, 7]) => ({ secrets, thresholds }) as unknown as Inventory;
  const today = new Date("2026-03-01T12:00:00Z");

  it("without thresholds the defaults 30 and 7 apply", () => {
    expect(computeStatus(secret({ expires: "2026-03-05" }), today, { thresholds: [] }).status).toBe("due");
    expect(computeStatus(secret({ expires: "2026-03-25" }), today, { thresholds: [] }).status).toBe("soon");
  });

  it("a place of an organization or an environment is looked up by its own key", () => {
    const live = new Map();
    const r = computeStatus(secret({ places: [{ repo: "acme", scope: "organization" }, { repo: "web", scope: "environment", environment: "staging" }] }), today, { live, owner: "acme" });
    expect(r.missingPlaces).toHaveLength(2);
  });

  it("findings: expired, soon, due, a required date that is missing, and the place text for every scope", () => {
    const list = findings(
      inventory([
        secret({ id: "gone", name: "GONE", expires: "2026-02-01", places: [{ repo: "web", scope: "environment", environment: "staging" }, { scope: "cloudflare-worker", accountId: "a", script: "portal" }] }),
        secret({ id: "due", name: "DUE", expires: "2026-03-05" }),
        secret({ id: "soon", name: "SOON", expires: "2026-03-20" }),
        secret({ id: "nodate", name: "NODATE", expiry: "required" }),
        secret({ id: "bare", name: "BARE", expires: "2026-02-01", places: [] }),
      ]),
      today,
    );
    expect(list.map((f) => [f.id, f.level])).toEqual([["gone", "expired"], ["due", "due"], ["soon", "soon"], ["nodate", "no-date"], ["bare", "expired"]]);
    expect(list[0]!.text).toContain("Betrifft: web/staging, worker:portal");
    expect(list[4]!.text).toContain("Betrifft: -");
    expect(list[3]!.text).toContain("Anbieter erzwingt ein Ablaufdatum");
  });

  it("findings without any threshold report no upcoming expiry", () => {
    expect(findings(inventory([secret({ expires: "2026-03-05" })], []), today)).toEqual([]);
  });
});

describe("stripe accounts", () => {
  it("lists accounts whatever the order the modes were connected in", async () => {
    const a = new ConnectionStore();
    a.session.set("stripe:acct_A:live", "k");
    a.session.set("stripe:acct_A:sandbox", "k");
    const b = new ConnectionStore();
    b.session.set("stripe:acct_A:sandbox", "k");
    b.session.set("stripe:acct_A:live", "k");
    expect((await listStripeAccounts(a))[0]!.modes).toEqual(["sandbox", "live"]);
    expect((await listStripeAccounts(b))[0]!.modes).toEqual(["sandbox", "live"]);
  });

  it("an unreadable label store gives no label", async () => {
    const vault = { get: async () => { throw new Error("vault locked"); } };
    const store = new ConnectionStore({ vault: vault as never });
    expect(await readConnectionLabel(store, "stripe:acct_A:live")).toBeUndefined();
  });

  it("deleting a label survives a vault that refuses", async () => {
    const vault = { delete: async () => { throw new Error("vault locked"); } };
    const store = new ConnectionStore({ vault: vault as never });
    await expect(deleteConnectionLabel(store, "stripe:acct_A:live")).resolves.toBeUndefined();
  });

  it("a label can be written through the vault", async () => {
    const set: unknown[][] = [];
    const store = new ConnectionStore({ vault: { set: async (...a: unknown[]) => void set.push(a) } as never });
    await writeConnectionLabel(store, "stripe:acct_A:live", "Acme");
    expect(set).toEqual([["stripe:acct_A:live#label", "Acme", null]]);
    void SecretVault;
  });

  it("a key carries its account when the key body starts with the account id", () => {
    const tail = "AbCdEfGhIjKl";
    const key = ["rk", "test", `51${tail}Zz9`].join("_");
    expect(stripeKeyCarriesAccount(key, `acct_1${tail}`)).toBe(true);
    expect(stripeKeyCarriesAccount(key, "acct_1Other0000000")).toBe(false);
    expect(stripeKeyCarriesAccount(key, "acct_1Short")).toBe(false);
    expect(stripeKeyCarriesAccount(key, "not-an-account")).toBe(false);
    expect(stripeKeyCarriesAccount("not-a-key", `acct_1${tail}`)).toBe(false);
  });
});
