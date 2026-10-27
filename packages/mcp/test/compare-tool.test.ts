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
  it("ist ein reines Lesewerkzeug", async () => {
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["compare", "kinds", "live", "normalize", "repo"]);
    expect(await call({})).toEqual(["GET /compare"]);
  });
  it("gibt die Optionen als Query weiter", async () => {
    expect(await call({ live: true, compare: ["staging", "production"], kinds: ["secret"], repo: "web", normalize: true })).toEqual(["GET /compare?live=1&compare=staging%2Cproduction&kinds=secret&repo=web&normalize=1"]);
    expect(await call({ live: false, normalize: false })).toEqual(["GET /compare"]);
  });
});
