import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryVaultStore } from "../src/vault-core.js";
import { FileVaultStore } from "../src/vault-file-store.js";
import { vaultStoreContract } from "../src/testing/vault-store-contract.js";

// One suite (exported as `@secret-desk/core/testing`), two stores. Corrupt-file handling is specific to the file store
// and stays in vault-file-store.test.ts.
const framework = { describe, it, expect };

vaultStoreContract(framework, "FileVaultStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sd-vault-contract-"));
  return { store: new FileVaultStore(join(dir, "nested", "vault.json")), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

vaultStoreContract(framework, "MemoryVaultStore", () => ({ store: new MemoryVaultStore() }));
