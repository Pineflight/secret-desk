# Architecture

## The path of a new value

```text
Provider API ──> value in memory ──> verification ──> review report + evidence image
                                                          │
                 human ticks the review items (attachment optional)
                                                          ▼
                 write to GitHub (encrypted) ──> re-check ──> revoke old value ──> inventory + report
```

1. **Prepare** (`prepareIssuance`): the provider module creates the value (or a human pastes it in). The portal checks length,
   that the targets are reachable with write permission, and provider-specific findings (active, permissions, expiry, mode). The result is a
   **review report** (metadata only) and an **evidence image** (SVG). The value stays in memory for **at most 15 minutes**.
   Nothing is written to GitHub and the old value is not revoked.
2. **Confirm** (`commitIssuance`): all review items must be ticked; a failed automatic finding blocks the step (unless `force` is used).
   Then: write to all targets, re-check (name exists, just changed), revoke the old value at the provider, record `rotatedAt`, `expires`,
   `verifiedAt` and `verifiedBy` in the inventory, and store the report with the confirmation. If a target fails, the old value stays valid and
   the review stays open.
3. **Discard** (`discardIssuance`): on rejection or timeout the new value is deleted at the provider again. Nothing was written.

## Data

- **Inventory** (`inventory.yaml`, in Git): secrets (name, stage, provider, expiry, targets), variables (including the expected value),
  dev templates, custom providers. Metadata and configuration only, never a secret value.
- **Review reports and attachments** (`.secret-desk-evidence/`, not in Git): reports as JSON, screenshots as PNG/JPEG/WebP up to 5 MB.
- **Memory:** issued but not yet confirmed values, the session's access tokens, pending approvals.
- **Local files** in `~/.secret-desk/`: the encrypted vault for integration tokens (`vault.json`), folder links (`repo-links.json`), the agent token and the browser profile. See [CONFIGURATION.md](CONFIGURATION.md#files-secret-desk-writes).

## Platforms
Path, permission and key questions live in `packages/core/src/platform.ts` (`securePrivateFile`, `ensurePrivateDir`, `writePrivateFile`,
`expandHome`, `isPathInside`, `realpathLoose`, `localPathProblem`, `sanitizeFileName`) and in the `KeySource`s of `vault.ts` (macOS Keychain,
Linux `secret-tool`, Windows DPAPI via PowerShell, optional key file). Everything takes `platform` (and, for commands, an `exec` function)
as a parameter, so Windows and Linux behavior can be tested on any system with `path.win32`/`path.posix` and a fake exec.
Only these commands are started: `git` (runtime/core), `op` (core), `security`/`secret-tool`/`powershell.exe` (core, vault), Chrome (Playwright).
Scripts in the repo are Node files under `scripts/` (`clean.mjs`, `demo.mjs`, `screenshots.mjs`), not shell lines.

## Repositories and links

- The **Repositories** page (`/repos`) combines the inventory (secrets, variables, templates), GitHub live (`GET repos?live=1`, names and metadata only)
  and local links. Without a GitHub connection it quietly falls back to the inventory and links.
- A **link** maps a repository to a folder on this machine. It is stored in `~/.secret-desk/repo-links.json`
  (mode 600, folder 700; config field `linksFile`), never in the shared inventory. The server checks the path, `.git` and the remote
  (`git remote get-url origin`; a mismatch is only a warning).
- **Scan locally** searches `policy.envRoots` down to depth 2 for Git folders whose origin points to the configured owner and
  proposes links. Nothing is applied until you click.
- For a linked repository, the Dev environment page and `env-export` use `<folder>/<template file>` as the default path. An explicit path wins.
- Endpoints (portal only): `PUT repos/:name/link`, `DELETE repos/:name/link`, `POST repos/scan`. Agents may only call `GET repos` (without paths).
- The repository fields in forms are select fields (inventory, GitHub, linked); free input remains possible.

## Stages

Stages are freely configurable: the `stages:` section in the inventory (portal: Settings). See [STAGES.md](STAGES.md). A definition has `id` (slug), `label` (display name), `kind`,
`environment` (name of the GitHub environment) and `tone` (color). Without `stages:`, `dev`, `staging`, `production` and `shared` apply.

Behavior depends on the `kind`, never on the name:

| kind | Meaning |
|---|---|
| `dev` | local: no GitHub target needed, agents may act directly (per `policy.agentStages`, default all dev stages), Dev `.env` |
| `test` | sandbox/test: provider keys are expected to be in test mode |
| `live` | production grade: agents always need an approval, keys must be in live mode, warning styling |
| `shared` | applies to all (for example a repository secret), mode is not checked |

If `environment` is missing: for `test`/`live` it is the `id`, for `dev`/`shared` there is none. `null` means explicitly none. For scope `environment` without a name,
secret-desk fills in the stage's environment (a name is only stored when it differs). Staging and production never share a value. At most 12 stages;
a stage can only be removed when no secret, variable, template or policy refers to it. The `organization` scope is in the schema but not in the portal form:
organization secrets need a repository selection that is not modeled yet.

## Stage comparison

The **Compare** page (`/vergleich`), `GET compare` and the MCP tool `desk_compare_stages` show which secrets and variables exist on which stage and where something is missing. It is read-only and never returns a value. The pure logic is `compareMatrix` in `packages/core/src/compare.ts` (inventory plus optionally pre-read GitHub names, testable without network); the network part is `compareStages` in `packages/runtime/src/compare.ts`; workflow parsing is `packages/core/src/workflow-needs.ts`. Cell states, parity, orphans, workflow needs, ignored and renamed repositories are described in [COMPARE.md](COMPARE.md).

## Packages

| Package | Role |
|---|---|
| `packages/core` | inventory, status, GitHub client, issuance and review flow, variables, compare, dev export, team file, vault |
| `packages/providers` | provider modules (Cloudflare, Supabase, Stripe, Resend, Grafana, random values, manual guides) |
| `packages/automation` | browser automation: recipes, drivers, Chrome lookup |
| `packages/runtime` | shared operations and policy for portal, CLI and MCP |
| `packages/cli` | command line |
| `packages/mcp` | MCP server for AI agents |
| `apps/desk` | the portal (Next.js, local only) |
| `skills/secret-desk` | skill for agents |


`core` knows no user interface. `runtime` bundles the operations and enforces the policy (`agent-api.ts`).
The CLI, the portal API and the MCP server use only `runtime`. The portal and the MCP server speak to the same routing layer
(`apps/desk/src/server/router.ts`): `/api/ui/*` for humans, `/api/agent/*` for agents.
