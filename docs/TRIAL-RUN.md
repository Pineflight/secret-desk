# Trial run with real services

Goal: try every path once with **real** accounts without touching anything important. Everything goes into the throwaway repository
`YOUR-ORG/secret-desk-sandbox` (private, empty, environment `staging`; replace `YOUR-ORG` with your GitHub account or organization everywhere below). Nothing there needs protecting.
Already verified (self-test against the real GitHub, 27 Oct 2026): encryption, creating, overwriting and deleting secrets
and variables on the repository and on the environment.

Tip: in the portal, every manual secret has an "Open the provider's page with presets" button. For GitHub, name, owner, expiry and permissions (`params.permissions` in the inventory) are prefilled; you only pick the repository yourself. For the first token (secret-desk itself) use this link:
`https://github.com/settings/personal-access-tokens/new?name=secret-desk-sandbox&description=secret-desk+trial+run&target_name=YOUR-ORG&expires_in=7&secrets=write&actions_variables=write&environments=read&metadata=read`

## 0. What to create beforehand (everything short-lived and with minimal permissions)

| What | Where | Permissions | Expiry |
|---|---|---|---|
| **GitHub token for secret-desk** | GitHub, Settings, Developer settings, Fine-grained tokens | Resource owner `YOUR-ORG`, **only repo `secret-desk-sandbox`**; Secrets: Read and write, Variables: Read and write, Environments: Read, Metadata: Read | 7 days |
| **Cloudflare bootstrap token** (test B only) | Cloudflare, My Profile, API Tokens, Custom token | **User > API Tokens > Edit** (nothing else) | 1 day |
| **Cloudflare account ID** (test B) | Cloudflare dashboard, account, "Copy account ID" | none | none |
| **Throwaway token to paste in** (test C, optional) | GitHub, fine-grained token, resource owner your own account, **no** permissions except Public Repositories (read-only) | none | 1 day |

Keep the values in 1Password or in environment variables, never in files and never in chat.

## 1. Prepare

On Windows (PowerShell), instead of `export` use `$env:SECRET_DESK_GITHUB_TOKEN = "..."`, instead of `~` the folder `$HOME`, and instead of `mkdir -p`/`cp`/`rm -rf` use `New-Item -ItemType Directory`, `Copy-Item`, `Remove-Item -Recurse -Force`. The commands below are bash.

Copy the templates: `mkdir -p ~/.secret-desk/trial && cp examples/trial/config.example.yaml ~/.secret-desk/trial/secret-desk.config.yaml && cp examples/trial/inventory.yaml ~/.secret-desk/trial/`

```bash
cd path/to/secret-desk                              # built with: pnpm install && pnpm build
export SECRET_DESK_GITHUB_TOKEN=...                 # token from row 1
export SECRET_DESK_CLOUDFLARE_TOKEN=...             # token from row 2 (test B only)
```

In `~/.secret-desk/trial/inventory.yaml`, replace the line `accountId: YOUR_CLOUDFLARE_ACCOUNT_ID` under `trial-cloudflare`.
Without Cloudflare, simply drop `trial-cloudflare` and skip test B.

## 2. Pre-check (reads only, writes nothing)

```bash
node packages/cli/dist/bin.js doctor --config ~/.secret-desk/trial/secret-desk.config.yaml
```

Expected: `[ok  ]` for the inventory, the github connection, the targets `secret-desk-sandbox/env:staging` and `.../repo`, "active" for Cloudflare,
and finally a message that the setup is ready for the trial run. On `[fail]` the reason is shown next to it (missing permission, wrong repo).

## 3. Start the portal

```bash
SECRET_DESK_CONFIG=~/.secret-desk/trial/secret-desk.config.yaml pnpm dev      # http://127.0.0.1:4747
```

## 4. Acceptance checklist

| # | Test | Steps | Expectation |
|---|---|---|---|
| A | Flow without a provider | Secrets, `SD_TRIAL_RANDOM`, "Generate new value" | Review page with evidence image, finding "Target reachable with write access", checklist. The button is enabled only after all boxes are ticked. After "Confirm": the secret `SD_TRIAL_RANDOM` exists in the sandbox repo under Environments > staging (`gh secret list -R YOUR-ORG/secret-desk-sandbox --env staging`). The secret shows "Last confirmed by ...". |
| B | Real provider | `SD_TRIAL_CLOUDFLARE`, "Generate new value" | Findings "Token active", "Permissions exact: Account Settings Read", "Account only ...", expiry in 7 days. **In the Cloudflare dashboard** (My Profile, API Tokens) there is now a token named `trial-cloudflare-<date>` with exactly this one permission. Before confirming, **nothing** has been written to GitHub. After confirming, `SD_TRIAL_CLOUDFLARE` exists in the sandbox repo. |
| B2 | Revoke the old value | Repeat B | After confirming, the report says "Old value revoked at the provider", and in the Cloudflare dashboard the **first** token is gone and the second one is there. |
| B3 | Reject | Start B, "Reject and delete new value" | The new token is **gone again** from the Cloudflare dashboard, nothing is written to GitHub, and the secret still shows the old state. |
| C | By hand | `SD_TRIAL_MANUAL`, "Paste value", paste the throwaway token | Findings "works (login name)" and the expiry date from GitHub's response; the field is cleared; after confirming, the secret exists in the repo. |
| D | Variables | Variables, `SD_TRIAL_URL`: "Compare with GitHub" -> "Missing in GitHub"; "Set in GitHub"; compare again -> matches; change the target value -> "Differs" | The variable appears under environment staging. |
| D2 | Import | In GitHub (browser) set `SD_TRIAL_FLAG` as a repository variable, then in the portal "Import from GitHub" | The target value is filled in. |
| D3 | Secret guard | Set `SD_TRIAL_URL` to a value starting with `sk_live_` followed by 24 letters | Rejected: "This looks like a secret". |
| E | Dev `.env` | Dev environment, template `trial-dev`, path `~/secret-desk-trial/.env.local`, enter a test value | File with mode 600 (`ls -l`), variable and random value inside, only key names shown in the portal. |
| F | Agent (optional) | Connect the MCP server, `desk_request_renewal` for `trial-random` | An approval is created (staging); nothing is written until you approve in the portal **and** confirm. |
| G | History | Open the secret `trial-random` | Two reports with evidence image and confirmation. |

## 5. Clean up

```bash
gh repo delete YOUR-ORG/secret-desk-sandbox --yes            # needs the delete_repo permission, otherwise use the browser
rm -rf ~/.secret-desk/trial ~/secret-desk-trial
```

Also: revoke the Cloudflare token `trial-cloudflare-*` and the bootstrap token, and delete the GitHub token for secret-desk and the throwaway token.

## 6. If something goes wrong

Send the output of `doctor` and the message from the portal (never a value). Deviations in the Cloudflare findings (names of the permission groups,
field `expires_on`) are especially interesting: so far they are implemented from the documentation only.
