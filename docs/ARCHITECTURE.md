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

### Portable entry point

`@secret-desk/core/portable` (`packages/core/src/portable.ts`) re-exports only the modules that import no Node built-ins and no libsodium: `secret`, `stages`, `types`, `inventory-store`, `inventory-errors`, `inventory-backend`, `evidence`, `vault-core`, `connections-core`, `variable-sources` and `github-core` (the GitHub client, see below). A runtime without Node APIs (for example a Cloudflare Worker) imports from there and does not pull in `node:fs`, `node:child_process` or libsodium. The Node facades (`SecretVault`, `InventoryStore`, `ConnectionStore`, the file stores, `platform`, the Node facade of the GitHub client) stay on the package root; the root keeps all its exports. `packages/core/package.json` also sets `"sideEffects": false`, so a bundler can drop the unused Node modules when only portable names are imported from the root.

The rule: a module is added to `portable.ts` only if it is portable, and then it is added to the guard. `portable-modules.test.ts` takes `portable.ts` as a root, follows its relative value imports, expects exactly the known set of files, fails on Node built-ins, `process`, `Buffer`, `require` and on any npm import other than the allowlisted pure packages (`yaml`, `zod`), and checks that `portable.ts` exports every runtime name of those modules.

### Host capabilities

`ConnectionStoreCore` (`connections-core.ts`, portable, covered by `portable-modules.test.ts`) holds the token lookup: session value, vault, then the configured source. What the hosting process lets a configuration reach is an explicit `ConnectionHost` (`label`, optional `env(name)` and `readReference(ref)`). Without `env`, an `env` source is not available; without `readReference`, an `op` source is not available. Both cases throw a `NotConnectedError` that tells the user to enter a token under Connections, and `status()` reports the same reason without throwing. Session and vault values are looked up first and work either way. `ConnectionStore` (`connections.ts`) is the Node facade of the local edition: it keeps the options `env` and `exec`, builds `nodeConnectionHost(env, exec)` (process environment and `op read <ref>`) from them, and accepts `host` to override it; `host: null` means no host at all. Omitting `host` on `ConnectionStore` grants the process environment and `op`: that default is for the local edition only. A runtime that shares one process between several users uses `ConnectionStoreCore` or `host: null` so a configuration cannot read the host's environment or run its tools.

### Injectable cryptography

Two cryptographic operations of the GitHub client can be supplied by the host, so the client also runs where the default implementations are not available or not wanted:

- **Sealing a value** for the GitHub secret store: `GitHubClientOptions.seal` takes a `SecretSealer` (`(publicKeyBase64, plaintext) => Promise<string>`) that returns the Base64 (original variant) of an anonymous sealed box (X25519, XSalsa20-Poly1305, nonce = BLAKE2b-192 of the ephemeral and the recipient public key). Without it the client uses libsodium (`github-seal-libsodium.ts`), which `github.ts` loads lazily on first use; a client with an injected sealer never loads it. This matters in runtimes that cannot compile WebAssembly at run time.
- **Signing the GitHub App JWT:** `GitHubAppOptions.sign` takes an `AppJwtSigner` (`(signingInput) => Promise<string>`) that receives `base64url(header).base64url(payload)` and returns the base64url RS256 signature. Exactly one of `privateKey` and `sign` must be given; with `sign` the private key never enters the process of the provider.

**Portable GitHub client.** The client lives in `github-core.ts` (no Node built-ins, no `Buffer`, no libsodium, no zod; guarded by `portable-modules.test.ts`) and is exported from `@secret-desk/core/portable` as `GitHubClient` and `githubAppProvider`. It has no defaults for the two operations above: `seal` and `sign` must be passed by the caller. Without `seal`, sealing (`seal()`, `putSecret`) throws a `GitHubError` ("no sealer configured") before anything is sent; without `sign`, `githubAppProvider` throws at construction. Base64, Base64URL and UTF-8 conversions use the small helpers in `base64.ts` (`TextEncoder`, `TextDecoder`, `btoa`, `atob`, chunked for large inputs). `placeKey` and the snapshot types moved to `place-key.ts` (re-exported by `status.ts`), so the client does not import `types.ts` and the zod schemas as values. `github.ts` is the Node facade with the same exported names as before: `GitHubClient` is a subclass that defaults `seal` to the lazily loaded libsodium sealer, and its `githubAppProvider` still accepts `privateKey` (signing with `node:crypto`) or `sign`.

The local edition passes neither: it seals with libsodium and signs with the private key held in the process. Both paths produce the same bytes as before (tests: `github-injection.test.ts`). libsodium is now loaded at the first seal, so a missing or broken libsodium surfaces at the first write or write probe instead of at start-up. `GitHubClient.seal(publicKeyBase64, plaintext)` seals through the client's sealer and checks the result before anything is sent (a non-empty Base64 string that is neither the plaintext nor its Base64, otherwise a `GitHubError`); `putSecret` and the connection write probe both use it, so an injected sealer covers the probe too.

## Authorisation hook

The runtime has one extension point for a process that embeds it and wants to add rules of its own, for example roles or approval by a second person, without forking: `RuntimeOptions.authorize` (kept on `Runtime.authorize`). This repository ships no such rules and stays a single-user tool; with no hook configured, nothing changes.

