# secret-desk: rules for Claude

- **Naming:** identifiers, file names, routes, API/JSON fields, config keys, env vars, CLI, error codes and test names are English. Only visible UI texts, legal texts, doc prose and comments are German or translated. Security terms stay English (salt, password, session, key, secret, checksum, caller).
- **Never touch, read, log or hard-code a value in tests/fixtures.** Test values are made-up strings. Never bypass `SecretValue` in
  outputs (call `reveal()` only where the value is actually passed on).
- Every new response, report and error message gets a test asserting that no value and no connection token appears in it.
- Policy lives in `packages/runtime/src/agent-api.ts` (agents: only `policy.agentStages` directly, never confirm, no values).
- GitHub is written only after a human confirms; the old value is revoked only after that.
- Variables: never weaken the secret guard (`guards.ts`).
- Before committing, run `pnpm run verify`.
