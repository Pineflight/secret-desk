import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentTokenPath } from "../src/server/security.js";

describe("agent token path", () => {
  it("is built from the home folder it is given", () => {
    expect(agentTokenPath(join("/made-up-home"))).toBe(join("/made-up-home", ".secret-desk", "agent-token"));
  });

  it("is refused when the host reports no home folder, instead of falling back to the home of the process", () => {
    expect(() => agentTokenPath(undefined)).toThrow(/home folder/);
    expect(() => agentTokenPath("")).toThrow(/home folder/);
  });

  it("the security module does not look up the home folder itself", async () => {
    const text = await readFile(fileURLToPath(new URL("../src/server/security.ts", import.meta.url)), "utf8");
    expect(text).not.toMatch(/homedir|node:os/);
  });
});
