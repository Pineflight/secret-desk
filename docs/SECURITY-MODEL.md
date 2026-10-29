# Security model

## Principle
Values are never stored. The portal holds them in memory only, only for as long as review and confirmation need them
(15 minutes), and passes them on in exactly two places: to the provider API and, encrypted, to GitHub.

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

### Limit: agents with shell access as the same OS user
The statements above hold for an agent that talks to the agent interface. An agent that has shell access as the **same operating-system user** can read every file that user can read
(including `~/.secret-desk/agent-token`, `.env` files and the browser profile) and can start processes. It can also watch the terminal where secret-desk runs, if it is allowed to,
and so obtain the launch secret and open the portal itself. The launch secret protects only against processes that cannot see that terminal (other local programs, scripts,
browser tabs of other sites). It is not a barrier against an agent running with your privileges. Recommendation: run agents in a separate sandbox, container or operating-system user,
and give them only the agent interface (token) and no access to your home folder.

## Team sync
Team sync talks to one private GitHub repository. It uses the GitHub integration unless an own `team-sync` token is set (which then wins). With a GitHub App the portal requests a short-lived installation token for that one repository with only `contents`, `pull_requests` (pull-request strategy) and `metadata: read`; with a PAT the rights of that token apply. An own token should be a fine-grained token for that repository only. The token needs *Contents* (read, to push also write) and, for pull requests, *Pull requests* write. It never goes into a file, log, API response or report, and the vault stores it encrypted like any other connection. The portal reads the team file with a read-only call and takes it over only after a preview and a human action; replacing needs `confirmReplace`. A push sends only the team file: structure, expected variable values and descriptions, never secret values, `externalId`, `rotatedAt` or a token (checked before every push). With the pull-request strategy the repository's review and branch protection decide what lands. Agents can read the sync status, never check, take over or push. The state file `.secret-desk-team-sync.json` holds only a blob SHA, a hash and timestamps.

## Provider access tokens
Enter them per session in the portal (memory only), optionally keep them in the encrypted vault ([INTEGRATIONS.md](INTEGRATIONS.md#vault)), or read them from an environment variable or a 1Password reference (`op://`). Never in the configuration. Order of use: session, vault, configured source.
Cloudflare needs a token with the *User > API Tokens > Edit* permission. That is powerful: keep it only for the session.

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
