import { describe, expect, it, vi } from "vitest";
import { GitHubClient, patProvider } from "../src/github.js";
import { looksSecret } from "../src/guards.js";
import { InventoryStore } from "../src/inventory.js";
import { SecretValue } from "../src/secret.js";
import { adoptVariable, applyVariable, assertPublicValue, inspectVariable, VariableError } from "../src/variables.js";

const YAML = `version: 1
variables:
  - id: site-url-staging
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-web, scope: environment, environment: staging }
      - { repo: acme-web-landing, scope: environment, environment: staging }
  - id: project-id
    name: ACME_PROJECT_ID
    stage: shared
    places:
      - { repo: acme-app, scope: repository }
`;

function client(live: Record<string, { name: string; value: string }[]>, calls: string[] = []) {
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.replace("https://api.github.com", "")}${init?.body ? ` ${init.body}` : ""}`);
    if (method === "GET") {
      const key = Object.keys(live).find((k) => u.includes(k));
      if (!key) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify({ variables: live[key]!.map((v) => ({ ...v, created_at: "c", updated_at: "u" })) }), { status: 200 });
    }
    if (method === "PATCH" && u.includes("/acme-web-landing/")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(null, { status: method === "POST" ? 201 : 204 });
  });
  return new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: f as unknown as typeof fetch });
}

describe("variables: target against actual", () => {
  it("detects in-sync, different, missing", async () => {
    const inv = InventoryStore.fromText(YAML);
    const gh = client({ "/acme-web/environments/staging": [{ name: "NEXT_PUBLIC_SITE_URL", value: "https://alt.example.com" }], "/acme-web-landing/environments/staging": [] });
    const drift = await inspectVariable(gh, "acme", inv.getVariable("site-url-staging")!);
    expect(drift.map((d) => d.state)).toEqual(["different", "missing"]);
    expect(drift[0]!.actual).toBe("https://alt.example.com");
  });
  it("sets the target value: PATCH, on 404 POST, unchanged ones are skipped", async () => {
    const calls: string[] = [];
    const inv = InventoryStore.fromText(YAML);
    const gh = client({ "/acme-web/environments/staging": [{ name: "NEXT_PUBLIC_SITE_URL", value: "https://alt.example.com" }], "/acme-web-landing/environments/staging": [] }, calls);
    const out = await applyVariable(gh, "acme", inv.getVariable("site-url-staging")!);
    expect(out.map((o) => o.outcome)).toEqual(["updated", "created"]);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/acme-web-landing/environments/staging/variables"))).toBe(true);
  });
  it("does not let unknown target values be applied, but adopts them from GitHub", async () => {
    const inv = InventoryStore.fromText(YAML);
    const gh = client({ "/acme-app/actions/variables": [{ name: "ACME_PROJECT_ID", value: "proj_123" }] });
    await expect(applyVariable(gh, "acme", inv.getVariable("project-id")!)).rejects.toThrow(/Sollwert/);
    const adopted = await adoptVariable(gh, "acme", inv, "project-id");
    expect(adopted.value).toBe("proj_123");
    expect(inv.toString()).toContain("proj_123");
  });
  it("does not adopt when the targets differ", async () => {
    const inv = InventoryStore.fromText(YAML.replace("project-id", "split").replace("{ repo: acme-app, scope: repository }", "{ repo: acme-web, scope: environment, environment: staging }\n      - { repo: acme-web-landing, scope: environment, environment: staging }"));
    const gh = client({ "/acme-web/environments/staging": [{ name: "ACME_PROJECT_ID", value: "a" }], "/acme-web-landing/environments/staging": [{ name: "ACME_PROJECT_ID", value: "b" }] });
    await expect(adoptVariable(gh, "acme", inv, "split")).rejects.toThrow(/unterschiedliche/);
  });
});

describe("protection against secrets in variables", () => {
  it("blocks unambiguous secrets", () => {
    for (const v of ["sk_live_" + "a".repeat(24), "whsec_" + "b".repeat(20), "ghp_" + "c".repeat(30), "-----BEGIN " + "PRIVATE KEY-----"]) {
      expect(looksSecret("X", v)?.level).toBe("block");
    }
    const serviceRole = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.sig`;
    expect(looksSecret("X", serviceRole)?.level).toBe("block");
  });
  it("warns on anon key, random values and suspicious names, lets normal ones through", () => {
    const anon = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.sig`;
    expect(looksSecret("SUPABASE_ANON_KEY", anon)?.level).toBe("warn");
    expect(looksSecret("X", "aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF3hJ5")?.level).toBe("warn");
    expect(looksSecret("DB_PASSWORD", "hunter2hunter2")?.level).toBe("warn");
    expect(looksSecret("NEXT_PUBLIC_SITE_URL", "https://example.com")).toBeNull();
    expect(looksSecret("PRINT_ENV", "live")).toBeNull();
  });
  it("assertPublicValue requires confirmation on warn and always blocks on block", () => {
    expect(() => assertPublicValue("DB_PASSWORD", "hunter2hunter2")).toThrow(/acknowledgedPublic/);
    expect(() => assertPublicValue("DB_PASSWORD", "hunter2hunter2", true)).not.toThrow();
    expect(() => assertPublicValue("X", "sk_test_" + "a".repeat(24), true)).toThrow(VariableError);
  });
  it("inventory rejects variables with duplicate id and knows env template references", () => {
    const inv = InventoryStore.fromText(YAML);
    expect(() => inv.addVariable({ id: "project-id", name: "X_Y", places: [{ repo: "r", scope: "repository" }] })).toThrow(/existiert/);
    inv.addEnvTemplate({ id: "ws-dev", repo: "acme-web", entries: [{ key: "NEXT_PUBLIC_SITE_URL", from: { type: "variable", variable: "site-url-staging" } }] });
    expect(() => inv.addEnvTemplate({ id: "bad", repo: "x", entries: [{ key: "A", from: { type: "variable", variable: "gibt-es-nicht" } }] })).toThrow(/unbekannte Variable/);
  });
});

describe("M5: further secret patterns", () => {
  it("blocks prefixes and connection strings with password", () => {
    const blocks = [
      "sb_secret_" + "a".repeat(20),
      "cfut_" + "a".repeat(30),
      "glsa_" + "a".repeat(30),
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "xoxb-123-456-abc",
      "xoxp-123-456-abc",
      "ghp_" + "c".repeat(36),
      "github_pat_" + "d".repeat(30),
      "postgres://user:pw@host:5432/db",
      "postgresql://user:pw@host/db",
      "mysql://root:geheim@localhost/app",
      "mongodb+srv://u:p@cluster0.example.net/db",
      "redis://default:pw@cache.example.com:6379",
    ];
    for (const v of blocks) expect(looksSecret("X", v)?.level, v).toBe("block");
  });
  it("connection string without password is no match", () => {
    expect(looksSecret("DB_URL", "postgres://host/db")).toBeNull();
    expect(looksSecret("SITE", "https://example.com/pfad")).toBeNull();
  });
  it("64-digit hex value warns", () => {
    expect(looksSecret("X", "ab".repeat(32))?.level).toBe("warn");
    expect(looksSecret("X", "ab".repeat(16))).toBeNull();
  });
  it("name rules warn for a set value from 8 characters", () => {
    for (const name of ["STRIPE_API_KEY", "SERVICE_KEY", "DB_PASSWORD", "APP_SECRET", "GH_TOKEN", "TOKEN", "PRIVATE_KEY_PEM"]) {
      expect(looksSecret(name, "irgendein-wert")?.level, name).toBe("warn");
    }
    expect(looksSecret("STRIPE_API_KEY", "kurz")).toBeNull();
    expect(looksSecret("MONKEY_NAME", "irgendein-wert")).toBeNull();
  });
  it("VariableError carries the code", () => {
    expect(() => assertPublicValue("X", "sk_live_" + "a".repeat(24))).toThrow(expect.objectContaining({ code: "secret-blocked" }));
    expect(() => assertPublicValue("DB_PASSWORD", "hunter2hunter2")).toThrow(expect.objectContaining({ code: "secret-ack" }));
  });
});
