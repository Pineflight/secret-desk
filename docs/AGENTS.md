# AI agents (MCP server and skill)

secret-desk lets AI agents do the tedious part of secret management (keep the inventory tidy, find what expires, ask for renewals, set up dev environments) without ever seeing a value and without the power to confirm anything.

- The **MCP server** `secret-desk-mcp` offers 24 tools. It is a thin client of the portal's [agent HTTP API](AGENT-API.md).
- The **skill** `skills/secret-desk/SKILL.md` teaches an agent the rules and typical workflows.
- The **policy** is enforced by the portal, not by the agent ([below](#policy)).

## Setup

1. Build (`pnpm build`) and start the portal (`pnpm dev`). The agent token `~/.secret-desk/agent-token` (mode 600) is created when the portal first handles an API request.
2. Register the MCP server in your agent's configuration (see [`examples/mcp.json`](../examples/mcp.json)):

```json
{
  "mcpServers": {
    "secret-desk": {
      "command": "node",
      "args": ["/PATH/TO/secret-desk/packages/mcp/dist/server.js"],
      "env": { "SECRET_DESK_URL": "http://127.0.0.1:4747" }
    }
  }
}
```

The server talks to the portal at `SECRET_DESK_URL` (default `http://127.0.0.1:4747`) and reads the token from `SECRET_DESK_AGENT_TOKEN` or from `~/.secret-desk/agent-token`. The portal must be running; if not, tools fail with a "portal not reachable" message.

3. Install the skill. For Claude Code copy the folder, or include it in a plugin:

```bash
mkdir -p ~/.claude/skills && cp -r skills/secret-desk ~/.claude/skills/secret-desk
```

## Tools

All tools return JSON text. Errors come back as an MCP error result with the portal's message and HTTP status. Stage ids come from `desk_list_stages`.

### Read

| Tool | Parameters | Returns |
|---|---|---|
| `desk_overview` | none | Totals by stage and status plus the most urgent entries. |
| `desk_list_stages` | none | Stage definitions: id, label, kind, environment, usage. Read-only. |
| `desk_list_secrets` | `stage?`, `repo?`, `product?`, `status?` (`ok`, `soon`, `due`, `expired`, `no-date`, `unknown`), `provider?`, `q?`, `tag?` | Secret metadata. |
| `desk_get_secret` | `id` | One secret with targets, expiry, provider, guide. |
| `desk_list_providers` | none | Providers: automatic or manual, needed connection, guide. |
| `desk_list_connections` | none | Which connections exist (yes or no, source), never tokens. |
| `desk_list_variables` | `stage?`, `repo?`, `product?`, `q?`, `tag?` | Variables with their expected value. |
| `desk_variable_status` | `id` | Expected against actual in GitHub per target (`in-sync`, `different`, `missing`, `unknown-expected`, `unreachable`). |
| `desk_list_reviews` | none | Open reviews waiting for a human: findings, checklist, fingerprint. |
| `desk_list_evidence` | `secretId` | Earlier review reports of a secret. |
| `desk_get_approval` | `id` | State of an approval request. |
| `desk_compare_stages` | `live?`, `compare?` (stage ids), `kinds?` (`secret`, `variable`), `repo?`, `normalize?`, `all_repos?`, `workflows?` | The stage comparison, see [COMPARE.md](COMPARE.md). `live` reads GitHub. |
| `desk_team_export` | none | The team file (YAML, no values). |

### Write metadata (inventory only; nothing is created or written in GitHub)

| Tool | Parameters | Effect |
|---|---|---|
| `desk_add_secret` | `id`, `name`, `service`, `stage`, `provider?`, `params?`, `expiry?`, `ttlDays?`, `product?`, `notes?`, `description?`, `owner?`, `link?`, `tags?`, `places?` | Adds an entry. Direct stages only; outside `dev`-like stages `places` is required. |
| `desk_update_secret` | `id`, `title?`, `description?`, `owner?`, `link?`, `tags?`, `notes?`, `product?` | Changes descriptive metadata only. Stage, targets, provider, parameters, expiry and stamps are human-only. |
| `desk_add_provider` | `id`, `label`, `url`, `steps?` | Adds a guide-only provider (no API). |
| `desk_add_env_template` | `id`, `repo`, `stage?`, `file?`, `entries[]` (`key`, `description?`, `from`) | Adds a dev `.env` template. |
| `desk_add_env_entry` | `template`, `key`, `from`, `description?` | Appends an entry to a template. |
| `desk_add_variable` | `id`, `name`, `stage`, `places[]` (at least one), `value?`, `description?`, `owner?`, `link?`, `tags?`, `product?` | Adds a variable to the inventory. Values that look like secrets are rejected. |
| `desk_set_variable_value` | `id`, `value` | Changes the expected value in the inventory. |
| `desk_update_variable_meta` | `id`, `description?`, `owner?`, `link?`, `tags?` | Changes descriptive fields. |

### Act (rules of the policy apply)

| Tool | Parameters | Effect |
|---|---|---|
| `desk_request_renewal` | `secretId`, `reason?`, `dryRun?` | Asks for a new value. `dryRun` returns only the plan. In a direct stage the value is created and verified and waits for a human to confirm (**Reviews**); otherwise an approval is created. **Never writes to GitHub itself.** |
| `desk_apply_variable` | `id`, `reason?` | Writes the expected value to GitHub: immediately in a direct stage, otherwise as an approval request. |
| `desk_export_dev_env` | `repo`, `path`, `template?` | Writes a dev `.env` (stage: the first stage of kind `dev`). Returns path, key names and origin, never values; or `needs-input` for keys a human must supply. |

`place` objects are `{ repo, scope: "repository" | "environment" | "organization", environment?, name? }`. `from` objects are `{ type: "default", value }`, `{ type: "generate", kind: "hex" | "base64" | "uuid", bytes }`, `{ type: "issue", secret }`, `{ type: "prompt", hint }` or `{ type: "variable", variable }`.

### Example calls

What expires soon:

```json
{ "tool": "desk_list_secrets", "input": { "status": "due" } }
```

Add a dev secret (stage `dev` is a direct stage by default):

```json
{
  "tool": "desk_add_secret",
  "input": {
    "id": "lead-token-dev", "name": "LEAD_INTAKE_TOKEN", "service": "internal", "stage": "dev",
    "provider": "random-hex", "description": "Local token for the lead intake during development.",
    "owner": "alice", "tags": ["dev"]
  }
}
```

Ask for a renewal, plan first:

```json
{ "tool": "desk_request_renewal", "input": { "secretId": "acme-api-key-acme-app-staging", "dryRun": true } }
{ "tool": "desk_request_renewal", "input": { "secretId": "acme-api-key-acme-app-staging", "reason": "Expires in 5 days" } }
```

In `staging` the second call answers `pending-approval` with an `approvalId`. Follow up with `desk_get_approval` and `desk_list_reviews`; tell the human, do not ask them to confirm in chat.

Compare stages live and look at gaps:

```json
{ "tool": "desk_compare_stages", "input": { "live": true, "kinds": ["secret"], "workflows": true } }
```

Write a dev environment:

```json
{ "tool": "desk_export_dev_env", "input": { "repo": "acme-app", "path": "/home/alice/projects/acme-app/.env.local" } }
```

## Policy

Enforced by the portal ([`agent-api.ts`](../packages/runtime/src/agent-api.ts)), not by the agent:

- An agent may act directly on the stages in `policy.agentStages` (default: all stages of kind `dev`). Everything else only with a human **approval**. A stage of kind `live` always needs an approval, even if the policy lists it. Agents can read the stage definitions; only a human changes them (**Settings**).
- A new value is **never** written immediately: it waits for a **human's confirmation** (**Reviews**). The old value is revoked only after that.
- Agents do not confirm or reject, do not enter values, do not set connections, do not upload attachments, do not overwrite files and do not see local folder paths.
- `.env` files only for stages of kind `dev` that are direct, only inside `policy.envRoots` (or the repository's linked folder), and only named `.env` or `.env.*` (not `.envrc`, `.npmrc`, `Makefile`, shell or script files). The agent receives path and key names, never contents.
- Agents cannot put network targets (`url`, `baseUrl`, `host` ...) into a secret's `params`.
- Input is strict: forbidden fields are rejected, not ignored.

The full rule set with status codes is in the [Agent API reference](AGENT-API.md#approvals-and-policy).

## Browser providers

Providers that create their value through a browser window (id `<recipe>-browser`) are never started by agents: `desk_request_renewal` returns `pending-approval` in every stage, because a window opens on the human's machine. A human approves in the portal and signs in in the window. State and cancellation of a run are portal-only. See [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md).

## Skill

[`skills/secret-desk/SKILL.md`](../skills/secret-desk/SKILL.md) describes the rules and typical flows to the agent: never touch a value, stages, always describe new entries, defaults in `.env` templates only for non-secret values, and how to handle `not-connected` and HTTP 403 errors.

## Limits

- The agent interface is only as strong as its token. An agent with shell access as the same operating-system user can read `~/.secret-desk/agent-token`, `.env` files and the browser profile. Run agents in a separate sandbox or user and give them only the token. See [SECURITY-MODEL.md](SECURITY-MODEL.md#limit-agents-with-shell-access-as-the-same-os-user).
- The MCP client does not request English messages; server messages arrive in German unless you call the HTTP API with `X-Secret-Desk-Lang: en`.
- Some HTTP routes have no MCP tool: `GET repos`, `GET dev-templates`, `GET variables/:id`, `GET approvals` (list), `GET reviews/:id` and `GET evidence/:secretId/:reportId`.
