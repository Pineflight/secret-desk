# Contributing to secret-desk

Thank you for helping. secret-desk handles credentials, so the bar for changes is higher than usual: the main rule is that **a secret value must never leak** into a log, report, response, error message, test fixture or commit.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems are **not** reported as public issues, see [SECURITY.md](SECURITY.md). Questions: [SUPPORT.md](SUPPORT.md).

## Setup

Requirements: Node 24 or newer and pnpm 10 (`packageManager` in `package.json`).

```bash
git clone https://github.com/Pineflight/secret-desk.git
cd secret-desk
pnpm install
pnpm build
pnpm demo          # try the portal with a simulated GitHub
```

Layout (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): `packages/core` (inventory, status, GitHub, issuance, compare), `packages/providers`, `packages/automation`, `packages/runtime` (shared operations and policy), `packages/cli`, `packages/mcp`, `apps/desk` (the Next.js portal), `recipes/`, `skills/`, `docs/`.

Useful scripts:

| Script | Purpose |
|---|---|
| `pnpm verify` | build, typecheck and all tests: **run it before every pull request** |
| `pnpm dev` | start the portal (needs `secret-desk.config.yaml`, see the README) |
| `pnpm demo` | demo portal with simulated GitHub |
| `pnpm test`, `pnpm typecheck`, `pnpm build` | the parts of `verify` |
| `pnpm --filter @secret-desk/core test` | tests of one package (also `providers`, `runtime`, `cli`, `mcp`, `automation`, `@secret-desk/desk`) |
| `pnpm docs:screenshots` | regenerate `docs/images` from the demo (needs Chrome) |
| `pnpm clean` | remove build output (`--deps` also `node_modules`) |

Build `packages/*` before running the app's tests; the packages consume each other's `dist`.

## Test rules

Tests run with [Vitest](https://vitest.dev). Every behavior change needs a test. In addition:

- **Never use a real value.** Test values are made-up strings. Never read real tokens, vaults, keychains or the network.
- **No real vault, keychain, network or home folder in tests.** Inject `fetch`, `exec`, `env`, `platform` and a temporary directory; the code is written to accept them (`RuntimeOptions`, `defaultKeySource(env, platform, exec)`, `path.win32`). Use `os.tmpdir()` folders, never `~/.secret-desk`.
- **Every new response, report and error message gets a test asserting that no value and no connection token appears in it.**
- Do not bypass `SecretValue` in outputs; call `reveal()` only where the value is actually passed on.
- Policy changes (agents, stages, approvals) need tests in `packages/runtime/test/agent-api.test.ts` or the router tests in `apps/desk/test`.
- Keep platform behavior testable on any system with injected platforms rather than skipping tests.
- Browser tests use the fake driver; tests against a real Chrome run only where Chrome exists and need no internet.

## Code style

- TypeScript, strict mode (`tsconfig.base.json`), ES modules, `noUncheckedIndexedAccess` on. No `any` where a type is known; validate external input with zod schemas.
- Match the surrounding code: naming, file layout, error classes. Prefer small pure functions in `core` and keep side effects in `runtime`.
- Comments explain *why*. The existing source comments are partly German; new code comments and all documentation are in **English**.
- Scripts are Node files under `scripts/`, not shell lines, so they work on Windows.
- Never weaken the secret guard for variables (`packages/core/src/guards.ts`) or the policy in `packages/runtime/src/agent-api.ts`. GitHub is written only after a human confirms; the old value is revoked only after that.
- **Naming:** identifiers, file and directory names, routes, API/JSON fields, config keys, env vars, CLI, error codes and test names are English; only visible UI texts, legal texts, doc prose and comments may be German. Saved formats (inventory, team file) keep accepting old German keys when read.

## Security rules

- **Never log, print or return a value.** Not in debug output either.
- External commands run with `execFile`, no shell, and receive key material via stdin, not arguments.
- New network targets must be fixed or allow-listed by configuration, never chosen by an inventory entry or an agent alone.
- Agents get metadata only. Anything that confirms, enters values, changes connections or stages stays human-only.
- Do not add dependencies lightly; pin GitHub Actions to commit SHAs as the existing workflows do.

## Commit and pull request style

- Conventional-style subject: `feat(portal): ...`, `fix(security): ...`, `docs: ...`, `test: ...`, `chore: ...`. Describe the **why** in the body.
- One logical change per pull request; keep it reviewable.
- Fill in the pull request template: `pnpm verify` green, tests added, docs updated, translations covered, no values.
- CI (`ci.yml`) runs `pnpm run verify` and a scan that fails the build if a Stripe key, GitHub token or private key pattern appears in a tracked file.

## Browser recipes as pull requests

Recipes are YAML under `recipes/` and are maintained like data. Read [docs/RECIPES.md](docs/RECIPES.md). A recipe pull request states the provider page it was tested against, the date and whether the run was supervised, and keeps the `# STATUS` comment honest. Never include real tokens, account names or screenshots of values.

## Translations

The portal UI is German and English.

- **UI texts** live in `apps/desk/src/messages/<namespace>.de.ts` and `<namespace>.en.ts`, collected by `messages/index.ts`. Add a key to **both** files. `apps/desk/test/i18n.test.ts` fails if the key sets differ, if placeholders (`{name}`) differ between languages, or if an English text is empty. Plurals use `key.one` and `key.other` with a `count` variable.
- **Backend messages** (errors, guides, report texts from `packages/core`, `runtime`, `providers`) are written in German with ASCII transliteration and translated at the API boundary by the catalog `packages/runtime/src/i18n-en.ts`. A new German message needs an entry there (exact text, or a pattern with `$1` for inserted values). `packages/runtime/test/i18n-en.test.ts` checks the catalog and fails if a message is not covered.
- Documentation is English only.

## Documentation

Change the docs with the code. A claim in the documentation must be backed by the source; say "not verified" where it is not. Screenshots are produced by `pnpm docs:screenshots` from the demo, never from real data. Check that relative links resolve.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
