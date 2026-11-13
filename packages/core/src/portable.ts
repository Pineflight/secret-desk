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
