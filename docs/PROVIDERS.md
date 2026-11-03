# Providers

`automatic` = the portal generates the value via API. `manual` = you create it at the provider and paste it in; the portal verifies it.
Each provider supplies its own checks and review points. The *Verified* column says how certain the endpoint is.

| Id | Kind | Connection | Verified |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | none | locally |
| `cloudflare-token` | automatic | `cloudflare` (token with *User > API Tokens > Edit*) | reference read, `expires_on` only from a third-party source |
| `cloudflare-access-service-token` | automatic | `cloudflare` (same token, no extra permission) | documentation read, **not verified live** |
| `cloudflare-turnstile` | automatic | `cloudflare-turnstile` | **not verified** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | documentation read, field names **not verified** |
| `supabase-db-password` | automatic | `supabase` (token with *Database config: Write*) | documentation read, **not verified live** |
| `stripe-webhook-secret` | automatic | `stripe:<acct_id>:<mode>` per account and mode, or `stripe-test` / `stripe-live` / `stripe` (see below) | search, fields **not verified**; sandbox: yes (2026-11-02) |
| `resend-api-key` | automatic | `resend` | **not verified** |
| `grafana-service-account-token` | automatic | `grafana` | **not verified** |
| `revenuecat-secret-key` | manual (carries the discovery for variable sources) | `revenuecat` | API reference read (list endpoints, field names, permissions); public key prefixes **not verified** |
| `openai` | automatic | `openai` (the organization **Admin API key**, created once by the guided sign-in) | issues a service account key per project (`POST /v1/organization/projects/{projectId}/service_accounts`, the key value is in the answer, shown once), revokes it with `DELETE .../service_accounts/{id}`; verifies it with `GET /v1/models?limit=1`; **not verified live yet** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `telegram-bot` | manual | none | guides; landing pages where no sub-page is known |

**Before the first real use**, test every `automatic` provider with a throwaway entry in dev or staging.

Provider ids are used as `provider` of a secret in the inventory; the connection column is the integration whose token the provider uses ([INTEGRATIONS.md](INTEGRATIONS.md)).

## OpenAI

OpenAI works like RevenueCat: a facade (the guided sign-in) with the recipe `openai-admin-key` creates an organization Admin API key in the signed-in browser, stores it as the `openai` connection and tests it (`GET https://api.openai.com/v1/organization/projects?limit=1`: 200 connected, 401/403 rejected). The projects it can see are discoverable (`openai.project`). From then on the provider `openai` issues keys **through the API**: it creates a service account named after the entry (`tokenName`) in the project given by the parameter `projectId` (`proj_...`, selectable from the discovered projects) and stores the key value from the answer. OpenAI keys never expire, so the entry gets its own `ttlDays` as expiry, or **90 days** as the rotation horizon when it has none; the expiry date is always filled. The per-entry recipe `openai-api-key` stays as the browser fallback for entries that name it. Nothing of the OpenAI facade, the admin-key recipe or the Admin API calls is verified against the live service yet.

## Parameters per provider

Given under `params` of the inventory entry. Source: [`packages/providers/src`](../packages/providers/src).

