# Providers

`automatic` = the portal generates the value via API. `manual` = you create it at the provider and paste it in; the portal verifies it.
Each provider supplies its own checks and review points. The *Verified* column says how certain the endpoint is.

| Id | Kind | Connection | Verified |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | none | locally |
| `cloudflare-token` | automatic | `cloudflare` (token with *API Tokens Write*) | reference read, `expires_on` only from a third-party source |
| `cloudflare-turnstile` | automatic | `cloudflare` | **not verified** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | documentation read, field names **not verified** |
| `stripe-webhook-secret` | automatic | `stripe-test` / `stripe-live` / `stripe` (see below) | search, fields **not verified** |
| `resend-api-key` | automatic | `resend` | **not verified** |
| `grafana-service-account-token` | automatic | `grafana` | **not verified** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `openai`, `telegram-bot` | manual | none | guides; landing pages where no sub-page is known |

**Before the first real use**, test every `automatic` provider with a throwaway entry in dev or staging.

## Permissions per integration
Create each token with no more than this. The **Test connection** button on the Integrations page makes read-only calls to confirm it (see below).

| Connection | Permissions the token needs |
|---|---|
| `github` | Fine-grained PAT, only the repositories the portal manages: *Secrets* Read and write, *Variables* Read and write, *Environments* Read and write (environment secrets), *Contents* Read-only (optional: lets the stage comparison read `.github/workflows` to show what workflows need; not needed for repositories linked to a local folder), *Metadata* Read. For organization secrets also the organization permission *Secrets*. Recommended expiry: 90 days. |
| `cloudflare` | Template *Create additional tokens* (*User > API Tokens > Edit*), nothing else. Recommended expiry: 1 to 7 days, ideally with an IP restriction. |
| `cloudflare-turnstile` | Custom token with *Account > Turnstile > Edit*, limited to the one account. |
| `supabase` | Access token with *API Keys* Read-write and *API Key Secrets* Read (optionally *Project Settings* Read, *Projects* Read). The token never exceeds your own role (Owner or Admin). |
| `stripe`, `stripe-test`, `stripe-live` | Restricted key: *Webhook Endpoints* Write, everything else None. Optionally *Balance* Read, so the test can confirm the key. |
| `resend` | API key with *Full access*. Only this type can manage API keys. |
| `grafana` | Service account token (role Admin) of the stack. |

### Stripe: test and live
Use one key per mode. `stripe-test` takes a sandbox key (`rk_test_`), `stripe-live` a live key (`rk_live_`). The portal rejects a key whose prefix does not match the connection.
For an entry, the connection is chosen in this order: `connection` in the entry parameters, then by the kind of the stage (`test` uses `stripe-test`, `live` uses `stripe-live`, if connected),
then the general `stripe` connection. Existing setups with only `stripe` keep working unchanged. `dev` and `shared` stages always use `stripe`.

### Test connection
Each connected integration has a **Test connection** button (`POST /api/ui/connections/<id>/check`, portal only, never available to agents). It makes read-only calls:
GitHub `GET /user` (login and token expiry from the `github-authentication-token-expiration` header) plus a public-key read per inventory target; Cloudflare `GET /user/tokens/verify`
(status and `expires_on`; an expiry beyond 7 days gets a recommendation to shorten it); Supabase `GET /v1/organizations`; Stripe `GET /v1/balance` (a 403 on a restricted key is normal and shown as information; the mode comes from the key prefix);
Resend `GET /api-keys` (401/403 means the key lacks *Full access*). Grafana cannot be tested without a stack address. An expiry reported by the provider is shown on the card in place of the manual entry.
GitHub also offers an opt-in *write test*, see [SECURITY-MODEL.md](SECURITY-MODEL.md#write-test).

## What providers do not offer
Supabase access tokens, GitHub tokens (fine-grained PATs) and Stripe restricted keys cannot be created via API. Use the
manual route for them (or browser automation, see [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md)). For GitHub, a **GitHub App** is worth it: the portal and your workflows then obtain a token valid for one hour per run.

## Adding your own provider
Without an API: in the inventory under `providers` (name, URL, steps), or via the MCP tool `desk_add_provider`.
With an API: register a `Provider` with `issue`, `revoke`, `verify` and `reviewChecklist` (see `packages/providers/src`).
