# Integration API

How other systems connect to a secret-desk portal: issue trackers (for example Jira), wikis (for example Confluence), Azure DevOps, CI systems and your own scripts. The contract is the OpenAPI 3.1 description [`docs/api/openapi.yaml`](api/openapi.yaml); a running portal also serves it at `GET /api/openapi.yaml`.

- [Status: what works today](#status-what-works-today)
- [Principles](#principles)
- [Network: who can reach whom](#network-who-can-reach-whom)
- [Authentication and scopes](#authentication-and-scopes)
- [Conventions](#conventions)
- [Webhooks and the event feed (planned)](#webhooks-and-the-event-feed-planned)
- [Example: Jira issue for an expiring secret](#example-jira-issue-for-an-expiring-secret)
- [Example: Confluence page with the inventory overview](#example-confluence-page-with-the-inventory-overview)
- [Example: Azure DevOps pipeline check and work item](#example-azure-devops-pipeline-check-and-work-item)
- [Open design questions](#open-design-questions)

## Status: what works today

Every operation and webhook in the description carries `x-secret-desk-status`. A contract test (`apps/desk/test/openapi-contract.test.ts`) keeps that honest: an `implemented` operation must be routed today, a `planned` one must not be.

| Part | Status | Where |
|---|---|---|
| Read metadata: overview, stages, secrets, variables, variable drift, compare, reviews, evidence, approvals, providers, connections, repositories | **Implemented** | `/api/agent/...` with the agent token |
| Ask for a renewal (`POST renewal-requests`); outside the policy it only creates an approval | **Implemented** | `/api/agent/renewal-requests` |
| The OpenAPI description itself | **Implemented** | `GET /api/openapi.yaml`, no token |
| Versioned base path `/api/v1` with the same shapes | Planned | |
| One token per integration with scopes, stage limits and expiry | Planned | |
| Outbound webhooks with signed payloads | Planned | |
| Event feed `GET events` (pull alternative to webhooks) | Planned | |
| `Idempotency-Key`, `RateLimit-*` headers, `code` on every error, `requestId` | Planned | |
| Connection test `GET integration` | Planned | |

Until integration tokens exist, the implemented operations are called under `/api/agent` with the agent token. Paths, parameters and response shapes are the ones `/api/v1` will serve, so moving later means changing the base URL and the token, nothing else.

## Principles

- **Metadata only.** No response, error or event ever contains a secret value, an integration token, a webhook signing secret or the agent token. A secret is described by name, stage, places, provider, expiry and status, and at most a `fingerprint` (the first 12 hex characters of a SHA-256 of the value).
- **Least privilege.** An integration can read and ask. It can never confirm a review, enter a value, approve a request, change a connection or write to GitHub. These stay with a human in the portal. There is deliberately no scope for them.
- **Humans decide.** `POST renewal-requests` in a stage outside `policy.agentStages` (and always in stages of kind `live`) creates an approval that a human grants. See [AGENT-API.md](AGENT-API.md#approvals-and-policy).
- **Additive changes only** within a major version: new operations, optional fields, response fields, event types and enum values may appear. Clients must ignore unknown fields and event types. Anything breaking needs `/api/v2`; the old major version stays served for at least 6 months after the next one ships.
- `/api/agent` ([openapi-agent.yaml](openapi-agent.yaml)) remains the surface of the MCP server and may change faster. Third-party systems should build on the operations listed in `docs/api/openapi.yaml`.

## Network: who can reach whom

The portal runs on a workstation (`127.0.0.1:4747`) or on a host in your local network. Cloud services such as Jira Cloud, Confluence Cloud and Azure DevOps Services **cannot reach it**, and it should not be exposed to the internet. Two patterns work:

1. **Pull from inside the network (works today).** A scheduled job that runs where the portal is reachable (a cron job, a self-hosted CI runner or Azure Pipelines agent) reads the API and calls the cloud service's own API. All examples below use this pattern.
2. **Push from the portal (planned).** The portal sends signed webhooks to an HTTPS endpoint you register. Outbound calls from the portal host to the internet are enough; nothing has to reach the portal.

On a LAN host, add the host name with port to `SECRET_DESK_ALLOWED_HOSTS` (for example `secret-desk.lan:4747`), otherwise requests fail the Host check with `403`. Every request with a bearer token needs no `Origin` header; browsers on other origins are rejected.

## Authentication and scopes

**Today:** the agent token, `Authorization: Bearer <token>`, read from `~/.secret-desk/agent-token` on the portal host (see [AGENT-API.md](AGENT-API.md#authentication)). It grants every agent operation, not only the integration scopes below. Use it only for jobs inside the portal's trust boundary, keep it in the CI system's secret store, and replace it with an integration token once those exist.

**Planned:** a human creates one token per integration in the portal (Settings, Integrations API) with a name, scopes, optional stage limits and an expiry of at most 365 days. The portal shows the token once and stores only a hash. Revoking it takes effect immediately.

| Scope | Allows |
|---|---|
| `inventory:read` | overview, stages, secrets, providers, connection state, repositories |
| `variables:read` | variables and their drift against GitHub |
| `compare:read` | stage comparison |
| `reviews:read` | open reviews and evidence reports |
| `approvals:read` | approval requests |
| `renewals:request` | `POST renewal-requests` (still subject to the approval policy) |
| `events:read` | the event feed |

Each operation names its scope in `x-secret-desk-scope`. A token without it gets `403` with `code: scope-missing`; an expired or revoked token gets `401`.

## Conventions

- JSON in and out; request bodies must be JSON objects. Input schemas are strict: unknown fields are a `400` naming the field.
- Errors: `{ "error": "<message>", "code"?: "...", "detail"?: "..." }`. Branch on HTTP status and `code`, never on the message. Messages are German unless you send `X-Secret-Desk-Lang: en`. The list of codes is in the description (`components.schemas.Error`).
- Lists return the complete array. Inventories are bounded (hundreds of entries), so the read operations are not paginated. The planned event feed uses cursor pagination (`after`, `limit`, `nextCursor`).
- Idempotency: `POST renewal-requests` returns the open approval when one already exists for the same secret instead of creating a second one. A result `awaiting-review` creates a new value per call, so do not retry it blindly. Planned: an `Idempotency-Key` header that replays the first response for 24 hours.
- Rate limits: none of its own today; GitHub and provider limits come back as `429` with `code: rate-limit`. Planned for integration tokens: 120 requests per minute per token, `RateLimit-Limit`, `RateLimit-Remaining` and `Retry-After`.
- `live=1` on secrets, compare and variable status reads GitHub and costs GitHub API calls; scheduled jobs should not set it more often than hourly.

## Webhooks and the event feed (planned)

A human registers a subscription in the portal: an HTTPS URL, the event types, and gets a signing secret shown once. Target hosts must be on an allowlist (`integrations.webhooks.allowedHosts`), so the portal cannot be used to call arbitrary internal addresses.

| Event | When |
|---|---|
| `secret.expiring` | A secret reaches a warning threshold (default 30, 14, 7 and 1 days), once per threshold |
| `secret.expired` | A secret is past its expiry date |
| `renewal.requested` | Someone asked for a new value |
| `review.pending` | A new value waits for a human to confirm (the review expires after 15 minutes) |
| `review.completed` | A human confirmed (written to GitHub) or rejected a review |
| `approval.pending`, `approval.resolved` | An approval request was created, or approved, denied, failed or became stale |
| `sync.completed` | A GitHub sync finished |
| `variable.drift` | A live check found a variable in GitHub that differs from the inventory |

Every delivery is a `POST` with this envelope; `data` depends on the type (schemas in the description):

```json
{
  "id": "evt_01JC0000000000000000000000",
  "type": "secret.expiring",
  "apiVersion": "v1",
  "occurredAt": "2026-11-05T06:00:00Z",
  "portalUrl": "http://secret-desk.lan:4747/secrets/acme-api-key-acme-app-live",
  "data": {
    "thresholdDays": 14,
    "secret": {
      "id": "acme-api-key-acme-app-live", "name": "ACME_API_KEY", "stage": "live", "provider": "acme",
      "owner": "platform", "expires": "2026-11-19", "daysLeft": 14, "status": "soon", "automatic": true,
      "places": [{ "repo": "acme-app", "scope": "environment", "environment": "production" }]
    }
  }
}
```

**Signature** (Standard Webhooks scheme). Headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64>`, where the signature is HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw body>` with the signing secret. Verify before parsing:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, headers, signingSecret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"];
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac("sha256", signingSecret).update(`${id}.${ts}.${rawBody}`).digest();
  return (headers["webhook-signature"] ?? "").split(" ").some((part) => {
    const [version, sig] = part.split(",");
    const given = Buffer.from(sig ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

**Delivery** is at least once: a non-2xx answer or no answer within 10 seconds is retried with backoff for up to 24 hours. Deduplicate on `webhook-id`. Several signatures separated by spaces appear while a signing secret is rotated.

**Event feed.** `GET events?after=<cursor>&types=...` returns the same events (kept 30 days) for jobs that cannot receive webhooks.

Tools that cannot check an HMAC (for example an incoming-webhook trigger of a no-code automation, which only knows a secret URL) need a small relay that verifies the signature and forwards the event; do not point the portal at an unauthenticated URL.

## Example: Jira issue for an expiring secret

**Today (pull).** A daily job inside the network lists secrets that need attention and opens one issue per secret, using a label to avoid duplicates. Jira credentials stay in the job's secret store; the issue contains only metadata.

```bash
#!/usr/bin/env bash
set -euo pipefail
DESK=http://secret-desk.lan:4747/api/agent        # later: /api/v1 with an integration token (inventory:read)
JIRA=https://example.atlassian.net
AUTH="$JIRA_USER:$JIRA_API_TOKEN"                  # from the CI secret store

for status in due expired; do
  curl -sf -H "Authorization: Bearer $SECRET_DESK_TOKEN" -H "X-Secret-Desk-Lang: en" \
    "$DESK/secrets?status=$status" |
  jq -c '.[] | {id, name, stage, owner, expires, daysLeft, places: [.places[].repo] | unique}'
done | while read -r s; do
  id=$(jq -r .id <<<"$s")
  label="secret-desk-$id"
  found=$(curl -sf -u "$AUTH" -G "$JIRA/rest/api/3/search/jql" \
    --data-urlencode "jql=labels = \"$label\" AND statusCategory != Done" --data-urlencode "maxResults=1" | jq '.issues | length')
  [ "$found" -gt 0 ] && continue
  jq -n --argjson s "$s" --arg label "$label" '{
    fields: {
      project: { key: "OPS" }, issuetype: { name: "Task" }, labels: ["secret-desk", $label],
      summary: "Renew \($s.name) (\($s.stage)), expires \($s.expires // "unknown")",
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text",
        text: "Owner: \($s.owner // "-"). Repositories: \($s.places | join(", ")). Renew in secret-desk; the value is never part of this ticket." }] }] }
    } }' |
  curl -sf -u "$AUTH" -H "Content-Type: application/json" -d @- "$JIRA/rest/api/3/issue" >/dev/null
done
```

To let the ticket start the renewal, the job can also call `POST renewal-requests` with `{ "secretId": "<id>", "reason": "OPS-123" }`. In a protected stage that creates an approval; a human still grants it and confirms the review in the portal.

**Planned (push).** Subscribe a relay to `secret.expiring` and `secret.expired`; the relay verifies the signature and creates the issue with the same payload mapping, keyed on `data.secret.id` and `data.thresholdDays`. Close the issue on `review.completed` with `decision: confirmed`.

## Example: Confluence page with the inventory overview

A scheduled job publishes a page with counts and a table of secrets: names, stages, owners, expiry and status, **never values**. It replaces the page body on each run.

```bash
#!/usr/bin/env bash
set -euo pipefail
DESK=http://secret-desk.lan:4747/api/agent        # later: /api/v1, scope inventory:read
WIKI=https://example.atlassian.net/wiki
PAGE_ID=123456                                     # an existing page
AUTH="$CONFLUENCE_USER:$CONFLUENCE_API_TOKEN"

H=(-H "Authorization: Bearer $SECRET_DESK_TOKEN" -H "X-Secret-Desk-Lang: en")
overview=$(curl -sf "${H[@]}" "$DESK/overview")
secrets=$(curl -sf "${H[@]}" "$DESK/secrets")

body=$(jq -rn --argjson o "$overview" --argjson s "$secrets" '
  def esc: tostring | gsub("&";"&amp;") | gsub("<";"&lt;") | gsub(">";"&gt;");
  "<p>\($o.total) secrets, \($o.variables) variables, \($o.pendingReviews) open reviews. Generated from secret-desk; contains no values.</p>"
  + "<table><tr><th>Name</th><th>Stage</th><th>Owner</th><th>Expires</th><th>Status</th><th>Repositories</th></tr>"
  + ([$s[] | "<tr><td>\(.name|esc)</td><td>\(.stage|esc)</td><td>\(.owner // "-"|esc)</td><td>\(.expires // "-"|esc)</td><td>\(.status|esc)</td><td>\([.places[].repo] | unique | join(", ") | esc)</td></tr>"] | join(""))
  + "</table>"')

version=$(curl -sf -u "$AUTH" "$WIKI/api/v2/pages/$PAGE_ID" | jq .version.number)
jq -n --arg id "$PAGE_ID" --arg body "$body" --argjson v "$((version + 1))" '{
  id: $id, status: "current", title: "Secret inventory",
  body: { representation: "storage", value: $body }, version: { number: $v, message: "secret-desk sync" } }' |
curl -sf -u "$AUTH" -X PUT -H "Content-Type: application/json" -d @- "$WIKI/api/v2/pages/$PAGE_ID" >/dev/null
```

Escape every field before it goes into storage format, as above: names and owners come from the inventory and are not trusted HTML. To publish only some stages, add `?stage=live` to the secrets call.

## Example: Azure DevOps pipeline check and work item

**Pipeline check (today).** A stage on a self-hosted agent that can reach the portal fails the run when a secret this repository needs is expired or missing, and warns when one is due. It reads metadata only; the pipeline still gets its values from its own variable groups or from GitHub.

```yaml
# azure-pipelines.yml (excerpt)
- stage: SecretCheck
  pool: { name: self-hosted-lan }
  jobs:
    - job: check
      steps:
        - bash: |
            set -euo pipefail
            curl -sf -H "Authorization: Bearer $(SECRET_DESK_TOKEN)" -H "X-Secret-Desk-Lang: en" \
              "http://secret-desk.lan:4747/api/agent/secrets?repo=acme-app&stage=live" > secrets.json
            jq -r '.[] | select(.status == "due" or .status == "soon") | "##vso[task.logissue type=warning]\(.name) expires \(.expires)"' secrets.json
            bad=$(jq '[.[] | select(.status == "expired" or .status == "missing")] | length' secrets.json)
            jq -r '.[] | select(.status == "expired" or .status == "missing") | "##vso[task.logissue type=error]\(.name): \(.status)"' secrets.json
            test "$bad" -eq 0
          displayName: Secrets of acme-app are valid
```

`GET variables?repo=acme-app` plus `GET variables/{id}/status` does the same for variables (expected against actual in GitHub). Store `SECRET_DESK_TOKEN` as a secret pipeline variable.

**Work item (today).** The Jira job above works the same way against the Azure DevOps REST API:

```bash
jq -n --arg title "Renew $name ($stage), expires $expires" --arg tag "secret-desk-$id" '[
  { op: "add", path: "/fields/System.Title", value: $title },
  { op: "add", path: "/fields/System.Tags", value: ("secret-desk; " + $tag) },
  { op: "add", path: "/fields/System.Description", value: "Renew in secret-desk. The value is never part of this work item." } ]' |
curl -sf -u ":$AZURE_DEVOPS_PAT" -H "Content-Type: application/json-patch+json" -d @- \
  "https://dev.azure.com/acme-org/acme-project/_apis/wit/workitems/\$Task?api-version=7.1" >/dev/null
```

Search for an open item with the tag first (WIQL, `POST _apis/wit/wiql`) to avoid duplicates.

**Planned (push).** Point a `secret.expiring` subscription at a relay that verifies the signature and creates the work item, or at a pipeline that is triggered by an incoming webhook and runs the same check.

## Open design questions

These are decided before the planned parts are built (tracked as follow-up items):

1. Integration tokens: stored in the encrypted vault or in a separate file; maximum lifetime; whether a token may be limited to repositories as well as stages.
2. `/api/v1` with the agent token as a transition, or integration tokens only.
3. Webhook delivery state: kept in memory (lost on restart, retried from the daily evaluation) or persisted next to the inventory.
4. `server.publicUrl` for deep links in events, and whether the portal may call out to the internet at all on hosts that are only meant for the local network.
