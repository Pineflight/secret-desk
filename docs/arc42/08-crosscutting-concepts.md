# 8. Crosscutting concepts

*Purpose: concepts that apply across several building blocks, each with its code location · Audience: contributors · As of 2026-11-07 · Sources: [`SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`CONTRIBUTING.md`](../../CONTRIBUTING.md), `packages/core/src`, `packages/runtime/src`, `apps/desk/src`*

## 8.1 Domain model

| Concept | Meaning | Code |
|---|---|---|
| Secret entry | An inventory record: id, name (`UPPER_SNAKE`), stage, provider, params, places (targets), expiry kind and date, `externalId`, `rotatedAt`, `verifiedAt`, `verifiedBy`. No value. | `SecretSchema` in [`types.ts`](../../packages/core/src/types.ts) |
| Place | A target: a GitHub repository, environment or organisation scope, or a Cloudflare Worker script. | `PlaceSchema` in `types.ts` |
| Variable entry | A configuration value with an expected value, compared with GitHub; a guard blocks secret-looking values. | [`variables.ts`](../../packages/core/src/variables.ts), [`guards.ts`](../../packages/core/src/guards.ts) |
| Stage | `id`, `label`, `kind` (`dev`, `test`, `live`, `shared`), `environment`, `tone`; up to 12. | [`stages.ts`](../../packages/core/src/stages.ts), [STAGES.md](../STAGES.md) |
| Pending issuance | A new value waiting for a human decision; memory only. | `PendingIssuance` in [`issuance.ts`](../../packages/core/src/issuance.ts) |
| Review report | Metadata, checks, checklist, fingerprint, evidence image, confirmation. | `VerificationReport` in [`verification.ts`](../../packages/core/src/verification.ts), [`evidence.ts`](../../packages/core/src/evidence.ts) |
| Dev template | Recipe for a developer's `.env.local` per repository. | `EnvTemplateSchema` in `types.ts`, [DEV-ENV.md](../DEV-ENV.md) |

Terms are defined in the [glossary](12-glossary.md).

## 8.2 Security

| Concept | Rule | Code |
|---|---|---|
| Value handling | `SecretValue` keeps the value in a private field; `toString`, JSON and `util.inspect` show nothing; `reveal()` only where the value is passed on. | [`secret.ts`](../../packages/core/src/secret.ts) |
| Redaction | Error texts are sanitised (known values, prefixes, JSON fields such as `token`, `secret`, `api_key`). | `redact` in `secret.ts`, [`http.ts`](../../packages/providers/src/http.ts) |
| Fingerprint | 12 hex characters of a SHA-256, for later comparison. | `fingerprintOf` in [`verification.ts`](../../packages/core/src/verification.ts) |
| Upload | Sealed with the target's public key before sending. | [`github.ts`](../../packages/core/src/github.ts) |
| Binding | A review is bound to a hash of targets, provider, params, stage and old id; a change makes it stale. | [`snapshot.ts`](../../packages/core/src/snapshot.ts) |
| Portal access | Loopback bind, Host check, Origin check, `Sec-Fetch-Site`, CSP, launch secret, `HttpOnly` `SameSite=Strict` cookie, CSRF token. | [`security.ts`](../../apps/desk/src/server/security.ts), [SECURITY-MODEL.md](../SECURITY-MODEL.md#access-to-the-portal) |
| Agent policy | Own bearer token; direct only in `policy.agentStages`; `requireHuman` for confirm, reject, values, connections. | [`agent-api.ts`](../../packages/runtime/src/agent-api.ts) |
| Vault | AES-256-GCM, key in the OS keychain or an explicit key source; damaged file is never overwritten. | [`vault.ts`](../../packages/core/src/vault.ts) |
| Files and processes | Modes 600/700; external commands via `execFile`, no shell; key material via stdin. | [`platform.ts`](../../packages/core/src/platform.ts) |
| Secret scan | `bash scripts/scan-values.sh` fails on key-like literals in tracked files; fixtures are assembled at run time. | [`scan-values.sh`](../../scripts/scan-values.sh) |

Limits (an agent with shell access as the same OS user, memory read by local admins, heuristic secret detection) are
in [SECURITY-MODEL.md](../SECURITY-MODEL.md#limits).

## 8.3 Persistence

The inventory is a YAML file read and written through one `InventoryStore` ([`inventory.ts`](../../packages/core/src/inventory.ts)).
It follows the file (content hash, stat pre-check, `fs.watch` hint), records changes as functions of the document and,
on `save()`, takes a lock file, replays the changes over fresh content and writes via temp file, `fsync`, `rename`, mode
`0600`. A change that no longer fits ends in `InventoryConflictError` (409) and writes nothing
([ARCHITECTURE.md](../ARCHITECTURE.md#data)). Reports go to `EvidenceStore`; there is no database.

## 8.4 Internationalisation

UI texts are German and English catalogues in [`apps/desk/src/messages`](../../apps/desk/src/messages) with a
runtime switch ([`i18n.tsx`](../../apps/desk/src/lib/i18n.tsx)). Backend messages are German, ASCII-transliterated, and are
translated at the API boundary by [`i18n-en.ts`](../../packages/runtime/src/i18n-en.ts); a coverage test
(`packages/runtime/test/i18n-en.test.ts`) fails when a new German text has no entry. Identifiers and API fields are English.

## 8.5 Error handling and logging

- Typed errors per area (`IssuanceError`, `StaleIssuanceError`, `InventoryConflictError`, `PolicyError`, `ProviderError`, `RecipeRunError`) map to HTTP statuses in the router ([AGENT-API.md](../AGENT-API.md#errors)).
- Providers turn network errors and timeouts into `ProviderError` without the token ([`registry.test.ts`](../../packages/providers/test/registry.test.ts)).
- Browser recipes fail closed: unexpected state aborts, nothing is written, a token already created is named in the error.
- Logging is plain `console` output: the launch address at start, unexpected router errors, one value-free line per scheduled sign-in check. There is no log framework, no remote logging and no telemetry. Every new response, report and error needs a test that no value or token appears in it ([CONTRIBUTING.md](../../CONTRIBUTING.md#test-rules)).

## 8.6 Testing

Vitest in every package (`pnpm run test`; `pnpm run verify` adds value scan, build and typecheck). Rules: made-up
values only, no real network, vault, keychain or home folder; dependencies injected (`fetch`, `exec`, `env`, `platform`,
clock); browser tests use the fake driver, tests against a real Chrome run only where Chrome exists. Test files live in
`packages/*/test` and `apps/desk/test`. Policy changes need tests in
[`agent-api.test.ts`](../../packages/runtime/test/agent-api.test.ts) or the router tests.

## 8.7 AI usage

AI agents are a first-class client, not a component: they use the Agent API or the MCP server and are bound by the
policy in 8.2 ([AGENTS.md](../AGENTS.md), [skill](../../skills/secret-desk)). secret-desk itself calls no AI model. The
repository's `CLAUDE.md` and [`docs/AGENTS.md`](../AGENTS.md) hold the rules for coding agents working on it.
