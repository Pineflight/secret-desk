# Providers, external services and roadmap

What secret-desk supports today, what is being built, and what is planned. "Verified" means checked against the live
service, not only against mocks; [PROVIDERS.md](PROVIDERS.md) has the per-endpoint detail.

## Supported today

### Created through the provider's API

| Provider | Creates | Variables it can load | Verified live |
|---|---|---|---|
| Local | random hex, base64, UUID | n/a | yes |
| Cloudflare | API tokens (account and single-zone permissions), Turnstile widget secrets | account id, zone id, Turnstile site key | API tokens and Turnstile secrets: yes (2026-11-02) |
| Supabase | API keys (secret, publishable), reads the service role key | project ref, project URL, publishable key | secret keys and service role read: yes (2026-11-02) |
| Stripe | webhook endpoints with their signing secret (sandbox and live) | n/a | sandbox: yes (2026-11-02) |
| Resend | sending API keys limited to one domain | domain id, domain name | yes (2026-11-02) |
| Grafana Cloud | service account tokens | n/a | no |

### Created in a browser (recipes)

The browser runs locally or as a sidecar on a server ([DOCKER.md](DOCKER.md#browser-on-the-pi)); the human signs in once.

| Provider | Creates | Status |
|---|---|---|
| GitHub | fine-grained personal access tokens | recipe scaffold, not verified |
| Supabase | personal access tokens | recipe scaffold, not verified |
| Stripe | restricted API keys | recipe scaffold (permission matrix not modeled), not verified |

### Pasted by a human, verified and written by secret-desk

Anything else: passwords, keys of providers without an API, values a provider hands out once. The portal checks the shape,
shows the review report and writes after confirmation. A VAPID key pair for web push comes from `secret-desk vapid`.

## In progress

| Item | What it brings |
|---|---|
| Recipe parameters | Recipes take per-entry parameters (project id, permission levels), so one recipe serves several projects or accounts. |
| RevenueCat | Secret API keys (v2, permission levels per area) through a recipe; project ids, app ids, public SDK keys and sandbox keys loaded through the RevenueCat API v2, for several projects. |
| Guided sign-in | On *Integrations*, pick a provider and sign in through a form: the portal drives the server browser, shows every step (email, password, one-time code, approval in the app, CAPTCHA hand-over) and then connects the integration on its own. The password is used for that run only and never stored. |

## Planned

| Item | Approach |
|---|---|
| Peecho, VesselAPI, OpenAI | Browser recipes behind the guided sign-in |
| Cloudflare R2 S3 credentials | API (an R2 token's id and the SHA-256 of its value are the S3 key pair) |
| Cloudflare Access service tokens | API |
| Tokens that span several Cloudflare zones | Provider support for more than one zone per token |
| GitHub without personal tokens | GitHub App installation tokens instead of fine-grained PATs |
| VAPID key pairs | As a provider that writes the private key as a secret and the public key as a variable |
| Organization secrets | The `organization` scope exists in the schema; the portal form does not offer it yet |
| Verified recipes and recipe-driven revocation | Every bundled recipe checked against the live page |

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
| RevenueCat API v2 (in progress) | Read projects, apps and public SDK keys | Project and app ids |
| Provider websites (browser recipes) | Create tokens where no API exists | What the recipe types into the provider's own form |
| Your team repository (optional team sync) | Share the value-free configuration | Inventory metadata |

Values are generated at the provider, held in memory for the review (at most 15 minutes) and written to GitHub
encrypted with the repository's public key. They are never stored by secret-desk.

## Third-party software

- The portal, CLI and MCP server: [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md), generated from the installed
  dependencies and checked in CI.
- The browser sidecar image: [docker/browser/THIRD-PARTY-NOTICES.md](../docker/browser/THIRD-PARTY-NOTICES.md)
  (Chromium, Xvfb, x11vnc, noVNC, websockify, socat and the Debian base).
