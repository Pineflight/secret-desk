# Configuration reference

secret-desk reads two YAML files. Both contain **metadata only**, never a value.

| File | Purpose | In Git? |
|---|---|---|
| `secret-desk.config.yaml` | Machine and account settings: where the inventory is, which GitHub owner, where access tokens come from, policy, vault, browser automation. | No (listed in `.gitignore`) |
| `inventory.yaml` | What you manage: stages, secrets, variables, dev `.env` templates, custom providers, expiry thresholds. | Yes, that is the point (it is the team's source of truth) |

The schemas are defined with zod in [`packages/core/src/config.ts`](../packages/core/src/config.ts) (configuration) and [`types.ts`](../packages/core/src/types.ts) and [`stages.ts`](../packages/core/src/stages.ts) (inventory). Unknown top-level fields are ignored by the configuration loader; invalid values stop the start with a message listing every problem as `path: message`.

The portal looks for the configuration in the file named by the environment variable `SECRET_DESK_CONFIG`, otherwise `secret-desk.config.yaml` in the repository root. The CLI takes `--config <file>`. `inventory`, `evidenceDir` and the paths under `automation` may be relative; they are resolved from the configuration file. Use absolute paths or `~` (the home directory) for `linksFile`, `vault.file` and `vault.keyFile`.

Annotated examples: [`examples/secret-desk.config.example.yaml`](../examples/secret-desk.config.example.yaml) and [`examples/inventory.example.yaml`](../examples/inventory.example.yaml).

- [Configuration file](#configuration-file)
- [Connection sources](#connection-sources)
- [Inventory (`inventory.yaml`)](#inventory-inventoryyaml)
- [Environment variables](#environment-variables)
- [Files secret-desk writes](#files-secret-desk-writes)

## Configuration file

### Top level

| Field | Type | Default | Description |
|---|---|---|---|
| `inventory` | string | required | Path to the inventory file, relative to the configuration file. |
| `evidenceDir` | string | `.secret-desk-evidence` | Folder for review reports and attachments, relative to the configuration file. Do not commit it. |
| `linksFile` | string | `~/.secret-desk/repo-links.json` | Local file with the folder links of repositories. Machine-specific, never part of the inventory. Created with mode 600. |
| `vault` | object | `{ enabled: true }` | Encrypted store for integration tokens, see [below](#vault). |
| `github` | object | required | GitHub owner and authentication, see [below](#github). |
| `connections` | map | `{}` | Where the access tokens of the providers come from, by connection id, see [Connection sources](#connection-sources). |
| `policy` | object | `{ envRoots: [] }` | What agents may do and where `.env` files may be written, see [below](#policy). |
| `providers` | object | `{ grafana: { allowedHosts: [] } }` | Provider-specific settings, see [below](#providers). |
| `automation` | object | see below | Browser automation for providers without an API. |
| `compare` | object | `{ ignoreRepos: [".github", ".github-private"] }` | Stage comparison settings. |
| `server` | object | `{ port: 4747 }` | Portal port. |

### `vault`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` turns the vault off: tokens can then only live in memory for the session (or come from a configured source). |
| `file` | string | `~/.secret-desk/vault.json` | Vault file (AES-256-GCM encrypted). |
| `keyFile` | string | unset | Set only deliberately. Windows: location of the DPAPI-protected key blob (default `<vault file>.key`). Linux and macOS: a file with the key (Base64, 32 bytes, mode 600) **instead of** the keychain. Key and data then sit on the same disk; use it only when no keychain is available. |

The key itself comes from, in this order: the environment variable `SECRET_DESK_VAULT_KEY`, then `keyFile` if set, then the system keychain (macOS Keychain, Linux `secret-tool`, Windows DPAPI). See [INTEGRATIONS.md](INTEGRATIONS.md#vault).

### `github`

| Field | Type | Default | Description |
|---|---|---|---|
| `owner` | string | required | GitHub user or organization that owns the repositories. |
| `auth` | object | required | One of the two variants below. |

**Personal access token** (`type: pat`):

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"pat"` | required | |
| `source` | [source](#connection-sources) | `{ type: session }` | Where the token comes from. |

**GitHub App** (`type: app`): a token valid for one hour is created per run.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"app"` | required | |
| `appId` | string | required | The App's id. |
| `privateKey` | [source](#connection-sources) | required | Source of the App's private key. |
| `repositories` | string[] | unset | Restrict the installation token to these repositories. |

In App mode the installation token is requested with the permissions `secrets: write`, `environments: read` and `metadata: read` only ([`runtime.ts`](../packages/runtime/src/runtime.ts)). Variables and reading workflow files are therefore not available in App mode.

### `policy`

| Field | Type | Default | Description |
|---|---|---|---|
| `agentStages` | string[] (stage ids) | all stages of kind `dev` | Stages that agents (MCP) may act on without an approval. A stage of kind `live` is **always** removed from this list: it needs an approval even if you list it. Unknown ids produce a warning in `doctor`. |
| `envRoots` | string[] | `[]` | Folders where `.env` files may be written. Also the folders searched by *Find locally* (down to depth 2) and, next to the home folder, the allowed base for folder links. Empty means: agents may not write files, and humans are not restricted. |

See [AGENTS.md](AGENTS.md#policy) and [REPOSITORIES.md](REPOSITORIES.md#path-rules).

### `providers`

Settings that release network targets which an inventory entry could otherwise choose freely. The inventory may come from foreign sources (Git, pull requests); the configuration does not.

| Field | Type | Default | Description |
|---|---|---|---|
| `grafana.allowedHosts` | string[] | `[]` | Hosts allowed for the `baseUrl` parameter of `grafana-service-account-token` **in addition to** `*.grafana.net`. Exact host name, no port, https only. |

### `automation`

Browser automation, see [RECIPES.md](RECIPES.md) and [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md).

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` disables browser providers. |
| `chromePath` | string | unset | Chrome, Chromium or Edge executable. Otherwise the usual locations are searched. |
| `profileDir` | string | `~/.secret-desk/browser-profile` | Persistent browser profile (mode 700). |
| `loginTimeoutMinutes` | number, 1 to 120 | `10` | How long to wait for sign-in, 2FA or CAPTCHA in the window. |
| `slowMoMs` | integer, 0 to 5000 | unset | Slows every browser action down (milliseconds), so you can watch. |
| `recipesDirs` | string[] | unset | Additional folders with recipes (`*.yaml`). `<inventory folder>/recipes` is always read as well. |
| `allowExternalRecipes` | boolean | `false` | Load recipes from folders other than the bundled one. Recipes are executable browser scripts: enable this only for sources you trust. A recipe with the id of a bundled recipe never overrides it. |

### `compare`

| Field | Type | Default | Description |
|---|---|---|---|
| `ignoreRepos` | string[] | `[".github", ".github-private"]` | Repositories that the comparison neither shows nor reads (no GitHub calls, no workflow files). They appear only as *Ignored repositories*. Add, for example, an Upptime `status` repository with foreign template workflows. Setting the field replaces the default list. |

### `server`

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | integer, 1024 to 65535 | `4747` | The port the portal's Host check expects. The portal always binds to `127.0.0.1`. |

The `pnpm dev` and `pnpm start` scripts of `apps/desk` start Next.js on port 4747 regardless of this field. If you change the port, start Next.js yourself with the same port, for example `pnpm --filter @secret-desk/desk exec next dev -H 127.0.0.1 -p 4800`, and set `server.port: 4800`.

## Connection sources

A **source** says where an access token comes from. It is never the value itself. Used by `github.auth.source`, `github.auth.privateKey` and every entry of `connections`.

| `type` | Fields | Meaning |
|---|---|---|
| `session` | none | Entered in the portal; kept in memory until the portal stops. |
| `env` | `name` | Read from the environment variable `name`. |
| `op` | `ref` (must start with `op://`) | Read with the 1Password CLI (`op read <ref>`). |

`connections` is keyed by connection id. The ids in use are `github`, `github-app-key`, `cloudflare`, `cloudflare-turnstile`, `supabase`, `stripe`, `stripe-test`, `stripe-live`, `resend` and `grafana`; a custom provider may bring its own. The GitHub entry is set through `github.auth`, not `connections`.

```yaml
connections:
  cloudflare: { type: session }
  supabase: { type: env, name: SUPABASE_ACCESS_TOKEN }
  resend: { type: op, ref: "op://Private/Resend/api key" }
```

**Resolution order** for a token at the time it is needed: a token entered in this portal session, then the vault, then the configured source. An expired session or vault token does not fall back silently: the connection reports the problem. See [INTEGRATIONS.md](INTEGRATIONS.md).

## Inventory (`inventory.yaml`)

Top level:

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | required | Schema version. |
| `thresholds` | integer[] (days) | `[30, 14, 7]` | Expiry warning levels. The **largest** value starts *soon*, the **smallest** is *due*. `secret-desk check` opens one finding per level. |
| `stages` | [stage](#stages)[] | the four default stages | Stage definitions. Missing or empty means `dev`, `staging`, `production`, `shared`. |
| `secrets` | [secret](#secrets)[] | `[]` | Managed secrets. |
| `variables` | [variable](#variables)[] | `[]` | Managed GitHub Actions variables. |
| `envTemplates` | [template](#env-templates)[] | `[]` | Dev `.env` templates. |
| `providers` | [provider](#custom-providers)[] | `[]` | Custom providers without an API. |
| `integrationDefaults` | map of connection id to map | unset | Non-secret default parameters per integration, for example `cloudflare: { accountId: ... }`. See [RESOURCES.md](RESOURCES.md). |

Validation across the file: ids are unique across secrets and variables; every `stage` exists; a secret outside stages of kind `dev` needs at least one `places` entry; `issue` and `variable` sources in templates must reference existing entries; stages and places are resolved (see [STAGES.md](STAGES.md)).

### Stages

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Slug: `^[a-z0-9][a-z0-9-]{0,30}$`. |
| `label` | string, 1 to 40 | the id | Display name. |
| `kind` | `dev` \| `test` \| `live` \| `shared` | required | Behavior, see [STAGES.md](STAGES.md). |
| `environment` | string (1 to 100) \| `null` | `id` for `test` and `live`, none for `dev` and `shared` | Name of the GitHub environment. `null` means explicitly none. |
| `tone` | `info` \| `ki` \| `stage-prod` \| `neutral` \| `primary` \| `success` \| `warn` | by kind | Color in the portal. |

At most 12 stages. Ids must be unique.

### Secrets

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | slug | required | Unique id: lowercase letters, digits, hyphens. |
| `name` | string | required | Name in GitHub: `^[A-Z][A-Z0-9_]*$`, for example `CLOUDFLARE_API_TOKEN`. |
| `title` | string | unset | Optional display title. |
| `description` | string, max 500 | unset | What it is for and where it is used. |
| `owner` | string, max 80 | unset | Person or team responsible. |
| `link` | http(s) URL | unset | Provider dashboard, documentation or ticket. |
| `tags` | string[], max 12 | `[]` | Lowercase letters, digits, hyphens (`^[a-z0-9][a-z0-9-]{0,30}$`). |
| `product` | string | unset | Free grouping label. |
| `stage` | stage id | `shared` | The stage the secret belongs to. |
| `service` | string | required | Free label for the service (`cloudflare`, `stripe`, `internal`). |
| `provider` | string | `manual` | Provider module that creates the value ([PROVIDERS.md](PROVIDERS.md)). `manual` means a human pastes the value. |
| `params` | map | `{}` | Provider parameters, for example `accountId` or `projectRef`. See [PROVIDERS.md](PROVIDERS.md#parameters-per-provider). |
| `expiry` | `none` \| `possible` \| `required` \| `unknown` | `unknown` | Whether the value expires. `required` without a date is flagged *No date*. |
| `expires` | `YYYY-MM-DD` \| `null` | `null` | Expiry day. Not allowed together with `expiry: none`. |
| `ttlDays` | positive integer | unset | Lifetime of a newly created value, used to compute `expires` after a renewal when the provider does not report one. |
| `rotatedAt` | `YYYY-MM-DD` | unset | Set by the portal after a confirmed renewal. |
| `verifiedAt`, `verifiedBy` | date, string | unset | When and by whom the value was confirmed after review. Set by the portal. |
| `externalId` | string | unset | Identifier at the provider, used to revoke the old value. Not a secret. Set by the portal. |
| `source`, `rotation`, `notes` | string | unset | Free text. |
| `places` | [place](#places)[] | `[]` | Where the secret lives in GitHub. |

The status shown in the portal derives from `expires`, `expiry` and `thresholds`: `expired` (date passed), `missing` (live check: not in GitHub), `due` (within the smallest threshold), `no-date` (`expiry: required` without a date), `soon` (within the largest threshold), `unknown` (`expiry: unknown` without a date), otherwise `ok` ([`status.ts`](../packages/core/src/status.ts)).

### Variables

GitHub Actions variables (`vars.*`) are configuration, not secrets. The expected value lives in the inventory.

| Field | Type | Default | Description |
|---|---|---|---|
| `id`, `name`, `description`, `owner`, `link`, `tags`, `product` | as for secrets | | |
| `stage` | stage id | `shared` | |
| `value` | string, max 1000 \| `null` | `null` | The expected value. `null` means unknown: adopt it from GitHub. Values that look like secrets are rejected (hard) or need an explicit acknowledgement (soft). |
| `from` | `{ connection, kind, resource, field }` | unset | Optional source of the expected value in an integration (public fields only). See [RESOURCES.md](RESOURCES.md#5-variables-from-a-provider). |
| `places` | [place](#places)[] | required, at least one | |

### Places

A place is a target in GitHub.

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | string | required | Repository name (for scope `organization` it is still required by the schema). |
| `scope` | `repository` \| `environment` \| `organization` | required | Repository-level, environment-level or organization-level. The portal form does not offer `organization` yet. |
| `environment` | string | from the stage | Environment name for scope `environment`. If omitted, the stage's environment is used; a stage without an environment (`dev`, `shared`) makes this an error. |
| `name` | secret-style name | the entry's `name` | A different name in the target (rare). |

### Env templates

Dev `.env` templates, see [GETTING-STARTED.md](GETTING-STARTED.md#8-dev-env-for-a-repository).

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | slug | required | |
| `repo` | string, one line | required | Repository the file belongs to. |
| `stage` | stage id | `dev` | Only stages of kind `dev` are exported for agents. |
| `file` | string, one line | `.env.local` | File name relative to the repository's linked folder (when no path is given). |
| `entries` | entry[] | required, at least one | See below. |

Each entry has `key` (`^[A-Za-z_][A-Za-z0-9_]*$`), an optional one-line `description` (max 300) and a `from` source:

| `from.type` | Fields | Value comes from |
|---|---|---|
| `default` | `value` | A fixed string. Only for non-secret values such as URLs. |
| `generate` | `kind` (`hex` \| `base64` \| `uuid`, default `hex`), `bytes` (8 to 128, default 32) | A fresh random value. |
| `issue` | `secret` (secret id) | A personal dev token created at the provider for that secret. The provider must be automatic. |
| `prompt` | `hint` (one line, optional) | A value you enter (portal field, `--prompt KEY=VALUE`, or the environment variable `SECRET_DESK_PROMPT_<KEY>`). |
| `variable` | `variable` (variable id) | The expected value of an inventory variable. |

### Custom providers

A provider without an API: a guide only.

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | slug | required | Use it as `provider` in a secret. Must not collide with a built-in provider id. |
| `label` | string | required | Display name. |
| `url` | http(s) URL | required | Where the human creates the token. |
| `steps` | string[] | `[]` | The guide steps. |

### Example

```yaml
version: 1
thresholds: [30, 14, 7]

stages:
  - { id: dev, kind: dev, environment: null }
  - { id: staging, label: Staging, kind: test, environment: staging }
  - { id: production, label: Production, kind: live, environment: production }
  - { id: shared, kind: shared, environment: null }

secrets:
  - id: cloudflare-deploy-acme
    name: CLOUDFLARE_API_TOKEN
    description: Deploy access for the Workers of both repositories
    owner: team-platform
    link: https://dash.cloudflare.com/profile/api-tokens
    tags: [deploy, cloudflare]
    stage: shared
    service: cloudflare
    provider: cloudflare-token
    params:
      accountId: "0123456789abcdef0123456789abcdef"
      permissions: ["Workers Scripts Write", "Account Settings Read"]
    ttlDays: 90
    expiry: possible
    places:
      - { repo: acme-app, scope: repository }
      - { repo: acme-website, scope: repository }

variables:
  - id: site-url-staging
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-app, scope: environment }   # environment taken from the stage

envTemplates:
  - id: acme-app-dev
    repo: acme-app
    stage: dev
    entries:
      - { key: NEXT_PUBLIC_SITE_URL, from: { type: variable, variable: site-url-staging } }
      - { key: RATE_LIMIT_SECRET, from: { type: generate, kind: hex, bytes: 32 } }

providers:
  - id: acme-api
    label: Acme API
    url: https://acme.example.com
    steps: ["Sign in to the Acme dashboard", "Open API access", "Create a key and paste it into the portal"]
```

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `SECRET_DESK_CONFIG` | portal | Absolute path of the configuration file (default: `secret-desk.config.yaml` in the repository root). |
| `SECRET_DESK_VAULT_KEY` | portal, CLI | Vault key: 32 bytes, Base64 (`openssl rand -base64 32`). Takes precedence over the keychain. |
| `SECRET_DESK_USER` | portal | Name shown as the acting user (default: the operating-system user). |
| `SECRET_DESK_NO_LAUNCH_SECRET` | portal | `1` turns the launch secret off. For demos and development only. |
| `SECRET_DESK_DEMO` | portal | `1` starts the demo mode with a simulated GitHub. |
| `SECRET_DESK_AGENT_TOKEN` | MCP server | Agent token; otherwise `~/.secret-desk/agent-token` is read. |
| `SECRET_DESK_URL` | MCP server | Portal address (default `http://127.0.0.1:4747`). |
| `SECRET_DESK_PROMPT_<KEY>` | CLI `env export` | Value for the `prompt` entry `<KEY>`, instead of `--prompt`. |

## Files secret-desk writes

| Path | Content | Mode |
|---|---|---|
| `inventory.yaml` | Your inventory, updated by the portal (metadata only). | as you created it |
| `<evidenceDir>/` | Review reports (JSON) and attachments (PNG, JPEG, WebP up to 5 MB). | 600 files, 700 folder (POSIX) |
| `~/.secret-desk/vault.json` | Encrypted integration tokens (if you store any). | 600 |
| `~/.secret-desk/repo-links.json` | Folder links of repositories. | 600 |
| `~/.secret-desk/agent-token` | Bearer token for the agent API. | 600 |
| `~/.secret-desk/browser-profile/` | Persistent browser profile for recipes. | 700 |
| `.env` files you export | Your dev environment. | 600 |
