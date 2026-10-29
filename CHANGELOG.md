# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **English naming:** the portal routes are now `/settings`, `/approvals`, `/reviews`, `/reviews/:id`, `/variables`, `/connections` and `/compare`; the new-entry query parameter is `new=1`. All test names are English, and `assets/logo-protokoll.json` became `assets/logo-log.json` with English keys.
- **Migration:** the old German routes (`/einstellungen`, `/freigaben`, `/pruefen`, `/variablen`, `/verbindungen`, `/vergleich`) redirect permanently with the query string kept, and `?neu=1` is still accepted. Inventory, config and team files already used English keys, so nothing needs to be migrated there; bookmarks keep working through the redirects.

### Fixed

- Container starts without internet access: `CMD` runs `next start` directly instead of `pnpm` (corepack no longer downloads pnpm at start).
- The launch address is printed when the server starts (`instrumentation.ts`), not at the first API call.
- Release workflow: image references in the manifest job are lowercased (`Pineflight/...` made `imagetools create` fail); annotations are set on the index only and the step also works with none.
- Cloudflare permission groups with the same name for different scopes (for example account and zone) are listed once, with their scopes combined, instead of twice.
- Grafana integration link: `https://grafana.com/profile/org` instead of `https://grafana.com/orgs` (404 without an org slug); with a known stack address the card links to `<baseUrl>/org/serviceaccounts`.

### Added

- **About and licenses:** the portal shows "created by Pineflight", the version and links in the sidebar footer and has an **About** page (`/about`: version and build, MIT license text, source, security, issues, privacy statement, open-source components with licenses). `THIRD-PARTY-NOTICES.md` and `apps/desk/third-party.json` are generated offline by `scripts/licenses.mjs`; CI checks the license policy and that they are current. CLI: `secret-desk about` and `--version`; the MCP server reports its real version. Docker: build arguments `SECRET_DESK_VERSION`, `SECRET_DESK_BUILD_TAG`, `SECRET_DESK_COMMIT`, OCI labels vendor/authors/url/documentation, `LICENSE` and `THIRD-PARTY-NOTICES.md` in `/licenses`, `NEXT_TELEMETRY_DISABLED=1`.

- **Mapping repositories to resources:** an explicit, human-maintained `resourceMap` in the inventory (`kind`, `repo`, optional `stage`, `value`, optional `label`) takes precedence over the name rules of the resource suggestions (reason *Mapping*), so Resend domains and similarly named Supabase projects can be suggested unambiguously. A mapped value the provider no longer lists gives no suggestion and a `mapMismatch` hint. Portal routes `GET`/`PUT`/`DELETE /api/ui/resource-map` (humans only), a mapping section in **Resources and defaults**, and *Remember for <repo>* after choosing a resource. Part of the team file. See [docs/RESOURCES.md](docs/RESOURCES.md).
- **Provider parameters:** every provider declares its parameters (`Provider.params`); entries are validated before any provider call (`400` / `params_invalid` with the missing keys instead of a misleading provider error), also when creating a secret. Read-only discovery of accounts, projects, zones and domains from the connected integration, at most one never-applied suggestion by repository and stage, a read-only preflight that names the chosen resource (`409` / `preflight_failed` on a sure mismatch), non-secret integration defaults, zone-bound Cloudflare permissions with presets, and `domainId` required for Resend `sending_access`. New portal routes are listed in `apps/desk/API.md`; agents only see `params: { status, missing }` per secret.
- **Variables from sources:** `from: { connection, kind, resource, field }` on variables, a fixed allowlist of public fields, `POST variables/:id/load-from-source` (proposal, then `apply`), `POST variables/suggest-all`.
- **Parameters in the portal:** a **Parameters** card on every secret (choose from the list or enter by hand, suggestion with a click, presets, status, preflight result); the same section in the create dialog; **Generate new value** is locked with a plain explanation while required parameters are missing; a *Parameters missing* badge and filter on the Secrets list; the dry run shows parameters and the chosen resource. Documented in [docs/RESOURCES.md](docs/RESOURCES.md).
- **Complete parameters:** a dialog on the Secrets page that reads the connected integrations once and proposes unambiguous values for all entries with missing parameters, applied per entry or all at once, only on click.
- **Resources and defaults:** per integration card, the accounts, projects, zones, domains and service accounts the token can read (with a hint and a way out when a list is not readable) and the non-secret defaults (Cloudflare `accountId`, Grafana `baseUrl`).
- **Variables from a provider:** a **Load from provider** section in the variable dialog and **Suggest values from providers** on the Variables page, comparing stored sources with what the provider reports now; applying changes the inventory only.
- **Team sync:** `teamSync` configuration, the connection `team-sync` and a Team page section keep the team file in a private GitHub repository (read with a preview before taking over, conflict handling, optional push as pull request or direct commit after a confirmation). First-start wizard (GitHub repository, file upload or start empty); a missing `SECRET_DESK_CONFIG` file is created instead of failing; headless setup with `SECRET_DESK_TEAM_REPO`, `SECRET_DESK_TEAM_PATH`, `SECRET_DESK_TEAM_BRANCH` and `SECRET_DESK_TEAM_TOKEN`. CLI: `team status|pull|push`. Agents can read the status only.
- `SECRET_DESK_LAUNCH_SECRET_FILE`: optional path of a file (mode 600) that keeps the launch secret stable across restarts. Without it the secret is new at every start, as before.
- Docker guide: where to find the launch address, `.local` name with a Caddy reverse proxy (HTTP).
- The launch-required message now also names `docker compose logs secret-desk`.
- Docker guide: configuration file in the volume (`SECRET_DESK_CONFIG`), minimal container configuration, mDNS host name, restart behavior and a health check.
- `SECRET_DESK_ALLOWED_HOSTS`: comma-separated extra `host:port` values accepted by the portal host and origin checks, so it can be reached over a LAN address. Default unchanged (loopback only).
- Release workflow checks that the image manifest lists both platforms and sets source, description and license labels; pull requests build the Dockerfile (amd64, no push).
- Docker image for `linux/amd64` and `linux/arm64` built natively per platform (`ubuntu-latest`, `ubuntu-24.04-arm`), tagged `<tag>-amd64`, `<tag>-arm64`, `latest-amd64` and `latest-arm64`, and combined into a multi-arch manifest for `<tag>` and `latest` with OCI annotations.
- [docs/DOCKER.md](docs/DOCKER.md): running the portal on a Raspberry Pi with compose and automatic updates.
- Release workflow: every run on `main` verifies, publishes a GitHub release (`v<version>-<run number>`) and a Docker image to `ghcr.io/pineflight/secret-desk`.
- `Dockerfile`. Publish the port to the host loopback only: `docker run --rm -p 127.0.0.1:4747:4747 -v secret-desk-data:/data ghcr.io/pineflight/secret-desk`.

