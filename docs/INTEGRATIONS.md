# Integrations

An **integration** is a connection to GitHub or to a provider: an access token that secret-desk uses to write secrets or to create, check and revoke tokens at the provider. The **Integrations** page shows the state of each connection, a guide with the exact permissions, and tests.

![Integrations](images/integrations.png)

Create every token with **no more than** the permissions below, with a short expiry. Guides are in [`connection-guides.ts`](../packages/runtime/src/connection-guides.ts); the **Guide** button on each card shows the same.

## Connecting a token

1. Open the card and paste the token.
2. State **until when the token is valid** (a date in the future) or "never expires". This is required: it feeds the expiry warnings on the card.
3. Choose where it lives:
   - **For this session**: in memory until the portal stops (default).
   - **Store encrypted on this machine** ([vault](#vault)): kept across restarts.
4. Click **Test connection**.

For Stripe the key's prefix is checked: the sandbox connection takes `rk_test_`, the live connection `rk_live_` (also `stripe:<acct_id>:sandbox` / `:live`); a mismatch is rejected.

Instead of pasting, the configuration can point to an environment variable or a 1Password reference ([CONFIGURATION.md](CONFIGURATION.md#connection-sources)). **Resolution order** when a token is needed: session, then vault, then the configured source. An expired session or vault token is reported instead of silently falling back.

A token that never expires and has been stored for more than 90 days is flagged on the card.

## Permissions and recommended flow

### GitHub

Why: writes secrets and variables, reads which names exist. All values end up here.

Fine-grained personal access token, restricted to the repositories the portal should manage:

| Permission | Level | |
|---|---|---|
| Secrets | Read and write | |
| Variables | Read and write | |
| Environments | Read and write | needed for environment secrets |
| Metadata | Read | |
| Contents | Read | optional: workflow files for [Compare](COMPARE.md#workflow-needs) |

For organization secrets also the organization permission *Secrets* (Read and write). Recommended expiry: 90 days. The Guide opens the GitHub form with name, owner, expiry and permissions prefilled; you choose the repositories yourself.

A **GitHub App** is an alternative (`github.auth.type: app`): the portal then obtains a token valid for one hour per run. The installation token is requested with `secrets: write`, `environments: read` and `metadata: read` only, so variables and workflow files are not available in App mode.

**Team sync with a GitHub App.** [Team sync](TEAM.md#team-sync-with-a-private-github-repository) asks for its own installation token per operation (one check, take-over or push; never cached across operations), only for the team repository and only with `contents` (read; write to push), `pull_requests` (write, pull-request strategy only) and `metadata: read`. Add *Contents* and *Pull requests* to the App's permissions (App settings, Permissions and events) and make sure the installation includes the team repository, otherwise GitHub refuses the token (the connection test says so). These extra App rights are only used for team sync.

### Cloudflare (`cloudflare`)

Why: creates, checks and revokes further Cloudflare tokens (`cloudflare-token`), and Access service tokens (`cloudflare-access-service-token`).

Template **Create additional tokens** (*User > API Tokens > Edit*), nothing else. A token that can create tokens can grant access to everything your user can reach, so set a short expiry (1 to 7 days) and, if possible, an IP restriction. Keep it for the session.

No extra permission is needed for Access service tokens: the connection token only has to be able to create tokens. For each issuance the provider creates a helper token with *Access: Service Tokens Write* limited to one account and ten minutes, uses it for the Access call and deletes it again (see [PROVIDERS.md](PROVIDERS.md#cloudflare-access-service-tokens-client-id-and-secret-together)). The connection token itself never needs the Access permission.

### Cloudflare Turnstile (`cloudflare-turnstile`)

Why: renews the secret of a Turnstile widget. A separate connection, because the permission to create tokens cannot be combined with other permissions.

Custom token with *Account > Turnstile > Edit*, limited to the account that owns the widget.

### Supabase (`supabase`)

Why: reads, creates and deletes API keys of Supabase projects and sets their database password through the Management API.

Access token with *API Keys* Read-write and *API Key Secrets* Read; optionally *Project Settings* Read and *Projects* Read, and *Database config* Write (fine-grained permission `database_config_write`), needed only for `supabase-db-password`. Limit the token to the organization or projects to manage. A token never exceeds your own role (Owner or Admin needed). A full-access ("legacy") token works but is not recommended. The token is shown only once.

### Stripe (`stripe:<acct_id>:<mode>`, `stripe-test`, `stripe-live`, `stripe`)

Why: creates and revokes webhook endpoints and reads their signing secrets.

Restricted key with all resources `None` and only *Webhook Endpoints, Event Destinations* `Write`. Optionally *Balance* `Read`, so the test can confirm the key. One key per mode: `stripe-test` (sandbox, `rk_test_`) is preferred for stages of kind `test`, `stripe-live` (`rk_live_`) for kind `live`, if connected; the general `stripe` connection is the fallback, and `dev` and `shared` stages always use it. An entry's parameter `connection` overrides the choice. For several products in one Stripe organization use one connection per account and mode, `stripe:<acct_id>:sandbox` and `stripe:<acct_id>:live`, and set `account` on the entry (see [PROVIDERS.md](PROVIDERS.md#stripe-one-connection-per-account-and-mode)); the connection then verifies that its key belongs to that account.

### Resend (`resend`)

Why: creates, lists and revokes Resend API keys.

An API key with **Full access** (only this type can manage API keys). The keys secret-desk creates are narrow: *Sending access*, optionally limited to a domain.

### RevenueCat (`revenuecat`)

Why: reads projects, apps and **public** SDK keys so variables such as the project id, the app ids and the SDK keys do not have to be typed. Read only.

A **v2 secret API key** (starts with `sk_`; v1 keys do not work with API v2) with **Project configuration: Read only** and every other area on `None`. Create it under Project settings, API keys, "+ New secret API key" (`https://app.revenuecat.com/projects/<project id>/api-keys/new`). The key is never written anywhere by secret-desk; only public values and identifiers are read from it.

### Grafana Cloud (`grafana`)

Why: creates and revokes tokens of service accounts in a Grafana stack.

A service account for secret-desk with role Admin (so it can manage tokens of other service accounts), and a short-lived token for it. The stack address and the target service account id are parameters of the inventory entry; allowed hosts are `*.grafana.net` plus `providers.grafana.allowedHosts`.

The card links to `https://grafana.com/profile/org` (forwards signed-in users to their own organization; `grafana.com/orgs` needs an org slug and answers 404). As soon as a stack address is known (integration default `baseUrl` or any Grafana entry), the card's direct link is `<baseUrl>/org/serviceaccounts`. Steps: open the stack, Administration, Users and access, Service accounts.

## Guided sign-in (provider facade)

For providers whose keys exist only with a user account, *Integrations* has *Connect with sign-in* (RevenueCat and Stripe today). Flow: enter the provider email and password (this run only, never stored); the portal signs in through the remote browser (`automation.cdpEndpoint`) and shows each step with elapsed time and time limit; a one-time code is typed in the portal, an approval is awaited, a CAPTCHA is solved by you via *Open browser*; then the facade creates the integration key (RevenueCat: v2, *Project configuration: Read only*, no expiry, name `secret-desk-integration-<date>-<time>`), stores it as the connection (vault, else this session), runs *Test connection* and reports e.g. "1 project, 3 apps". The project is read from the dashboard address after sign-in; if that fails, enter the project id and connect (the browser stays signed in). *Check sign-in* needs no credentials. Pasting a key stays available as the collapsed *I already have a key*. **Stripe** also asks for the account id (`acct_...`) and the mode (`sandbox` or `live`), because one Stripe organization holds several accounts: the facade creates the restricted key (*Webhook Endpoints, Event Destinations: Write*, named `secret-desk-<test|live>-<date>-<time>`) with the recipe `stripe-restricted-key`, checks with `GET /v1/account` that the key belongs to that account and mode **before** storing it, stores it as `stripe:<acct_id>:<mode>` and tests it. A wrong key is not stored and the portal names the key to expire. The live mode may ask for the password again; the portal then says it waits for you in the browser window. The recipe for the sign-in form itself is not verified. Adding a provider means a descriptor in `packages/runtime/src/facade.ts` plus a recipe with `login.form`; `inputs` lists the recipe parameters the human chooses per run. Verification: see [ROADMAP.md](ROADMAP.md).

## Resources and defaults

Besides the permissions above, each card has **Resources and defaults**. The portal uses the same token, read-only, to list the accounts, projects, zones, domains or service accounts it can see, so entries can pick a resource from a list instead of typing an id, and to store non-secret **defaults** per integration. How the lists, suggestions and the preflight work: [RESOURCES.md](RESOURCES.md).

| Integration | What is listed | What the token must be allowed to read | Defaults |
|---|---|---|---|
| Cloudflare (`cloudflare`) | accounts, zones, permission groups | Accounts and zones need a read permission (for example *Account Settings Read* for accounts, a zone read permission for zones). The template *Create additional tokens* has none: enter the account id once by hand as the default (dashboard, account overview, copy the account id). Permission groups can always be listed. The connection page then shows "0 found" for accounts and zones with a hint saying exactly this. | `accountId` |
| Cloudflare Turnstile (`cloudflare-turnstile`) | accounts, Turnstile widgets | *Account > Turnstile > Edit* lists the widgets of the account; the account list needs a read permission as well, otherwise enter `accountId` by hand. | `accountId` |
| Supabase (`supabase`) | projects | The optional *Projects* Read (see above). Without it the list is empty or unreadable: enter the project ref by hand. | none |
| Resend (`resend`) | domains and their verification status | Domains can only be listed with **Full access** (the same key type the connection needs anyway). | none |
| RevenueCat (`revenuecat`) | projects, apps (with type) and, for variables, the public SDK keys of an app | *Project configuration: Read only* (`project_configuration:projects:read` and `project_configuration:apps:read`). | `projectId` |
| Grafana (`grafana`) | service accounts of the stack | The Admin service account of the connection; needs the stack address first. | `baseUrl` |
| GitHub, Stripe | nothing | | none |

If a list cannot be read, the card says so and the pickers on the entries fall back to *Enter the value by hand*. Nothing breaks: only the convenience is missing. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#parameters-and-resources).

## Test connection

A button on every connected card (`POST /api/ui/connections/<id>/check`, portal only, never available to agents). It makes **read-only** calls with the stored token:

| Connection | Call | What it shows |
|---|---|---|
| GitHub | `GET /user`, then a public-key read for every target in the inventory, and a workflow-files read | login, token expiry (header `github-authentication-token-expiration`), missing permissions per target, whether Contents is readable |
| Cloudflare | `GET /user/tokens/verify` | status, expiry (`expires_on`); more than 7 days for the creating token gets a recommendation |
| Supabase | `GET /v1/organizations` | token valid |
| Stripe | `GET /v1/balance`; for `stripe:<acct_id>:<mode>` also `GET /v1/account` | key valid and mode; a 403 on a restricted key is normal (information); the key belongs to the account of the connection id (and its name becomes the label) |
| Resend | `GET /api-keys` | 401 or 403 means the key lacks Full access |
| RevenueCat | `GET /v2/projects?limit=1` | 401 invalid key, 403 lacks *Project configuration: Read only*, 429 rate limit (60 requests per minute), a key not starting with `sk_` is flagged |
| Grafana | none | Cannot be tested without a stack address; checked when issuing |
| GitHub App key | none | Checked on first access: test through the GitHub connection |

An expiry reported by the provider is shown on the card instead of the manual entry. Messages never contain the token.

### Write test

GitHub only, opt-in, never automatic. It proves that the token may write. Open **Write test**, choose targets (repository or environment ids from the inventory; live stages are never preselected) and run it. For each chosen target the portal:

1. checks that no secret `SD_WRITE_PROBE` (variable `SD_WRITE_PROBE_VAR`) exists yet, and leaves an existing one untouched;
2. creates the probe with a throwaway value (the secret sealed with the target's public key, as for any other secret);
3. deletes it again immediately.

If the deletion fails the result names the probe and the target so you can remove it by hand. At most 40 targets are tested. See [SECURITY-MODEL.md](SECURITY-MODEL.md#write-test).

## Vault

The vault stores integration tokens encrypted so you do not need to enter them at every start. It never stores the values that secret-desk manages (those live only in GitHub).

- **Encryption:** AES-256-GCM. A hash would not work: the token must be usable again.
- **Key:** never next to the data. In this order: environment variable `SECRET_DESK_VAULT_KEY` (32 bytes, Base64), `vault.keyFile` if set, then the system keychain: macOS Keychain, Linux `secret-tool` (libsecret), Windows DPAPI (blob in `<vault>.key`, openable only by the same Windows account on the same machine).
- **File:** `~/.secret-desk/vault.json` (mode 600; `vault.file`). Only a missing file means an empty vault. A damaged file is an error, a copy is kept as `vault.json.corrupt-<time>`, and it is never overwritten.
- **Cards** show a short fingerprint (first characters of the token's SHA-256) so you can recognize the token without seeing it.
- **Turn it off** with `vault.enabled: false`.
- **Without a keyring** (Linux server, container): the vault says so and stores nothing in plain text. Set `SECRET_DESK_VAULT_KEY` or `vault.keyFile` (key and data on the same disk then).
- **On macOS** a new key is created only when the keychain reports the item as missing; any other failure (locked, denied) is an error and overwrites nothing.

To remove a stored token, use **Disconnect** on the card.