| Provider | Parameters |
|---|---|
| `random-hex`, `random-base64` | `bytes`: integer 8 to 128, default 32 |
| `random-uuid` | none |
| `cloudflare-token` | `accountId` (string, required, may come from the integration default), `permissions` (string[] of permission group names, required, for example `["Workers Scripts Write"]`), `zoneId` (optional, needed for zone-bound permissions) |
| `cloudflare-access-service-token` | `accountId` (required, may come from the integration default), `clientIdTarget` (required: inventory id of the secret entry that receives the client ID), `duration` (`8760h` default, `720h`, `2160h`, `forever`) |
| `cloudflare-turnstile` | `accountId` (required), `sitekey` (required) |
| `openai` | `projectId` (required, `^proj_[A-Za-z0-9]+$`, selectable from the discovered `openai.project` resources) |
| `supabase-api-key` | `projectRef` (required), `type`: `secret` (default) or `publishable` |
| `supabase-service-role` | `projectRef` (required); reads the existing `service_role` key, creates nothing |
| `supabase-db-password` | `projectRef` (required), `length`: integer 24 to 64, default 40. The password is generated locally (letters and digits only, safe in a Postgres URL) and set with `PATCH /v1/projects/<ref>/database/password`. The old password stops working at once; there is nothing to revoke, and the API gives no read-back, so the test checks only the shape and that the API answered 2xx (no login to Postgres). |
| `stripe-webhook-secret` | `url` (required, the webhook endpoint), `events` (string[] of event types, required), `account` (optional, `acct_...`: use the connection of that account in the mode of the stage and refuse any other account, see below), `connection` (optional, forces one connection, for example `stripe-test` or `stripe:acct_1AbC:live`; the account check still runs when `account` is set) |
| `resend-api-key` | `permission`: `sending_access` (default) or `full_access`; `domainId` (required for `sending_access`: the key is limited to this domain; not used for `full_access`) |
| `revenuecat-secret-key` (manual) | `projectId` (optional, integration default allowed): project that apps and public SDK keys are read from; without it the apps of every project of the connection are listed |
| `grafana-service-account-token` | `baseUrl` (required, https, no port; host must be `*.grafana.net` or in `providers.grafana.allowedHosts`), `serviceAccountId` (integer, required) |
| `github-fine-grained-token` (manual) | optional `params.permissions`, a map such as `{ contents: read, metadata: read }`, prefills the GitHub token form (together with `ttlDays`, the description and the configured owner) |
| other manual providers | none |

### Cloudflare Access service tokens (client ID and secret together)

`cloudflare-access-service-token` issues the pair a workflow needs to reach an app behind Cloudflare Access. Put it on the entry
`CLOUDFLARE_ACCESS_CLIENT_SECRET`; `clientIdTarget` names the entry `CLOUDFLARE_ACCESS_CLIENT_ID` (a secret entry with its own places).
Both values come from the same API answer and are written in the same commit; the review lists the client ID entry (name, targets,
fingerprint, never the value) and rejecting or letting the review expire discards both.

How it works:

1. The `cloudflare` connection (template *Create additional tokens*) cannot call the Access API. The provider therefore creates a
   **helper token** (permission *Access: Service Tokens Write*, or *Edit* if that is how the account lists it; scoped to the one account;
   expiry 10 minutes), calls the Access API with it and deletes it right away, also on failure. The helper value stays in memory.
   If deleting fails, it still expires after ten minutes.
2. **Renewal** (the entry has an `externalId`): if that service token still exists (`GET .../access/service_tokens/{id}`), its secret is
   renewed in place (`POST .../service_tokens/{id}/rotate`). The client ID stays, so the client ID entry is not rewritten. The review warns
   that the old secret is invalid from that call on, and that rejecting does not bring it back. If the token is gone, a new one is created
   (`POST .../access/service_tokens` with `name` and `duration`) and the old id is deleted after confirm.
3. `expires` comes from `expires_at` in the answer; without it the `duration` is used (`forever` means no expiry).

Not verified live: the API field names (`client_id`, `client_secret`, `expires_at`, `id`), the exact name of the permission group,
whether a token with *Create additional tokens* may grant that group, and what happens to the old secret after the in-place renewal.
The check that an Access policy still references the token is not implemented; the provider only checks that the token exists. The
client ID entry must be a secret entry (a variable cannot be a companion yet) in the same stage.

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
| `PATCH api.supabase.com/v1/projects/<ref>/database/password` | database password (`password`) | not verified |
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

The parameters are validated before any browser opens (`params_invalid`). The form and the key list were checked against the live dashboard on 2026-11-02 with a throwaway key (revoked afterwards); the full recipe run was verified live on 2026-11-03 (two secret keys and one integration key through the guided sign-in); the password, one-time code, approval and CAPTCHA steps of the sign-in form are not.

## Permissions per integration
Create each token with no more than this. The **Test connection** button on the Integrations page makes read-only calls to confirm it (see below).

