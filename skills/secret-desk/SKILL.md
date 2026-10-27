---
name: secret-desk
description: Use when you need to add, rename, expire or renew a token, key or secret for a project, set up the dev .env of a repo, check what is about to expire, or onboard a teammate. Works through the secret-desk MCP tools (desk_*), never touches secret values, and respects stages (such as dev, staging, production). Auch auf Deutsch - Token, Schluessel oder Secret erneuern, Ablauf pruefen, .env einrichten.
---

# secret-desk for agents

secret-desk manages a team's tokens and secrets: keeping an eye on expiry, generating at the provider, and writing into the project's
GitHub secret store. **Values are never stored in the portal and never handed to agents.** You work
with metadata and file requests.

## Rules that always apply

1. **Never touch a value.** You do not receive one, you do not query one, and you do not ask the human to name one in chat.
   You do not read a generated `.env` and you do not repeat its contents.
2. **Stages:** you may touch `dev` directly (metadata and local `.env`). Other stages (such as `staging` and `production`) never trigger immediately:
   `desk_request_renewal` and `desk_apply_variable` create an approval request there, which a human grants in the portal. Even a new value
   is never written immediately: it is generated, reviewed, and waits for a human's confirmation (review report, evidence). Tell the human about the request and do not ask
   for the confirmation in chat.
3. **Never touch `production` without the human's explicit instruction** and never as a side effect of another task.
4. **New entries only with targets:** apart from `dev`, every entry needs `places` (repo, `repository` or `environment` with a name).
5. **Names:** `id` in lowercase-with-hyphens, `name` in UPPERCASE_WITH_UNDERSCORES. One secret per stage and repo group; staging and
   production never share a secret.
6. **Always describe new entries:** `description` (what it is for, where it is used, 1-2 sentences), `owner` and, if available, `link` to the provider page or docs, plus 1-3 `tags` (lowercase-with-hyphens). Applies to secrets and variables. Ask the human if you do not know the purpose instead of making something up.
7. **Defaults in `.env` templates** only for non-secret values (URLs, flags). Everything secret is `generate`, `issue` or `prompt`.

## Typical flows

**What expires soon?** `desk_overview`, then `desk_list_secrets` with `status: due` or `soon`. Summarize what needs to be done
(provider, target, guide for manual ones).

**New secret for a project:**
1. `desk_list_providers` (is there an automatic provider? otherwise `manual`), `desk_list_connections` (is the connection established?).
2. `desk_add_secret` with stage, target and provider, plus `ttlDays`/`expires` if the provider has an expiry.
3. Automatic: `desk_request_renewal` (dryRun first). Manual: give the human the `guide` from `desk_get_secret`; they enter the value in the portal.

**New provider without an API:** `desk_add_provider` with a URL and steps, then entries with `provider: <id>`.

**Dev environment of a repo:**
1. `desk_export_dev_env` with `repo` and `path` (the repo's folder, which must be within the portal's approved roots).
2. Response `needs-input`: tell the human the missing keys; they enter them in the portal or with `secret-desk env export`.
3. Response `written`: pass on only the key names. Heed the Git warning (`.gitignore`).
4. If a template is missing: `desk_add_env_template`, then repeat.

**New team member:** `desk_team_export` returns the configuration without values. They import it with `secret-desk team import`, connect their accounts
and generate their dev files.

**Variables (vars.*, configuration, not secret):** `desk_list_variables`, `desk_variable_status` (target vs. actual in GitHub),
`desk_add_variable` / `desk_set_variable_value` / `desk_update_variable_meta` (target value and description in the inventory), `desk_apply_variable` (to GitHub). Never create a secret as a variable:
it is readable there in plain text. Keys, tokens and passwords belong in a secret. The portal rejects values that look like keys.

**Evidence:** `desk_list_reviews` shows what is waiting for a human's confirmation, `desk_list_evidence` the earlier review reports of a secret.

## Errors

- `Portal nicht erreichbar` (portal unreachable): the portal is not running (`pnpm dev` in the secret-desk repo); tell the human.
- `not-connected`: the human has to establish the connection in the portal under Integrations.
- HTTP 403 on a stage: you may not touch this stage directly; file a request.
