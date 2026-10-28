# Troubleshooting

Messages are quoted as the English portal shows them. Nothing below ever requires you to look at a secret value; if a fix seems to, stop and report it as a bug.

- [403 Resource not accessible by personal access token](#403-resource-not-accessible-by-personal-access-token)
- [404 not found or not shared with the token](#404-not-found-or-not-granted)
- [Launch required, 401 and the launch secret](#launch-required-401-and-the-launch-secret)
- [Host not allowed, port in use](#host-not-allowed-port-in-use)
- [Vault and keychain](#vault-and-keychain)
- [Chrome not found or the browser run fails](#chrome-not-found-or-the-browser-run-fails)
- [Windows paths and links](#windows-paths-and-links)
- [Folder links and `.env` export](#folder-links-and-env-export)
- [Provider and approval problems](#provider-and-approval-problems)
- [Compare shows errors](#compare-shows-errors)
- [Agents](#agents)
- [Build and tests](#build-and-tests)

## 403 Resource not accessible by personal access token

GitHub refuses a write: the token lacks a permission. The portal reports "GitHub denied access. Check the permissions of the GitHub token." (HTTP 502 with code `github-denied`) and **Test connection** names the cause.

Fix: a fine-grained token needs, on the repositories you manage, **Secrets: Read and write**, **Variables: Read and write**, **Environments: Read and write** and **Metadata: Read**. The usual culprit is **Environments**: with only *Read* the write of an **environment** secret fails with exactly this message. Edit the token on GitHub (Settings, Developer settings, Fine-grained tokens), set Environments to *Read and write*, and test again. See [GETTING-STARTED.md](GETTING-STARTED.md#5-create-a-github-token-with-the-exact-permissions).

For organization secrets the token additionally needs the organization permission *Secrets* (Read and write). In GitHub App mode the installation token has `secrets: write`, `environments: read` and `metadata: read` only: variables are not available there.

## 404 not found or not granted

"Not found or not granted (HTTP 404). The repository or environment must exist and be granted to the token." Check:

- The repository name and `github.owner` are right (and the repository was not renamed, see the *Repositories* page).
- The token's repository selection includes the repository ("Only select repositories").
- The **environment exists** in GitHub (Settings, Environments) with the name the stage derives, see [STAGES.md](STAGES.md#environment-derivation).

`secret-desk doctor` checks every target and names the reason per target.

## Launch required, 401 and the launch secret

The portal prints an address like `http://127.0.0.1:4747/?launch=<secret>` in the terminal where it started. It hands out a browser session **only** to someone who presents that secret. If you open `http://127.0.0.1:4747` without it you see "Launch address required: open the address with ?launch=... from the terminal where secret-desk was started" (HTTP 401, code `launch-required`).

- Open the exact printed address. The secret is regenerated on every start, so an old bookmark stops working.
- The page removes `?launch=...` from the address bar after the first load; reloading is fine, the session cookie keeps working.
- A second browser or private window needs the launch address again.
- For demos and development only: `SECRET_DESK_NO_LAUNCH_SECRET=1` turns the check off (`pnpm demo` does).

## Host not allowed, port in use

- "Host not allowed" (403): the portal only accepts `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` as host. Reaching it through another host name, a proxy, a tunnel or a container port mapping fails by design (DNS rebinding protection).
- **Port 4747 is in use.** The `dev` and `start` scripts bind port 4747. Another secret-desk (or anything else) may hold it. Pick another port and keep both places in sync:

```bash
pnpm --filter @secret-desk/desk exec next dev -H 127.0.0.1 -p 4800
```

and in the configuration `server: { port: 4800 }`. Point the MCP server at it with `SECRET_DESK_URL=http://127.0.0.1:4800`. The configuration's port is what the Host check expects; if it differs from the port Next.js listens on, every request is "Host not allowed".

## Vault and keychain

| Message | Cause and fix |
|---|---|
| "SECRET_DESK_VAULT_KEY is missing or is not a 32-byte key in Base64." | The variable is set but invalid. Create one: `openssl rand -base64 32`. |
| "secret-tool (libsecret) is not available." / "secret-tool cannot reach the keyring ..." | Linux without a keyring (server, container, WSL without D-Bus). Install libsecret and run GNOME Keyring or KWallet with a D-Bus session, **or** set `SECRET_DESK_VAULT_KEY`, **or** set `vault.keyFile` (Base64 key, mode 600; key and data then sit on the same disk). The vault never falls back to plain text. |
| "The macOS keychain is unreachable, locked or access was denied. Nothing is overwritten." | Unlock the keychain or allow access. secret-desk creates a new key only when the item is reported missing; otherwise it would make every stored token unreadable. |
| "The keychain entry secret-desk/vault-key does not contain a valid key. It is not overwritten." | The entry was changed by hand. Restore it, or delete the entry and the vault file and re-enter your tokens. |
| Windows: key file cannot be opened with DPAPI | The blob `<vault>.key` belongs to another Windows account or machine. By design it cannot be moved; delete it and the vault and enter the tokens again. It is never overwritten automatically. |
| A damaged `vault.json` | A copy is kept as `vault.json.corrupt-<time>`; the original is not overwritten. |
| A token shows as expired or unreadable | Enter it again on **Integrations**. An expired token never falls back silently to another source. |

The vault is optional: `vault.enabled: false` keeps tokens in memory for the session only.

## Chrome not found or the browser run fails

- "Chrome not found ..." (with the hint to set `automation.chromePath` or install Google Chrome). secret-desk drives your installed Chrome, Chromium or Edge and downloads nothing. Install one, or set `automation.chromePath` (or `--chrome-path` for the CLI). Check with `secret-desk browser doctor`.
- **Linux:** Snap and Flatpak browsers are sandboxed and often cannot be driven. Use the distribution package (`google-chrome`, `chromium`) or the `.deb` from Google.
- **Containers without user namespaces:** Chrome is always started with its sandbox enabled and there is deliberately no switch to turn it off; run secret-desk outside such a container.
- `playwright-core` missing: it is an optional dependency; run `pnpm install`.
- A run waits for you: sign-in, 2FA and CAPTCHA are yours. It aborts after `automation.loginTimeoutMinutes` (default 10).
- "A browser run is already in progress (secret ...). Wait for it or cancel it first.": only one browser run at a time. Cancel the running one on the secret's page.
- A step fails ("Step 3 (...) failed"): the provider's page changed or the recipe was never verified. Do a dry run and see [RECIPES.md](RECIPES.md#testing). If a token had already been created, its name is in the message: delete it at the provider.

## Windows paths and links

- Network paths (`\\server\share`) and `\\?\` paths are rejected; use a local drive path.
- Reserved names (`CON`, `NUL`, `COM1`, ...) and the characters `< > : " | ? *` are rejected.
- In YAML, put backslash paths in single quotes (`'C:\path\to\projects'`) or use forward slashes (`C:/path/to/projects`).
- Folder links must be below your user folder or a folder in `policy.envRoots`, possibly on another drive: add that drive's folder to `envRoots`.
- Files outside your user profile inherit the folder's ACL; secret-desk cannot set POSIX modes on Windows. Check permissions of `.env` files yourself.

## Folder links and `.env` export

- "The folder is outside the home folder and the allowed folders (policy.envRoots)." Add a parent folder to `policy.envRoots`.
- "The folder is not a Git repository (.git is missing)."
- A warning "The remote origin ... does not point to owner/name" is only a warning; check that you linked the right folder.
- Export fails with "outside the allowed folders" for a path: it must lie inside `policy.envRoots` or the repository's linked folder.
- "File already exists: <path>": use *Overwrite existing file* (`--overwrite`); agents can never overwrite.
- The portal warns when Git does not ignore the written file: add it to `.gitignore` before committing anything.
- `needs-input` / "Inputs missing": the template has `prompt` entries; fill them in (portal fields, `--prompt KEY=VALUE`, or `SECRET_DESK_PROMPT_<KEY>`).

## Provider and approval problems

- "The provider denied access. Check the token and its permissions." (502, `provider-denied`): the integration token lacks a permission; see [INTEGRATIONS.md](INTEGRATIONS.md) and use **Test connection**.
- "The provider is rate limiting requests. Please try again later." (429).
- A `not-connected` error (409), whose message names the connection: connect the integration on **Integrations**. Session tokens are lost when the portal restarts.
- A new value waits for confirmation and then disappears: reviews expire after **15 minutes**; the new value is deleted at the provider again. Generate a new one.
- An approval turned `stale`: the entry changed after it was requested; ask again.
- Approvals and open reviews live in memory; a portal restart clears them.
- A variable value is rejected "Looks like a ...": it resembles a secret. Create it as a secret. If it really is public (a site key), a human acknowledges it in the portal (`--ack-public` in the CLI); clear secret formats are always refused.
- Provider endpoints that were only tested against mocks may fail in unexpected ways; see [PROVIDERS.md](PROVIDERS.md) and try with a throwaway token first.

## Compare shows errors

- An `error` cell with HTTP 403: the token cannot read that target (Secrets or Environments missing, or the repository is not shared with the token).
- HTTP 429: GitHub's rate limit; wait and reload. Use *All repositories* sparingly on big organizations.
- "token needs Contents: Read, or link the repository locally" for workflows: add the optional permission or link the repository to a local folder.
- A repository you do not care about appears (`.github`, an Upptime `status` repository): add it to `compare.ignoreRepos`.

## Agents

- "Portal not reachable ... Is it running? (pnpm dev)": start the portal; check `SECRET_DESK_URL`.
- "No agent token found": open the portal once so it creates `~/.secret-desk/agent-token`, or set `SECRET_DESK_AGENT_TOKEN`.
- 401 from the agent API: the token is wrong or was regenerated; restart the MCP server so it re-reads the file.
- "Stage ... needs an approval in the portal (Approvals tab)." arrives as a `pending-approval` result, not as an error: by design; a human approves under **Approvals**.
- 400 "Field not allowed: ...": agents may only change descriptive metadata ([AGENT-API.md](AGENT-API.md)).

## Build and tests

- Node older than 24: `pnpm install` warns (`engines`); upgrade Node.
- Typecheck or tests fail after pulling: run `pnpm install && pnpm build`, because packages consume each other's `dist`.
- `pnpm clean` removes build output, `pnpm clean --deps` also `node_modules`.
- Line endings on Windows: `.gitattributes` enforces LF; no `core.autocrlf` is needed.
