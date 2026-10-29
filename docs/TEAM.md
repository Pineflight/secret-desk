# Team

## Distributing the configuration file
`secret-desk team export --config secret-desk.config.yaml --out secret-desk.team.yaml` (or in the portal: Team, Download).
The file contains the structure: expiry `thresholds`, stage definitions (`stages:`), secrets (name, stage, provider, parameters, targets, expiry data), variables with expected values, dev templates and
custom providers. **No values**, and no provider-internal identifiers (`externalId`) or `rotatedAt`. Variable values are configuration, not secrets. Open the file before you share it: descriptions and links are part of it.

## New team member
1. Clone the repo, `pnpm install`, `pnpm build`.
2. `secret-desk team import secret-desk.team.yaml --inventory inventory.yaml`.
3. Create your own configuration (GitHub access, provider connections).
4. Dev environment per repo: `secret-desk env export --config secret-desk.config.yaml --repo <repo>`.
   It contains defaults and variables from the inventory, random values and **personal** dev tokens that your account creates at the provider.
   Values you have to supply yourself (for example a sandbox key) are asked for (`--prompt KEY=VALUE`).

The `.env` is created on your machine with mode 600. The portal does not store it.

## Team sync with a private GitHub repository
Instead of passing the team file around by hand, a team can keep it in a private GitHub repository (any `owner/name`, path and branch) and let the portal sync with it. Configure `teamSync` ([Configuration](CONFIGURATION.md#teamsync)) or use the first-start wizard. The file is the same team file as above: structure only, no values.

**Roles.** Everyone reads. In `mode: pull-push` the people who may change the team structure also push. The repository decides who may merge: with `push.strategy: pull-request` (the default) a push only opens or updates a pull request, and your normal review and branch protection apply.

**Token.** By default team sync **uses the GitHub integration**; no extra token is needed. Resolution order: an own `team-sync` token (session, vault, `connections.team-sync`, `SECRET_DESK_TEAM_TOKEN`) wins, otherwise the connection `github`.
- *GitHub token (PAT):* used as it is, so its repository selection and rights apply: the team repository must be selected, with *Contents: Read* (sync) or *Read and write* (push) and, for pull requests, *Pull requests: Read and write*.
- *GitHub App* (`github.auth.type: app`): for every run the portal requests a short-lived installation token for **this one repository** with exactly `contents` (read, or write to push), `pull_requests` (write, only for the pull-request strategy) and `metadata: read`. No hand-made token. The App must have these permissions (App settings, Permissions: Contents and Pull requests) and its installation must include the team repository (Repository access); the installation owner is the owner of `teamSync.repo`. Note that these are rights beyond the ones for secrets and variables.
- *Own token:* needed only when the GitHub integration cannot reach the repository. GitHub cannot create fine-grained tokens through the API; the *Team repository* card under Integrations links to the GitHub form with name, owner, expiry and the exact rights prefilled and says which repository to select. Where browser automation is available you can create an inventory entry with the provider `github-fine-grained-token` instead (not in the container).

The portal checks instead of guessing: the connection test of *Team repository* (and `GET /api/ui/team-sync/status`, `neededRights`, `tokenSource`) reads the repository and the file, tries to list pull requests when the pull-request strategy needs them and, for a GitHub App, compares the rights GitHub actually granted with the needed ones. *Write test* (`POST connections/team-sync/check` with `deep: true`) creates a probe branch and deletes it again to prove Contents write. A missing right is shown as a finding with the exact rights and how to extend them (token: repository access and rights; App: rights and installation). Token values are never shown.

**Pull.** When the portal starts (`pullOnStart`) and on *Sync now* (Team page, or `secret-desk team pull`) the portal reads the file read-only and compares it with the local state. It tells you whether everything is equal, the repository is new or changed, only you changed something, or both sides changed. Before anything is taken over you see a preview: which secrets, variables, stages, providers and dev templates would be added, changed or are only local (names and ids, no values). Taking over uses the merge logic of `team import` (new entries are added, existing ones stay); *replace* needs an explicit confirmation. The blob SHA of the last synced file is kept locally in `.secret-desk-team-sync.json` next to the configuration file to recognize changes on both sides.

**Conflicts.** If the repository and the local inventory both changed, nothing is overwritten silently. You see the difference and choose: take over the repository (merge or replace), keep local (the repository state is marked as seen, a later push will overwrite it), or cancel.

**Push.** In `mode: pull-push` the Team page shows *Push to repo* (or `secret-desk team push`). The portal exports the team file, checks that it contains no values, `externalId` or `rotatedAt` (and not the access token), shows the difference to the repository and asks for one confirmation for all pending changes. Then it commits one file: with `pull-request` to `push.branch` and opens (or updates) a pull request against `branch`, with `direct` straight to `branch`. Pushes are rate-limited (at least 30 seconds apart) so clicking repeatedly does not create a commit each time. Errors (no network, expired token, 403, 404, conflict) are reported and nothing partial is written. Portal changes are not pushed automatically: they show up as *local changes*, and you push when you are ready.

**Agents.** AI agents may read the status (`GET /api/agent/team-sync/status`). Checking, taking over and pushing are human actions in the portal or the CLI.

**CLI.** `secret-desk team status|pull|push --config secret-desk.config.yaml`. `pull` shows the preview; `--apply merge|replace|keep-local` takes over (`--confirm-replace` for replace). `push` shows the difference; `--yes` confirms.

## Resource mapping in a team
The `resourceMap` (repository to provider resource, see [RESOURCES.md](RESOURCES.md#mapping-repositories-to-resources)) is exported with the rest and contains only ids and display names, no secrets. On import (merge), an entry whose key (`kind`, `repo`, `stage`) already exists locally stays unchanged and new keys are added; `--replace` takes over the list from the file (and removes the local list if the file has none). Resource ids belong to a provider account: a teammate who connects a different account sees *The mapping points to a resource the provider does not know* until the mapping is adjusted.

## Stages in a team
Stage definitions are exported along with the rest (see [STAGES.md](STAGES.md)). On import (merge), unknown stage ids are added and existing ones stay unchanged (no silent change of kind or
environment); `--replace` takes over the list from the file completely and keeps the local fields `externalId`, `rotatedAt`, `verifiedAt` and `verifiedBy` of secrets with the same id. In the portal, *Replace* needs an explicit confirmation (`confirmReplace`).
