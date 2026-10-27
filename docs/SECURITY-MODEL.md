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
- **Linux without `secret-tool`:** a clear error message, never silent plaintext storage. Options: `SECRET_DESK_VAULT_KEY` or the explicit
  setting `vault.keyFile` (key file, mode 600, rejected if its permissions are too open). The latter puts key and data on the same
  disk: use it only when no keyring is available.
- **Path checks:** comparisons ("is below home/envRoots") resolve symlinks and, on Windows, compare case-insensitively and
  including the drive; UNC and `\\?\` paths and reserved names are rejected on Windows. Names in the evidence folder are limited to `[A-Za-z0-9._-]`,
  with no trailing dot and no Windows device names.
- **Processes:** all external commands (`git`, `op`, `security`, `secret-tool`, `powershell.exe`, Chrome via Playwright) run with `execFile` without a shell
  and with `windowsHide`.

## Access to the portal
- Listens only on `127.0.0.1` (on all systems; allowed Host values are `127.0.0.1`, `localhost` and `[::1]`, each with the port). Host check against DNS rebinding, origin check on changes.
- Portal session: cookie (`HttpOnly`, `SameSite=Strict`) plus a CSRF token on every call.
- Agent interface: its own bearer token (`~/.secret-desk/agent-token`, mode 600; on Windows `%USERPROFILE%\.secret-desk\agent-token`, protected by the user profile). Agents **cannot confirm anything**,
  cannot set connections, upload attachments or pass values, and cannot trigger anything in non-dev stages (such as staging or production) without approval.

## Provider access tokens
Enter them per session in the portal (memory only), or via environment variable, or via a 1Password reference (`op://`). Never in the configuration.
Cloudflare needs a token with the *API Tokens Write* permission. That is powerful: keep it only for the session.

## Limits
- Anyone with access to your machine and the running process can read its memory.
- Detection of secrets in variables is a heuristic.
- Some provider endpoints are only tested against mocks (see [PROVIDERS.md](PROVIDERS.md)).
