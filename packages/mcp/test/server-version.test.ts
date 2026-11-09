import { describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({ content: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (fsState.content === null) throw new Error("unreadable");
      void args;
      return fsState.content;
    }) as typeof actual.readFileSync,
  };
});

import { packageVersion } from "../src/server.js";

describe("packageVersion", () => {
  it("returns the version from package.json", () => {
    fsState.content = '{"version":"9.8.7"}';
    expect(packageVersion()).toBe("9.8.7");
  });
  it("falls back to 0.0.0 when package.json has no version", () => {
    fsState.content = "{}";
    expect(packageVersion()).toBe("0.0.0");
  });
  it("falls back to 0.0.0 when package.json cannot be read", () => {
    fsState.content = null;
    expect(packageVersion()).toBe("0.0.0");
  });
});
