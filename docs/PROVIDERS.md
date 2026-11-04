# Providers

`automatic` = the portal generates the value via API. `manual` = you create it at the provider and paste it in; the portal verifies it.
Each provider supplies its own checks and review points. The *Verified* column says how certain the endpoint is.

| Id | Kind | Connection | Verified |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | none | locally |
| `cloudflare-token` | automatic | `cloudflare` (token with *User > API Tokens > Edit*) | reference read, `expires_on` only from a third-party source |
| `cloudflare-access-service-token` | automatic | `cloudflare` (same token, no extra permission) | documentation read, **not verified live** |
| `cloudflare-r2-credentials` | automatic | `cloudflare` (token that may create API tokens) | documentation read, **not verified live** |
| `cloudflare-turnstile` | automatic | `cloudflare-turnstile` | **not verified** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | documentation read, field names **not verified** |
| `supabase-db-password` | automatic | `supabase` (token with *Database config: Write*) | documentation read, **not verified live** |
| `stripe-webhook-secret` | automatic | `stripe:<acct_id>:<mode>` per account and mode, or `stripe-test` / `stripe-live` / `stripe` (see below) | search, fields **not verified**; sandbox: yes (2026-11-02) |
| `resend-api-key` | automatic | `resend` | **not verified** |
| `grafana-service-account-token` | automatic | `grafana` | **not verified** |
| `grafana-access-policy-token` | automatic | `grafana-cloud` (a grafana.com token with `accesspolicies:write`) | from memory of the Cloud API, **not verified live** |
| `vapid-keypair` | automatic | none | locally (P-256 from `node:crypto`; derivation checked in tests) |
| `revenuecat-secret-key` | manual (carries the discovery for variable sources) | `revenuecat` | API reference read (list endpoints, field names, permissions); public key prefixes **not verified** |
| `openai` | automatic | `openai` (the organization **Admin API key**, created once by the guided sign-in) | issues a service account key per project (`POST /v1/organization/projects/{projectId}/service_accounts`, the key value is in the answer, shown once), revokes it with `DELETE .../service_accounts/{id}`; verifies it with `GET /v1/models?limit=1`; **not verified live yet** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `telegram-bot` | manual | none | guides; landing pages where no sub-page is known |

**Before the first real use**, test every `automatic` provider with a throwaway entry in dev or staging.

Provider ids are used as `provider` of a secret in the inventory; the connection column is the integration whose token the provider uses ([INTEGRATIONS.md](INTEGRATIONS.md)).

## OpenAI

OpenAI works like RevenueCat: a facade (the guided sign-in) with the recipe `openai-admin-key` creates an organization Admin API key in the signed-in browser, stores it as the `openai` connection and tests it (`GET https://api.openai.com/v1/organization/projects?limit=1`: 200 connected, 401/403 rejected). The projects it can see are discoverable (`openai.project`). From then on the provider `openai` issues keys **through the API**: it creates a service account named after the entry (`tokenName`) in the project given by the parameter `projectId` (`proj_...`, selectable from the discovered projects) and stores the key value from the answer. OpenAI keys never expire, so the entry gets its own `ttlDays` as expiry, or **90 days** as the rotation horizon when it has none; the expiry date is always filled. The per-entry recipe `openai-api-key` stays as the browser fallback for entries that name it. Nothing of the OpenAI facade, the admin-key recipe or the Admin API calls is verified against the live service yet.

## Anthropic

Anthropic keys are created in the browser, and the Admin API only helps around them. The Admin API (organization **Admin key**, header `x-api-key` plus `anthropic-version: 2023-06-01`) can list workspaces and list, rename and deactivate API keys, but it never returns a key's secret and **cannot create API keys**. An **individual organization** has no admin keys at all, so the integration works without one:

