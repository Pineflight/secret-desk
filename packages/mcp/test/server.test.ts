import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { DeskApiError, DeskClient } from "../src/client.js";
import { packageVersion, createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

type Call = [string, string, unknown];

/** Fake client: records every request, answers with `answer(call)`. */
function fakeClient(answer: (call: Call) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      const call: Call = [method, path, body];
      calls.push(call);
      return answer(call);
    },
  } as unknown as DeskClient;
  return { client, calls };
}

async function connect(client: DeskClient) {
  const server = createServer(client);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

const text = (res: unknown): string => ((res as { content: { text: string }[] }).content[0]!).text;

/** One call per tool: [tool name, arguments, expected [method, path, body]]. */
const CASES: [string, Record<string, unknown>, Call][] = [
  ["desk_overview", {}, ["GET", "/overview", undefined]],
  ["desk_list_stages", {}, ["GET", "/stages", undefined]],
  ["desk_compare_stages", { live: true }, ["GET", "/compare?live=1", undefined]],
  ["desk_list_secrets", { stage: "dev", repo: "web", q: "key" }, ["GET", "/secrets?stage=dev&repo=web&q=key", undefined]],
  ["desk_get_secret", { id: "a/b" }, ["GET", "/secrets/a%2Fb", undefined]],
  ["desk_add_secret", { id: "web-key", name: "WEB_KEY", service: "web", stage: "dev" }, ["POST", "/secrets", { id: "web-key", name: "WEB_KEY", service: "web", stage: "dev" }]],
  ["desk_update_secret", { id: "web-key", notes: "n" }, ["PATCH", "/secrets/web-key", { notes: "n" }]],
  ["desk_list_providers", {}, ["GET", "/providers", undefined]],
  ["desk_list_connections", {}, ["GET", "/connections", undefined]],
  ["desk_add_provider", { id: "acme", label: "Acme", url: "https://acme.test/tokens" }, ["POST", "/providers", { id: "acme", label: "Acme", url: "https://acme.test/tokens" }]],
  [
    "desk_add_env_template",
    { id: "web-dev", repo: "web", entries: [{ key: "SITE_URL", from: { type: "default", value: "http://localhost" } }] },
    ["POST", "/env-templates", { id: "web-dev", repo: "web", entries: [{ key: "SITE_URL", from: { type: "default", value: "http://localhost" } }] }],
  ],
  ["desk_add_env_entry", { template: "web dev", key: "A", from: { type: "prompt" } }, ["POST", "/env-templates/web%20dev/entries", { key: "A", from: { type: "prompt" } }]],
  ["desk_request_renewal", { secretId: "web-key", dryRun: true }, ["POST", "/renewal-requests", { secretId: "web-key", dryRun: true }]],
  ["desk_list_reviews", {}, ["GET", "/reviews", undefined]],
  ["desk_list_evidence", { secretId: "web key" }, ["GET", "/evidence/web%20key", undefined]],
  ["desk_list_variables", { repo: "web" }, ["GET", "/variables?repo=web", undefined]],
  ["desk_variable_status", { id: "v1" }, ["GET", "/variables/v1/status", undefined]],
  [
    "desk_add_variable",
    { id: "v1", name: "V_ONE", stage: "dev", places: [{ repo: "web", scope: "repository" }] },
    ["POST", "/variables", { id: "v1", name: "V_ONE", stage: "dev", places: [{ repo: "web", scope: "repository" }] }],
  ],
  ["desk_set_variable_value", { id: "v1", value: "x" }, ["PATCH", "/variables/v1", { value: "x" }]],
  ["desk_update_variable_meta", { id: "v1", owner: "me" }, ["PATCH", "/variables/v1", { owner: "me" }]],
  ["desk_apply_variable", { id: "v1", reason: "r" }, ["POST", "/variables/v1/apply", { reason: "r" }]],
  ["desk_get_approval", { id: "ap1" }, ["GET", "/approvals/ap1", undefined]],
  ["desk_export_dev_env", { repo: "web", path: "/work/.env" }, ["POST", "/env-export", { repo: "web", path: "/work/.env" }]],
  ["desk_team_export", {}, ["GET", "/team-export", undefined]],
];

describe("MCP server", () => {
  it("has a test case for every registered tool except desk_env_export (own test file)", () => {
    const covered = new Set(CASES.map((c) => c[0]));
    expect(TOOLS.map((t) => t.name).filter((n) => !covered.has(n))).toEqual(["desk_env_export"]);
  });

  it("lists every tool with its description", async () => {
    const mcp = await connect(fakeClient().client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.every((t) => t.description)).toBe(true);
  });

  it.each(CASES)("%s forwards to the portal and returns the JSON answer", async (name, args, expected) => {
    const { client, calls } = fakeClient(() => ({ answer: name }));
    const mcp = await connect(client);
    const res = await mcp.callTool({ name, arguments: args });
    expect(calls).toEqual([expected]);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ answer: name });
  });

  it("returns string results (team export YAML) unchanged", async () => {
    const mcp = await connect(fakeClient(() => "stages: []\n").client);
    expect(text(await mcp.callTool({ name: "desk_team_export", arguments: {} }))).toBe("stages: []\n");
  });

  it("desk_env_export asks the portal for a preview and returns no content", async () => {
    const { client, calls } = fakeClient(() => ({ repo: "web", stage: "dev", format: "dotenv", filename: ".env", content: "A=made-up", keys: ["A"], missing: [] }));
    const mcp = await connect(client);
    const res = await mcp.callTool({ name: "desk_env_export", arguments: { repo: "web" } });
    expect(calls).toEqual([["POST", "/env/export", { repo: "web", stage: "dev", format: "dotenv", include: "variables" }]]);
    expect(text(res)).not.toContain("made-up");
    expect(JSON.parse(text(res))).toMatchObject({ status: "preview", keys: ["A"] });
  });

  it("reports a portal error with its HTTP status as tool error", async () => {
    const failing = { request: async () => { throw new DeskApiError(403, "policy denies this"); } } as unknown as DeskClient;
    const res = await (await connect(failing)).callTool({ name: "desk_overview", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("policy denies this (HTTP 403)");
  });

  it("omits the HTTP suffix when the status is 0 (portal unreachable)", async () => {
    const failing = { request: async () => { throw new DeskApiError(0, "Portal nicht erreichbar"); } } as unknown as DeskClient;
    const res = await (await connect(failing)).callTool({ name: "desk_overview", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Portal nicht erreichbar");
  });

  it("reports any other error by its message", async () => {
    const failing = { request: async () => { throw new Error("boom"); } } as unknown as DeskClient;
    const res = await (await connect(failing)).callTool({ name: "desk_overview", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("boom");
  });

  it("builds a default client when none is passed", () => {
    expect(createServer()).toBeDefined();
  });

  it("reads the package version", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
