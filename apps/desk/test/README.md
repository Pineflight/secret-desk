# apps/desk tests

Run: `npx vitest run` (add `--coverage` for the 100% gate). Typecheck covers `test/` too.

## Environments (vitest projects, see `vitest.config.ts`)

- `*.test.ts` run in **node**: libs, server router, security, anything without a DOM.
- `*.test.tsx` run in **happy-dom** (project `dom`): components, pages and hooks (`renderHook`). Hook tests live in `*.test.tsx` files as well, even without JSX.
- The `@/` alias works in both projects (same as in the app).
- `test/setup-dom.ts` (dom project only): jest-dom matchers, RTL `cleanup`, `localStorage.clear()`, `vi.unstubAllGlobals()` and the `next/navigation` fake after every test, and the stored locale `de` before every test (happy-dom is English, the app defaults to German).

## Helpers (`test/helpers/`)

- `render.tsx`: `renderApp(ui, options?)` renders inside `I18nProvider` and `ToastProvider` (the providers of `src/app/layout.tsx`, without the Shell) and returns the RTL result plus `user` (user-event). `Providers` is the bare wrapper for `renderHook({ wrapper: Providers })`.
- `navigation.ts`: fake of `next/navigation`, mocked for every dom test by the setup file. `navigation.set("/entries?q=x")` sets what `usePathname()` and `useSearchParams()` return; `navigation.router.push` etc. are `vi.fn()` to assert on. Reset after every test.
- `portal.ts`: `fakePortal({ "GET entries": [...], "POST entries": (call) => ({ status: 201, body: {...} }) })` stubs `fetch` for `src/lib/api.ts`. `/api/session` always succeeds. Keys are `"METHOD path"` without the `/api/ui/` prefix; unknown routes answer 404. Returns `{ calls, callsTo(method, path) }` with parsed JSON bodies and headers for assertions.

## Conventions

- Assert behaviour a user sees (roles, text, focus, calls made), not implementation details.
- No real network, no timers by sleeping: use `findBy*`/`waitFor` or `vi.useFakeTimers()`.
- No real tokens or secret-looking strings in tests (CI greps for token prefixes and key headers). Use obvious placeholders such as `csrf-for-tests`, `value-for-tests`.
- Code, test names and comments are English; expected UI strings are whatever the German messages say.
- Unreachable code: remove it if behaviour stays the same, otherwise `/* v8 ignore next */` with a one-line reason.