- **Connect** on the card signs in through the portal (recipe `anthropic-admin-key`: email plus one-time code, or Google) and then tries the Admin keys page. With an organization it creates the Admin key, stores it as the `anthropic` connection and tests it (`GET /v1/organizations/workspaces?limit=1`: 200 connected, 401/403 rejected). Without one the page has no create button within eight seconds: the run ends as *unsupported* and the facade finishes as done with the message "Admin keys need an Anthropic organization; API keys are created in the browser". Nothing is stored; the sign-in is remembered, so the card shows **Ready (browser)**.
- The admin key stays optional ("organization only"): with it, workspaces are discoverable (`anthropic.workspace`; the default workspace is added to the list), keys are checked and deactivated through the API, and the card says "Works without browser sign-in".
- API keys come from the recipe `anthropic-api-key` through the signed-in browser (provider `anthropic-api-key-browser`, optional parameter `workspace`; empty or `Default` keeps the Default workspace of the dialog). The Console follows the account language, so the recipe accepts German and English wording. The key is checked with `GET /v1/models`.
- **Expiry is always set.** The key dialog has an expiry (default 30 days): the entry's `ttlDays` (default 30) is chosen in the dialog and the same number of days from today is the expiry date; if the Console does not offer that many days, the run fails before a key is created. 30 days is the dialog default and is not clicked. If a run reports no date, 90 days is the fallback.
- Revoke: with the `anthropic` connection, the key is found by its name (`GET /v1/organizations/api_keys`), set to `inactive`, then `archived`; a refusal of the second step is ignored. Without the connection the recipe's browser revoke runs (not verified).

Verified live on 2026-11-04 (German Console, individual organization, no key created): the email plus one-time code sign-in, the cookie banner wording, that Admin keys has no create button, and the fields of the key dialog (name placeholder `my-secret-key`, expiry select with 30 days by default, workspace select, submit button). Not verified: what the Console shows after creation (the key is read by pattern from any readonly input or code element of the dialog), other expiry options and workspaces, the browser revoke, creating an admin key in a real organization, whether the default workspace is listed by the API, and whether `archived` can be set through the API. The Console moved from `console.anthropic.com` to `platform.claude.com`; both hosts are accepted.

## Parameters per provider

Given under `params` of the inventory entry. Source: [`packages/providers/src`](../packages/providers/src).

| Provider | Parameters |
|---|---|
| `random-hex`, `random-base64` | `bytes`: integer 8 to 128, default 32 |
| `random-uuid` | none |
| `anthropic-api-key-browser` | `workspace` (optional, selectable from the discovered `anthropic.workspace` resources, empty = Default workspace) |
| `cloudflare-token` | `accountId` (string, required, may come from the integration default), `permissions` (string[] of permission group names, required, for example `["Workers Scripts Write"]`), `zoneId` (optional, needed for zone-bound permissions), `zones` (optional string[] of zone names, resolved through the API), `allZones` (optional, `true` = every zone of the account). The expiry is always set: the entry's `ttlDays`, else 90 days (the review says *default*). |
| `cloudflare-r2-credentials` | `accountId` (required, may come from the integration default), `value` (required: `secretAccessKey` or `accessKeyId`, the half this entry receives), `companionEntry` (required: inventory id of the entry that receives the other half), `access` (required: `read`, `write`, `admin`), `buckets` (optional string[]; not with `admin`), `jurisdiction` (optional: `default`, `eu`, `fedramp`) |
| `cloudflare-access-service-token` | `accountId` (required, may come from the integration default), `clientIdTarget` (required: inventory id of the secret entry that receives the client ID), `duration` (`8760h` default, `720h`, `2160h`, `forever`) |
| `cloudflare-turnstile` | `accountId` (required), `sitekey` (required) |
| `openai` | `projectId` (required, `^proj_[A-Za-z0-9]+$`, selectable from the discovered `openai.project` resources) |
| `supabase-api-key` | `projectRef` (required), `type`: `secret` (default) or `publishable` |
| `supabase-service-role` | `projectRef` (required); reads the existing `service_role` key, creates nothing |
| `supabase-db-password` | `projectRef` (required), `length`: integer 24 to 64, default 40; optional companion: `dbUrlTarget` (inventory id of the secret entry that receives the connection URL), `urlTemplate` (default `postgresql://postgres.{{ref}}:{{password}}@aws-0-{{region}}.pooler.supabase.com:6543/postgres`; placeholders `{{ref}}`, `{{password}}` percent-encoded, `{{region}}`), `region` (needed only if the template uses `{{region}}`; the pooler host differs per project, so check it). A project that is paused or not active makes the preflight fail ("start the project first") and nothing is changed. The password is generated locally The password is generated locally (letters and digits only, safe in a Postgres URL) and set with `PATCH /v1/projects/<ref>/database/password`. The old password stops working at once; there is nothing to revoke, and the API gives no read-back, so the test checks only the shape and that the API answered 2xx (no login to Postgres). |
| `stripe-webhook-secret` | `url` (required, the webhook endpoint), `events` (string[] of event types, required), `account` (optional, `acct_...`: use the connection of that account in the mode of the stage and refuse any other account, see below), `connection` (optional, forces one connection, for example `stripe-test` or `stripe:acct_1AbC:live`; the account check still runs when `account` is set) |
| `resend-api-key` | `permission`: `sending_access` (default) or `full_access`; `domainId` (required for `sending_access`: the key is limited to this domain; not used for `full_access`) |
| `revenuecat-secret-key` (manual) | `projectId` (optional, integration default allowed): project that apps and public SDK keys are read from; without it the apps of every project of the connection are listed |
| `grafana-service-account-token` | `baseUrl` (required, https, no port; host must be `*.grafana.net` or in `providers.grafana.allowedHosts`), `serviceAccountId` (integer, required). The expiry is always set: `ttlDays`, else 90 days. |
| `grafana-access-policy-token` | `region` (required, for example `us` or `eu`; integration default allowed), `accessPolicyId` (required, selectable from the discovered `grafana.accessPolicy` resources). The expiry comes from `ttlDays` (default 90 days). |
| `vapid-keypair` | `publicKeyVariable` (required: inventory id of the **variable** entry that receives the public key) |
| `github-fine-grained-token` (manual) | optional `params.permissions`, a map such as `{ contents: read, metadata: read }`, prefills the GitHub token form (together with `ttlDays`, the description and the configured owner) |
| other manual providers | none |

