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
   **Companion values:** a provider may return values for other inventory entries from the same answer (`IssuedSecret.companions`, for
   example the client ID next to the client secret). Only entries the provider names in its params (`companionParams`) can receive one, in
   the same stage; this is checked before anything is issued. The report lists them (name, targets, fingerprint), confirm writes them in
   the same commit and records `rotatedAt` and `externalId` on them, and reject, expiry or a changed target discard them with the main value.
   When the provider renews in place (new id equals old id), nothing is deleted on confirm or discard.
3. **Discard** (`discardIssuance`): on rejection or timeout the new value is deleted at the provider again. Nothing was written.

## Data

- **Inventory** (`inventory.yaml`, in Git): secrets (name, stage, provider, expiry, targets), variables (including the expected value),
  dev templates, custom providers. Metadata and configuration only, never a secret value.
- **Who writes the inventory:** the portal, the CLI, the MCP server and scripts, all through `InventoryStore` (`packages/core/src/inventory.ts`) on the same file. The store follows the file: it reloads when the content hash differs (stat pre-check on every read, `fs.watch` on the directory in the portal as a hint, `onExternalChange` listeners to drop derived state: open approvals whose entry changed become `stale`, the cached team-sync comparison is cleared), and the file's version counter (`GET inventory/version`) lets open pages reload silently. Every change is applied as a function of the document and remembered until it is saved. `save()` takes a lock file, compares the file with the content the change was based on and, if it differs, loads the fresh content, replays the changes and writes it (temp file, `fsync`, `rename`, mode `0600`). A change that no longer fits, a full replacement (`replaceData`, the team import) over a changed file, or a file that is invalid on disk ends in `InventoryConflictError` (409) and writes nothing. See [CONFIGURATION.md](CONFIGURATION.md#inventory-inventoryyaml).
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

The **Compare** page (`/compare`), `GET compare` and the MCP tool `desk_compare_stages` show which secrets and variables exist on which stage and where something is missing. It is read-only and never returns a value. The pure logic is `compareMatrix` in `packages/core/src/compare.ts` (inventory plus optionally pre-read GitHub names, testable without network); the network part is `compareStages` in `packages/runtime/src/compare.ts`; workflow parsing is `packages/core/src/workflow-needs.ts`. Cell states, parity, orphans, workflow needs, ignored and renamed repositories are described in [COMPARE.md](COMPARE.md).

## Storage seams in core

Three interfaces separate what `packages/core` does from where the bytes live, so the core can run in a runtime without a file system:

- **Vault:** `Vault` (`vault-core.ts`) encrypts with AES-256-GCM through Web Crypto and talks to a `VaultStore` (`read`, `write`) and a `KeySource`. `FileVaultStore` (`vault-file-store.ts`) is the JSON file of the local edition, `MemoryVaultStore` the in-memory one. `SecretVault` (`vault.ts`) is a `Vault` with the file store and the operating system key sources as defaults; its constructor also accepts `store`. The stored format did not change: an entry written before the split is read by `Vault` and the other way round (tests: `vault-core.test.ts`).
- **Evidence:** `EvidenceStore` (`evidence.ts`) is the interface for reports and attachments, `MemoryEvidenceStore` the in-memory implementation, `FileEvidenceStore` (`evidence-file-store.ts`) the folder-based one. One contract test runs the same cases against both.
- **Inventory:** the store keeps its synchronous getters and all of its logic: refresh gating, adopting or rebasing an external change, the retry loop of `save()`, problem handling, versioning and listeners. That logic is `InventoryStoreCore` in `inventory-store.ts`, which imports no Node built-ins; `InventoryStore` in `inventory.ts` is a thin Node facade that extends it with `open(path)` and builds the file backend, so every existing import keeps working. Only the I/O primitives sit behind an `InventoryBackend` (`inventory-backend.ts`): `stamp()` (a cheap change stamp compared by string equality), `read()` (text plus an opaque revision), `withWriteLock(fn)` (the only writer; hands `fn` a transaction with `read()` and `write(text, expected)`, which writes only if the stored revision still equals `expected` and otherwise reports `written: false` so the store can rebase and retry) and an optional `watch(hint)`. `FileInventoryBackend` (`inventory-file-backend.ts`) is the file of the local edition: stat-based stamp, sha256 revision, lock file next to the file, temp file plus fsync plus rename. `InventoryStore.open(path)` and `fromText(text, path)` build it; `InventoryStore.withBackend(backend, initial?)` takes any other backend. The error classes live in `inventory-errors.ts` and are re-exported by `inventory.ts`. `MemoryInventoryBackend` (in `inventory-backend.ts`) is the in-memory implementation: one document, a counter as revision, writers queued one at a time, and `replaceExternally(text)` to simulate another writer (it calls the `watch` hints). `inventory-contract.test.ts` runs the same behaviour cases against the file and the memory backend.