| Connection | Permissions the token needs |
|---|---|
| `github` | Fine-grained PAT, only the repositories the portal manages: *Secrets* Read and write, *Variables* Read and write, *Environments* Read and write (environment secrets), *Contents* Read-only (optional: lets the stage comparison read `.github/workflows` to show what workflows need; not needed for repositories linked to a local folder), *Metadata* Read. For organization secrets also the organization permission *Secrets*. Recommended expiry: 90 days. |
| `cloudflare` | Template *Create additional tokens* (*User > API Tokens > Edit*). Accounts and zones can only be picked in the portal if the token may read them (*Account > Account Settings > Read*, *Zone > Zone > Read*). The template does not combine with other permissions, so with it you enter the account ID once by hand as the integration default (Cloudflare dashboard, account overview); the permission groups are listed either way. Recommended expiry: 1 to 7 days, ideally with an IP restriction. |
| `cloudflare-turnstile` | Custom token with *Account > Turnstile > Edit*, limited to the one account. |
| `supabase` | Access token with *API Keys* Read-write and *API Key Secrets* Read (optionally *Project Settings* Read, *Projects* Read). The token never exceeds your own role (Owner or Admin). |
| `stripe`, `stripe-test`, `stripe-live`, `stripe:<acct_id>:<mode>` | Restricted key: *Webhook Endpoints, Event Destinations* Write, everything else None. Optionally *Balance* Read, so the test can confirm the key. |
| `resend` | API key with *Full access*. Only this type can manage API keys. |
| `revenuecat` | v2 secret key with *Project configuration: Read only*, everything else `None`. Read only; public values and identifiers only. |
| `grafana` | Service account token (role Admin) of the stack. |

### Stripe: test and live
Use one key per mode. `stripe-test` takes a sandbox key (`rk_test_`), `stripe-live` a live key (`rk_live_`). The portal rejects a key whose prefix does not match the connection.
For an entry without `account`, the connection is chosen in this order: `connection` in the entry parameters, then by the kind of the stage (`test` uses `stripe-test`, `live` uses `stripe-live`, if connected),
then the general `stripe` connection. Existing setups with only `stripe` keep working unchanged. `dev` and `shared` stages always use `stripe`.

### Stripe: one connection per account and mode
A Stripe *organization* holds several accounts (one per product), each with a sandbox and a live mode. A key belongs to exactly one `(account, mode)`, so a connection can too:
its id is `stripe:<acct_id>:<mode>` with `<mode>` = `sandbox` or `live`, for example `stripe:acct_1AbC:sandbox`. The fixed ids above stay as they are.

- **Entry.** `stripe-webhook-secret` takes the optional parameter `account` (`^acct_[A-Za-z0-9]+$`, picked from the connected accounts through the discovery kind `stripe.account`). With it, the connection is `stripe:<account>:<mode>`, where the mode follows the kind of the stage: `live` uses `live`, `test` and `dev` use `sandbox`. A `shared` stage has no mode: set `connection`. There is no fallback to `stripe`, `stripe-test` or `stripe-live`: without a key for exactly that account and mode the entry is "not connected". Without `account` nothing changes.
- **The account is checked, not trusted.** Before an endpoint is created, `GET /v1/account` with the connection's key must return the entry's account id, otherwise nothing is created. The same check is part of the preflight (a failure blocks the issue) and of verify (check `account`). The mode check stays. This is exactly the mistake the parameter prevents: a key of another account of the same organization creating the webhook in the wrong product.
- **Test connection** of a per-account connection checks the key prefix against the mode of the id and `GET /v1/account` against the account of the id. A successful check also reads the account name (`business_profile.name`, else `settings.dashboard.display_name`) and keeps it as the display label (*Stripe Acme Studio (Sandbox)*). The name is not a secret; it lives next to the key in the vault (entry `<id>#label`) or in the session.
- **Connect with sign-in.** *Integrations*, Stripe, *Connect with sign-in* asks for the account id (`acct_...`) and the mode, creates the restricted key by the recipe `stripe-restricted-key` (preset `webhooks`), checks that it belongs to the account and mode, stores it as `stripe:<account>:<mode>` and tests it. A key of another account is never stored; the portal names the key to expire at Stripe.
- **Discovery.** The kind `stripe.account` lists the connected accounts (id, name if known, modes) from the connection store. It makes no request.

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
