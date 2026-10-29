import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("version and about", () => {
  it("--version, -v and version print only the version", async () => {
    for (const flag of ["--version", "-v", "version"]) {
      const r = await run(flag);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^\d+\.\d+\.\d+/);
      expect(r.out).not.toContain("\n");
    }
  });
  it("about names the version, the creator, the license and the source", async () => {
    const r = await run("about");
    expect(r.code).toBe(0);
    expect(r.out).toContain("secret-desk");
    expect(r.out).toContain("Pineflight");
    expect(r.out).toContain("MIT");
    expect(r.out).toContain("https://github.com/Pineflight/secret-desk");
    expect(r.out).toMatch(/\d+ Komponenten/);
  });
  it("the help lists about", async () => {
    expect((await run("hilfe-gibts-nicht")).err + (await run("hilfe-gibts-nicht")).out).toContain("about");
  });
});
