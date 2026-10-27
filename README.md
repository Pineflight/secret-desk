# secret-desk

secret-desk is a local-first portal for keeping track of a team's tokens, secrets and variables. It shows what expires when, issues new tokens at
the providers through their APIs, lets a human review and confirm each new value, and only then writes it straight into the project's GitHub secret
store. Secret values are never persisted by the portal.

## Features

- **Secrets and Variables with expiry:** every secret and variable is listed by stage and status (ok, expiring soon, expired, missing), with description,
  owner, link and tags. Expiry reminders can be raised as issues by a workflow. Variables (`vars.*`) carry an expected value that is compared with GitHub,
  and a guard prevents a secret from ending up as a variable.
- **Two-step issuance:** the provider API generates the token, the portal verifies it (function test, permissions, expiry, targets reachable) and produces a
  review report with an evidence image. A human ticks the review items (optionally with their own screenshot). Only then is the value written to GitHub and the old
  one revoked. Rejecting deletes the new value at the provider again. Providers without an API use the same flow with a manual paste.
- **Freely configurable stages:** define your own stages (default `dev`, `staging`, `production`, `shared`); behavior follows the stage `kind`, not its name.
- **Stage comparison:** one matrix of all secrets and variables against all stages (`/vergleich`, `desk_compare_stages`): what is expected, what really exists in GitHub (optional live check), where a stage has a gap, plus names that only exist in GitHub. Read-only, never values.
- **Dev `.env` export:** per-repository templates produce the file on demand (defaults, random values, personal dev tokens, variables) with mode 600, stored nowhere.
- **Repositories:** link repositories from the inventory and GitHub to local folders (links stay on your machine, never in the inventory).
- **Team file:** export the configuration without values, so new team members import it, connect their accounts and start.
- **MCP server and skill for AI agents:** agents maintain metadata, query status and request renewals. They never see values and never confirm.
- **Browser automation:** for providers without an API, a visible Chrome walks through the form; sign-in, 2FA and CAPTCHA stay with the human.
- **Test connection:** every integration card has a button that checks the token with read-only calls (valid, expiry, permissions). For GitHub an opt-in write test creates and immediately deletes a probe secret in the targets you choose. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Bilingual UI:** German and English.
- **Encrypted local vault** for integration tokens (OS keychain, DPAPI on Windows, or a key file).

## Security principles

- Values are held in memory only, for at most 15 minutes, and passed on in exactly two places: the provider API and, encrypted, GitHub.
- The portal listens on `127.0.0.1` only.
- Values live only in the GitHub secret store; reports, logs, errors and responses never contain a value (only a short fingerprint).
- Agents get metadata, never values, and a human always confirms.

Details: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## Quick start

Requirements: Node 24 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
```

**Demo without accounts** (simulated GitHub, made-up data; works on macOS, Linux and Windows):

```bash
pnpm demo
```

`pnpm demo` sets `SECRET_DESK_DEMO=1` and `SECRET_DESK_CONFIG` itself (script `scripts/demo.mjs`) and serves the portal at http://127.0.0.1:4747.
By hand, depending on your shell:

```bash
# bash / zsh
SECRET_DESK_DEMO=1 SECRET_DESK_CONFIG=$PWD/examples/demo/secret-desk.config.yaml pnpm dev
```
```powershell
# PowerShell
$env:SECRET_DESK_DEMO = "1"; $env:SECRET_DESK_CONFIG = "$PWD\examples\demo\secret-desk.config.yaml"; pnpm dev
```
```bat
:: cmd
set SECRET_DESK_DEMO=1 && set SECRET_DESK_CONFIG=%CD%\examples\demo\secret-desk.config.yaml && pnpm dev
```

**Your own configuration:** copy the examples and adapt them.

```bash
# macOS / Linux
cp examples/secret-desk.config.example.yaml secret-desk.config.yaml
cp examples/inventory.example.yaml inventory.yaml
```
```powershell
# PowerShell
Copy-Item examples\secret-desk.config.example.yaml secret-desk.config.yaml
Copy-Item examples\inventory.example.yaml inventory.yaml
```
```bat
:: cmd
copy examples\secret-desk.config.example.yaml secret-desk.config.yaml
copy examples\inventory.example.yaml inventory.yaml
```

Then run `pnpm dev` (http://127.0.0.1:4747). Provider access tokens are entered per session in the portal, or the configuration points to environment
variables or 1Password (`op://...`); never put the value in the file.

