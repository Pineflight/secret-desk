# Agent API reference

The local portal serves an HTTP interface for AI agents under `/api/agent`. The [MCP server](AGENTS.md) is a thin client of exactly this API; you can also call it directly from scripts. An [OpenAPI 3.1 description](openapi-agent.yaml) is available.

The interface returns **metadata only**. No response ever contains a secret value, an integration token or the agent token. It cannot confirm a review, enter a value, set a connection, upload an attachment or change stages; for everything outside the policy it creates an [approval](#approvals-and-policy) that a human grants in the portal.

The portal that serves it must be running (`pnpm dev`). Default base URL: `http://127.0.0.1:4747` (the MCP server reads `SECRET_DESK_URL`).

Source of truth: [`apps/desk/src/server/router.ts`](../apps/desk/src/server/router.ts) (routes), [`packages/runtime/src/agent-api.ts`](../packages/runtime/src/agent-api.ts) (policy), [`packages/core/src/patch.ts`](../packages/core/src/patch.ts) (input schemas).

- [Authentication](#authentication)
- [Conventions](#conventions)
- [Errors](#errors)
- [Approvals and policy](#approvals-and-policy)
- [Routes](#routes)

## Authentication

Every request carries the agent token as a bearer token:

```http
Authorization: Bearer <agent-token>
```

The token is a random 256-bit value stored in `~/.secret-desk/agent-token` (mode 600). The portal creates it the first time it handles an API request, so opening the portal once is enough. The MCP server also accepts it through the environment variable `SECRET_DESK_AGENT_TOKEN`. Anyone who holds the token can use this API; see the [limit for agents with shell access](SECURITY-MODEL.md#limit-agents-with-shell-access-as-the-same-os-user).

Optional header `X-Agent-Name: <name>` labels the caller in approvals (`requestedBy`). It is not verified; it is shortened to 40 characters and reduced to `A-Za-z0-9 ._:@/-`; default `agent`.

Before authentication, every request must pass these checks:

| Check | Failure |
|---|---|
| `Host` header is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (DNS rebinding protection) | `403` |
| If a browser sends `Sec-Fetch-Site`, it must be `same-origin` or `none` | `403` |
| Non-GET request without an `Origin` header and without an `Authorization` header | `403` (a bearer token makes the Origin header unnecessary) |
| `Authorization: Bearer` token matches | `401` |

```bash
TOKEN=$(cat ~/.secret-desk/agent-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/api/agent/overview
```

## Conventions

- Paths are relative to `/api/agent`; a trailing slash is ignored. Names in path segments must be URL-encoded.
- Requests with a body use `Content-Type: application/json`. The body must be a JSON object (an array, a string or `null`-like primitives are `400`).
- Input schemas are **strict**: an unknown or forbidden field is a `400` that names it (for example `Field not allowed: stage`), never silently ignored.
- Responses are JSON with `Cache-Control: no-store`, except `GET team-export` (YAML).
- Language of messages: backend messages are German by default; send `X-Secret-Desk-Lang: en` to get English. (The MCP client does not send it.)
- Boolean query flags are `1` for true.
- Stage ids come from `GET stages`.
- Routes that exist only for humans answer `404`, not `403`, to the agent API (for example `POST reviews/:id/confirm`).

## Errors

Error bodies are `{ "error": "<message>" }` plus optional fields.

| Status | Meaning | Extra fields |
|---|---|---|
| `400` | Invalid input: schema violation, unknown field, unknown stage, invalid inventory change, invalid template, secret-like variable value. | `code`: `secret-blocked` or `secret-ack` for variable values that look like secrets |
| `401` | Token missing or wrong. | |
| `403` | Policy violation (agents may not do this, stage needs approval for direct action, review/approval/report not found or expired), or Host/Origin/fetch-site check failed. | |
| `404` | Unknown route, or a route that exists only for humans. | |
| `409` | State conflict: a provider connection is missing, the vault is unavailable, an issuance cannot proceed, a browser run is already active. | `code: "not-connected"` with `connection` and `hint`; `code: "vault-unavailable"` |
| `429` | Rate limit at GitHub or at a provider. | `code: "rate-limit"`, `detail` |
| `500` | Unexpected error. The message is generic; details are logged on the server without values. | |
| `502` | GitHub or a provider denied access or failed. | `code`: `github-denied`, `provider-denied` or `provider-error`; `detail` |

## Approvals and policy

Whether an agent may act **directly** depends on the stage of the entry it touches:

- The stages in `policy.agentStages` (default: every stage of kind `dev`) are *direct*. A stage of kind `live` is never direct, even if listed.
- Everything else, and every entry **without targets** (`places` empty), creates an **approval**: the call answers `status: "pending-approval"` with an `approvalId` and nothing happens until a human approves in the portal (**Approvals**). `GET approvals/:id` shows the state: `pending`, `approved`, `denied`, `failed` or `stale`.
- An approval is bound to the content that was current when it was requested (stage, provider, parameters, targets, expected value). If the entry changes before approval, the approval becomes `stale` and is discarded.
- Approvals live in memory; after a portal restart open requests are gone and must be requested again.
- Providers that create their value through a browser window (id ending in `-browser`) always need an approval, in every stage, because a window opens on the human's machine.
- Even after approval nothing is written to GitHub until a human confirms the review report in the portal.

What agents can never do, in any stage: confirm or reject a review, enter a value, set or remove connections, upload attachments, change stage definitions, delete entries, adopt variable values from GitHub, import a team file, read evidence images, see local folder paths, overwrite existing files.

## Routes

Summary:

| Method and path | Purpose |
|---|---|
| `GET overview` | Totals by stage and status, items needing attention |
| `GET stages` | Stage definitions with usage |
| `GET secrets` | List secrets (metadata) |
| `GET secrets/:id` | One secret |
| `POST secrets` | Add a secret entry |
| `PATCH secrets/:id` | Change descriptive metadata |
| `GET compare` | Compare stages and repositories |
| `GET variables` | List variables |
| `GET variables/:id` | One variable |
| `POST variables` | Add a variable |
| `PATCH variables/:id` | Change expected value or description |
| `GET variables/:id/status` | Expected against actual in GitHub |
| `POST variables/:id/apply` | Write the expected value to GitHub |
| `POST renewal-requests` | Ask for a new value |
| `GET reviews`, `GET reviews/:id` | Open reviews (waiting for a human) |
| `GET evidence/:secretId`, `GET evidence/:secretId/:reportId` | Earlier review reports |
| `GET approvals`, `GET approvals/:id` | Approval requests |
| `GET providers`, `POST providers` | Providers, add a guide-only provider |
| `GET connections` | Connection state (yes or no) |
| `GET dev-templates` | Dev `.env` templates |
| `POST env-templates`, `POST env-templates/:id/entries` | Create or extend a template |
| `POST env-export` | Write a dev `.env` |
| `GET repos` | Repositories (no local paths) |
| `GET team-export` | Team file as YAML |

### GET overview

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/api/agent/overview
```

Response:

```json
{
  "total": 8,
  "byStage": { "dev": 1, "staging": 4, "production": 0, "shared": 3 },
  "byStatus": { "ok": 5, "unknown": 1, "soon": 0, "no-date": 1, "due": 1, "missing": 0, "expired": 0 },
  "attention": [ /* SecretView[], up to 25, the most urgent first */ ],
  "variables": 3,
  "pendingReviews": 0,
  "pendingApprovals": 0
}
```

### GET stages

Returns the stage definitions: `[{ "id", "label"?, "kind", "environment"?, "tone"?, "environmentName": string|null, "usage": { "secrets", "variables", "templates", "policy": boolean } }]`. Read-only; only a human changes stages (Settings).

### GET secrets

Query parameters (all optional): `stage`, `repo`, `product`, `status` (`ok`, `unknown`, `soon`, `no-date`, `due`, `missing`, `expired`), `provider`, `q` (free text over id, name, title, description, owner, product, service, tags, repositories), `tag`, `live=1` (compare with GitHub, network).

Response: `SecretView[]`, most urgent first. A `SecretView`:

```json
{
  "id": "cloudflare-deploy-acme-app",
  "name": "CLOUDFLARE_API_TOKEN",
  "title": null,
  "description": "Deploy access for the Workers and Pages of Acme App",
  "owner": "alice",
  "link": "https://dash.cloudflare.com/profile/api-tokens",
  "tags": ["deploy", "cloudflare"],
  "product": "acme-app",
  "stage": "shared",
  "service": "cloudflare",
  "provider": "random-hex",
  "automatic": true,
  "browser": false,
  "expiry": "possible",
  "expires": "2026-11-02",
  "daysLeft": 5,
  "status": "due",
  "rotatedAt": null,
  "verifiedAt": null,
  "verifiedBy": null,
  "ttlDays": 90,
  "places": [{ "repo": "acme-app", "scope": "repository" }],
  "guide": null,
  "connection": null,
  "notes": null
}
```

With `live=1` a `liveErrors` array may appear: targets GitHub could not read (403, 429, 5xx); for them "missing" is unknown.

### GET secrets/:id

One `SecretView`. `400` if the id is unknown.

### POST secrets

Adds an inventory entry (metadata only; nothing is created or written).

Body (strict): `id`, `name`, `service`, `stage` (default `shared`), `provider` (default `manual`), `params`, `expiry`, `ttlDays`, `product`, `title`, `description`, `owner`, `link`, `tags`, `notes`, `source`, `rotation`, `places`. Not allowed for agents: `expires`, `rotatedAt`, `verifiedAt`, `verifiedBy`, `externalId`. See [CONFIGURATION.md](CONFIGURATION.md#secrets) for the types.

Policy:

- `stage` must be a direct stage (`403` otherwise). A stage not in `policy.agentStages` needs a human.
- `provider` must exist or be `manual` (`400`).
- `params` must not contain network targets: keys `baseUrl`, `url`, `endpoint`, `host`, `hostname`, `origin`, `webhookUrl`, `server` (compared case-insensitively) are rejected with `403`.
- Outside stages of kind `dev` at least one place is required (`400`).

Response: the new `SecretView`.

### PATCH secrets/:id

Changes descriptive metadata. Body (strict, all optional, `null` clears): `title`, `description` (max 500), `owner` (max 80), `link` (http(s) URL), `tags` (max 12), `notes` (max 2000), `product`. Everything else (stage, places, provider, params, expiry, verification stamps) is a `400`; only a human changes those. Response: the updated `SecretView`.

### GET compare

Read-only comparison of secrets and variables across stages. Details: [COMPARE.md](COMPARE.md).

| Query | Meaning |
|---|---|
| `live=1` | Read the actual state from GitHub (read-only). Without it: expectations from the inventory only. |
| `all=1` | With `live`: also read repositories of the organization that have no inventory entry. |
| `workflows=1` | Evaluate workflow files for names they need (local linked folder, otherwise GitHub Contents API with `live`). |
| `compare=a,b` | Stage ids whose presence is compared for parity. Default: all stages of kind `test` and `live`. |
| `kinds=secret,variable` | Restrict to secrets and/or variables (`secrets` and `variables` also accepted). |
| `repo=name` | One repository. |
| `normalize=1` | Merge names that differ only by a stage word (`STAGING`, `PRODUCTION`, `PROD`, `DEV`, stage ids). |

Response (shape, abbreviated):

```json
{
  "stages": [{ "id": "staging", "label": "Staging", "kind": "test", "environment": "staging" }],
  "compared": ["production", "staging"],
  "rows": [{
    "repo": "acme-app", "name": "ACME_API_KEY", "kind": "secret", "ids": ["acme-api-key-acme-app-staging"],
    "cells": { "staging": { "state": "ok", "expected": true, "present": true } },
    "parity": "gap", "missingIn": ["production"], "tags": [], "neededMissing": false, "levelMismatch": false
  }],
  "summary": { "perStage": { "staging": { "expected": 7, "present": 5, "missing": 2, "unexpected": 0, "error": 0, "needed": 0, "levelMismatch": 0 } }, "gaps": 5, "orphans": 0, "neededMissing": 0, "levelMismatch": 0 },
  "ignored": [".github"],
  "repos": [ /* every known repository with notes, rename hints and counters */ ],
  "live": true,
  "errors": []
}
```

### GET variables, GET variables/:id

Query for the list (all optional): `stage`, `repo`, `product`, `q`, `tag`. A `VariableView`:

```json
{ "id": "site-url-acme-web-staging", "name": "NEXT_PUBLIC_SITE_URL", "description": null, "owner": null, "link": null, "tags": [], "product": "acme-web", "stage": "staging", "value": "https://app-staging.example.com", "places": [{ "repo": "acme-web", "scope": "environment", "environment": "staging" }] }
```

`value` is the **expected** value from the inventory (a variable is configuration, not a secret); it is `null` if still unknown.

### POST variables

Adds a variable to the inventory. Body (strict): `id`, `name`, `stage`, `places` (at least one), and optional `value`, `description`, `owner`, `link`, `tags`, `product`. Nothing is written to GitHub. Values that clearly look like secrets are rejected with `400` and `code: "secret-blocked"`; values that only look suspicious are rejected with `code: "secret-ack"` (an agent cannot acknowledge them; a human can in the portal). Unlike secrets, variable entries are not restricted to direct stages, because creating one only edits the inventory; applying it follows the approval rules below.

### PATCH variables/:id

Body (strict, all optional): `value`, `description`, `owner`, `link`, `tags`, `acknowledgedPublic` (ignored for agents). `stage`, `places`, `id` and `name` are not fields of this route (`400`). Changes the inventory only. Response: the `VariableView`.

### GET variables/:id/status

Expected against actual, read live from GitHub:

```json
{
  "variable": { "id": "...", "name": "...", "value": "..." },
  "drift": [{ "variableId": "...", "place": { "repo": "acme-web", "scope": "environment", "environment": "staging" }, "placeLabel": "acme-web/env:staging", "state": "different", "expected": "https://a.example.com", "actual": "https://b.example.com", "updatedAt": "2026-10-20T08:00:00Z" }]
}
```

`state` is `in-sync`, `missing`, `different`, `unknown-expected` (no expected value yet) or `unreachable` (with `error` and `errorStatus`).

### POST variables/:id/apply

Body (optional): `reason` (shown to the approver), `acknowledgedPublic` (ignored for agents). Sets the expected value in GitHub.

- Direct stage with targets: `{ "status": "applied", "outcomes": [{ "place": "acme-web/env:staging", "outcome": "created" | "updated" | "unchanged" | "failed", "error"? }] }`.
- Otherwise: `{ "status": "pending-approval", "approvalId": "...", "message": "..." }`. The variable is set when a human approves.

### POST renewal-requests

Asks for a new value for a secret at its provider.

Body: `secretId` (required), `reason` (optional, shown to the approver), `dryRun` (optional boolean).

Results (field `status`):

| `status` | When | Other fields |
|---|---|---|
| `dry-run` | `dryRun: true` (checked before the approval rule; nothing is created) | `plan`: `{ secretId, stage, provider, automatic, places: string[], revokesOld, ttlDays }` |
| `awaiting-review` | Direct stage with targets and an API provider: the value was created and verified, and waits for a human to confirm in the portal | `issuance`: an `IssuanceView` (see below), `message` |
| `pending-approval` | Stage not direct, no targets, or a browser provider | `approvalId`, `secretId`, `message` |

Nothing is ever written to GitHub by this call. The new value exists in the portal's memory for at most 15 minutes; a human confirms or rejects it under **Reviews**.

An `IssuanceView`:

```json
{
  "id": "aa102594-374e-427f-a6bc-cdab308275f6",
  "secretId": "cloudflare-deploy-acme-app",
  "secretName": "CLOUDFLARE_API_TOKEN",
  "stage": "shared",
  "provider": "random-hex",
  "kind": "issued",
  "createdAt": "2026-10-28T08:37:25.377Z",
  "expiresAt": "2026-10-28T08:52:25.377Z",
  "overall": "pass",
  "report": {
    "id": "...", "label": "...", "targets": ["acme-app/repo"],
    "checks": [{ "id": "shape", "label": "...", "status": "pass" }],
    "checklist": [{ "id": "...", "text": "..." }],
    "fingerprint": "2b4bd2f23d95",
    "attachments": []
  }
}
```

`overall` is `pass`, `warn` or `fail`. The `fingerprint` is the first 12 hex characters of a SHA-256 of the value: it allows later comparison but does not reveal the value.

### GET reviews, GET reviews/:id

Open reviews (values waiting for a human), as `IssuanceView[]` and one `IssuanceView`. Expired reviews are hidden. An unknown or expired id is `403`.

### GET evidence/:secretId, GET evidence/:secretId/:reportId

The review reports of a secret (newest history, with confirmation and attachment metadata) as `VerificationReport[]`, or one report (`403` if not found). Evidence images and attachments are available to humans only.

### GET approvals, GET approvals/:id

`Approval[]` (newest first) and one `Approval` (`403` if unknown):

```json
{
  "id": "...", "action": "issue", "targetId": "acme-api-key-acme-app-staging", "requestedBy": "claude",
  "reason": "Key expires next week", "createdAt": "2026-10-28T08:40:00.000Z",
  "state": "pending", "snapshotHash": "...", "snapshot": { },
  "result": "optional short text after execution"
}
```

`action` is `issue` or `apply-variable`; `state` is `pending`, `approved`, `denied`, `failed` or `stale`.

### GET providers, POST providers

`GET`: `[{ "id", "label", "kind": "automatic" | "manual", "browser": boolean, "connection": string|null, "guide": { "url", "steps" } | null }]`.

`POST` adds a provider without an API: body `{ "id", "label", "url", "steps"? }` (`url` must be http(s); the id must not exist yet, not even a built-in one, else `400`). Response: the created definition.

### GET connections

Connection state without tokens: `[{ "id", "connected", "source": "session" | "env" | "op" | "vault" | "none", "hint"?, "expires"?, "fingerprint"?, "canRemember", "daysLeft", "savedAt", "label", "description", "url", "openUrl", "steps", "permissions" }]`. Agents cannot set or remove connections.

### GET dev-templates

`[{ "id", "repo", "stage", "file", "entries": [{ "key", "source": "default" | "generate" | "issue" | "prompt" | "variable", "description", "variable"?, "secret"?, "value"? }] }]`. `value` appears only for `default` entries (non-secret by definition).

### POST env-templates

Creates a dev template. Body: `id`, `repo`, `stage` (default `dev`), `file` (default `.env.local`), `entries` (at least one: `{ key, from, description? }`, see [CONFIGURATION.md](CONFIGURATION.md#env-templates)). Policy for agents: the stage must be direct; `file` must be named `.env` or `.env.<suffix>` (not `.envrc`, `.npmrc`, `Makefile`, shell or script files); `issue` sources only for secrets in direct stages. Response: the template.

### POST env-templates/:id/entries

Appends one entry `{ key, from, description? }` to a template, with the same policy. Response: the updated template.

### POST env-export

Writes a dev `.env` file. Body: `repo` (required), `path` (target file; may be omitted if the repository is linked to a local folder), `template`, `stage` (default: the first stage of kind `dev`), `overwrite`, `prompts`.

Policy for agents (`403` unless stated): `overwrite` is forbidden; `prompts` (values) are forbidden; the stage must be direct; `policy.envRoots` must not be empty; the file name must be `.env` or `.env.*`; the path must lie inside `policy.envRoots` or the repository's linked folder (`400`).

Responses:

```json
{ "status": "written", "path": "/home/alice/projects/acme-app/.env.local", "keys": ["NEXT_PUBLIC_SITE_URL", "RATE_LIMIT_SECRET"], "sources": { "RATE_LIMIT_SECRET": "generate" }, "gitIgnored": true, "warnings": [] }
```

```json
{ "status": "needs-input", "keys": ["STRIPE_SECRET_KEY"], "message": "A human must provide these values in the portal or with `secret-desk env export --prompt KEY=VALUE`." }
```

The file gets mode 600. The response never contains values; do not read the file afterwards.

### GET repos

`GET repos?live=1` returns `{ "owner", "github": "ok" | "unavailable" | "off", "repos": [{ "name", "secrets", "variables", "templates", "inInventory", "github": { "private", "archived", "pushedAt" } | null, "link": { "path": null, "exists", "remote", "remoteMatches" } | null, "renamedTo"? }] }`. For agents `link.path` is always `null`: an agent sees that a folder is linked, not where.

### GET team-export

Returns the team file as YAML (`Content-Type: text/yaml`, `Content-Disposition: attachment; filename="secret-desk.team.yaml"`). No values. See [TEAM.md](TEAM.md).
