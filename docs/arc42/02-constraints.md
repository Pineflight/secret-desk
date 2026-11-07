# 2. Constraints

*Purpose: fixed conditions that limit design freedom, each with its consequence · Audience: contributors, reviewers · As of 2026-11-07 · Sources: [`package.json`](../../package.json), [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`Dockerfile`](../../Dockerfile), [`CLAUDE.md`](../../CLAUDE.md), [`SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`LICENSE`](../../LICENSE)*

Versions of frameworks and libraries are tracked in the lockfile ([`pnpm-lock.yaml`](../../pnpm-lock.yaml)) and in the
[release notes](../../CHANGELOG.md); third-party licences in [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md)
(checked in CI by `node scripts/licenses.mjs --check`).

## 2.1 Technical constraints

| Constraint | Consequence |
|---|---|
| Node.js >= 24 (`engines` in `package.json`), pnpm workspace (`packageManager: pnpm@10.25.0`) | Single toolchain; the container image uses `node:24-slim` ([`Dockerfile`](../../Dockerfile)). |
| TypeScript, strict, ES modules, validation of external input with zod ([CONTRIBUTING.md](../../CONTRIBUTING.md)) | Types document the interfaces in chapter 5; no `any` where a type is known. |
| The portal is a Next.js app that listens on `127.0.0.1` only ([SECURITY-MODEL.md](../SECURITY-MODEL.md#access-to-the-portal)) | No remote access by design; LAN use needs an explicit allowed-hosts setting and is discouraged beyond a trusted network. |
| macOS, Linux and Windows 10/11 must work ([README, "Platforms"](../../README.md#platforms)) | All path, permission and key logic sits behind injected `platform` and `exec` parameters ([`platform.ts`](../../packages/core/src/platform.ts)). |
| GitHub is the only target store | Encryption with the target's public key (libsodium sealed box); the GitHub token's rights bound what can be written ([INTEGRATIONS.md](../INTEGRATIONS.md#github)). |
| Browser automation uses the user's own Chrome, Chromium or Edge via `playwright-core`, no browser download ([BROWSER-AUTOMATION.md](../BROWSER-AUTOMATION.md#principles)) | Needs a display or a remote browser sidecar; unavailable inside the plain portal container ([DOCKER.md](../DOCKER.md#what-does-not-work-in-a-container)). |
| Integration tokens sit in an OS keychain-backed vault or are read from the environment | On Linux without a keyring there is no silent plaintext fallback ([SECURITY-MODEL.md](../SECURITY-MODEL.md#file-permissions-and-platforms)). |

## 2.2 Organisational constraints

| Constraint | Consequence |
|---|---|
| Public repository, MIT licence | No internal product, repository, account or host names in code or docs; examples use neutral placeholders (`acme-app`, `acme-org`). Enforced by [`no-internal-names.test.ts`](../../packages/runtime/test/no-internal-names.test.ts) and [`internal-names-allowlist.txt`](../../scripts/internal-names-allowlist.txt). |
| English identifiers, file names, routes, JSON fields, config keys and error codes ([CLAUDE.md](../../CLAUDE.md)) | German appears only in visible UI texts; some older code comments are still German (chapter 11). |
| Tests never use real values, vaults, keychains or the network ([CONTRIBUTING.md](../../CONTRIBUTING.md#test-rules)) | Dependencies are injected (`fetch`, `exec`, `env`, `platform`, temp directories). |
| `pnpm run verify` before every pull request: value scan, build, typecheck, tests | Mirrored by the `verify` job in [`ci.yml`](../../.github/workflows/ci.yml). |
| Every release is built from `main` | [`release.yml`](../../.github/workflows/release.yml) publishes a multi-arch image and a GitHub release on every push to `main` (chapter 7). |

## 2.3 Legal and conventions

| Constraint | Consequence |
|---|---|
| Providers may restrict automation of their web interface in their terms of use | The team decides per provider whether to use a recipe ([BROWSER-AUTOMATION.md](../BROWSER-AUTOMATION.md#limits)). No stealth plugins, no CAPTCHA services. |
| Third-party licences of dependencies and of the browser sidecar | Notices are generated and checked ([`docker/browser/THIRD-PARTY-NOTICES.md`](../../docker/browser/THIRD-PARTY-NOTICES.md)). |
| No telemetry | Only the services the user connects are contacted ([ROADMAP.md](../ROADMAP.md#external-services-secret-desk-talks-to)). |
| Vulnerability reports go through private vulnerability reporting ([SECURITY.md](../../SECURITY.md)) | No public issue for security findings. |
| Changelog follows Keep a Changelog, versions aim at SemVer ([CHANGELOG.md](../../CHANGELOG.md)) | Architecture-relevant changes appear in `Unreleased`. |
