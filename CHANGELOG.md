# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **English naming:** the portal routes are now `/settings`, `/approvals`, `/reviews`, `/reviews/:id`, `/variables`, `/connections` and `/compare`; the new-entry query parameter is `new=1`. All test names are English, and `assets/logo-protokoll.json` became `assets/logo-log.json` with English keys.
- **Migration:** the old German routes (`/einstellungen`, `/freigaben`, `/pruefen`, `/variablen`, `/verbindungen`, `/vergleich`) redirect permanently with the query string kept, and `?neu=1` is still accepted. Inventory, config and team files already used English keys, so nothing needs to be migrated there; bookmarks keep working through the redirects.

### Fixed

- Release workflow: image references in the manifest job are lowercased (`Pineflight/...` made `imagetools create` fail); annotations are set on the index only and the step also works with none.

### Added

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
