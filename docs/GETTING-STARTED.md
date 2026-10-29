# Getting started

This guide takes you from a fresh checkout to your first reviewed renewal and a dev `.env`. Budget 20 minutes. For a risk-free first run against real services, see also [TRIAL-RUN.md](TRIAL-RUN.md).

Contents: [1. Install](#1-install-and-build) - [2. Try the demo](#2-try-the-demo) - [3. Your own configuration](#3-your-own-configuration) - [4. The inventory](#4-create-the-inventory) - [5. GitHub token](#5-create-a-github-token-with-the-exact-permissions) - [6. Start and connect](#6-start-the-portal-and-connect-github) - [7. First renewal](#7-your-first-renewal-with-review) - [8. Dev .env](#8-dev-env-for-a-repository) - [9. Expiry reminders](#9-optional-expiry-reminders-as-github-issues)

## 1. Install and build

Requirements: Node 24 or newer ([`engines`](../package.json)) and pnpm 10.

```bash
git clone https://github.com/Pineflight/secret-desk.git
cd secret-desk
pnpm install
pnpm build
```

`pnpm build` compiles all packages and the portal. It is needed once, and again after you pull changes.

## 2. Try the demo

```bash
pnpm demo
```

Open <http://127.0.0.1:4747>. The demo uses a **simulated GitHub** inside the process and made-up data (`acme-app`, `alice`, `example.com`) from [`examples/demo`](../examples/demo). Nothing leaves your machine and no account is needed. In the demo you can:

- Look at **Overview** and **Secrets and variables** (kind, expiry, status, targets). The *Kind* switch (*All*, *Secrets*, *Variables*) narrows the one list; the old addresses `/secrets` and `/variables` redirect to it.
- Open a secret and choose **Generate new value** for one with the provider `random-hex` (a random value generated locally), then go to **Reviews**, tick the checklist and **Confirm and write to GitHub**. The write goes to the simulated GitHub.
- Open **Compare**, tick *Check live against GitHub* and look at gaps between stages.
- Switch *Kind* to *Variables* and compare the expected value with GitHub.

Stop the demo with Ctrl+C. The demo turns the launch secret off (`SECRET_DESK_NO_LAUNCH_SECRET=1`); a normal start does not.

## 3. Your own configuration

```bash
cp examples/secret-desk.config.example.yaml secret-desk.config.yaml
cp examples/inventory.example.yaml inventory.yaml
```

(Windows PowerShell: `Copy-Item examples\secret-desk.config.example.yaml secret-desk.config.yaml`, same for the inventory.)

Both files are metadata only. `secret-desk.config.yaml` is listed in `.gitignore`. Edit at least:

```yaml
inventory: ./inventory.yaml
github:
  owner: your-org          # your GitHub user or organization
  auth:
    type: pat
    source: { type: session }   # token entered in the portal, kept in memory
policy:
  agentStages: [dev]
  envRoots:
    - ~/projects               # folders where .env files may be written and Git folders are searched
```

Where access tokens come from (`session`, an environment variable, a 1Password reference) is described in [CONFIGURATION.md](CONFIGURATION.md#connection-sources). Never put a value in the file.

`pnpm dev` finds `secret-desk.config.yaml` in the repository root. To use another location set the environment variable `SECRET_DESK_CONFIG` to the file's absolute path.

## 4. Create the inventory

The inventory (`inventory.yaml`) lists what you manage: **secrets**, **variables**, the **stages**, dev `.env` **templates**, custom **providers** and the expiry **thresholds**. It holds metadata only and is safe to commit. The full field list is in [CONFIGURATION.md](CONFIGURATION.md#inventory-inventoryyaml).

A minimal inventory with one staging secret:

```yaml
version: 1
thresholds: [30, 14, 7]
secrets:
  - id: acme-hmac-staging
    name: ARTIFACT_HMAC_SECRET
    description: Signs artifact links. Must be identical in the worker and the edge function.
    owner: alice
    stage: staging
    service: internal
    provider: random-hex          # the portal generates a random value
    expiry: none
    places:
      - { repo: acme-app, scope: environment, environment: staging }
```

You can create entries in three ways:

1. Edit the YAML by hand.
2. Use **New** in the portal and pick *Secret* or *Variable* (preselected from the *Kind* switch).
3. Let the portal find them: on **Compare**, switch on *Check live against GitHub* and *All repositories of the organization*; names that exist in GitHub but not in the inventory can be added with a prefilled dialog (metadata only, provider `manual`, expiry unknown, never a value). See [COMPARE.md](COMPARE.md#orphans-and-adding-to-the-inventory).

The `staging` environment must exist in the GitHub repository before secrets can be written to it.

## 5. Create a GitHub token with the exact permissions

secret-desk writes with a **fine-grained personal access token** (or a GitHub App, see [INTEGRATIONS.md](INTEGRATIONS.md#github)). Grant the token access only to the repositories the portal should manage ("Only select repositories") and these permissions:

| Permission | Level | Needed for |
|---|---|---|
| Secrets | Read and write | writing secrets, reading which names exist |
| Variables | Read and write | variables (`vars.*`) |
| Environments | Read and write | **environment** secrets and variables |
| Metadata | Read | mandatory for every fine-grained token |
| Contents | Read | optional: lets *Compare* read `.github/workflows` to show what workflows need |

For **organization** secrets the token additionally needs the organization permission *Secrets* (Read and write). Recommended expiry: 90 days.

Prepared link (replace `YOUR-ORG` with your user or organization; check the form before you generate):

```text
https://github.com/settings/personal-access-tokens/new?name=secret-desk&target_name=YOUR-ORG&expires_in=90&secrets=write&actions_variables=write&environments=write&contents=read&metadata=read
```

In the portal, the **Guide** button on the GitHub card under **Integrations** opens the same link with your configured owner filled in. GitHub cannot prefill the repository selection; choose "Only select repositories" yourself.

> **Environments must be Read and write.** With only Read, writing an environment secret fails with `403 Resource not accessible by personal access token`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#403-resource-not-accessible-by-personal-access-token).

## 6. Start the portal and connect GitHub

```bash
pnpm dev
```

The terminal prints an address with a **launch secret**:

```text
http://127.0.0.1:4747/?launch=<secret>
```

Open exactly this address (the secret is shown only in that terminal). Without it the portal answers `401` and asks for the launch address. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#launch-required-401-and-the-launch-secret).

Then:

1. Go to **Integrations**, open the **GitHub** card, paste the token and state until when it is valid (a date, or "never expires"). With the config above it is kept in memory for this session. You can instead tick *Store encrypted on this machine* to keep it in the encrypted vault, see [INTEGRATIONS.md](INTEGRATIONS.md#vault).
2. Click **Test connection**. It makes read-only calls: login, token expiry, and a public-key read for every target in your inventory. A red line names the missing permission.
3. Optional: open **Write test**, choose targets and run it. It creates a probe secret and variable (`SD_WRITE_PROBE`, `SD_WRITE_PROBE_VAR`) and deletes them immediately. Live stages are never preselected.

You can run the same pre-check from the command line (only works for tokens from environment variables or 1Password; a session token lives in the portal's memory):

```bash
node packages/cli/dist/bin.js doctor --config secret-desk.config.yaml
```

## Choose the resource for each token

Providers with an API need to know which account, project or domain a token is for. On **Integrations**, open **Resources and defaults** on the card (save the Cloudflare account id there once), then check the **Parameters** card of each entry: choose from the list, take a suggestion if there is one, or type the value. **Generate new value** stays locked until the required parameters are set. With several entries, **Complete parameters** on **Secrets** fills the unambiguous ones in one go. Details: [RESOURCES.md](RESOURCES.md). Entries with the provider `random-hex` need none of this.

## 7. Your first renewal with review

Use a harmless secret first (provider `random-hex`, stage `staging` or `dev`).

1. **Secrets and variables**, open the secret, choose **Generate new value**. The portal creates the value in memory, checks that every target is reachable with write permission, and builds a **review report** with an evidence image. **Nothing is written to GitHub yet.**
2. **Reviews** shows the open review. Read the findings, tick every checklist item (optionally attach your own screenshot) and choose **Confirm and write to GitHub**. The button stays disabled until every item is ticked.
3. The portal encrypts the value with the target's public key, writes it, re-checks that the name exists, revokes the old value at the provider (where the provider supports it) and records `rotatedAt`, `expires`, `verifiedAt` and `verifiedBy` in the inventory.
4. **Reject and delete new value** instead discards it; at the provider the new value is deleted again.

If you do nothing, the review expires after 15 minutes and the value is discarded. The same flow from the command line: `secret-desk renew <id> --config secret-desk.config.yaml` ([CLI.md](CLI.md#renew)). With `--dry-run` it only prints the plan.

For providers without an API the portal shows a guide; you create the token at the provider and paste it in. The portal verifies it and the flow continues with the review.

## 8. Dev `.env` for a repository

Add a template to the inventory:

```yaml
envTemplates:
  - id: acme-app-dev
    repo: acme-app
    stage: dev
    file: .env.local
    entries:
      - { key: NEXT_PUBLIC_SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: RATE_LIMIT_SECRET, from: { type: generate, kind: hex, bytes: 32 } }
      - { key: STRIPE_SECRET_KEY, from: { type: prompt, hint: "Restricted key from the Stripe sandbox" } }
```

Open **Dev environment**, choose the repository and generate the file. Keys with `prompt` sources are reported as *Inputs missing*; fill in the fields shown, set the path (or link the repository to a local folder under **Repositories** and leave the path empty) and generate again. The file is written with mode 600; the portal shows key names only and warns if Git does not ignore the file. From the command line:

```bash
node packages/cli/dist/bin.js env export --config secret-desk.config.yaml --repo acme-app --prompt STRIPE_SECRET_KEY=...
```

The target folder must lie inside `policy.envRoots` (or the linked folder of that repository).

## 9. Optional: expiry reminders as GitHub issues

`secret-desk check --inventory inventory.yaml` works offline, prints one finding per level (30, 14, 7 days, expired, date missing) and exits `1` when something is expired or due. The template [`examples/workflows/secret-desk-expiry.yml`](../examples/workflows/secret-desk-expiry.yml) runs it daily and opens one issue per finding. The template calls `npx secret-desk@latest`; secret-desk is not published to npm, so adapt the install step to check out and build this repository (`pnpm install && pnpm build`) and call `node packages/cli/dist/bin.js check ...`.

## Where to go next

- [CONFIGURATION.md](CONFIGURATION.md): every field.
- [STAGES.md](STAGES.md): your own stages (for example `qa`, `canary`).
- [COMPARE.md](COMPARE.md): find missing names across stages.
- [AGENTS.md](AGENTS.md): let an AI agent maintain metadata safely.
- [TEAM.md](TEAM.md): onboard teammates.