### VAPID key pairs (private key as secret, public key as variable)

`vapid-keypair` generates a P-256 pair for web push with `node:crypto`: the private key is the raw 32-byte scalar and the public key the uncompressed 65-byte point, both base64url (the format web-push libraries expect). Put it on the secret entry `VAPID_PRIVATE_KEY`; `publicKeyVariable` names the **variable** entry (for example `VAPID_PUBLIC_KEY` or `NEXT_PUBLIC_VAPID_PUBLIC_KEY`) that receives the public key from the same issuance. The review lists the variable (name, targets, fingerprint), the commit writes it as a GitHub variable and stores the new value as the variable's expected value. A value for an entry of the wrong kind is refused (a public value never reaches a secret entry, a secret never a variable).

The pair does not expire (`expiry: none`). **Rotating invalidates all existing push subscriptions**; users have to subscribe again. The review checklist and the checks say so, so a human confirms it. The pair is checked before it is shown (the private key must derive the public key); the test derives the public key again from the stored private key, but cannot compare it with the variable (the verification only sees the private key).

### Grafana Cloud access policy tokens

`grafana-access-policy-token` creates a token for an access policy on grafana.com (not a stack): `POST https://www.grafana.com/api/v1/tokens?region=<region>` with `accessPolicyId`, `name`, `displayName` and `expiresAt`, revoke with `DELETE /api/v1/tokens/<id>?region=<region>`, discovery with `GET /api/v1/accesspolicies?region=<region>` (resource kind `grafana.accessPolicy`). The host is fixed to `www.grafana.com`, so the connection token never goes to a host from the inventory. The connection `grafana-cloud` holds a grafana.com token whose access policy has `accesspolicies:write` (and `accesspolicies:read` for discovery). **The request and response shapes are written from memory of the API and are not verified live**; the code marks them. The test calls the policies endpoint with the new token: HTTP 200 passes, 401 fails, 403 or anything else is reported as "not checkable with this scope".

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

#### Several zones, Terraform and Cloudflare for SaaS

The zone-bound policy can cover more than one zone:

- `zoneId`: one zone by id (as before).
- `zones`: a list of zone **names**, for example `["acme.example", "acme.test"]`. Each name is resolved through `GET /zones?name=<name>&account.id=<account>` (exact name match, lower-cased); the ids go into one policy. A name that does not resolve aborts the issuance with the names (fail closed), and no token is created. Resolving needs a connection token that may read zones. `zoneId` and `zones` can be combined. An entry of `zones` that already is a zone id (32 hex characters) is used as it is, without a lookup, for connection tokens that may not read zones.
- `allZones: true`: the policy uses the resource `{ "com.cloudflare.api.account.<account>": { "com.cloudflare.api.account.zone.*": "*" } }`, i.e. every zone of the account, **also zones created later**. It cannot be combined with `zoneId` or `zones`, and the preflight warns about the reach. No zone lookup is made.

