# Providers

`automatic` = the portal generates the value via API. `manual` = you create it at the provider and paste it in; the portal verifies it.
Each provider supplies its own checks and review points. The *Verified* column says how certain the endpoint is.

| Id | Kind | Connection | Verified |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | none | locally |
| `cloudflare-token` | automatic | `cloudflare` (token with *User > API Tokens > Edit*) | reference read, `expires_on` only from a third-party source |
| `cloudflare-turnstile` | automatic | `cloudflare-turnstile` | **not verified** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | documentation read, field names **not verified** |
| `stripe-webhook-secret` | automatic | `stripe-test` / `stripe-live` / `stripe` (see below) | search, fields **not verified** |
| `resend-api-key` | automatic | `resend` | **not verified** |
| `grafana-service-account-token` | automatic | `grafana` | **not verified** |
| `revenuecat-secret-key` | manual (carries the discovery for variable sources) | `revenuecat` | API reference read (list endpoints, field names, permissions); public key prefixes **not verified** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `openai`, `telegram-bot` | manual | none | guides; landing pages where no sub-page is known |

**Before the first real use**, test every `automatic` provider with a throwaway entry in dev or staging.

Provider ids are used as `provider` of a secret in the inventory; the connection column is the integration whose token the provider uses ([INTEGRATIONS.md](INTEGRATIONS.md)).

## Parameters per provider

Given under `params` of the inventory entry. Source: [`packages/providers/src`](../packages/providers/src).

| Provider | Parameters |
|---|---|
| `random-hex`, `random-base64` | `bytes`: integer 8 to 128, default 32 |
| `random-uuid` | none |
| `cloudflare-token` | `accountId` (string, required, may come from the integration default), `permissions` (string[] of permission group names, required, for example `["Workers Scripts Write"]`), `zoneId` (optional, needed for zone-bound permissions) |
| `cloudflare-turnstile` | `accountId` (required), `sitekey` (required) |
| `supabase-api-key` | `projectRef` (required), `type`: `secret` (default) or `publishable` |
| `supabase-service-role` | `projectRef` (required); reads the existing `service_role` key, creates nothing |
| `stripe-webhook-secret` | `url` (required, the webhook endpoint), `events` (string[] of event types, required), `connection` (optional, forces `stripe-test`, `stripe-live` or `stripe`) |
| `resend-api-key` | `permission`: `sending_access` (default) or `full_access`; `domainId` (required for `sending_access`: the key is limited to this domain; not used for `full_access`) |
| `revenuecat-secret-key` (manual) | `projectId` (optional, integration default allowed): project that apps and public SDK keys are read from; without it the apps of every project of the connection are listed |
| `grafana-service-account-token` | `baseUrl` (required, https, no port; host must be `*.grafana.net` or in `providers.grafana.allowedHosts`), `serviceAccountId` (integer, required) |
| `github-fine-grained-token` (manual) | optional `params.permissions`, a map such as `{ contents: read, metadata: read }`, prefills the GitHub token form (together with `ttlDays`, the description and the configured owner) |
| other manual providers | none |

### Parameter specification, discovery and preflight

Every provider declares its parameters (`Provider.params`: key, German and English label and help, type `string` / `stringList` / `enum` / `url` / `integer`, `required`, `requiredWhen`, `options`, `discover`, `presets`, `integrationDefault`).
Before anything is issued the entry is validated against it (`validateEntryParams`, no network call). A missing parameter is answered with `400` and `code: "params_invalid"`, for example
`Pflichtparameter fehlen: accountId (Cloudflare-Konto), permissions (Berechtigungen)`, where the old message was the misleading "The provider did not accept the request".
`resend-api-key`: `domainId` is required when `permission` is `sending_access` (also when `permission` is omitted) and not used for `full_access`.
`cloudflare-token`: `zoneId` is needed when a permission group applies to a zone only (for example *Workers Routes Write*); the token then gets a second policy on that zone. Presets: *Worker deploy* (*Workers Scripts Write*, *Account Settings Read*), *Worker deploy with custom domain* (adds *Workers Routes Write*, needs a zone).

