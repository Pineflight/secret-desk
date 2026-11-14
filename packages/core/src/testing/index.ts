// Entry point `@secret-desk/core/testing`: contract suites for implementations of the storage seams (inventory backend,
// vault store, evidence store). Not re-exported from the package root or from `./portable`, so application bundles
// never contain test code. The suites take the test-framework functions as an argument and import no framework.
export * from "./framework.js";
export * from "./inventory-fixture.js";
export * from "./inventory-backend-contract.js";
export * from "./vault-store-contract.js";
export * from "./evidence-store-contract.js";
