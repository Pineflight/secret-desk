# Portal interface (contract for the user interface)

All human routes live under `/api/ui/...`. Call `GET /api/session` once first: the answer is `{ csrf, user, demo, owner }` and sets the cookie `sd_session`. Outside the demo, `GET /api/session` needs the launch secret (`?launch=` query or header `x-secret-desk-launch`), otherwise it answers `401` with `code: "launch-required"`. Every further request sends the header `x-secret-desk-csrf: <csrf>` (the cookie travels automatically). Changes (POST, PATCH, PUT, DELETE) also send an `Origin` header (the browser does). Responses are JSON; errors are `{ error: string }`. `409` with `code: "not-connected"` means a provider connection is missing (`connection`, `hint`). Send `x-secret-desk-lang: en` for English messages.

The agent interface under `/api/agent/...` is a subset of these routes, see [docs/AGENT-API.md](../../docs/AGENT-API.md).

Types come from `@secret-desk/runtime` and `@secret-desk/core` (`import type` only).

| Method and path | Response / purpose |
|---|---|
| GET `overview` | `Overview` (totals by stage and status, `attention`, `variables`, `pendingReviews`, `pendingApprovals`) |
| GET `stages` | `StageView[]` (definitions with usage) |
| PUT `stages` `{ stages }` | Replace the stage definitions (human only) |
| GET `settings` | Configuration metadata (paths, switches, resolved policy), never values (human only) |
| GET `secrets?stage&repo&product&status&provider&q&tag&live=1` | `SecretView[]` |
| GET `secrets/:id` | `SecretView` |
| POST `secrets` | `SecretView`, add (metadata) |
| PATCH `secrets/:id` | Change metadata (strict: humans may also change `expires`, `rotatedAt`, `verifiedAt`, `verifiedBy`, `externalId`, `ttlDays`, `expiry`) |
| POST `renewal-requests` `{ secretId, reason?, dryRun? }` | `awaiting-review` + `IssuanceView`, `pending-approval` or `dry-run` |
| GET `reviews` / `reviews/:id` | `IssuanceView[]` / `IssuanceView` (open reviews, metadata only: `report.checks`, `report.checklist`, `fingerprint`, `expiresAt`) |
| POST `reviews/:id/confirm` `{ ticks: string[], note?, force? }` | `CommitResult` (writes to GitHub only now) |
| POST `reviews/:id/reject` `{ note? }` | `{ revokedNew }` |
| POST `secrets/:id/manual-value` `{ value }` | `IssuanceView` (the value is verified, never stored, waits for confirmation) |
| GET `evidence/:secretId` | `VerificationReport[]` (history) |
| GET `evidence/:secretId/:reportId` | `VerificationReport` |
| GET `evidence/:secretId/:reportId/svg` | Evidence image (`image/svg+xml`, use in `<img>`; cookie only) |
| POST `evidence/:secretId/:reportId/attachments` (multipart `file`, `note`) | `Attachment` (PNG, JPEG or WebP up to 5 MB) |
| GET `evidence/:secretId/:reportId/attachments/:file` | Image |
| GET `compare?live=1&all=1&workflows=1&compare=a,b&kinds=secret,variable&repo&normalize=1` | `CompareResult` (matrix of repository and name against stage with cell state, `parity`, `summary`, `repos`, `errors`; read-only, never values; `live=1` reads GitHub) |
| GET `variables?stage&repo&product&q&tag` | `VariableView[]` |
| GET `variables/:id` | `VariableView` |
| POST `variables` | Add a variable (`acknowledgedPublic` for a soft warning) |
| PATCH `variables/:id` `{ value?, description?, owner?, link?, tags?, acknowledgedPublic? }` | Change expected value and description in the inventory |
| GET `variables/:id/status` | `{ variable, drift: VariableDrift[] }` (expected against actual in GitHub) |
| POST `variables/:id/apply` `{ acknowledgedPublic? }` | `applied` (+ outcomes) or `pending-approval` |
| POST `variables/:id/adopt` | Adopt the actual value from GitHub as the expected value |
| DELETE `variables/:id` | Remove from the inventory |
| GET `approvals` / `approvals/:id` / POST `approvals/:id/approve` or `deny` | `Approval[]` / `Approval` |
| GET `dev-templates` | Dev templates: `{ id, repo, stage, file, entries: [{ key, source, description, value? (defaults only), variable?, secret? }] }` |
| POST `env-templates`, POST `env-templates/:id/entries` | Create or extend a template |
| POST `providers` / GET `providers` | Add a guide-only provider / providers (`kind`, `connection`, `guide`) |
| GET `connections` | `ConnectionStatus[]` (yes or no, never tokens) |
| POST `connections/:id/token` `{ token, expires \| neverExpires, remember? }` / DELETE | Set the token for this session, or (`remember`) in the vault; delete |
| POST `connections/:id/check` `{ deep?, targets? }` | Test connection (read-only); `deep` adds the GitHub write test for the listed targets |
| GET `connections/github/write-targets` | Targets selectable for the write test |
| GET `repos?live=1` | `RepoList` (agents get no paths) |
| PUT `repos/:name/link` `{ path }` / DELETE `repos/:name/link` | Link or unlink a local folder |
| POST `repos/scan` | Proposals for local links |
| POST `repos/:name/rename` `{ to }` | Rename a repository in the inventory (changes nothing in GitHub) |
| GET `automation`, GET `automation/runs/:secretId`, POST `automation/runs/:secretId/cancel` | Browser automation info and run state (human only) |
| POST `env-export` `{ repo, stage?, template?, path?, overwrite?, prompts? }` | `DevEnvResult` (writes the file with mode 600) |
| GET `team-export` | YAML download without values |
| POST `team-import` `{ text, replace?, confirmReplace? }` | `{ added, skipped, addedStages? }` (`replace` needs `confirmReplace: true`) |

Error codes: 400 invalid input, 401 session (or launch secret), 403 policy or host, 404, 409 state (also provider not connected), 429 rate limit, 502 GitHub or provider.

Never present in a response: the value of a secret, a connection's token, the agent token.

Descriptive fields (same for secrets and variables): `description` (max 500 characters), `owner`, `link` (URL), `tags` (lowercase-with-hyphens, max 12). `SecretView` and `VariableView` contain them; empty values are `null` or `[]`.