Parameters can be defaults of the integration (`integrationDefaults` in the inventory, only parameters marked `integrationDefault`: `accountId` for Cloudflare, `baseUrl` for Grafana). They apply when an entry does not set the parameter.
`discover` lists resources of the connected integration read-only; the portal offers **one** suggestion at most (project name contains repository and stage; zone or domain name contains the repository; a single account) and never applies it by itself. Ambiguous or weak matches give no suggestion.
The preflight (read-only, before prepare and in the dry run for humans) checks that the chosen resource belongs to the integration and names it, for example `Supabase-Projekt wake-miles-staging (ref abc)`. A sure mismatch (`fail`) stops the issue with `409` / `code: "preflight_failed"`; unreadable lists are warnings.

New read endpoints (all `GET`, with the stored token of the integration). **Not verified against the real API** unless marked:

| Endpoint | Used for | Verified |
|---|---|---|
| `GET api.cloudflare.com/client/v4/user/tokens/permission_groups` | permission groups, scopes | in use before; `scopes` field not verified |
| `GET .../client/v4/accounts?per_page=50` | Cloudflare accounts (needs a read permission such as *Account Settings Read*; without it Cloudflare answers with an empty list and the portal shows a hint to enter the account ID by hand) | not verified |
| `GET .../client/v4/zones?per_page=50[&account.id=]` | zones | not verified |
| `GET .../client/v4/accounts/<id>/challenges/widgets` | Turnstile widgets | not verified |
| `GET api.supabase.com/v1/projects` | projects (`ref` or `id`, `name`) | not verified |
| `GET api.supabase.com/v1/projects/<ref>/api-keys` (without `reveal`) | public key for variables | not verified |
| `GET api.resend.com/domains` | domains with status | not verified |
| `GET api.revenuecat.com/v2/projects` | projects (`items[].id`, `name`), forward pagination (`limit` 1-100, `starting_after`) | API reference read |
| `GET api.revenuecat.com/v2/projects/<id>/apps` | apps (`items[].id`, `name`, `type`) | API reference read; values of `type` seen in the reference: `app_store`, `mac_app_store`, `play_store`, `amazon`, `stripe`, `rc_billing`, `paddle`, `roku`, `galaxy`, `test_store`, `external` |
| `GET api.revenuecat.com/v2/projects/<id>/apps/<app>/public_api_keys` | public SDK keys (`items[].key`, `environment` = `production` or `sandbox`, `created_at`) | API reference read. Sandbox keys are always listed; RC Checkout keys are omitted; production keys of Stripe/Web Billing apps are omitted when the linked Stripe account is test-only. **Not verified:** the key prefixes (`appl_`, `goog_`, `amzn_`, `rcb_`, `rcb_sb_`, `strp_`, `roku_`) and the exact shape of `next_page` (a URL according to the reference; secret-desk never follows it and continues with `starting_after` = id of the last item) |
| `GET <baseUrl>/api/health`, `GET <baseUrl>/api/serviceaccounts/search` | Grafana reachability, service accounts | not verified |

Variables can load their value from a source (`from: { connection, kind, resource, field }`), with a fixed allowlist of public fields only: Supabase `ref`, `url`, `publishableKey` (never `service_role` or secret keys); Cloudflare `accountId`, `zoneId`, zone `name`, Turnstile `sitekey`; Resend `domainId`, `name`; RevenueCat project `id`, `name`, app `id`, `name`, `type`, and the public SDK keys `production` and `sandbox` of an app (never a secret key; if an app has several keys for an environment, the newest by `created_at` is used). Not implemented: Grafana stack (`grafana.stack`: needs the Grafana Cloud API) and a Stripe publishable key (no read endpoint with a restricted key).

## RevenueCat via the browser