Presets on the `permissions` parameter (the lists live in `packages/providers/src/cloudflare.ts` and are covered by a test; an entry can always set `permissions` itself):

| Preset | Permission groups | Needs |
|---|---|---|
| `terraform-plan` | Account Settings Read, Zone Read, DNS Read, Zone Settings Read, Page Rules Read, Config Settings Read, Workers Routes Read, Workers Scripts Read, Workers R2 Storage Read, Access: Apps and Policies Read, Turnstile Sites Read, Pages Read | `zones` or `allZones` |
| `terraform-apply` | Account Settings Read, Zone Read, DNS Write, Zone Settings Write, Page Rules Write, Config Settings Write, Workers Routes Write, Workers Scripts Write, Workers R2 Storage Write, Access: Apps and Policies Write, Turnstile Sites Write, Pages Write | `zones` or `allZones` |
| `saas-custom-hostnames` | SSL and Certificates Write, Zone Read | `zoneId` (or `zones`) |

Zone-level groups (DNS, Zone Settings, Page Rules, Config Settings, Workers Routes, SSL and Certificates, Zone) go to the zone policy, the others to the account policy. The group names are the ones the Cloudflare permission-group list is shows (user tokens); the names were checked against a live account on 2026-11-04. The pages groups are called *Pages Read* and *Pages Write*. A name the account does not list stops the issuance and is named in the error (fail closed). Cloudflare for SaaS custom hostnames are managed under the zone's SSL and certificates; no separate "Custom Hostnames" group is known, and if the account lists one, add it to `permissions`. Use separate entries (and tokens) for plan and apply so the read-only token cannot change anything. The account-level `Workers R2 Storage` groups cover R2 buckets managed by Terraform, not object access: use `cloudflare-r2-credentials` for that.

### Cloudflare R2 S3 credentials (access key ID and secret access key together)

Account-owned tokens are not used: the *Create additional tokens* connection token gets HTTP 403 (code 9109) on `/accounts/<id>/tokens` (seen live on 2026-11-04).

`cloudflare-r2-credentials` issues the S3 key pair for R2 from one API token. Cloudflare derives the S3 credentials from an API token: the **Access Key ID is the token id** and the **Secret Access Key is the SHA-256 (hex) of the token value**. The provider creates a user token (`POST /user/tokens`, like `cloudflare-token`) restricted to R2 resources of the account and derives both values locally; the token value itself is never stored.

- Attach it to **one** of the two entries. `value` says which half this entry receives (`secretAccessKey` or `accessKeyId`), `companionEntry` names the entry for the other half. Both are written in the same commit; the review lists the companion (name, targets, fingerprint, never the value). Every issuance creates a new token, so both entries change together. Two pairs (for example app storage and a Terraform state bucket) are two token entries, each with its own companion.
- `access`: `read` (*Workers R2 Storage Bucket Item Read*), `write` (item read and write) or `admin` (account-level *Workers R2 Storage Read* and *Write*, also manages buckets). `buckets` limits read and write to `com.cloudflare.edge.r2.bucket.<account>_<jurisdiction>_<bucket>` resources; without it the account resource is used (all buckets). `admin` cannot be limited to buckets.
- Expiry: `expires_on` is always set, from the entry's `ttlDays` (default 90).
- Revoke deletes the token (`DELETE /user/tokens/<id>`; already gone counts as done).
- Verify: the token is read through the connection (status, expiry). With a `bucket` and when the entry holds the secret access key, an S3 `ListObjectsV2` (`max-keys=1`) on the first bucket is signed with SigV4 (`node:crypto`, region `auto`, service `s3`) against `https://<account>.r2.cloudflarestorage.com` (`<account>.eu.r2...` for `eu`). Without a bucket only the token is checked: the token value is not available at verify time (the entry holds only its hash), so the planned `GET /accounts/<id>/r2/buckets` probe with the token itself is not possible.

