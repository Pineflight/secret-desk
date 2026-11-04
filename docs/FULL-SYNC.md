# Full sync: set up every repository from the inventory

This guide brings the secrets and variables of many repositories into a known state in one pass: the inventory is built
from what the workflows actually read, names are normalized, every value that a provider can create is created, every
variable gets its value from its source, and GitHub receives all of it. Use it for a first rollout, or for a clean start
after you emptied the repositories on purpose.

It assumes a running portal (locally, or in Docker as described in [DOCKER.md](DOCKER.md)), a connected GitHub
integration and the provider integrations you need ([INTEGRATIONS.md](INTEGRATIONS.md)).

## Order

1. [Back up the inventory](#1-back-up-the-inventory)
2. [Find what the workflows need](#2-find-what-the-workflows-need)
3. [Complete the inventory](#3-complete-the-inventory)
4. [Normalize names](#4-normalize-names)
5. [Assign sources and parameters](#5-assign-sources-and-parameters)
6. [Create missing GitHub environments](#6-create-missing-github-environments)
7. [Dry run](#7-dry-run)
8. [Write variables](#8-write-variables)
9. [Create and write secrets](#9-create-and-write-secrets)
10. [Paste the remaining values](#10-paste-the-remaining-values)
11. [Change workflows and remove old names](#11-change-workflows-and-remove-old-names)
12. [Check the result](#12-check-the-result)

Steps 1 to 7 change nothing in GitHub. Steps 8 to 11 do, so read the output of step 7 before you continue.

## Running the CLI in the container

All commands below use the CLI ([CLI.md](CLI.md)). It acts as a human, so it is not bound by the agent policy, and it
uses the integration tokens from the vault. When the portal runs in Docker, call the CLI inside the container:

```bash
docker exec -it <container> sh -c 'cd /app && node packages/cli/dist/bin.js <command> --config /data/config/secret-desk.config.yaml'
```

Replace `<container>` with the container name (`docker ps`). In the rest of this guide, `secret-desk` stands for
`node packages/cli/dist/bin.js` and `--config` is left out for brevity.

The CLI and the portal both edit `inventory.yaml`, and you do not need to restart the portal after a CLI run. The portal
follows the file: every read checks whether the file changed (cheap stat check, then a content hash) and reloads it, and the
open pages refresh within a few seconds or when you return to the tab. When the portal saves, it never writes over a newer
file: if the CLI wrote in between, the portal reloads, applies its change to the new content and saves that. Only when its
change no longer fits (for example it adds an id the CLI just added) the save fails with a conflict (409) and nothing is
overwritten; reload and repeat. A file that cannot be parsed or validated (an editor mid-save) is ignored, the last valid
state stays in use, and the portal shows a notice if it stays unreadable. Open approvals whose entry changed on disk become
*stale* immediately. Open reviews and approvals still live in memory and are lost on a restart. Edits by hand are picked up
the same way; an editor that writes in place can be caught half way, which the portal treats like any unreadable file
(it waits and retries).

## 1. Back up the inventory

```bash
cp -p /data/config/inventory.yaml /data/config/inventory.yaml.bak-$(date +%Y%m%d-%H%M)
```

The inventory holds only metadata, so the backup is safe to keep next to it. Make one before every larger change.

## 2. Find what the workflows need

The comparison reads `secrets.X` and `vars.X` from the workflow files of every repository and shows what is missing:

- Portal: **Compare**, with *Check live against GitHub* and *Evaluate workflows* switched on, and *All repositories of the
  organization* if some are not in the inventory yet.
- API: `GET /api/agent/compare?live=1&all=1&workflows=1` ([COMPARE.md](COMPARE.md)).

Look at three things:

| Finding | Meaning | What to do |
|---|---|---|
| *needed, missing* | A workflow reads the name, the inventory has no entry for it. | Add the entry (step 3). |
| *orphan* | An inventory entry no workflow reads. | Usually an old name: remove it or let normalization rename it. |
| *level mismatch* | The job reads it in an environment, the inventory keeps it at repository level, or the other way round. | Fix the place (step 3). |

The workflows are the source of truth for this run. Reusable workflows (`workflow_call`) receive their secrets from the
caller; their needs belong to the calling repository.

**Where a job reads a value.** A job with `environment: staging` sees the environment's secrets and variables first and
falls back to the repository level. A job without `environment` sees only the repository level. A name read in
`if:` at job level, or in the workflow-level `env:`, must be a repository variable, because environments are not
resolved there.

## 3. Complete the inventory

Add every missing entry with its stage and place: in the portal (*New entry*), or for many
entries at once in `inventory.yaml` ([CONFIGURATION.md](CONFIGURATION.md#inventory-inventoryyaml)). Check the file with:

```bash
secret-desk check
```

`check` validates the whole inventory offline (ids, stages, places, schema) and prints the number of entries.

Some rules that save a second pass:

- One value used in several places (two repositories, or an environment and the repository level) is **one entry with
  several places**, so the same value goes everywhere. Two entries for the same provider resource (for example one
  Turnstile widget) rotate it twice and the second one fails.
- A value that is the same for every stage belongs at repository level (stage `shared`); the environment falls back to it.
- Configuration (account ids, project refs, URLs, site keys, public keys) is a **variable**, not a secret.

## 4. Normalize names

**Normalize** proposes unified names: no stage word in the name (the environment decides the stage), no framework
prefix (`NEXT_PUBLIC_`, `VITE_` belong in the workflow), current provider terms. It also proposes sources for variables
and providers for secrets that can be created automatically. Details: [NAMING.md](NAMING.md).

```bash
secret-desk inventory normalize                    # show the plan, changes nothing
secret-desk inventory normalize --apply <id>,<id>  # apply selected changes
secret-desk inventory normalize --apply all        # apply every unambiguous change
```

Leave out a rename when one job needs two of the renamed entries at the same place (for example two project refs that a
single Terraform job reads together): one name could not hold both. Renames take effect in GitHub only after the
workflows are changed (step 11).

## 5. Assign sources and parameters

**Variables.** A variable with a source gets its value from the provider instead of being typed: project ref, URL and
publishable key from Supabase, account and zone ids from Cloudflare, the site key of a Turnstile widget, the id of a
Resend domain. Choose the source in the variable's card (*Load from provider*); [RESOURCES.md](RESOURCES.md) lists the
sources. Normalize assigns the unambiguous ones; for the rest, pick the resource yourself.

**Secrets.** Every automatic entry needs its parameters, for example the Cloudflare `permissions` and, for zone-bound
permissions, a `zoneId`; the Resend `domainId`; the Supabase `projectRef`; the Stripe webhook `url` and `events`. Use
*Complete parameters* in the portal, or the parameter card of each entry. [PROVIDERS.md](PROVIDERS.md) lists
the parameters per provider.

## 6. Create missing GitHub environments

Secrets and variables of an environment can only be written when the environment exists. The comparison shows a
`404` for those targets. Create each one in GitHub (*Settings*, *Environments*, *New environment*) or with
`gh api -X PUT repos/<owner>/<repo>/environments/<name>`. Protection rules are up to you.

## 7. Dry run

```bash
secret-desk doctor                 # connections, write access to every target, policy
secret-desk renew <secret-id> --dry-run
```

`doctor` checks every GitHub target for write access without writing. `renew --dry-run` prints the plan for one entry:
provider, targets, and whether an old value would be revoked. Run it for every automatic entry; an entry that fails here
will fail in step 9 as well.

## 8. Write variables

Load each sourced variable from its provider, then write it:

```bash
secret-desk vars list                    # expected values
secret-desk vars apply <variable-id>     # writes the expected value to every place
```

`vars apply` prints `created`, `updated`, `unchanged` or `failed` per place. A value that only looks like a secret (a long
site key, a JWT-shaped publishable key) needs `--ack-public`; clear secret formats are always refused.

## 9. Create and write secrets

For every automatic entry:

```bash
secret-desk renew <secret-id>
```

`renew` creates the value at the provider, verifies it, prints the review report and asks you to confirm each checklist
item before it writes to GitHub. With `--yes` all items are confirmed without asking; use it only when you have read the
dry run and the checklist of that provider.

To go through many entries, loop over the ids and keep the output, which never contains a value:

```bash
for id in <id-1> <id-2> <id-3>; do echo "## $id"; secret-desk renew "$id" --yes; done 2>&1 | tee renew.log
```

Read `renew.log` for `Fehler`/`Error` lines and rerun only those entries after fixing their parameters.

**Order matters for running systems.** A new value takes effect in a deployed worker or app only with its next deploy.
Values that must match on two sides (a webhook secret registered at the provider, a signing key shared by two services)
change at once on both sides only when both are deployed. Renew the stages you can redeploy right away first.

## 10. Paste the remaining values

Entries with provider `manual` (passwords, keys from providers without an API) get their value in the portal: open the
entry, *Paste value*, then confirm the review. Providers that have a browser recipe can create the value in a browser
window instead ([BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md)). A VAPID key pair for web push comes from
`secret-desk vapid`: paste the private key into the secret entry and set the public key as the variable's expected value.

## 11. Change workflows and remove old names

For every rename from step 4, per repository:

1. Make sure the value exists in GitHub under the new name (steps 8 to 10).
2. Change the workflow to read the new name and merge it.
3. Delete the old name in GitHub. The comparison lists it as an orphan.

Never delete an old name before the workflow that reads it is changed.

## 12. Check the result

Run the comparison again with *Check live against GitHub* and *Evaluate workflows* on. Every needed name should be present in every stage it is read in;
what remains are entries waiting for a manual value or for a provider resource that does not exist yet. `secret-desk
status --live` lists every secret with its status against GitHub.

## Limits you may meet

- **Paused projects.** Supabase refuses to create API keys while a project is paused
  (`Project must be healthy to create new API keys`) and returns no publishable key. Resume the project, then rerun.
- **Read permissions of integration tokens.** A Cloudflare token from the template *Create additional tokens* cannot list
  accounts or zones, so sources of kind `cloudflare.account` and `cloudflare.zone` cannot be read with it. Keep those
  variables as fixed values, or connect a token that may read them.
- **Zones of a Cloudflare token.** Zone-bound permissions (DNS, Workers Routes, Zone Settings) need `zoneId`, a list of zone
  names in `zones` (resolved through the API, which needs a token that may read zones) or `allZones: true` (every zone of the
  account, also future ones). See [PROVIDERS.md](PROVIDERS.md#several-zones-terraform-and-cloudflare-for-saas).
- **Turnstile secrets.** Renewing a widget's secret starts a rotation at Cloudflare; a second renewal of the same widget
  fails until the first one is finished. Keep one entry per widget.
- **Organization secrets** are not written by this flow; the GitHub token needs the organization permission to see them.