`revenuecat-secret-api-key-browser` creates a RevenueCat **secret API key** (V2) through the dashboard with a [browser recipe](RECIPES.md) (`recipes/revenuecat-secret-api-key.yaml`), because the key is created in the dashboard. You sign in yourself; secret-desk fills the form, clicks *Generate*, reveals the key in the key list and reads it. Revocation is automated too (More, Revoke, Confirm in the key's row).

| Parameter | Meaning |
|---|---|
| `projectId` | Required. The project id from the dashboard address (`/projects/<id>/`), matching `^[a-z0-9]{6,20}$`. |
| `projectConfiguration`, `customerInformation`, `chartsMetrics`, `audiences`, `iam` | Access level of that permission section: `No access` (default), `Read only` or `Read & write`. Give the key no more than the service needs. |

The parameters are validated before any browser opens (`params_invalid`). The form and the key list were checked against the live dashboard on 2026-11-02 with a throwaway key (revoked afterwards); a full recipe run is **not verified** yet.

## Permissions per integration
Create each token with no more than this. The **Test connection** button on the Integrations page makes read-only calls to confirm it (see below).

| Connection | Permissions the token needs |
|---|---|
| `github` | Fine-grained PAT, only the repositories the portal manages: *Secrets* Read and write, *Variables* Read and write, *Environments* Read and write (environment secrets), *Contents* Read-only (optional: lets the stage comparison read `.github/workflows` to show what workflows need; not needed for repositories linked to a local folder), *Metadata* Read. For organization secrets also the organization permission *Secrets*. Recommended expiry: 90 days. |
| `cloudflare` | Template *Create additional tokens* (*User > API Tokens > Edit*). Accounts and zones can only be picked in the portal if the token may read them (*Account > Account Settings > Read*, *Zone > Zone > Read*). The template does not combine with other permissions, so with it you enter the account ID once by hand as the integration default (Cloudflare dashboard, account overview); the permission groups are listed either way. Recommended expiry: 1 to 7 days, ideally with an IP restriction. |
| `cloudflare-turnstile` | Custom token with *Account > Turnstile > Edit*, limited to the one account. |
| `supabase` | Access token with *API Keys* Read-write and *API Key Secrets* Read (optionally *Project Settings* Read, *Projects* Read). The token never exceeds your own role (Owner or Admin). |
| `stripe`, `stripe-test`, `stripe-live` | Restricted key: *Webhook Endpoints* Write, everything else None. Optionally *Balance* Read, so the test can confirm the key. |
| `resend` | API key with *Full access*. Only this type can manage API keys. |
| `revenuecat` | v2 secret key with *Project configuration: Read only*, everything else `None`. Read only; public values and identifiers only. |
| `grafana` | Service account token (role Admin) of the stack. |

### Stripe: test and live
Use one key per mode. `stripe-test` takes a sandbox key (`rk_test_`), `stripe-live` a live key (`rk_live_`). The portal rejects a key whose prefix does not match the connection.
For an entry, the connection is chosen in this order: `connection` in the entry parameters, then by the kind of the stage (`test` uses `stripe-test`, `live` uses `stripe-live`, if connected),
then the general `stripe` connection. Existing setups with only `stripe` keep working unchanged. `dev` and `shared` stages always use `stripe`.

### Test connection
Each connected integration has a **Test connection** button (`POST /api/ui/connections/<id>/check`, portal only, never available to agents). It makes read-only calls:
GitHub `GET /user` (login and token expiry from the `github-authentication-token-expiration` header) plus a public-key read per inventory target; Cloudflare `GET /user/tokens/verify`
(status and `expires_on`; an expiry beyond 7 days gets a recommendation to shorten it); Supabase `GET /v1/organizations`; Stripe `GET /v1/balance` (a 403 on a restricted key is normal and shown as information; the mode comes from the key prefix);
Resend `GET /api-keys` (401/403 means the key lacks *Full access*). RevenueCat `GET /v2/projects?limit=1`. Grafana cannot be tested without a stack address. An expiry reported by the provider is shown on the card in place of the manual entry.
GitHub also offers an opt-in *write test*, see [SECURITY-MODEL.md](SECURITY-MODEL.md#write-test).

## What providers do not offer
Supabase access tokens, GitHub tokens (fine-grained PATs) and Stripe restricted keys cannot be created via API. Use the
manual route for them (or browser automation, see [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md)). For GitHub, a **GitHub App** is worth it: the portal and your workflows then obtain a token valid for one hour per run.

## Adding your own provider
Without an API: in the inventory under `providers` (name, URL, steps), or via the MCP tool `desk_add_provider`.
With an API: register a `Provider` with `issue`, `revoke`, `verify` and `reviewChecklist` (see `packages/providers/src`).
