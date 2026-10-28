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

## Stages in a team
Stage definitions are exported along with the rest (see [STAGES.md](STAGES.md)). On import (merge), unknown stage ids are added and existing ones stay unchanged (no silent change of kind or
environment); `--replace` takes over the list from the file completely and keeps the local fields `externalId`, `rotatedAt`, `verifiedAt` and `verifiedBy` of secrets with the same id. In the portal, *Replace* needs an explicit confirmation (`confirmReplace`).
