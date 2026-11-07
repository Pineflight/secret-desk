# 4. Solution strategy

*Purpose: the few decisions that shape everything else · Audience: contributors, reviewers · As of 2026-11-07 · Sources: [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`BROWSER-AUTOMATION.md`](../BROWSER-AUTOMATION.md), [`CLAUDE.md`](../../CLAUDE.md)*

Decision ids (D-nn) refer to the register in [chapter 9](09-architecture-decisions.md); no separate ADR files exist yet.

## 4.1 Strategy at a glance

| Goal (chapter 1) | Approach | Decisions | Where it lives |
|---|---|---|---|
| #secure: values never stored | A value exists only as a `SecretValue` in memory (at most 15 minutes) and leaves it in two places: the provider API and, sealed, GitHub. Reports carry a 12-character SHA-256 fingerprint instead. | D-01, D-04, D-05 | [`secret.ts`](../../packages/core/src/secret.ts), [`issuance.ts`](../../packages/core/src/issuance.ts) |
| #safe: nothing goes live unreviewed | Two-stage issuance: prepare (create and verify, write nothing) then confirm (write, re-check, revoke). Only a human can confirm. | D-02, D-03, D-12 | [`issuance.ts`](../../packages/core/src/issuance.ts), [`agent-api.ts`](../../packages/runtime/src/agent-api.ts) |
| #reliable: failures are recoverable | A failed target leaves the old value valid and the review open; the pending value is discarded at the provider on reject or timeout. | D-02 | `discardIssuance` in `issuance.ts` |
| #flexible: more providers | A `Provider` interface (`issue`, `verify`, `revoke`, `reviewChecklist`, `discover`, `preflight`) and registry; providers without an API use browser recipes as YAML data. | D-09, D-14 | [`provider.ts`](../../packages/core/src/provider.ts), [`recipes/`](../../recipes) |
| #operable: any platform | All platform questions behind injected `platform` and `exec`; OS keychain for the vault key; container image for small hosts. | D-13, D-15 | [`platform.ts`](../../packages/core/src/platform.ts), [`Dockerfile`](../../Dockerfile) |
| #testable | `core` has no UI; every external dependency (fetch, exec, platform, clock) is injected; browser runs use a fake driver. | D-09, D-15 | `packages/*/test`, `apps/desk/test` |

## 4.2 Structural decisions

1. **One flow, many front ends.** `packages/core` holds the domain (inventory, status, issuance, GitHub client,
   vault) and knows no user interface. `packages/runtime` bundles the operations and enforces the policy. The portal
   API, the CLI and the MCP server use only `runtime` (D-09). Humans reach `/api/ui/*`, agents `/api/agent/*`, both
   routed by [`router.ts`](../../apps/desk/src/server/router.ts).
2. **Metadata in Git, values nowhere.** The inventory (`inventory.yaml`) holds names, stages, providers, expiry and
   targets and may live in Git; review reports and attachments sit in `.secret-desk-evidence/`, outside Git (D-06, D-07).
3. **Stage behaviour follows the stage kind, never the name.** `dev`, `test`, `live`, `shared`; an unknown stage id
   is treated as `live` (D-08, [STAGES.md](../STAGES.md)).
4. **Agents are constrained by policy, not by trust.** Agents act directly only on stages in `policy.agentStages`
   (default: kind `dev`; never `live`); everything else becomes an approval a human grants in the portal (D-11, D-12).
5. **Local-first.** The portal binds to `127.0.0.1` and is protected by a launch secret, session cookie and CSRF token
   (D-10). Deployment on a small host is possible but stays inside a trusted network (chapter 7).
6. **Browser automation is a last resort and fails closed.** A visible browser, the human signs in, recipes are
   data, any unexpected state aborts and writes nothing (D-14).
7. **Honest verification status.** Every provider endpoint and recipe states how certain it is
   ([PROVIDERS.md](../PROVIDERS.md), `# STATUS` comments in [`recipes/`](../../recipes)); the project calls itself an
   early version (chapter 11).
