import { describe, expect, it, vi } from "vitest";

// playwright-core is an optional dependency: with it missing, the driver and the availability check say so.
vi.mock("playwright-core", () => {
  throw new Error("Cannot find module 'playwright-core'");
});

const { PlaywrightDriver, playwrightAvailable } = await import("../src/index.js");

describe("without playwright-core", () => {
  it("open() explains how to install it", async () => {
    await expect(new PlaywrightDriver().open()).rejects.toThrow("playwright-core ist nicht installiert (pnpm install, optionale Abhaengigkeit).");
  });
  it("playwrightAvailable() is false", async () => {
    expect(await playwrightAvailable()).toBe(false);
  });
});
