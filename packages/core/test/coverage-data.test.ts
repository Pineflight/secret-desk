import { describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  InventorySchema,
  InventoryStore,
  SecretValue,
  TeamBundleError,
  VariableError,
  VariableSourceSchema,
  WorkerSecretsClient,
  WorkerSecretsError,
  adoptVariable,
  applyVariable,
  findings,
  inspectVariable,
  mergeTeamBundle,
  parseTeamBundle,
  renderEvidenceSvg,
  MAX_TEAM_FILE_BYTES,
} from "../src/index.js";
import type { VariableEntry, VerificationReport } from "../src/index.js";

describe("team bundle", () => {
  it("refuses a file above the size limit before parsing it", () => {
    expect(() => parseTeamBundle("#".repeat(MAX_TEAM_FILE_BYTES + 1))).toThrow(new TeamBundleError("Team-Datei ist groesser als 1 MiB: wird nicht gelesen."));
  });
  it("reports invalid YAML", () => {
    expect(() => parseTeamBundle("version: [1\n")).toThrow(/^Ungueltiges YAML: /);
  });
  it("reports every schema problem with its path", () => {
    expect(() => parseTeamBundle("version: 2\nsecrets: nope\n")).toThrow(/version.*; secrets/);
  });

  const BUNDLE = `version: 1
stages:
  - { id: qa, kind: test }
variables:
  - { id: site-url, name: SITE_URL, stage: qa, value: "https://qa.example.com", places: [{ repo: web, scope: repository }] }
providers:
  - { id: acme, label: Acme, url: "https://acme.example.com/tokens", steps: [Open] }
resourceMap:
  - { kind: supabase.project, repo: web, value: ref-1 }
  - { kind: supabase.project, repo: web, stage: qa, value: ref-2 }
`;

  it("merge adds new variables, providers and mappings, and leaves existing ones as they are", () => {
    const store = InventoryStore.fromText("version: 1\n");
    const first = mergeTeamBundle(store, parseTeamBundle(BUNDLE));
    expect(first.addedStages).toEqual(["qa"]);
    expect(store.getVariable("site-url")).toBeDefined();
    expect(store.data.providers.map((p) => p.id)).toEqual(["acme"]);
    expect(store.data.resourceMap).toHaveLength(2);
    // The same bundle again changes nothing.
    mergeTeamBundle(store, parseTeamBundle(BUNDLE));
    expect(store.data.variables).toHaveLength(1);
    expect(store.data.providers).toHaveLength(1);
    expect(store.data.resourceMap).toHaveLength(2);
  });

  it("replace keeps the local runtime fields of known secrets and takes new secrets as they are", () => {
    const local = InventoryStore.fromText("version: 1\nsecrets:\n  - { id: s1, name: S_ONE, stage: shared, service: x, provider: manual, expiry: none, externalId: local-id, places: [{ repo: web, scope: repository }] }\n");
    const bundle = parseTeamBundle("version: 1\nsecrets:\n  - { id: s1, name: S_ONE, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }] }\n  - { id: s2, name: S_TWO, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }] }\n");
    const r = mergeTeamBundle(local, bundle, "replace");
    expect(r.added).toEqual(["s1", "s2"]);
    expect(local.getSecret("s1")!.externalId).toBe("local-id");
    expect(local.getSecret("s2")).toBeDefined();
  });
});

