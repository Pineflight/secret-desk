# Providers, external services and roadmap

What secret-desk supports today, what is being built, and what is planned. "Verified" means checked against the live
service, not only against mocks; [PROVIDERS.md](PROVIDERS.md) has the per-endpoint detail.

## Supported today

### Created through the provider's API

| Provider | Creates | Variables it can load | Verified live |
|---|---|---|---|
| Local | random hex, base64, UUID | n/a | yes |
| Cloudflare | API tokens (account and single-zone permissions), Turnstile widget secrets, Access service tokens (client ID and secret in one issuance) | account id, zone id, Turnstile site key | API tokens and Turnstile secrets: yes (2026-11-02); Access service tokens: no |
| Supabase | API keys (secret, publishable), reads the service role key, database password | project ref, project URL, publishable key | secret keys and service role read: yes (2026-11-02); database password: no |
| Stripe | webhook endpoints with their signing secret (sandbox and live), one connection per account and mode (`stripe:<acct_id>:<mode>`) with an account check | n/a | sandbox: yes (2026-11-02); per-account connections and the account check: no |
| Resend | sending API keys limited to one domain | domain id, domain name | yes (2026-11-02) |
| Grafana Cloud | service account tokens | n/a | no |

### Created in a browser (recipes)

The browser runs locally or as a sidecar on a server ([DOCKER.md](DOCKER.md#browser-on-the-pi)); the human signs in once.

| Provider | Creates | Status |
|---|---|---|
| GitHub | fine-grained personal access tokens | recipe scaffold, not verified |
| Supabase | personal access tokens with an organization, project and permission preset | verified live: full run 2026-11-03 (five scoped tokens) |
| OpenAI (facade) | one browser step creates the organization Admin API key (`openai-admin-key`), after that project keys are issued through the Admin API (service accounts) | API-based after one browser step; **verified live 2026-11-03**: admin key created, stored and tested through the signed-in browser (sign-in form, single-sign-on methods and revoke not verified) |
| Anthropic (facade and recipe) | browser for key creation (the Admin API cannot create keys: `anthropic-admin-key`, `anthropic-api-key`), API for the checks: workspaces, key check (`/v1/models`), deactivate and archive | **not verified live**: every selector and the revoke path are guesses; the API calls follow the Admin API reference |
| OpenAI (recipe) | API keys (owner, expiry, permissions) | verified live: full run 2026-11-03 with owner *You* (one key); *Service account* and the project choice not verified |
| VesselAPI | API keys (30 to 90 days on the free plan) | verified live: full run 2026-11-03 (two keys) |
| Peecho (read-only) | reads the Merchant API Key and the Secret key of the live or test portal (`peecho-api-keys`, `kind: read`; nothing is created) | navigation and DOM read live 2026-11-04; sign-in form, the `/mio-dashboard/settings/api` page and a full run not verified |
| Stripe | restricted API keys per account and mode (presets `webhooks`, `full-except-sensitive`) | sandbox wizard, result view and expiry checked 2026-11-03 with a throwaway key; full run, live mode and sign-in not verified |

### Created through a guided sign-in (provider facade)

| Provider | What the facade does | Status |
|---|---|---|
| RevenueCat | Signs in through the remote browser, creates a v2 secret key (*Project configuration: Read only*), stores it as the connection `revenuecat`, tests it; projects, apps and public SDK keys are then loaded through the API v2 for several projects | Verified live: the full key run on 2026-11-03 (two secret keys and one integration key through the guided sign-in, on a browser that was already signed in). Sign-in form: only the email step checked; password, one-time code, approval, CAPTCHA and error steps **not verified**. |
| Stripe | Signs in through the remote browser, asks for the account (`acct_...`) and the mode, creates a restricted key (*Webhook Endpoints, Event Destinations: Write*), checks that it belongs to that account and mode before storing it, stores it as `stripe:<acct_id>:<mode>` and tests it | Sandbox wizard, result view and expiry checked 2026-11-03 with a throwaway key. The sign-in form (every step), the live mode (including a possible password confirmation) and the full flow are **not verified**. |

### Pasted by a human, verified and written by secret-desk

Anything else: passwords, keys of providers without an API, values a provider hands out once. The portal checks the shape,
shows the review report and writes after confirmation. A VAPID key pair for web push comes from `secret-desk vapid`.

## In progress

| Item | What it brings |
|---|---|
| Live verification of the RevenueCat sign-in form | Password, one-time code, approval, CAPTCHA and error steps of the recipe are written defensively and still to be checked against the live site (the key run itself is verified). |
| Live verification of the Stripe key recipe | The full run in the sandbox, the live mode and the sign-in form of the recipe `stripe-restricted-key`; then the first real use of `account` on webhook entries. |

## Planned

| Item | Approach |
|---|---|
| GitHub, Supabase, Peecho, VesselAPI | A facade descriptor each, behind the same guided sign-in (their recipes exist; Supabase and VesselAPI are verified live, Peecho's is read-only and read live in part). OpenAI has its facade now (key creation verified live 2026-11-03). |
| Cloudflare R2 S3 credentials | API (an R2 token's id and the SHA-256 of its value are the S3 key pair) |
| Tokens that span several Cloudflare zones | Provider support for more than one zone per token |
| GitHub without personal tokens | GitHub App installation tokens instead of fine-grained PATs |
| VAPID key pairs | As a provider that writes the private key as a secret and the public key as a variable |
| Organization secrets | The `organization` scope exists in the schema; the portal form does not offer it yet |
| Verified recipes and recipe-driven revocation | Every bundled recipe checked against the live page (four of six ran end to end on 2026-11-03; GitHub and the Stripe full run are open) |

Ideas, not promises: order and scope can change.

## External services secret-desk talks to

secret-desk has no telemetry and no Pineflight server. It talks only to the services you connect:

| Service | Why | What is sent |
|---|---|---|
| GitHub API | Read names of secrets and variables, the public key of a repository or environment, workflow files (optional); write encrypted secrets and variables | Names, encrypted values, variable values |
| Cloudflare API | Create and verify tokens, Turnstile secrets; read permission groups | Token names, permissions, account and zone ids |
| Supabase Management API | Create API keys, read projects and keys | Project refs, key names |
| Stripe API | Create webhook endpoints | Endpoint URL, event types |
| Resend API | Create sending keys, read domains | Key names, domain ids |
| Grafana Cloud API | Create service account tokens | Token names |
| RevenueCat API v2 | Read projects, apps and public SDK keys | Project and app ids |
| Provider websites (browser recipes) | Create tokens where no API exists | What the recipe types into the provider's own form; with the guided sign-in also the email and password you entered for that run (only on the recipe's host, never stored) |
| Your team repository (optional team sync) | Share the value-free configuration | Inventory metadata |

Values are generated at the provider, held in memory for the review (at most 15 minutes) and written to GitHub
encrypted with the repository's public key. They are never stored by secret-desk.

## Third-party software

- The portal, CLI and MCP server: [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md), generated from the installed
  dependencies and checked in CI.
- The browser sidecar image: [docker/browser/THIRD-PARTY-NOTICES.md](../docker/browser/THIRD-PARTY-NOTICES.md)
  (Chromium, Xvfb, x11vnc, noVNC, websockify, socat and the Debian base).
