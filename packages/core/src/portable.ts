// Portable entry point (`@secret-desk/core/portable`) for runtimes without Node APIs, for example a Cloudflare Worker.
//
// Rule: this file re-exports only modules that import no Node built-ins and no libsodium. Adding a module here means
// adding it to the guard in `test/portable-modules.test.ts` (it checks the whole import closure of this file).
// Node-only facades (`vault.ts`, `inventory.ts`, `connections.ts`, the file stores, ...) stay on the package root.
export * from "./secret.js";
export * from "./stages.js";
export * from "./types.js";
export * from "./inventory-store.js";
export * from "./inventory-errors.js";
export * from "./inventory-backend.js";
export * from "./evidence.js";
export * from "./vault-core.js";
export * from "./connections-core.js";
export * from "./variable-sources.js";
// The GitHub client: the caller injects the sealer (`seal`) and the App JWT signer (`sign`); there are no defaults.
export * from "./github-core.js";
// The pure domain logic on top of those: providers' contract, parameters, checks, snapshots, issuance and revoke, the
// configuration schema. Digests come from `sha256.ts` (no `node:crypto`), ids from `globalThis.crypto`.
export * from "./provider.js";
export * from "./worker-secrets.js";
export * from "./params.js";
export * from "./status.js";
export * from "./preflight.js";
export * from "./place-io.js";
export * from "./snapshot.js";
export * from "./verification.js";
export * from "./issuance.js";
export * from "./rotate.js";
export * from "./config-core.js";
export * from "./sha256.js";
export * from "./variables.js";
export * from "./patch.js";
export * from "./team.js";
export * from "./guards.js";
export * from "./vendors.js";
export * from "./stripe-accounts.js";
export * from "./env-export-errors.js";
