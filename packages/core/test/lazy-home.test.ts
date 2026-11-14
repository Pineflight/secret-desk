import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Importing the vault module must not look up the home folder; only calling `defaultVaultFile()` does.
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

describe("default vault file", () => {
  it("does not read the home folder when the module is imported", async () => {
    vi.resetModules();
    home.calls = 0;
    const vault = await import("../src/vault.js");
    expect(home.calls).toBe(0);
    expect("DEFAULT_VAULT_FILE" in vault).toBe(false);
    expect(vault.defaultVaultFile()).toBe(join("/made-up-home", ".secret-desk", "vault.json"));
    expect(home.calls).toBe(1);
  });
});
