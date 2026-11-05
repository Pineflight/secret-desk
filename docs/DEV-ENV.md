# Local development: a working `.env.local` per repository

This guide is for developers. It shows how a dev template in the inventory turns into a working `.env.local` in each
repository checkout, which values secret-desk produces, and what stays manual.

Rules that hold throughout:

- Only stages of kind `dev` go into these files. Staging and production secrets, and live keys, never end up in a dev file.
- Values come into existence during the export and are stored nowhere else: not in the inventory, not in a log, not on the
  terminal. The file is written with mode 600.
- The file must be ignored by Git. The export warns when it is not.

## 1. One-time setup on your machine

1. Build the CLI: `pnpm install && pnpm build` (the binary is `packages/cli/dist/bin.js`, called `secret-desk` below).
2. Point a `secret-desk.config.yaml` at the inventory (see [CONFIGURATION.md](CONFIGURATION.md)). In a team, import the
   team file first ([TEAM.md](TEAM.md)).
3. Link each repository to its checkout, in the portal (Repositories) or once per repository, so the export knows where to
   write ([REPOSITORIES.md](REPOSITORIES.md)). Links live in `~/.secret-desk/repo-links.json` on your machine only.
4. Make sure each repository ignores its env file (`.env.local` or the template's `file`).

## 2. What a template can produce

Each entry of a template names its source (`from.type`). Field reference: [CONFIGURATION.md](CONFIGURATION.md#env-templates).

| Source | Produced by | Typical keys |
|---|---|---|
| `default` | the template (non-secret values only) | `NEXT_PUBLIC_SITE_URL=http://localhost:3000` |
| `variable` | the expected value of an inventory variable | public URLs, project ids |
| `generate` | a fresh random value, optionally with a `prefix` | `RATE_LIMIT_SECRET`, `CRON_SECRET`, `STRIPE_WEBHOOK_SECRET` with `prefix: whsec_` |
| `generate` with `kind: vapid-public` / `vapid-private` | one Web Push key pair per export (`pair` groups them) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |
| `ref` | the value another template's key already has | a token the API checks and the website sends |
| `command` (`supabase-status`) | `supabase status -o env` in the linked checkout | `ANON_KEY`, `SERVICE_ROLE_KEY`, `API_URL` of the local Supabase stack |
| `issue` | a personal dev token at the provider (automatic providers only) | a scoped dev API token |
| `prompt` | you, at export time; `optional: true` leaves it empty instead of blocking | third-party test keys you hold yourself |

Example with two repositories that must share one token, and local Supabase keys:

```yaml
envTemplates:
  - id: acme-website-dev
    repo: acme-website
    stage: dev
    entries:
      - { key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 32 } }
  - id: acme-portal-dev
    repo: acme-portal
    stage: dev
    entries:
      - { key: SUPABASE_URL, from: { type: command, command: supabase-status, key: API_URL } }
      - { key: SUPABASE_ANON_KEY, from: { type: command, command: supabase-status, key: ANON_KEY } }
      - { key: SUPABASE_SERVICE_ROLE_KEY, from: { type: command, command: supabase-status, key: SERVICE_ROLE_KEY } }
      - { key: LEAD_INTAKE_TOKENS, from: { type: ref, template: acme-website-dev, key: LEAD_INTAKE_TOKEN } }
      - { key: STRIPE_WEBHOOK_SECRET, from: { type: generate, kind: base64, bytes: 24, prefix: whsec_ } }
      - { key: VAPID_PUBLIC_KEY, from: { type: generate, kind: vapid-public } }
      - { key: VAPID_PRIVATE_KEY, from: { type: generate, kind: vapid-private } }
      - { key: MAPS_API_KEY, description: Only for the map view, from: { type: prompt, optional: true, hint: test key from the maps console } }
```

A list key such as `LEAD_INTAKE_TOKENS` that accepts several comma-separated tokens works with a single one, so a `ref`
is enough.

## 3. Daily use

Start the local services first (for example `supabase start` in the repository), then export:

```bash
secret-desk env export --from-template --config ~/secret-desk.config.yaml --repo acme-website --repo acme-portal
```

- Each file goes to `<linked folder>/<template file>`. Without a link it goes to `<current directory>/<template file>`;
  `--out <path>` overrides this for a single repository.
- Templates that refer to each other are exported in dependency order within one run, so `acme-portal` gets the token
  `acme-website` just generated. Exporting `acme-portal` alone reads the token from the file `acme-website` produced earlier.
  If neither has a value the export stops before anything is issued and says which template to export first.
- `command` entries run in the linked checkout. If the command fails (stack not running) the export stops and names the
  command and exit code only. `--no-commands` skips them and leaves those keys as commented, empty lines.
- Existing files are kept; `--overwrite` replaces them. Regenerating a shared token means exporting both repositories
  together with `--overwrite`, otherwise the two files disagree.
- The CLI prints one line per file (`written: <path> (n of m keys set, mode 600)`), the keys it left empty, and warnings
  such as a missing `.gitignore` entry. It never prints a value.

Exit codes: `0` all written, `1` a required `prompt` is missing (pass `--prompt KEY=VALUE` or `SECRET_DESK_PROMPT_<KEY>`),
`2` an error.

### From the portal or an agent

The portal (page Dev) and the MCP tool `desk_export_dev_env` run the same templates. They never run local commands: `command`
entries are written as commented, empty lines, to be filled by a CLI run on the developer machine. Agents never pass
prompt values and never receive values back.

## 4. What stays manual

- Starting local services (`supabase start`, Docker) before the export.
- Third-party test keys that only you can create (payment, maps, mail test accounts): `prompt` entries, required or optional.
- Adding the env file to `.gitignore` when the export warns.
- Linking each repository once, and re-exporting with `--overwrite` after a local stack reset (new local keys).
- Anything for staging or production: those values are handled in GitHub through the reviewed renewal, never in a dev file.
