# Command line reference

The CLI (`packages/cli`) offers the same operations as the portal for scripts and CI. It acts as a human (`cli`), so it is not bound by the agent policy.

```bash
node packages/cli/dist/bin.js <command> [options]
```

After `pnpm build`, `packages/cli/dist/bin.js` is the entry point; the package declares the binary name `secret-desk`. This document writes `secret-desk` for short. Run `secret-desk help` for the built-in overview.

Notes that apply to all commands:

- **Output language.** The text the CLI prints (including the built-in help) is currently German. Command names and options are as documented here.
- **Tokens.** The CLI reads access tokens from the configured sources: environment variable, 1Password reference, or the vault. A token that you entered in the portal for the session lives only in the portal's memory and is not available to the CLI.
- **Exit codes.** `0` success, `1` the command ran but reports a problem (see each command), `2` an error such as invalid input, an unknown command or a missing option.
- `--config <file>` is the path to `secret-desk.config.yaml`.

| Command | Purpose |
|---|---|
| [`doctor`](#doctor) | Read-only pre-check before the first real use |
| [`check`](#check) | Expiry check, offline |
| [`status`](#status) | List secrets with status, optionally live against GitHub |
| [`renew`](#renew) | Create, review, confirm and write a new value |
| [`vars list / status / set / apply / adopt / add`](#vars) | Manage variables |
| [`env export`](#env-export) | Write a dev `.env` |
| [`team export / import`](#team) | Share the configuration without values |
| [`browser doctor / run`](#browser) | Check and dry-run browser recipes |
| [`vapid`](#vapid) | Generate a VAPID key pair |

## doctor

```bash
secret-desk doctor --config <file>
```

A read-only pre-check. It reads the configuration and inventory, checks the connections (GitHub always, plus the ones the providers in the inventory need), checks every GitHub target for write access to secrets (a public-key read, it writes nothing), checks the Cloudflare token when Cloudflare providers are used, and reports the agent policy. It creates, writes and revokes nothing and prints no value.

Each finding is one line `[ok  ]`, `[warn]` or `[fail]` with a label and, if useful, a hint. Exit `1` if any finding is `fail`, otherwise `0`. See [TRIAL-RUN.md](TRIAL-RUN.md).

## check

```bash
secret-desk check (--inventory <file> | --config <file>) [--json] [--today YYYY-MM-DD]
```

Checks expiry dates **offline** (no network). One finding per level: `expired`, `due` (within the smallest threshold, default 7 days), `soon` (30 and 14 days by default) and `no-date` (provider forces an expiry but the inventory has none).

| Option | Description |
|---|---|
| `--inventory <file>` | Read this inventory directly. |
| `--config <file>` | Take the inventory from this configuration. One of the two is required. |
| `--json` | Print the findings as JSON (`level`, `id`, `key`, `text`). |
| `--today YYYY-MM-DD` | Pretend today is this date (testing). |

Exit `1` if any finding is `expired` or `due`, otherwise `0`. The [expiry workflow template](../examples/workflows/secret-desk-expiry.yml) uses `--json` to open one issue per finding.

## status

```bash
secret-desk status --config <file> [--stage <id>] [--repo <name>] [--live]
```

Lists every secret: status, days left, stage, id, provider (and `automatisch` for providers that generate values). `--live` additionally checks in GitHub whether the names exist (read-only). Exit `0`.

| Option | Description |
|---|---|
| `--stage <id>` | Only this stage. |
| `--repo <name>` | Only secrets with a target in this repository. |
| `--live` | Compare with GitHub (network). |

Status values: `ok`, `unknown`, `soon`, `no-date`, `due`, `missing` (live only), `expired`.

## renew

```bash
secret-desk renew <secret-id> --config <file> [--dry-run] [--yes]
```

Runs the full two-stage flow for one secret: create the value at the provider, verify, print the review report, ask you to confirm each checklist item, then write to GitHub and revoke the old value.

| Option | Description |
|---|---|
| `--dry-run` | Only print the plan (provider, targets, whether the old value will be revoked). Nothing is created. |
| `--yes` | Tick **all** checklist items without asking. Use it only when you have checked them. |

Without `--yes` the CLI asks for each checklist item (`j` to confirm; anything else counts as not confirmed). If not every item is confirmed the new value is discarded (and deleted at the provider again) and the exit code is `1`. After a successful write each target is printed with its outcome. Exit `0` on success, `1` if not complete: the old value then stays valid.

## vars

Variables are `vars.*` configuration values with an expected value in the inventory. All subcommands need `--config <file>`.

```bash
secret-desk vars list   --config <file> [--stage <id>] [--repo <name>]
secret-desk vars status <id> --config <file>
secret-desk vars set    <id> --value <value> --config <file> [--ack-public]
secret-desk vars apply  <id> --config <file> [--ack-public]
secret-desk vars adopt  <id> --config <file>
secret-desk vars add    --id <id> --name <NAME> --stage <id> --place <repo[:env]> [--place ...] [--value <value>] --config <file> [--ack-public]
```

| Subcommand | What it does |
|---|---|
| `list` | Prints stage, id, name and expected value. |
| `status <id>` | Compares expected value and GitHub per target (`in-sync`, `missing`, `different`, `unknown-expected`, `unreachable`). Exit `1` unless every target is in sync. |
| `set <id> --value` | Changes the expected value **in the inventory** only. |
| `apply <id>` | Writes the expected value to GitHub. Prints `created`, `updated`, `unchanged` or `failed` per target; exit `1` if any failed. |
| `adopt <id>` | Takes the current value from GitHub as the expected value. |
| `add` | Creates a variable in the inventory. `--place repo` is repository level, `--place repo:env` an environment. `--value` is optional. Writes nothing to GitHub. |

`--ack-public` confirms that a value which only looks suspicious (long random string, JWT, name containing `TOKEN` or `KEY`) is really public. Values that clearly are secrets (Stripe keys, GitHub tokens, private keys, service-role JWTs and so on) are always rejected.

## env export

```bash
secret-desk env export --config <file> --repo <name> [--stage <id>] [--template <id>] [--out <path>] [--overwrite] [--prompt KEY=VALUE]...
```

Creates a dev `.env` from a template. The values come into existence now and are stored nowhere except in the file (mode 600).

| Option | Description |
|---|---|
| `--repo <name>` | Required. Repository whose template to use. |
| `--stage <id>` | Stage of the template. Default: the first stage of kind `dev`. |
| `--template <id>` | A specific template id; otherwise the first template of the repository and stage. |
| `--out <path>` | Target file. Default `.env.local` in the current directory. It must lie inside `policy.envRoots` (when set). |
| `--overwrite` | Replace an existing file. |
| `--prompt KEY=VALUE` | Value for a `prompt` entry; repeatable. The environment variable `SECRET_DESK_PROMPT_<KEY>` works too. |

If `prompt` values are missing the command lists the keys and exits `1`. It warns if Git does not ignore the file.

## team

```bash
secret-desk team export --config <file> [--out <file>]
secret-desk team import <file> --inventory <file> [--replace]
```

`export` writes the configuration without values (stages, secrets, variables, templates, custom providers) to `--out` or to the terminal. `import` merges it into the inventory (created if missing): existing ids stay unchanged, new ones are added, unknown stage ids are added. `--replace` takes the file over completely (local fields `externalId`, `rotatedAt`, `verifiedAt` and `verifiedBy` of secrets with the same id are kept). See [TEAM.md](TEAM.md).

## inventory

```bash
secret-desk inventory normalize --config <file> [--apply all|<id>,<id>...] [--yes]
```

Without `--apply` the command prints the normalization plan grouped by kind (rename, provider, source, stage, merge, manual-only): names, stages, providers and parameter keys, never values. With `--apply all` it applies every unambiguous change; with a list of change ids (as printed) only those. It asks for confirmation unless `--yes` is given. Only the inventory file changes: nothing is written to GitHub, issued or revoked. A merge, a manual-only entry or a source without a clear resource cannot be applied and is an error. After a provider switch, complete the parameters in the portal. See [NAMING.md](NAMING.md).

## browser

```bash
secret-desk browser doctor [--recipes <dir>]... [--chrome-path <path>] [--profile-dir <dir>]
secret-desk browser run <recipe-id> --dry [--recipes <dir>]... [--chrome-path <path>] [--profile-dir <dir>]
                        [--name <n>] [--owner <o>] [--days <n>] [--date <YYYY-MM-DD>] [--description <text>]
                        [--repos a,b] [--permissions k=v,k=v] [--stage <id>] [--secret-id <id>]
                        [--login-timeout <minutes>] [--out <dir>]
```

`browser doctor` checks that `playwright-core` is installed, finds Chrome, shows the profile folder, and loads and validates all recipes (the bundled ones plus `--recipes` folders), printing each recipe's `# STATUS` comment. Exit `1` if anything fails.

`browser run <id> --dry` opens a visible browser and runs the recipe **up to, but not including,** the step that creates the token (the step marked `createsToken: true`). You sign in in the window yourself. Nothing is created. Real runs are started from the portal. Variables for the recipe come from the options (`--name`, `--owner`, `--days`, ...); defaults: name `<recipe>-probe-<date>`, `days` 30, stage `dev`, secret id `probelauf`. `--out <dir>` saves the evidence screenshots as PNG files. Press Ctrl+C to abort. See [RECIPES.md](RECIPES.md).

## vapid

```bash
secret-desk vapid
```

Prints a new VAPID key pair for web push as `VAPID_PUBLIC_KEY=...` and `VAPID_PRIVATE_KEY=...`. The private key appears in your terminal: store it straight into a secret, do not keep the output.
