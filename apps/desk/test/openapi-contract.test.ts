import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOpenApi, openApiCandidates, openApiResponse } from "../src/server/openapi.js";
import { agentRoutes } from "../src/server/router.js";

type Operation = { operationId?: string; "x-secret-desk-status"?: string; "x-secret-desk-scope"?: string; security?: unknown[] };
type Spec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation | unknown>>;
  webhooks?: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

const ROOT = resolve(import.meta.dirname, "../../..");
const load = (rel: string): Spec => parse(readFileSync(join(ROOT, rel), "utf8")) as Spec;
const integration = load("docs/api/openapi.yaml");
const agent = load("docs/openapi-agent.yaml");

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
function operations(spec: Spec): { method: string; path: string; op: Operation }[] {
  const out: { method: string; path: string; op: Operation }[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) if (item[m]) out.push({ method: m.toUpperCase(), path, op: item[m] as Operation });
  }
  return out;
}
/** "/secrets/{id}" -> "secrets/sample-id" (the router matches paths without the /api/agent prefix). */
const concrete = (path: string): string => path.replace(/^\//, "").replace(/\{[^}]+\}/g, "sample-id");
const routed = (method: string, path: string): boolean => agentRoutes().some((r) => r.method === method && r.pattern.test(concrete(path)));

// docs/openapi-agent.yaml must describe exactly what the router serves under /api/agent, in both directions.
describe("agent OpenAPI description matches the router", () => {
  it("every documented agent operation is routed", () => {
    const missing = operations(agent).filter(({ method, path }) => !routed(method, path)).map(({ method, path }) => `${method} ${path}`);
    expect(missing).toEqual([]);
  });

  it("every agent route is documented", () => {
    const documented = operations(agent);
    const undocumented = agentRoutes()
      .filter((r) => !documented.some(({ method, path }) => method === r.method && r.pattern.test(concrete(path))))
      .map((r) => `${r.method} ${r.pattern.source}`);
    expect(undocumented).toEqual([]);
  });
});

describe("integration API description", () => {
  const ops = operations(integration);
  const SCOPES = (integration.components.schemas["Scope"] as { enum: string[] }).enum;

  it("is OpenAPI 3.1 with unique operation ids", () => {
    expect(integration.openapi).toBe("3.1.0");
    const ids = [...ops.map((o) => o.op.operationId), ...Object.values(integration.webhooks ?? {}).flatMap((w) => Object.values(w).map((o) => o.operationId))];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks every operation and webhook as implemented or planned", () => {
    for (const { op } of ops) expect(["implemented", "planned"]).toContain(op["x-secret-desk-status"]);
    for (const w of Object.values(integration.webhooks ?? {})) for (const op of Object.values(w)) expect(op["x-secret-desk-status"]).toBe("planned");
  });

  it("names a known scope for every versioned operation", () => {
    for (const { path, op } of ops) {
      if (path === "/openapi.yaml" || path === "/integration") continue;
      expect(SCOPES, `${path}`).toContain(op["x-secret-desk-scope"]);
    }
  });

  it("offers no scope that writes values, confirms or approves", () => {
    expect(SCOPES.some((s) => /write|confirm|approve|value|admin/.test(s))).toBe(false);
  });

  it("every implemented operation is served by the agent API today and described there the same way", () => {
    const implemented = ops.filter(({ op, path }) => op["x-secret-desk-status"] === "implemented" && path !== "/openapi.yaml");
    expect(implemented.length).toBeGreaterThan(10);
    const notRouted = implemented.filter(({ method, path }) => !routed(method, path)).map(({ method, path }) => `${method} ${path}`);
    expect(notRouted).toEqual([]);
    for (const { method, path, op } of implemented) {
      const twin = operations(agent).find((o) => o.method === method && o.path === path);
      expect(twin?.op.operationId, `${method} ${path}`).toBe(op.operationId);
    }
  });

  it("no implemented operation is a human-only action", () => {
    const humanOnly = /\/(confirm|reject|approve|deny|manual-value|token|adopt)$/;
    expect(ops.filter(({ path }) => humanOnly.test(path)).map(({ path }) => path)).toEqual([]);
    expect(ops.filter(({ method }) => method !== "GET" && method !== "POST")).toEqual([]);
  });

  it("planned operations are not routed yet (status stays honest)", () => {
    const planned = ops.filter(({ op }) => op["x-secret-desk-status"] === "planned");
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.filter(({ method, path }) => routed(method, path)).map(({ path }) => path)).toEqual([]);
  });

  it("shares the schemas of the agent description unchanged", () => {
    const shared = Object.keys(integration.components.schemas).filter((n) => n in agent.components.schemas && n !== "Error");
    expect(shared.length).toBeGreaterThan(5);
    for (const name of shared) expect(integration.components.schemas[name], name).toEqual(agent.components.schemas[name]);
  });

  it("no schema except variables has a plain value, token or secret field", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== "object") return;
      const props = (node as { properties?: Record<string, unknown> }).properties;
      if (props) {
        for (const [key, prop] of Object.entries(props)) {
          // A reference (e.g. secret: SecretSummary) is metadata; a plain string field with such a name could carry a value.
          const isRef = !!prop && typeof prop === "object" && "$ref" in prop;
          if (!isRef && /^(value|token|secret|signingSecret|password)$/i.test(key)) offenders.push(`${where}.${key}`);
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    };
    for (const [name, schema] of Object.entries(integration.components.schemas)) if (!name.startsWith("Variable")) walk(schema, name);
    walk(integration.webhooks, "webhooks");
    expect(offenders).toEqual([]);
  });
});

describe("serving the integration description", () => {
  it("finds docs/api/openapi.yaml from the desk working directory", async () => {
    const text = await loadOpenApi(openApiCandidates(join(ROOT, "apps/desk")), false);
    expect(text).not.toBeNull();
    expect((parse(text!) as Spec).info).toBeDefined();
  });

  it("answers YAML with nosniff", async () => {
    const res = await openApiResponse(openApiCandidates(join(ROOT, "apps/desk")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/yaml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((parse(await res.text()) as Spec).openapi).toBe("3.1.0");
  });

  it("answers 404 when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-openapi-"));
    await writeFile(join(dir, "unrelated.txt"), "x");
    const res = await openApiResponse([join(dir, "missing.yaml")]);
    expect(res.status).toBe(404);
  });
});