Not verified live: the permission group names, the `all buckets` resource form and the S3 derivation against a real bucket. The SigV4 signer is checked against the AWS test vector `get-vanilla`.

Parameters can be defaults of the integration (`integrationDefaults` in the inventory, only parameters marked `integrationDefault`: `accountId` for Cloudflare, `baseUrl` for Grafana). They apply when an entry does not set the parameter.
`discover` lists resources of the connected integration read-only; the portal offers **one** suggestion at most (project name contains repository and stage; zone or domain name contains the repository; a single account) and never applies it by itself. Ambiguous or weak matches give no suggestion.
The preflight (read-only, before prepare and in the dry run for humans) checks that the chosen resource belongs to the integration and names it, for example `Supabase-Projekt acme-app-staging (ref abc)`. A sure mismatch (`fail`) stops the issue with `409` / `code: "preflight_failed"`; unreadable lists are warnings.

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

Variables can load their value from a source (`from: { connection, kind, resource, field }`), with a fixed allowlist of public fields only: Supabase `ref`, `url`, `publishableKey` (never `service_role` or secret keys); Cloudflare `accountId` (from `GET /accounts`; a configuration value, not a secret: keep `CLOUDFLARE_ACCOUNT_ID` as a variable with this source, normalize says so for a secret of that name), `zoneId`, zone `name`, Turnstile `sitekey`; Resend `domainId`, `name`; RevenueCat project `id`, `name`, app `id`, `name`, `type`, and the public SDK keys `production` and `sandbox` of an app (never a secret key; if an app has several keys for an environment, the newest by `created_at` is used). Not implemented: Grafana stack (`grafana.stack`: needs the Grafana Cloud API) and a Stripe publishable key (no read endpoint with a restricted key).

## RevenueCat via the browser

`revenuecat-secret-api-key-browser` creates a RevenueCat **secret API key** (V2) through the dashboard with a [browser recipe](RECIPES.md) (`recipes/revenuecat-secret-api-key.yaml`), because the key is created in the dashboard. You sign in yourself; secret-desk fills the form, clicks *Generate*, reveals the key in the key list and reads it. Revocation is automated too (More, Revoke, Confirm in the key's row).

| Parameter | Meaning |
|---|---|
| `projectId` | Required. The project id from the dashboard address (`/projects/<id>/`), matching `^[a-z0-9]{6,20}$`. |
| `projectConfiguration`, `customerInformation`, `chartsMetrics`, `audiences`, `iam` | Access level of that permission section: `No access` (default), `Read only` or `Read & write`. Give the key no more than the service needs. |

The parameters are validated before any browser opens (`params_invalid`). The form and the key list were checked against the live dashboard on 2026-11-02 with a throwaway key (revoked afterwards); the full recipe run was verified live on 2026-11-03 (two secret keys and one integration key through the guided sign-in); the password, one-time code, approval and CAPTCHA steps of the sign-in form are not.

## Peecho via the browser (read-only)

`peecho-api-keys-browser` reads the two API keys that Peecho shows in its dashboard (*Merchant API Key* and *Secret key*) with the [read-only recipe](RECIPES.md#reading-values-instead-of-creating-them-kind-read) `recipes/peecho-api-keys.yaml`. Peecho has no API and no button to create, replace or reveal these keys; they are fixed and only readable, so renewal means *read again* (for example after Peecho support changed the key by e-mail). Nothing is created or revoked, and the keys do not expire.

| Parameter | Meaning |
|---|---|
| `portal` | Required: `live` (`www.peecho.com`) or `test` (`test.www.peecho.com`). Separate accounts, separate keys. |
| `value` | Required: `merchantKey` or `secretKey`, the key this entry takes. |
| `companionEntry` | Optional: inventory id of the entry that receives the other key from the same read. |

The run opens the dashboard (you sign in), tries `/mio-dashboard/settings/api` (read-only inputs, selectors not verified) and otherwise follows the *Application settings* link and reads the *API* tab (a definition list of plain text, verified 2026-11-04). Both values must match `^[A-Za-z0-9]{32,64}$`. The review says *Not checked against Peecho API keys*: Peecho offers no call to test a key, so only the shape is checked. Use `expiry: none` on the entries; `verifiedAt` is the date of the last read.

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
