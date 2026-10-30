# Naming convention and normalization

The inventory of a long-lived project drifts: `CF_ACCESS_CLIENT_ID` next to `CLOUDFLARE_API_TOKEN`, a stage in the name (`SUPABASE_STAGING_URL`) although the GitHub environment already says it, German words, framework prefixes. **Normalize** brings every secret and variable to one convention and, where a provider can deliver a value, switches the entry from "paste by hand" to "fetch automatically".

It changes the **inventory only**. It never writes to GitHub, never issues a value and never revokes one.

## The convention

Rules are applied in this order; each one that fires is reported with a reason code and the suggested name. A name that already complies produces no finding. The result is stable: normalizing a suggested name changes nothing.

| # | Code | Rule | Example |
|---|---|---|---|
| 1 | `not-upper-snake` | `UPPER_SNAKE_CASE`: only `A-Z`, `0-9` and `_`, starting with a letter. | `stripe-key` becomes `STRIPE_KEY` |
| 2 | `stage-in-name` | No stage in the name. The tokens `STAGING`, `STAGE`, `PRODUCTION`, `PROD`, `LIVE`, `DEV` and `TEST` are removed as whole `_`-separated tokens; the stage comes from the GitHub environment. | `SUPABASE_PRODUCTION_URL` becomes `SUPABASE_URL` |
| 3 | `provider-abbreviation` | Spell out the provider: leading `CF_` becomes `CLOUDFLARE_`, `TF_` becomes `TERRAFORM_`, `R2_` becomes `CLOUDFLARE_R2_`. `GH_<X>_TOKEN` becomes `<X>_GITHUB_TOKEN`, other `GH_<X>` becomes `<X>_GITHUB`. | `CF_ACCESS_CLIENT_ID` becomes `CLOUDFLARE_ACCESS_CLIENT_ID`; `GH_SECRETS_SYNC_TOKEN` becomes `SECRETS_SYNC_GITHUB_TOKEN` |
| 3b | `github-prefix` | GitHub rejects names that start with `GITHUB_`. The checker flags them and moves the provider to the end. A bare `GITHUB_TOKEN` is flagged without a suggestion. | `GITHUB_DEPLOY_TOKEN` becomes `DEPLOY_GITHUB_TOKEN` |
| 4 | `framework-prefix` | Remove leading `NEXT_PUBLIC_` and `VITE_`. The workflow maps the GitHub name to the framework name in `env:`. | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` becomes `TURNSTILE_SITE_KEY` |
| 5 | `supabase-canonical` | After rules 2 and 4: `SUPABASE_ANON_KEY` becomes `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` becomes `SUPABASE_SECRET_KEY`. | `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_STAGING_ANON_KEY` become `SUPABASE_PUBLISHABLE_KEY` |
| 6 | `non-english` | German words from a small dictionary become English (`GEHEIMNIS` to `SECRET`, `ABGLEICH` to `RECONCILIATION`, `KUNDENDOMAIN` to `CUSTOMER_DOMAIN`, ...). Unknown words are never guessed. | `RATE_LIMIT_GEHEIMNIS_WEB` becomes `RATE_LIMIT_SECRET_WEB` |
| 7 | `workspace-rename` | `naming.renames` in the configuration wins over the generic rules; `naming.keep` names are never changed. | `MAIL_API_KEY` becomes `RESEND_API_KEY` |

A product suffix is allowed and stays: `CLOUDFLARE_ZONE_ID_WAKEMILES` and `STRIPE_WEBHOOK_SECRET` are compliant.

### Workspace overrides

```yaml
# secret-desk.config.yaml
naming:
  renames:
    MAIL_API_KEY: RESEND_API_KEY   # a case the rules cannot know
  keep:
    - LEGACY_PARTNER_KEY            # never changed
