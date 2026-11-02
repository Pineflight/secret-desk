import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools.js";

describe("provider facade (guided sign-in)", () => {
  it("has no MCP tool: agents never sign in, enter codes or create integration keys", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.filter((n) => /facade|sign_?in|login|password|mfa|code/i.test(n))).toEqual([]);
    for (const t of TOOLS) {
      expect(Object.keys(t.inputSchema).filter((k) => /password|username|email|code|credential/i.test(k)), t.name).toEqual([]);
    }
  });
});
