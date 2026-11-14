import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Importing the driver module must not look up the home folder; only calling `defaultProfileDir()` does.
const home = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return {
    ...real,
    homedir: () => {
      home.calls++;
      return "/made-up-home";
    },
  };
});

describe("default browser profile folder", () => {
  it("does not read the home folder when the module is imported", async () => {
    vi.resetModules();
    home.calls = 0;
    const driver = await import("../src/playwright-driver.js");
    expect(home.calls).toBe(0);
    expect("DEFAULT_PROFILE_DIR" in driver).toBe(false);
    expect(driver.defaultProfileDir()).toBe(join("/made-up-home", ".secret-desk", "browser-profile"));
    expect(home.calls).toBe(1);
  });
});
