# Providers

`automatic` = the portal generates the value via API. `manual` = you create it at the provider and paste it in; the portal verifies it.
Each provider supplies its own checks and review points. The *Verified* column says how certain the endpoint is.

| Id | Kind | Connection | Verified |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | none | locally |
| `cloudflare-token` | automatic | `cloudflare` (token with *API Tokens Write*) | reference read, `expires_on` only from a third-party source |
| `cloudflare-turnstile` | automatic | `cloudflare` | **not verified** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | documentation read, field names **not verified** |
| `stripe-webhook-secret` | automatic | `stripe` (key of the respective account) | search, fields **not verified** |
| `resend-api-key` | automatic | `resend` | **not verified** |
| `grafana-service-account-token` | automatic | `grafana` | **not verified** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `openai`, `telegram-bot` | manual | none | guides; landing pages where no sub-page is known |

**Before the first real use**, test every `automatic` provider with a throwaway entry in dev or staging.

## What providers do not offer
Supabase access tokens, GitHub tokens (fine-grained PATs) and Stripe restricted keys cannot be created via API. Use the
manual route for them (or browser automation, see [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md)). For GitHub, a **GitHub App** is worth it: the portal and your workflows then obtain a token valid for one hour per run.

## Adding your own provider
Without an API: in the inventory under `providers` (name, URL, steps), or via the MCP tool `desk_add_provider`.
With an API: register a `Provider` with `issue`, `revoke`, `verify` and `reviewChecklist` (see `packages/providers/src`).