```

See [CONFIGURATION.md](CONFIGURATION.md#naming).

## What Normalize proposes

Every proposal is a **change** with a stable id, shown before and after, with its reasons. Names, stages, providers and parameter keys are shown; **values never are**.

| Kind | What it does | Applicable automatically |
|---|---|---|
| `rename` | The name changes. The **entry id stays**. | yes |
| `stage` | A name that carried the stage (`..._STAGING_...`) on an entry whose stage is `shared`: the matching stage is proposed (`STAGING` to `staging`, `PRODUCTION`/`PROD`/`LIVE` to `production`, `DEV` to `dev`; `TEST` is ambiguous and proposes nothing). Skipped when a place names a different environment. | yes |
| `provider` | A manual entry whose value a provider can create switches to that provider: `SUPABASE_SECRET_KEY` (also the legacy `SUPABASE_SERVICE_ROLE_KEY`) and `SUPABASE_PUBLISHABLE_KEY` to `supabase-api-key` with `type: secret` or `publishable`; `STRIPE_WEBHOOK_SECRET` to `stripe-webhook-secret`; `GRAFANA_SERVICE_ACCOUNT_TOKEN` and `GRAFANA_READ_TOKEN` to `grafana-service-account-token`. Existing parameters are kept; missing required ones (`projectRef`, `url` and `events`, `baseUrl` and `serviceAccountId`) are named and completed afterwards with **Complete parameters**. Nothing is guessed. | yes |
| `source` | A variable without `from` gets one: `SUPABASE_URL` (field `url`), `SUPABASE_PROJECT_REF` (`ref`), `SUPABASE_PUBLISHABLE_KEY` (`publishableKey`), `CLOUDFLARE_ACCOUNT_ID` (`accountId`), `CLOUDFLARE_ZONE_ID` (`zoneId`), `TURNSTILE_SITE_KEY` (`sitekey`). The resource is set **only when unambiguous**: the existing value is that id, or the resource map has an entry for the repository (and stage), or, for the Cloudflare account, the integration default. Without a clear resource the change says "choose the resource" and nothing is set. | only with a clear resource |
| `merge` | After renaming, two entries of the same kind would have the same name at the same repository, scope, environment and stage. Shown as a conflict; you decide, nothing is merged for you. The colliding renames are withheld. | never |
| `manual-only` | Every other manual secret is listed with the reason it stays manual: no API at the provider (RevenueCat, Peecho, VesselAPI, DIP, OpenAI admin keys, Stripe restricted keys, `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`), an API secret-desk has no provider for yet (Cloudflare Access service tokens, R2 access keys), or no provider at all. | never |

Entry ids are **not** renamed on purpose. Evidence reports are stored per entry id on disk, approvals and review queues refer to it, and templates point at it. Moving all of that safely is not possible from the inventory alone, so a rename changes `name` only.

## In the portal

On **Secrets and variables** the button **Normalize** (with a count of the unambiguous changes) opens a dialog grouped by kind. Each change shows before and after, the reason and, for renames, the badge **Workflow change needed**. Tick the changes you want and choose **Apply selected**, or **Apply all unambiguous**. Afterwards the dialog offers **Complete parameters now**, which opens the existing dialog described in [RESOURCES.md](RESOURCES.md#4-complete-parameters-for-many-entries).

A secret or variable whose name breaks the convention also shows a small warning with the suggested name in its header.

The server applies everything or nothing: an unknown id, a change that is not automatic, or a result that would put two entries on the same target aborts the whole request and the inventory stays as it was. Apply is humans only. An agent may read the plan (`GET normalization`) but cannot apply it.

## On the command line

```bash
secret-desk inventory normalize --config secret-desk.config.yaml             # print the plan, names only
secret-desk inventory normalize --config secret-desk.config.yaml --apply all # asks, then applies the unambiguous changes
secret-desk inventory normalize --config secret-desk.config.yaml --apply rename:secret:cf-access,stage:variable:v-url --yes
```

See [CLI.md](CLI.md#inventory).

## What changes in your workflows

A rename changes the **name in the inventory**. GitHub keeps the old name until you create the new one, and your workflows still read the old one. In the comparison view the old name appears as an **orphan** ([COMPARE.md](COMPARE.md)) until the workflow uses the new name. For `NEXT_PUBLIC_` and `VITE_` names the workflow also needs an `env:` mapping:

```yaml
env:
  NEXT_PUBLIC_SUPABASE_URL: ${{ vars.SUPABASE_URL }}
  NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ vars.SUPABASE_PUBLISHABLE_KEY }}
```

## Migration order

1. **Normalize the inventory** (this page). Nothing in GitHub changes.
2. **Complete parameters** for the entries that switched to a provider ([RESOURCES.md](RESOURCES.md)).
3. **Generate or paste the values under the new names** in GitHub (renew an automatic entry, or paste the value for a manual one; set variables with their normal apply).
4. **Change the workflows** of each repository to the new names.
5. **Delete the old names** in GitHub. The comparison view lists them as orphans.

Do the steps per repository and in this order: deleting an old name before its workflow is changed breaks that workflow.
