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

## Provider parameters, resources and variable sources (portal only, agents get `404`)

Parameters are configuration (ids, addresses, permissions), never secret values; no response contains a connection token. Discovery and preflight read from the provider with the stored token of the integration. A suggestion (`suggestedFor`, `suggested`) is only a proposal: the portal applies it only when the human confirms (`PUT`). Error bodies: `400 { error, code: "params_invalid", problems: [{ key, code: "missing"|"wrong_type"|"not_in_options"|"unknown_key", message, label, labelEn }] }`, `409 { error, code: "preflight_failed", findings }`.

| Method and path | Response / purpose |
|---|---|
| GET `secrets/:id/params?live=0` | `ParamsView` (below). `live=0` skips discovery and preflight (`resources: {}`, `preflight: null`) |
| PUT `secrets/:id/params` `{ params?, remove?, preset? }` | Sets keys (`null` removes), `preset` = id of a preset of the spec. Unknown keys, wrong types and values outside `options` give `params_invalid`, nothing is saved; missing required keys do not (partial state, see `problems`/`complete`). Unknown keys already in the entry are kept. Returns `ParamsView` (`live=0`) |
| GET `providers/:id/params?repo=&stage=&live=0&param.<key>=` | `ParamsView` for an entry that does not exist yet (create dialog); no `secretId` |
| GET `providers/:id/resources?kind=&repo=&stage=&param.<key>=` | `{ provider, kind, status, options, suggested, error?, hint?, connection? }` |
| GET `connections/:id/resources?kind=&repo=&stage=&param.<key>=` | `{ connection, connected, defaultSpecs: ParamSpec[], defaults, resources: { [kind]: { status, options, suggested, error? } } }`. Without `kind`: all kinds that need no other parameter |
| PUT `connections/:id/defaults` `{ values: { accountId: "..." } }` | `{ connection, defaults, defaultSpecs }`. `null`/`""` removes a key |
| POST `params/suggest-all` | `{ suggestions: [{ secretId, provider, stage, missing, suggestions: { [key]: { value, label, reason } \| null }, status: "suggested"\|"partial"\|"none"\|"not-connected" }] }` (writes nothing) |
| POST `secrets?preflight=1` | As `POST secrets`; the response also has `preflight` (an `EntryPreflight`). Missing or invalid parameters give `400 params_invalid` (manual and random providers are unaffected) |
| POST `renewal-requests` `{ dryRun: true }` | Human: `{ status: "dry-run", plan, preflight }`; `plan.params = { ok, missing, problems }` |
| GET `variable-sources` | `{ sources: [{ kind, connection, label, labelEn, fields: [{ field, label, labelEn }], connected }] }` (the allowlist) |
| POST `variable-sources/value` `{ kind, resource, field, repo?, stage?, params? }` | `{ from, value, resourceLabel }` (for the create dialog; writes nothing) |
| POST `variables/:id/load-from-source` `{ kind?, resource?, field?, params?, apply?, acknowledgedPublic? }` | `{ variableId, from, current, proposed, resourceLabel, changed, applied }`. Without `apply: true` only a proposal. With it the value becomes the expected value in the inventory and `from` is remembered (nothing is written to GitHub; use `variables/:id/apply`) |
| POST `variables/suggest-all` | `{ suggestions: [{ variableId, from, current, proposed, resourceLabel, changed, status: "ok" } \| { variableId, from, status: "error", error }] }` for variables with a `from` (writes nothing) |
| POST `variables` / PATCH `variables/:id` | accept `from` (kind, connection and field are checked against the allowlist; `null` clears it on PATCH). `VariableView` has `from` |

`ParamsView`: `{ secretId?, provider, providerLabel, connection, connected, specs: ParamSpec[], values, defaults, effective, unknown, problems, complete, resources: { [paramKey]: { status: "ok"|"not-connected"|"needs-params"|"error"|"unsupported", options: [{ value, label, detail?, suggestedFor?: { score, reason } }], suggested: value|null, error? } }, preflight: { status: "ok"|"warn"|"fail"|"skipped"|"not-connected", skippedReason?: "params"|"none"|"not-connected", resource: string|null, findings: [{ id, level: "ok"|"warn"|"fail", label, detail? }] } | null }`.
`ParamSpec`: `{ key, label, labelEn, type: "string"|"stringList"|"enum"|"url"|"integer", required, requiredWhen?: { key, equals }, help, helpEn, options?: [{ value, label, labelEn }], defaultValue?, discover?: kind, presets?: [{ id, label, labelEn, values, needs? }], integrationDefault?, min?, max? }`.
Discovery kinds: `cloudflare.account`, `cloudflare.zone` (use `param.accountId`), `cloudflare.permissionGroups` (option `detail` is `account` or `zone`), `cloudflare.turnstileWidget` (needs `param.accountId`), `supabase.project`, `resend.domain`, `grafana.serviceAccount` (needs `param.baseUrl`).

Example `GET secrets/cf-deploy-wake-miles-staging/params` (abridged):

```json
{ "secretId": "cf-deploy-wake-miles-staging", "provider": "cloudflare-token", "connection": "cloudflare", "connected": true,
  "values": {}, "defaults": {}, "effective": {}, "unknown": { "custom": "keep-me" }, "complete": false,
  "problems": [{ "key": "accountId", "code": "missing", "message": "accountId fehlt", "label": "Cloudflare-Konto", "labelEn": "Cloudflare account" }],
  "resources": { "accountId": { "status": "ok", "suggested": "acc1", "options": [{ "value": "acc1", "label": "Pineflight", "detail": "acc1", "suggestedFor": { "score": 1, "reason": "einzige Option" } }] } },
  "preflight": { "status": "skipped", "skippedReason": "params", "resource": null, "findings": [] } }
```

Agents (`/api/agent`) only get `params: { status: "ok"|"missing"|"invalid"|"none", missing: string[] }` on each `SecretView` and `plan.params` in the dry run; no discovery, no preflight, no write route.