Clean up with `pnpm clean` (build output) or `pnpm clean --deps` (also `node_modules`).
CLI: `node packages/cli/dist/bin.js help` (commands: `check`, `status`, `renew`, `vars`, `env export`, `team`, `vapid`).

## Repository layout

```
packages/core        inventory, status, GitHub upload, review flow, variables, dev export, team file
packages/providers   providers: Cloudflare, Supabase, Stripe webhook, Resend, Grafana, random values, manual guides
packages/automation  browser automation for providers without an API
packages/runtime     shared operations and policy for portal, CLI and MCP
packages/cli         command line
packages/mcp         MCP server for AI agents
apps/desk            the portal (Next.js, local only)
skills/secret-desk   skill for agents
```

## Platforms

secret-desk runs on **macOS, Linux and Windows 10/11** (portal, CLI, MCP server, browser automation). Development and real-world testing so far happen on
macOS; Linux and Windows behavior is covered through simulated platforms (injected `platform`/commands, `path.win32`). The manually triggered
`Cross-Platform` workflow (GitHub Actions, `workflow_dispatch`) runs on real runners.

| | macOS | Linux | Windows 10/11 |
|---|---|---|---|
| Requirements | Node 24, pnpm | Node 24, pnpm | Node 24, pnpm (PowerShell 5.1 or newer is included) |
| Vault key | Keychain (`security`) | `secret-tool` (libsecret, for example GNOME Keyring/KWallet); otherwise `SECRET_DESK_VAULT_KEY` or `vault.keyFile` | DPAPI (bound to the Windows account), blob in `<vault>.key` |
| Browser automation | Chrome, Chromium, Edge | Chrome/Chromium/Edge as a distribution package; Snap/Flatpak are sandboxed and often do not work | Chrome or Edge (Program Files, Program Files (x86), `%LOCALAPPDATA%`) |
| File permissions | chmod 600/700 | chmod 600/700 | no POSIX modes: protection through the user profile (ACL) |
| Demo | `pnpm demo` | `pnpm demo` | `pnpm demo` |

Known limits:
- **Windows:** network paths (`\\server\share`) and `\\?\` paths are rejected, as are reserved names (`CON`, `NUL`, `COM1` ...). Folder links
  require a local drive path below the user folder or `policy.envRoots`. The vault key cannot be moved to another machine or account (by design);
  enter a new token there.
- **Linux without a keyring** (servers, containers, WSL without D-Bus): the vault reports this clearly and stores nothing in plain text. Set
  `SECRET_DESK_VAULT_KEY` (`openssl rand -base64 32`) or point `vault.keyFile` to a key file with mode 600.
  Note: with `vault.keyFile`, key and data sit on the same disk; this only protects the file system.
- **WSL** counts as Linux: home folder, keyring and Chrome are those of the Linux side, not of Windows.
- Paths in `secret-desk.config.yaml` may use `~` (and `~\` on Windows). Put YAML paths with backslashes in single quotes
  (`'C:\path\to\projects'`) or use forward slashes (`C:/path/to/projects`).
- Line endings: `.gitattributes` enforces LF; on Windows no `core.autocrlf` is needed.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the path of a value, data, stages, repositories and links, packages
- [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md): what is protected and how
- [docs/PROVIDERS.md](docs/PROVIDERS.md): supported providers and how well each endpoint is verified
- [docs/AGENTS.md](docs/AGENTS.md): MCP server, skill and the policy for AI agents
- [docs/TEAM.md](docs/TEAM.md): sharing the configuration and onboarding
- [docs/BROWSER-AUTOMATION.md](docs/BROWSER-AUTOMATION.md): browser recipes for providers without an API
- [docs/TRIAL-RUN.md](docs/TRIAL-RUN.md): first use with real services (throwaway repo, `doctor` pre-check, acceptance list)

## Project status

Early version. Several provider endpoints were implemented from documentation or memory and are only tested against mocks (see
[docs/PROVIDERS.md](docs/PROVIDERS.md)); try each provider with a throwaway token before real use. The browser recipes have not been checked against the live
provider pages (see [docs/BROWSER-AUTOMATION.md](docs/BROWSER-AUTOMATION.md)). Real-world testing so far happened on macOS.

## Contributing

Run `pnpm verify` (build, typecheck, tests) before opening a pull request, and add tests for changes. Browser recipes are YAML files under `recipes/`
and can be contributed through pull requests; see [docs/BROWSER-AUTOMATION.md](docs/BROWSER-AUTOMATION.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). Copyright (c) Niklas Lurse (Pineflight).