## [0.1.0] - 2026-10-28

Initial release.

### Added

- **Inventory and status:** metadata-only inventory (`inventory.yaml`) of secrets, variables, stages, dev templates and custom providers; expiry status (ok, soon, due, expired, missing, no date) with configurable thresholds; offline `secret-desk check` and a workflow template that raises expiry issues.
- **Two-stage issuance with review evidence:** the provider API creates a value, the portal verifies it (function test, permissions, expiry, reachable targets), builds a review report with an evidence image and optional screenshot attachment, and writes to GitHub only after a human ticks the checklist. The old value is revoked after the write; rejecting deletes the new value at the provider again. Manual paste for providers without an API.
- **Providers:** random values (hex, base64, UUID), Cloudflare tokens and Turnstile secrets, Supabase API keys, Stripe webhook secrets (sandbox and live connections kept apart), Resend API keys, Grafana service-account tokens, and guides for GitHub fine-grained tokens, Supabase access tokens, Stripe restricted keys, OpenAI and Telegram bots.
- **Freely configurable stages:** stage `kind` (`dev`, `test`, `live`, `shared`) drives behavior; GitHub environment derived from the stage; Settings page; stages travel in the team file.
- **Variables:** `vars.*` with expected values, drift status against GitHub, apply and adopt, quick row actions, and a guard against putting secrets into variables.
- **Compare:** matrix of secrets and variables against stages and repositories with live read-only checks, parity, orphans, all repositories of the organization, what workflows need (`secrets.*`, `vars.*`), level differences, optional references, ignored repositories and detection of renamed repositories with an inventory rename.
- **Repositories and local links:** repository selection, local folder links stored outside the inventory, local search, default `.env` paths from links.
- **Integrations:** per-provider permission guides, a prefilled GitHub token link, a read-only **Test connection**, an opt-in **write test** for GitHub, and expiry tracking of access tokens.
- **Encrypted vault** for integration tokens (AES-256-GCM) with the key in the OS keychain (macOS Keychain, Linux `secret-tool`, Windows DPAPI) or a key file.
- **Browser automation:** YAML recipes driving a visible system Chrome through Playwright for providers without an API (`github-fine-grained-token`, `supabase-access-token`, `stripe-restricted-key` scaffold); `browser doctor` and `browser run --dry`.
- **Dev `.env` export** from per-repository templates (defaults, random values, personal dev tokens, variables, prompts), mode 600, never stored.
- **Team file** export and import without values.
- **Agents:** MCP server with 24 tools, a skill, and an HTTP agent API with an approval flow for everything outside `policy.agentStages`.
- **Portal:** Overview, Secrets, Variables, Compare, Repositories, Reviews, Approvals, Dev environment, Integrations, Team and Settings; German and English UI; searchable select fields.
- **CLI:** `doctor`, `check`, `status`, `renew`, `vars`, `env export`, `team`, `browser`, `vapid`.
- **Platforms:** macOS, Linux and Windows hardening (path rules, file permissions, platform-specific key sources) with simulated-platform tests and a manual cross-platform workflow.
- **Documentation:** README, guides, reference pages, OpenAPI description of the agent API, demo data, and a screenshot generator (`pnpm docs:screenshots`).

### Security

- Values are held in memory only (at most 15 minutes) and passed on only to the provider API and, sealed, to GitHub; reports, logs, errors and responses carry only a fingerprint.
- Launch secret for the portal session, `127.0.0.1` binding, Host, Origin and `Sec-Fetch-Site` checks, CSRF token, `HttpOnly` and `SameSite=Strict` cookie, Content-Security-Policy.
- Agent boundary: strict input schemas, approvals bound to the content that was requested, agent actions limited to `policy.agentStages` (never `live`), no confirmation, value entry, connection changes or attachment uploads by agents, atomic approval handling.
- Hardening: protection against `.env` injection, an allow-list for Grafana base URLs, protected bundled recipes, no key material in process arguments, vault data-loss protection, GitHub redirects followed only within GitHub, CI actions pinned to commit SHAs.
- GitHub token guidance corrected to require *Environments: Read and write*.

[Unreleased]: https://github.com/Pineflight/secret-desk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pineflight/secret-desk/releases/tag/v0.1.0
