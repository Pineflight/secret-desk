# Security model

## Principle
Values are never stored. The portal holds them in memory only, only for as long as review and confirmation need them
(15 minutes), and passes them on in exactly two places: to the provider API and, encrypted, to GitHub.

**The rule for everything that revokes a new value at a provider: revoking a value that is in use is worse than leaving an unconfirmed value valid until the provider expires it.** When in doubt nothing is revoked, the record is kept and the case is reported. One function, `revokeNewValue`, decides for every site (expiry, stale entry, the sweep and its retries, a person's reject, an explicit orphan revoke); see [ARCHITECTURE.md](ARCHITECTURE.md#instance-state-and-deadlines) for the full list. It refuses, without calling the provider, when a write of the value to any place was ever started (a failed or timed-out write counts: the remote may have applied it; only a person's explicit acknowledgement lifts this), when the identifier is the current one of the entry or of a companion entry in the inventory, when the entry is gone or has another provider (for a record alone), or when there is nothing to call. A refusal because of a started write keeps the record, flags it for a person, writes an evidence note and tells the embedder (`onNeedsDecision`); the other refusals mean the record is stale. A delete that fails is retried a bounded number of times and then reported, not forced. **What remains, plainly:** a value whose write was started is never revoked automatically, so an unconfirmed value can stay valid at the provider until a person decides or the provider expires it; the gate knows only the inventory, not uses outside it; the old-value revoke after a confirmed commit and the separate rotate and env-export flows are outside it. Known limitations: rotate and the environment export call a provider's revoke outside the gate and are unchanged; for a provider that rotates in place they can revoke a token that is in use. The guard test (`revoke-gate-guard.test.ts`) is a text check of `packages/core/src` and `packages/runtime/src` with blind spots (aliases, other packages), not a proof. The portal has no control to send the acknowledgement and does not list reviews kept for a decision (the API and the `onNeedsDecision` callback exist; the product surface is follow-up work). Two reviews of one secret can be confirmed concurrently (as before). `revokeOrphan` refuses a record before its deadline plus the claim grace has passed unless it is flagged for a decision, because on a shared store such a record may be another runtime's live review.

