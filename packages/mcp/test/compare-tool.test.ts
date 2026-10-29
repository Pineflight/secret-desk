import { describe, expect, it } from "vitest";
import type { DeskClient } from "../src/client.js";
import { TOOLS } from "../src/tools.js";

describe("desk_compare_stages", () => {
  const tool = TOOLS.find((t) => t.name === "desk_compare_stages")!;
  const call = async (input: Record<string, unknown>): Promise<string[]> => {
    const seen: string[] = [];
    const client = { request: async (method: string, path: string) => { seen.push(`${method} ${path}`); return {}; } } as unknown as DeskClient;
    await tool.run(client, input);
    return seen;
  };
  it("is a pure read tool", async () => {
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["all_repos", "compare", "kinds", "live", "normalize", "repo", "workflows"]);
    expect(await call({})).toEqual(["GET /compare"]);
  });
  it("passes the options on as query", async () => {
    expect(await call({ live: true, compare: ["staging", "production"], kinds: ["secret"], repo: "web", normalize: true })).toEqual(["GET /compare?live=1&compare=staging%2Cproduction&kinds=secret&repo=web&normalize=1"]);
    expect(await call({ live: false, normalize: false })).toEqual(["GET /compare"]);
    expect(await call({ live: true, all_repos: true, workflows: true })).toEqual(["GET /compare?live=1&all=1&workflows=1"]);
  });
});
