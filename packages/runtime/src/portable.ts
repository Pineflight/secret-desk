// Portable entry point (`@secret-desk/runtime/portable`) for a JavaScript runtime without Node built-ins.
//
// Rule: this file reaches only modules that import no Node built-in, no libsodium and no browser automation, and it takes the core and the
// providers from their portable entries (`@secret-desk/core/portable`, `@secret-desk/providers/portable`). Adding a module here means
// adding it to the guard in `test/portable-modules.test.ts` (it checks the whole import closure of this file). Not part of it: the Node
// host (`host.ts`), the browser automation (`automation.ts`), the file stores, the local `createRuntime` (`runtime.ts`) and the agent
// interface (`agent-api.ts`). They stay on the package root.

// The builder and what it returns.
export * from "./runtime-core.js";
// What a runtime holds: waits for a person, reviews, approvals.
export * from "./instance-state.js";
export * from "./issuances.js";
export * from "./approvals.js";
// The GitHub cryptography on the portable client; the defaults come from the embedder.
export * from "./github-crypto-core.js";
// The host capability (interface, error, readers) and the port of browser automation (with the default that offers none).
export * from "./host-core.js";
export * from "./automation-port.js";
export * from "./live-check-notify.js";