What "at most 15 minutes" means exactly (see [ARCHITECTURE.md](ARCHITECTURE.md#instance-state-and-deadlines)): every access to a pending review checks its deadline against the runtime's clock first, so an expired review is unreachable through the queue on the very next access, whether or not a timer or a sweep ran. A review that a confirm or reject has claimed is hidden past its deadline but held for that operation, and the queue takes it back at the deadline plus a fixed grace of two minutes (`CLAIM_GRACE_MS`); a commit checks that bound (a signal and the clock) before each write, so one that comes back later writes nothing more. What this does not do: a write to GitHub that is already in flight is not cut off (the GitHub client takes no abort signal), a commit whose single write never settles keeps its own reference to the value while that call hangs, and strings cannot be erased in this runtime, so "gone" means no reference is left in the queue, not that the memory is overwritten. A store of pending reviews that an embedder supplies sees metadata only (identifier, deadline, the provider's identifier of the new value), never the value. Timers inside the browser automation package use the system clock, not the runtime's injected clock.

## What is protected
- **`SecretValue`**: the value lives in a private field and appears in no output (`toString`, JSON, `util.inspect`).
- **Reports and responses** never contain a value. Instead they carry a fingerprint (12 characters of a SHA-256) for later comparison.
- **Error messages** are sanitized (known tokens, typical prefixes and JSON fields such as `token`, `secret`, `api_key`).
- **GitHub upload** encrypts the value with the target's public key (libsodium sealed box) before sending.
- **Variables** are readable in plain text. Values that look like secrets (Stripe keys, GitHub tokens, service-role JWTs, private keys)
  are rejected; suspicious ones only after explicit confirmation by a human.
- **`.env` files** are created with mode 600 and only in approved folders. The portal warns if Git does not ignore the file.
- **Attachments** (screenshots) are limited to PNG, JPEG and WebP up to 5 MB and are served with `nosniff` and `sandbox`.

## Folder links
- Paths are machine-specific and live only in the local file `repo-links.json` (mode 600), never in the inventory or the team export.
- Only folders **below** the home folder or `policy.envRoots` (after resolving symlinks) that contain a `.git` are allowed.
  The remote is read with `execFile` (no shell); a differing remote only produces a warning.
- Only the portal sets and removes links. Agents see the list without paths and cannot link anything.
- `env/export` (content export, `desk_env_export`): agents only for the stages of `policy.agentStages`; secret values of a stage that is not of kind `dev` are never exported, for anybody; secrets get a value only from a dev template (no provider call). The MCP tool never returns values to the agent (without `out` it returns names only); it writes with mode 600, never over an existing file, never into a path Git tracks, only inside the working directory.
- For `env-export`, a linked folder counts as an allowed root, but only for its own repository. The link is re-checked on every
  use (folder exists, still below home or `envRoots`).

## File permissions and platforms
- **macOS/Linux:** vault, agent token, link file, `.env` files and attachments are created with mode 600, their folders (`~/.secret-desk`,
  browser profile, evidence folder) with 700. Centralized in `securePrivateFile`, `ensurePrivateDir` and `writePrivateFile` (core, `platform.ts`).
- **Windows:** POSIX modes do not exist (`chmod` only affects the read-only bit). The helpers do nothing wrong there and promise nothing:
  protection comes from the user profile (`%USERPROFILE%` is readable only by the account, SYSTEM and administrators via ACL). Files outside the profile
  (for example a `.env` in a freely chosen folder on another drive) inherit the folder's ACL: check the permissions yourself.
- **Vault key:** macOS Keychain, Linux `secret-tool`, Windows DPAPI (`ProtectedData`, scope `CurrentUser`): a random 32-byte key
  is protected with DPAPI and stored as a blob in `<vault>.key`. It can only be opened by the same Windows account on the same machine.
  Data reaches PowerShell (`-NoProfile -NonInteractive`) only via stdin, never via arguments. An existing blob file that cannot be opened
  is never overwritten. Anyone with DPAPI access as the same account (malware running in the user context) can obtain the key: DPAPI protects against
  other users and against theft of the files, not against code running in your own account.
- **macOS Keychain:** a new key is created only when `security find-generic-password` reports "item not found" (exit code 44). Any other failure
  (locked keychain, access denied) is an error and overwrites nothing, because a new key would make every vault entry unreadable. The new key is passed
  to `security -i` via stdin, not as a command-line argument, so it does not appear in the process list.
- **Vault file:** only a missing file means an empty vault. A damaged or unreadable file is an error (a copy is kept as `vault.json.corrupt-<time>`) and is never overwritten. Writes in one process are serialized.
- **Linux without `secret-tool`:** a clear error message, never silent plaintext storage. Options: `SECRET_DESK_VAULT_KEY` or the explicit
  setting `vault.keyFile` (key file, mode 600, rejected if its permissions are too open). The latter puts key and data on the same
  disk: use it only when no keyring is available.
- **Path checks:** comparisons ("is below home/envRoots") resolve symlinks and, on Windows, compare case-insensitively and
  including the drive; UNC and `\\?\` paths and reserved names are rejected on Windows. Names in the evidence folder are limited to `[A-Za-z0-9._-]`,
  with no trailing dot and no Windows device names.
- **Processes:** all external commands (`git`, `op`, `security`, `secret-tool`, `powershell.exe`, Chrome via Playwright) run with `execFile` without a shell
  and with `windowsHide`. Key material reaches `powershell.exe` (Windows) and `security -i` (macOS) via stdin; `secret-tool` (Linux) also gets it via stdin.
- **Browser automation:** Chrome is started with its sandbox enabled (`chromiumSandbox: true`; Playwright would otherwise add `--no-sandbox`). In some containers without user namespaces
  this can fail to start; there is deliberately no option to turn the sandbox off: run secret-desk outside such a container. Recipes: bundled recipes cannot be overridden by a recipe with the same id from another folder.
  The browser URL is checked against the recipe's `host`/`allowHosts` before the token is read.

## Access to the portal
- Listens only on `127.0.0.1` (on all systems; allowed Host values are `127.0.0.1`, `localhost` and `[::1]`, each with the port). Host check against DNS rebinding, origin check on changes,
  and `Sec-Fetch-Site` is evaluated: cross-site and same-site browser requests are rejected. A Content-Security-Policy restricts pages to their own origin.
- **Launch secret:** at start the server creates a random 256-bit secret and prints the URL `http://127.0.0.1:<port>/?launch=<secret>` in the terminal only.
  `/api/session` issues the session cookie and CSRF token only to a caller that presents the secret (compared in constant time) or already holds a valid cookie;
  everyone else gets 401. The page sends the secret once and removes it from the address bar; it is never stored. Without it, any local process could
  simply request a session. For demos and development, `SECRET_DESK_NO_LAUNCH_SECRET=1` turns this off (`pnpm demo` sets it).
- Portal session: cookie (`HttpOnly`, `SameSite=Strict`) plus a CSRF token on every call.
- Agent interface: its own bearer token (`~/.secret-desk/agent-token`, mode 600; the mode is checked on every read and corrected, on Windows only a warning, protection comes from the user profile).
  An agent that only uses this interface **cannot confirm anything**, cannot set connections, upload attachments or pass values, and cannot trigger anything outside `policy.agentStages`
  (by default only stages of kind `dev`; never `live`) without approval.

### Authorisation hook for embedding processes
A process that embeds the runtime can pass an `authorize` hook (see [ARCHITECTURE.md](ARCHITECTURE.md#authorisation-hook)) that is asked before sensitive actions, for example to require a second person for a confirmation. The hook runs after the built-in checks, so it can only make the rules stricter, never weaker; an error inside the hook, a return value other than `undefined`, a missing function or a timeout is a refusal with a generic message and the action does not happen (fail closed). The hook sees ids, names and an opaque principal id, never a value. Every state-changing or value-moving entry point of the portal and the agent API asks it, including what an approval causes after it is approved and every env export. The work the process does on its own that changes state or moves values (the team sync applied at start-up, the scheduled sign-in checks and the scheduled live check) asks it as well, with a `system` actor and a fixed routine name that no request from outside can produce; the command line is not part of this. The expiry sweep of unconfirmed reviews is deliberately not asked: it only discards a value and revokes it at the provider, and no hook can keep a value in memory past its deadline. Note that agents can read the names and principal ids that are recorded on reviews (`preparedBy`, `requestedBy`), approvals (`requestedBy`, `requestedByRef`, `decidedBy`) and in the confirmation of evidence reports; a deployment that sets principal ids should treat them as identifiers that are visible to agents. This repository ships no rules and no sign-in: the local portal and CLI behave exactly as described above.

### Limit: agents with shell access as the same OS user
The statements above hold for an agent that talks to the agent interface. An agent that has shell access as the **same operating-system user** can read every file that user can read
(including `~/.secret-desk/agent-token`, `.env` files and the browser profile) and can start processes. It can also watch the terminal where secret-desk runs, if it is allowed to,
and so obtain the launch secret and open the portal itself. The launch secret protects only against processes that cannot see that terminal (other local programs, scripts,
browser tabs of other sites). It is not a barrier against an agent running with your privileges. Recommendation: run agents in a separate sandbox, container or operating-system user,
and give them only the agent interface (token) and no access to your home folder.

## Team sync
Team sync talks to one private GitHub repository. It uses the GitHub integration unless an own `team-sync` token is set (which then wins). With a GitHub App the portal reads the private key and requests, per operation (no cache across operations), a short-lived installation token for that one repository with only `contents`, `pull_requests` (pull-request strategy) and `metadata: read`; with a PAT the rights of that token apply. An own token should be a fine-grained token for that repository only. The token needs *Contents* (read, to push also write) and, for pull requests, *Pull requests* write. It never goes into a file, log, API response or report, and the vault stores it encrypted like any other connection. The portal reads the team file with a read-only call and takes it over only after a preview and a human action; replacing needs `confirmReplace`. A push sends only the team file: structure, expected variable values and descriptions, never secret values, `externalId`, `rotatedAt` or a token (checked before every push: the own token, the GitHub token, the installation token and the App private key of the operation, plus the shapes `ghp_`/`github_pat_` and PEM private key headers). Before any push the repository must be `private` and the token must be able to push (user token: `permissions.push`; App: granted `contents: write`, plus `pull_requests: write` for pull requests), otherwise nothing is written (`team_repo_not_private`, `team_repo_no_push`). Owner, name, path and branches are validated (no `.`/`..` segments) in the configuration and again in the GitHub client. A fetched team file over 1 MiB is rejected before parsing. At startup with `SECRET_DESK_TEAM_REPO` only new entries are applied; changed or removed entries wait for confirmation in the preview. With the pull-request strategy the repository's review and branch protection decide what lands. Agents can read the sync status, never check, take over or push. The state file `.secret-desk-team-sync.json` holds only a blob SHA, a hash and timestamps.

## Provider access tokens
Enter them per session in the portal (memory only), optionally keep them in the encrypted vault ([INTEGRATIONS.md](INTEGRATIONS.md#vault)), or read them from an environment variable or a 1Password reference (`op://`). Never in the configuration. Order of use: session, vault, configured source.
Cloudflare needs a token with the *User > API Tokens > Edit* permission. That is powerful: keep it only for the session.

## Guided sign-in
The provider facade (see [INTEGRATIONS.md](INTEGRATIONS.md#guided-sign-in-provider-facade)) is the one place where secret-desk types a provider password: the email and password the human entered in the portal for this run. Why this is acceptable: a human started it and typed the values; they are held in memory for one run, typed only into pages on the recipe's `host` (and `allowHosts`), and the run aborts if the browser is on any other host; they are wiped when the run ends, is cancelled or times out; there is no automatic retry with the same password. What it never does: store the values (not in the vault, configuration, inventory, run state, logs, evidence, screenshots, error messages or API responses; the sign-in takes no screenshots), solve CAPTCHAs, or read credentials from files. A one-time code is typed once and dropped. The routes are human-only (`/api/ui`, cookie and CSRF); agents get 404 and the MCP server has no tool for it. The key the facade creates is stored as a connection by this human-started flow, with the smallest permission the connection needs.

## Write test
**Test connection** for GitHub can additionally prove that the token may write. This is opt-in and never automatic: the request must carry `deep: true` and an explicit list of `targets`
(repository or environment ids from the inventory, chosen by the human in the portal; live stages are never preselected). For each chosen target the portal
1. checks that no secret named `SD_WRITE_PROBE` (variable `SD_WRITE_PROBE_VAR`) exists yet, and leaves an existing one untouched;
2. creates the probe with a throwaway value (the secret sealed with the target's public key, as for any other secret) and
3. deletes it again immediately.
If the delete fails, the result is a failure that names the probe and the target so you can remove it by hand. A 403 *Resource not accessible by personal access token* is reported as a missing permission
(*Secrets*, *Environments*, *Variables*: Read and write). The endpoint is portal-only (cookie and CSRF); agents get 404. No token value appears in any response.

## Limits
- Anyone with access to your machine and the running process can read its memory.
- Detection of secrets in variables is a heuristic.
- Some provider endpoints are only tested against mocks (see [PROVIDERS.md](PROVIDERS.md)).