What a backend must guarantee: `read()` and `stamp()` never throw and agree (a changed text has a changed revision; an unchanged revision under a new stamp is harmless); `withWriteLock` runs one writer at a time and rejects with an explanatory error if it cannot; `write(text, expected)` checks the stored revision against `expected` (`null` = nothing stored yet) and reports `written: false` on a mismatch instead of overwriting. A hosted backend has exactly one writer per document and stores the text in one row with a version: the version is the revision and the compare-and-set on it is the expected-revision check. Concurrent edits from other sessions then show up as `written: false`, and the store rebases its unsaved changes on the new text and retries; it never writes over a newer version.

`vault-core.ts`, `evidence.ts`, `inventory-backend.ts`, `inventory-errors.ts` and `inventory-store.ts` import no Node built-ins and do not use `process`, `Buffer` or `require`; `portable-modules.test.ts` fails if that changes. Everything that needs the file system or the operating system stays in `vault.ts`, `vault-file-store.ts`, `evidence-file-store.ts`, `inventory-file-backend.ts` and `platform.ts`.

### Host capabilities

`ConnectionStoreCore` (`connections-core.ts`, portable, covered by `portable-modules.test.ts`) holds the token lookup: session value, vault, then the configured source. What the hosting process lets a configuration reach is an explicit `ConnectionHost` (`label`, optional `env(name)` and `readReference(ref)`). Without `env`, an `env` source is not available; without `readReference`, an `op` source is not available. Both cases throw a `NotConnectedError` that tells the user to enter a token under Connections, and `status()` reports the same reason without throwing. Session and vault values are looked up first and work either way. `ConnectionStore` (`connections.ts`) is the Node facade of the local edition: it keeps the options `env` and `exec`, builds `nodeConnectionHost(env, exec)` (process environment and `op read <ref>`) from them, and accepts `host` to override it; `host: null` means no host at all. Omitting `host` on `ConnectionStore` grants the process environment and `op`: that default is for the local edition only. A runtime that shares one process between several users uses `ConnectionStoreCore` or `host: null` so a configuration cannot read the host's environment or run its tools.

### Injectable cryptography

Two cryptographic operations of the GitHub client can be supplied by the host, so the client also runs where the default implementations are not available or not wanted:

- **Sealing a value** for the GitHub secret store: `GitHubClientOptions.seal` takes a `SecretSealer` (`(publicKeyBase64, plaintext) => Promise<string>`) that returns the Base64 (original variant) of an anonymous sealed box (X25519, XSalsa20-Poly1305, nonce = BLAKE2b-192 of the ephemeral and the recipient public key). Without it the client uses libsodium (`github-seal-libsodium.ts`), which `github.ts` loads lazily on first use; a client with an injected sealer never loads it. This matters in runtimes that cannot compile WebAssembly at run time.
- **Signing the GitHub App JWT:** `GitHubAppOptions.sign` takes an `AppJwtSigner` (`(signingInput) => Promise<string>`) that receives `base64url(header).base64url(payload)` and returns the base64url RS256 signature. Exactly one of `privateKey` and `sign` must be given; with `sign` the private key never enters the process of the provider.

The local edition passes neither: it seals with libsodium and signs with the private key held in the process. Both paths produce the same bytes as before (tests: `github-injection.test.ts`). libsodium is now loaded at the first seal, so a missing or broken libsodium surfaces at the first write or write probe instead of at start-up. `GitHubClient.seal(publicKeyBase64, plaintext)` seals through the client's sealer and checks the result before anything is sent (a non-empty Base64 string that is neither the plaintext nor its Base64, otherwise a `GitHubError`); `putSecret` and the connection write probe both use it, so an injected sealer covers the probe too.

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
