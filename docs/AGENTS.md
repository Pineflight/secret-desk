# AI agents (MCP and skill)

The MCP server `secret-desk-mcp` is a thin client of the local portal interface (`/api/agent`). It returns **metadata only**.

```json
{ "mcpServers": { "secret-desk": { "command": "node", "args": ["/PATH/TO/secret-desk/packages/mcp/dist/server.js"] } } }
```

The agent token is stored in `~/.secret-desk/agent-token` (created on the portal's first start), or provided via `SECRET_DESK_AGENT_TOKEN`.
The portal must be running (`pnpm dev`).

## Tools
`desk_overview`, `desk_list_stages`, `desk_list_secrets`, `desk_get_secret`, `desk_add_secret`, `desk_update_secret`, `desk_list_providers`, `desk_list_connections`,
`desk_add_provider`, `desk_add_env_template`, `desk_add_env_entry`, `desk_request_renewal`, `desk_list_reviews`, `desk_list_evidence`,
`desk_list_variables`, `desk_variable_status`, `desk_update_variable_meta`, `desk_add_variable`, `desk_set_variable_value`, `desk_apply_variable`, `desk_get_approval`,
`desk_export_dev_env`, `desk_team_export`.

## Policy rules (enforced by the portal, not by the agent)
- An agent may act directly on stages in `policy.agentStages` (default: all stages of kind `dev`); everything else only with a human **approval**. Stages of kind `live` always need an approval, even if the policy lists them. Agents can read stage definitions (`desk_list_stages`); only a human can change them in the portal (Settings).
- A new value is **never** written immediately: it waits for a **human's confirmation** (Reviews tab).
- Agents do not confirm, do not enter values, do not set connections and do not upload attachments.
- `.env` files only for stages of kind `dev` and only inside `policy.envRoots`. The agent receives the path and key names, never contents.

## Skill
`skills/secret-desk/SKILL.md` describes the rules and typical workflows to the agent. Copy it to `~/.claude/skills/secret-desk/` or include it as a plugin.

## Browser providers

Providers that create their value through a browser window (id `<recipe>-browser`) are never started by agents: `renewal-requests` returns `pending-approval`
in every stage, because a window opens on the human's machine. A human approves in the portal and signs in in the window themselves. The state and cancellation
of a run are available in the portal only. See [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md).