describe("inventory schema issues", () => {
  const issues = (yaml: Record<string, unknown>) => {
    const r = InventorySchema.safeParse({ version: 1, ...yaml });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const secret = (over: Record<string, unknown> = {}) => ({ id: "s1", name: "S_ONE", stage: "shared", service: "x", provider: "manual", expiry: "none", places: [{ repo: "web", scope: "repository" }], ...over });

  it("flags a duplicate secret id", () => {
    expect(issues({ secrets: [secret(), secret()] })).toContain("secrets.1.id: id doppelt: s1");
  });
  it("flags an environment place without a name on a stage that has no environment", () => {
    expect(issues({ secrets: [secret({ places: [{ repo: "web", scope: "environment" }] })] }).join("\n")).toContain("hat keine GitHub-Environment");
  });
  it("flags a variable on an unknown stage without a second place error", () => {
    const list = issues({ variables: [{ id: "v1", name: "V_ONE", stage: "nowhere", places: [{ repo: "web", scope: "repository" }] }] });
    expect(list).toEqual(["variables.0.stage: Unbekannte Stage: nowhere"]);
  });
  it("flags a variable id that a secret already uses", () => {
    expect(issues({ secrets: [secret()], variables: [{ id: "s1", name: "V_ONE", stage: "shared", places: [{ repo: "web", scope: "repository" }] }] })).toContain("variables.0.id: id doppelt: s1");
  });
});

describe("variable sources", () => {
  const parse = (v: unknown) => {
    const r = VariableSourceSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  it("rejects an unknown kind", () => {
    expect(parse({ connection: "x", kind: "nope.thing", resource: "r", field: "url" })).toEqual(["kind: Unbekannte Quelle: nope.thing"]);
  });
  it("rejects a connection that does not own the kind, and a field the kind does not offer", () => {
    const ok = parse({ connection: "supabase", kind: "supabase.project", resource: "ref", field: "url" });
    expect(ok.join()).not.toContain("kind:");
    expect(parse({ connection: "cloudflare", kind: "supabase.project", resource: "ref", field: "url" })).toEqual(["connection: Die Quelle supabase.project gehoert zur Verbindung supabase"]);
    expect(parse({ connection: "supabase", kind: "supabase.project", resource: "ref", field: "no-such-field" })).toEqual(["field: Feld nicht erlaubt: no-such-field"]);
  });
});

describe("variable drift and apply", () => {
  const variable = (over: Partial<VariableEntry> = {}): VariableEntry => ({ id: "v1", name: "SITE_URL", stage: "staging", value: "https://a.example.com", places: [{ repo: "web", scope: "repository" }], ...over }) as VariableEntry;
  const github = (lists: Record<string, unknown>) => ({
    listVariables: vi.fn(async (t: { repo: string }) => {
      const v = lists[t.repo];
      if (v instanceof Error || typeof v === "string") throw v;
      return v ?? [];
    }),
    putVariable: vi.fn(async (_t: unknown, name: string) => (name === "BOOM" ? Promise.reject(new Error("write refused")) : "updated")),
  });

  it("marks places whose listing fails as unreachable, with the status of a GitHub error; the listing is read once per store", async () => {
    const gh = github({ web: new GitHubError(403, "forbidden"), api: "plain failure" });
    const drift = await inspectVariable(gh as never, "acme", variable({ places: [{ repo: "web", scope: "repository" }, { repo: "web", scope: "repository", name: "OTHER" }, { repo: "api", scope: "organization" }, { repo: "api", scope: "environment", environment: "staging" }] }));
    expect(drift.map((d) => [d.placeLabel, d.state, (d as { error?: string }).error, (d as { errorStatus?: number }).errorStatus])).toEqual([
      ["web/repo", "unreachable", "forbidden", 403],
      ["web/repo", "unreachable", "forbidden", 403],
      ["api/org", "unreachable", "plain failure", undefined],
      ["api/env:staging", "unreachable", "plain failure", undefined],
    ]);
    expect(gh.listVariables).toHaveBeenCalledTimes(3);
  });

  it("compares the target value: missing, unknown-expected, in-sync, different", async () => {
    const gh = github({ web: [{ name: "SITE_URL", value: "https://a.example.com", updatedAt: "t" }] });
    expect((await inspectVariable(gh as never, "acme", variable()))[0]).toMatchObject({ state: "in-sync", actual: "https://a.example.com", updatedAt: "t" });
    expect((await inspectVariable(gh as never, "acme", variable({ value: "https://b.example.com" })))[0]!.state).toBe("different");
    expect((await inspectVariable(gh as never, "acme", variable({ value: null })))[0]!.state).toBe("unknown-expected");
    expect((await inspectVariable(gh as never, "acme", variable({ name: "OTHER" })))[0]).toMatchObject({ state: "missing", actual: null, updatedAt: null });
  });

  it("apply leaves a variable that is in sync alone and reports a write that fails", async () => {
    const gh = github({ web: [{ name: "SITE_URL", value: "https://a.example.com", updatedAt: "t" }], api: [] });
    const out = await applyVariable(gh as never, "acme", variable({ places: [{ repo: "web", scope: "repository" }, { repo: "api", scope: "repository" }, { repo: "api", scope: "repository", name: "BOOM" }] }));
    expect(out).toEqual([
      { place: "web/repo", outcome: "unchanged" },
      { place: "api/repo", outcome: "updated" },
      { place: "api/repo", outcome: "failed", error: "write refused" },
    ]);
  });

  it("apply needs a target value", async () => {
    await expect(applyVariable(github({}) as never, "acme", variable({ value: null }))).rejects.toThrow(VariableError);
  });

  describe("adopt", () => {
    const store = () => InventoryStore.fromText("version: 1\nvariables:\n  - { id: v1, name: SITE_URL, stage: staging, value: null, places: [{ repo: web, scope: repository }, { repo: api, scope: repository }] }\n");
    it("fails for an unknown variable", async () => {
      await expect(adoptVariable(github({}) as never, "acme", store(), "nope")).rejects.toThrow("Variable nicht gefunden: nope");
    });
    it("fails when it is set nowhere", async () => {
      await expect(adoptVariable(github({}) as never, "acme", store(), "v1")).rejects.toThrow("In GitHub ist die Variable nirgends gesetzt.");
    });
    it("fails when the targets differ", async () => {
      const gh = github({ web: [{ name: "SITE_URL", value: "a", updatedAt: "t" }], api: [{ name: "SITE_URL", value: "b", updatedAt: "t" }] });
      await expect(adoptVariable(gh as never, "acme", store(), "v1")).rejects.toThrow("unterschiedliche Werte");
    });
    it("takes the common value as the target value", async () => {
      const gh = github({ web: [{ name: "SITE_URL", value: "https://a.example.com", updatedAt: "t" }] });
      const s = store();
      expect((await adoptVariable(gh as never, "acme", s, "v1")).value).toBe("https://a.example.com");
    });
  });
});

describe("evidence SVG", () => {
  const base = { id: "r1", secretId: "s1", secretName: "S_ONE", createdAt: "2026-03-01T10:00:00Z", kind: "issued", provider: "p", stage: "production", label: "label", targets: [], checks: [], attachments: [], fingerprint: "ab:cd" } as unknown as VerificationReport;

  it("shows the minimum: no external id, no expiry, no targets, no checks", () => {
    const svg = renderEvidenceSvg(base);
    expect(svg).toContain("nie / nicht bekannt");
    expect(svg).toContain(">keine<");
    expect(svg).not.toContain("Kennung");
    expect(svg).not.toContain("Bestaetigt");
  });

  it("shows external id, expiry, targets, long values shortened and checks with and without details", () => {
    const svg = renderEvidenceSvg({
      ...base,
      externalId: "ext-1",
      expiresAt: "2026-06-01T00:00:00Z",
      targets: ["web", "api"],
      label: "x".repeat(100),
      checks: [
        { id: "a", label: "plain", status: "pass" },
        { id: "b", label: "detailed", status: "warn", expected: "e", actual: "a", detail: "d" },
        { id: "c", label: "long", status: "fail", detail: "y".repeat(200) },
        { id: "d", label: "info", status: "info" },
      ],
    } as never);
    expect(svg).toContain("Kennung");
    expect(svg).toContain("2026-06-01");
    expect(svg).toContain("web, api");
    expect(svg).toContain(`${"x".repeat(75)}...`);
    expect(svg).toContain("erwartet: e   gefunden: a   d");
    expect(svg).toContain(`${"y".repeat(107)}...`);
    expect(svg).toContain("fehlgeschlagen");
  });

  it("states the overall result: passed, with notes, failed", () => {
    expect(renderEvidenceSvg({ ...base, checks: [{ id: "a", label: "a", status: "pass" }] } as never)).toContain(">bestanden<");
    expect(renderEvidenceSvg({ ...base, checks: [{ id: "a", label: "a", status: "warn" }] } as never)).toContain(">mit Hinweisen<");
    expect(renderEvidenceSvg({ ...base, checks: [{ id: "a", label: "a", status: "fail" }] } as never)).toContain(">fehlgeschlagen<");
  });

  it("renders the fixed texts in English on request and keeps German as the default", () => {
    const full = {
      ...base,
      externalId: "ext-1",
      expiresAt: "2026-06-01T00:00:00Z",
      targets: ["web"],
      checks: [{ id: "b", label: "Name present", status: "warn", expected: "e", actual: "a", detail: "d" }],
      confirmation: { by: "alice", at: "2026-03-01T10:20:30Z", ticks: [], decision: "confirmed" },
    } as never;
    const en = renderEvidenceSvg(full, "en");
    for (const text of ["Evidence sheet", "Evidence ", ">with notes<", ">Secret<", ">Provider<", ">Name at the provider<", ">Identifier<", ">Expires<", ">Targets<", ">Fingerprint<", ">Created<", "Automatic checks", "expected: e   found: a   d", "Confirmed by alice on 2026-03-01 10:20"]) expect(en).toContain(text);
    for (const text of ["Pruefbeleg", "Anbieter", "Kennung", "Laeuft ab", "Ziele", "Fingerabdruck", "Erstellt", "Automatische", "erwartet", "gefunden", "Bestaetigt", "mit Hinweisen"]) expect(en).not.toContain(text);
    expect(renderEvidenceSvg(base, "en")).toContain("never / not known");
    expect(renderEvidenceSvg(base, "en")).toContain(">none<");
    expect(renderEvidenceSvg({ ...base, checks: [{ id: "a", label: "a", status: "pass" }] } as never, "en")).toContain(">passed<");
    expect(renderEvidenceSvg({ ...base, checks: [{ id: "a", label: "a", status: "fail" }], confirmation: { by: "me", at: "2026-03-01T10:20:30Z", ticks: [], decision: "rejected" } } as never, "en")).toMatch(/>failed<[\s\S]*Rejected by me on/);
    // Data stays data: fingerprint, name, dates; and no value text can appear because none is ever passed in.
    expect(en).toContain("ab:cd");
    expect(en).toContain("S_ONE (s1)");
    expect(en).toContain("2026-06-01");
    expect(renderEvidenceSvg(full)).toBe(renderEvidenceSvg(full, "de"));
    expect(renderEvidenceSvg(full)).toContain("Pruefbeleg");
  });

  it("shows who confirmed or rejected, and escapes the name", () => {
    const confirmed = renderEvidenceSvg({ ...base, confirmation: { by: "<reviewer>", at: "2026-03-01T10:20:30Z", ticks: [], decision: "confirmed" } } as never);
    expect(confirmed).toContain("Bestaetigt von &lt;reviewer&gt; am 2026-03-01 10:20");
    const rejected = renderEvidenceSvg({ ...base, confirmation: { by: "me", at: "2026-03-01T10:20:30Z", ticks: [], decision: "rejected" } } as never);
    expect(rejected).toContain("Abgelehnt von me");
  });
});

describe("Cloudflare Worker secrets client", () => {
  const ACCOUNT = { accountId: "acc", script: "portal" };
  const auth = async () => SecretValue.from("made-up-token");
  const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText: "Status Text" });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { result: [{ name: "A" }, { name: 5 }, null, "x"] }));
    try {
      expect(await new WorkerSecretsClient({ auth }).listSecretNames(ACCOUNT)).toEqual(["A"]);
      expect(spy.mock.calls[0]![0]).toContain("/accounts/acc/workers/scripts/portal/secrets");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an answer that is not the documented shape", async () => {
    for (const body of ["not json", { result: "no list" }, null]) {
      const client = new WorkerSecretsClient({ auth, fetch: (async () => json(200, body as never)) as never });
      await expect(client.listSecretNames(ACCOUNT)).rejects.toThrow("something unexpected for the list of Worker secrets");
      await expect(client.listScripts("acc")).rejects.toThrow("something unexpected for the list of Workers");
    }
  });

  it("lists Workers by id and ignores entries without one", async () => {
    const client = new WorkerSecretsClient({ auth, fetch: (async () => json(200, { result: [{ id: "portal" }, { id: 1 }, null] })) as never });
    expect(await client.listScripts("acc")).toEqual([{ name: "portal" }]);
  });

  describe("error text", () => {
    const failing = (status: number, body: unknown) => new WorkerSecretsClient({ auth, fetch: (async () => json(status, body as never)) as never });
    it("names Cloudflare's messages, with the code when it is a number", async () => {
      const client = failing(400, { errors: [{ code: 10007, message: "no such worker" }, { message: "second" }, { code: 1 }] });
      await expect(client.listSecretNames(ACCOUNT)).rejects.toThrow("Cloudflare GET /accounts/acc/workers/scripts/portal/secrets -> 400: no such worker (10007); second");
    });
    it("falls back to the status text without messages or without JSON", async () => {
      await expect(failing(500, { errors: [] }).listSecretNames(ACCOUNT)).rejects.toThrow(/-> 500: Status Text$/);
      await expect(failing(500, { success: false }).listSecretNames(ACCOUNT)).rejects.toThrow(/-> 500: Status Text$/);
      await expect(failing(502, "<html>").listSecretNames(ACCOUNT)).rejects.toThrow(/-> 502: Status Text$/);
    });
    it("adds a hint for 401, 403 and 404", async () => {
      await expect(failing(403, {}).listSecretNames(ACCOUNT)).rejects.toThrow("braucht das Recht Workers Scripts Write");
      await expect(failing(401, {}).listSecretNames(ACCOUNT)).rejects.toThrow("braucht das Recht Workers Scripts Write");
      await expect(failing(404, {}).listSecretNames(ACCOUNT)).rejects.toThrow("Worker nicht gefunden (Konto und Name pruefen).");
    });
    it("is a WorkerSecretsError with the status", async () => {
      await expect(failing(404, {}).check(ACCOUNT)).rejects.toBeInstanceOf(WorkerSecretsError);
    });
  });

  it("putSecret says created for a new name and updated for a known one or when the listing fails", async () => {
    const calls: string[] = [];
    let listing: () => Response = () => json(200, { result: [{ name: "KNOWN" }] });
    const client = new WorkerSecretsClient({
      auth,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return init.method === "GET" ? listing() : json(200, {});
      }) as never,
    });
    expect(await client.putSecret(ACCOUNT, "NEW", SecretValue.from("v"))).toBe("created");
    expect(await client.putSecret(ACCOUNT, "KNOWN", SecretValue.from("v"))).toBe("updated");
    listing = () => json(500, {});
    expect(await client.putSecret(ACCOUNT, "NEW", SecretValue.from("v"))).toBe("updated");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(3);
  });
});

describe("findings without places", () => {
  it("a secret that is due and has no places names no place", () => {
    const secret = { id: "s", name: "S", stage: "shared", service: "x", provider: "manual", expiry: "possible", expires: "2026-03-03", places: [] };
    const list = findings({ secrets: [secret], thresholds: [30, 14, 7] } as never, new Date("2026-03-01T00:00:00Z"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: "due" });
    expect(list[0]!.text).toContain("Betrifft: -");
  });
});