- **Opaque principal.** `Actor` has an optional `principalId`: an opaque, stable reference supplied by whatever authenticates the request. This repository never interprets it. The portal and the CLI build their actors as before and set none.
- **Recording.** A pending review records `preparedBy` (`ActorRef`: `name`, `kind`, optional `principalId`; who caused it to run), `requestedBy` (who asked, for example the agent) and `approvalId` when it came from an approval. An approval records `requestedBy` (name, for compatibility), `requestedByRef` (`ActorRef`), and `decidedBy` and `decidedAt` when a human approves or denies it. The confirmation in the review report gets a `principalId` next to `by` when the confirming actor has one. `verifiedBy` in the inventory stays the display name. All of this is names and ids, never a value.
- **The hook.** `Authorize = (request) => void | Promise<void>`. It receives a copy of `{ actor, action, subject? }` and refuses by throwing; returning `undefined` (or a promise of it) means allowed, any other return value (`false`, an object) is a refusal. A `PolicyError` is passed on unchanged. Anything else it throws, a return value, a hook that does not settle within `RuntimeOptions.authorizeTimeoutMs` (default 10000 ms) or a hook that is not a function becomes one generic German refusal (`Die Berechtigungspruefung hat die Aktion nicht zugelassen.`), so no hook internals or values reach a response. The optional `RuntimeOptions.onAuthorizeFault` callback is told the action, the reason and, for a throw, the class name of the error (never its message); a throwing callback changes nothing.
- **Claim on pending reviews.** Confirm and reject claim the pending item synchronously before the hook is awaited (`IssuanceQueue.claim` and `release`). A second operation on a claimed item is refused ("wird gerade bearbeitet"), the claim is released when the hook refuses or the operation fails, and after the hook the item must still be the same object. Core refuses to commit or discard an item that was already discarded, committed or is being committed, so a slow hook cannot lead to a double discard or a commit after a discard.
- **An approval is also asked for what it causes.** `approval.resolve` is followed, on approve, by `issuance.prepare` (plus `automation.run` when a browser run starts) or `variable.apply` on behalf of the approving actor, with the approval id and the requester in the subject. A refusal leaves the request pending.
- **Built-in rules always apply first.** The hook is consulted only after the built-in checks (`requireHuman`, stage policy, parameter and secret guards) have passed, and before the first side effect. It can therefore only refuse what the built-in rules allow: an agent calling a human-only action is refused by the built-in rule and the hook is not asked. A hook cannot weaken a built-in rule. For the human-only portal routes that are gated in the router (team sync, stages, repository links, browser and sign-in flows, deep connection check) the route table is the built-in rule, so agents never get that far; checks of ids and bodies inside those handlers run after the hook.
- **Actions** (`AuthorizedAction`): `issuance.prepare` (a request that prepares a review or creates an approval request; a dry run is not asked), `issuance.confirm`, `issuance.reject`, `issuance.manual-value`, `approval.resolve`, `inventory.edit` (secrets, variables, providers, templates, integration defaults, resource map, normalization), `variable.apply`, `integration.connect` and `integration.disconnect` (storing or removing a connection token in the portal), `evidence.attach`, `automation.run` (a browser run starts: a human's issuance request, a live check, a session check, the start of a team token run), `github.sync`, `team.sync.apply`, `team.sync.push`, `team.sync.configure` (team sync setup, dismissing the setup or a revocation notice), `team.import` (subject `mode`: `merge` or `replace`), `settings.edit` (stage definitions), `repo.link` (repository link set, remove and rename), `connection.check` (only the deep check, which probes write access), `env.export` (content export and file export; subject `repo` and `stage`). In the guided sign-in flows of providers and recipes and in the team token flow, the steps that accept a credential, a one-time code, a confirmation or that create and store a key are `integration.connect` (subject `connectionId`: the facade, recipe or connection id).
- **Subject** (ids and actor references only, never a value): `secretId`, `variableId`, `approvalId`, `connectionId`, `repo`, `stage`, `mode`; for `issuance.confirm` and `issuance.reject` also `preparedBy`, `requestedBy` (name), `requestedByRef` and `approvalId`; for `approval.resolve` and what an approval causes also `requestedBy` and `requestedByRef`. That is what a second-person rule needs: refuse `issuance.confirm` when the actor and `subject.preparedBy` are the same party (compare kind and principal id, not display names), or refuse `approval.resolve` when the approver is `subject.requestedByRef`. A review that a human approved on behalf of an agent's request is prepared by the approving human and requested by the agent.
- **Left unhooked, on purpose.** Operations that only read (listings, plans, previews, the plain connection check, the repository scan, the push plan, `team-export`, which carries structure and never a value), the cancel steps of browser runs (they only close a run), and what the process does on its own without an actor: scheduled live checks and sign-in checks, and the team sync applied at start-up from the environment. The command line (`secret-desk ...`) builds its own runtime without a hook; the commands that go through the runtime functions are asked as above when a process embeds the runtime with a hook, the commands that act on a local file as the operating-system user (for example `team import --inventory`) are not. The MCP server talks to the agent API of the portal, so it passes the same checks.

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
