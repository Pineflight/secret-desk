# Browser automation (providers without an API)

For providers where a token can only be created through the web interface (GitHub fine-grained PAT, Supabase access token,
Stripe restricted key), secret-desk drives a real browser through the form. It is the same flow as for API providers:
generate the value, review it, report with evidence, **a human confirms**, and only then is it written to GitHub.

Adding a provider step by step: [DEVELOPING-INTEGRATIONS.md](DEVELOPING-INTEGRATIONS.md). The state of the remote browser and the recipes is shown under *Settings*, *Developer*.

## Principles

1. **The human signs in themselves, or types the sign-in for one run.** The browser is a visible window (not headless) with its own persistent profile
   (`~/.secret-desk/browser-profile`, mode 700). secret-desk never types a password or 2FA code and never solves a CAPTCHA. When a
   login, 2FA, CAPTCHA or password confirmation appears, it waits (10 minutes by default) and then continues.
2. **The value stays in memory.** The token is read from the page and handed to `prepareIssuance` as a `SecretValue`.
   It never appears in logs, recipe output, error messages or screenshots. Screenshots are taken before the value
   becomes visible, or with masked regions (`mask`).
3. **Fail closed.** Any unexpected state (element missing, wrong page, timeout) aborts, and nothing is written to GitHub.
   If a token was already created at the provider, its name appears in the error and in the report so it can be deleted there.
4. **Recipes are data, not code.** A web interface changes; the fix is then a YAML change via pull request.
   Others on the team can add providers without writing TypeScript.
5. **Your own browser only.** `playwright-core` with the installed Chrome/Chromium (`channel: "chrome"` or
   `automation.chromePath`), or with a browser you run yourself and reach over the DevTools protocol (`automation.cdpEndpoint`,
   see [Remote browser](#remote-browser-headless-host)); no browser download.
6. **No circumvention.** No stealth plugins, no CAPTCHA services, no credentials from files. If a page demands a bot check,
   the human completes it in the window.

## Guided sign-in (provider facade)

Principle 1 has one exception: a recipe with `login.form` can be driven by the guided sign-in. The human enters email and password in the portal; they are used for that run only (memory, typed only on the recipe's hosts, wiped afterwards, never logged or stored). The run state (`AutomationRunState`) then carries `phase`, `timeline`, `needs` (`mfa-code`, `approval` or `captcha`), `timeoutAt`, `failure` and `result`; the portal polls it. A one-time code is typed in the portal and entered once. For a CAPTCHA the portal offers *Open browser* (noVNC); nothing is circumvented. Afterwards the key recipe runs in the same browser profile. Routes (human-only): `GET facades`, `GET facades/:id/state`, `POST facades/:id/sign-in|code|connect|cancel|check`. Only one browser run at a time. See [RECIPES.md](RECIPES.md#guided-sign-in-loginform) and [SECURITY-MODEL.md](SECURITY-MODEL.md#guided-sign-in).

## Recipe (YAML)

The how-to for writing recipes (schema, step kinds, variables, safety rules, testing) is [RECIPES.md](RECIPES.md). This section is the short form.

```yaml
id: github-fine-grained-token
label: GitHub Fine-grained Token
host: github.com                   # pages outside this host (and listed hosts) are not served
login:
  # Signed in when this test passes after goto; otherwise wait for the human.
  expect: { url: "^https://github\\.com/settings/" }
steps:
  - goto: "https://github.com/settings/personal-access-tokens/new?name={{name}}&target_name={{owner}}&expires_in={{days}}"
  - fill: { label: "Token name", value: "{{name}}" }
  - click: { role: button, name: "Generate token" }
  - screenshot: form-before            # evidence before the value
capture:
  token:
    find: { css: "#new-access-token" }  # prefer role/label/text/testid, css only if necessary
    pattern: "^github_pat_[A-Za-z0-9_]+$"
  externalId: { from: name }            # identifier for later revocation
  expires: { from: days }
mask: [{ css: "#new-access-token" }]    # hidden in all later screenshots
revoke:
  steps: [ ... ]                         # optional; otherwise a hint for the human
```

Steps: `goto`, `fill` (label/role/placeholder/testid, `value`), `select`, `check`, `click`, `press`, `waitFor` (url/visible/text),
`pause: human` (the human has to do something; the text is shown in the portal), `screenshot: <name>`. Variables in `{{ }}`: `name`, `owner`,
`days`, `date`, `description`, `repos`, `permissions`, `stage`, `secretId`. Unknown variables are an error.

## Components

- Package `@secret-desk/automation` (optional dependency `playwright-core`):
  `RecipeSchema` (zod), `loadRecipes(dirs)`, `renderTemplate`, `runRecipe(recipe, vars, driver, hooks)`,
  the `BrowserDriver` interface (Playwright implementation `PlaywrightDriver`, test implementation without a browser),
  masking, login waiting with a timeout, abort.
- A provider that runs `issue` through a recipe and returns `IssuedSecret` (evidence PNGs go to the `EvidenceStore`). The runtime
  (`createRuntime`) registers recipes from `recipes/` (bundled), `<inventory folder>/recipes/` and `automation.recipesDirs` as provider `<recipe-id>-browser`.
- The `github-fine-grained-token` recipe also serves the **team token** of team sync ([TEAM.md](TEAM.md#team-sync)): the portal starts it without an inventory entry (variables `owner`, `repos`, `permissionsQuery`, `days` 90, name `secret-desk-team-<repo>`), tests the new token itself and stores it as the connection `team-sync`. The recipe and its selectors are unchanged and still not verified against the live page.
- Bundled recipes: `github-fine-grained-token`, `supabase-access-token`, `revenuecat-secret-api-key`, `stripe-restricted-key` (per account and mode; sandbox wizard checked, live mode and sign-in form not verified).
- Portal: a "Browser" provider chip; during a run the status "Browser running, please sign in/confirm in the window" with Cancel and a timeout.
- CLI: `secret-desk browser doctor` (Chrome found, profile, recipes valid), `secret-desk browser run <recipe> --dry` (only up to just before "generate").
- Configuration: `automation: { enabled?, chromePath?, cdpEndpoint?, profileDir?, loginTimeoutMinutes?, signInFreshHours?, slowMoMs?, recipesDirs?, allowExternalRecipes? }` (see [CONFIGURATION.md](CONFIGURATION.md#automation)).

## Remote browser (headless host)

On a host without a display, such as a Raspberry Pi with Raspberry Pi OS Lite, the browser runs in a sidecar container and secret-desk connects to it:

- `automation.cdpEndpoint` (or the environment variable `SECRET_DESK_BROWSER_CDP`, which wins), for example `http://browser:9222`. Only `http`, `https`, `ws` and `wss` are accepted. The address is never logged or shown with credentials, query or fragment.
- The driver uses `chromium.connectOverCDP` and the browser's **default context**, so the persistent profile (cookies) lives in the sidecar, not in secret-desk. `chromePath`, `profileDir` and `headless` are ignored.
- Every run opens **its own tab** (and closes it, with popups it opened, at the end) and then only **disconnects**. The remote browser, its profile and the tabs you keep open are never closed. Cancelling a run behaves the same.
- A host name is resolved to an IP address before connecting, because Chromium answers DevTools requests only for IP or `localhost` in the `Host` header.
- Principles stay: you sign in yourself, in the sidecar's browser window through noVNC; when a provider asks again, the run pauses ("waiting for you in the browser window") and you complete it there.
- `secret-desk browser doctor` and the portal (*Connections*) report the mode and whether the endpoint answers (`/json/version`; no page content).
- **Port 9222 gives full control over a signed-in browser.** It belongs on a private network between the two containers and must never be published or proxied.

Setup, compose file and Caddy route: [DOCKER.md](DOCKER.md#browser-on-the-pi).

## Platforms
Chrome is searched for in the usual locations: macOS (`/Applications`), Linux (`google-chrome`, `chromium`, `chromium-browser`, Edge under `/usr/bin`, Snap, Flatpak),
Windows (`%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%LOCALAPPDATA%`: Chrome, Chromium, Edge). Otherwise use `--chrome-path`/`automation.chromePath`. Snap and
Flatpak browsers are sandboxed and often cannot be driven. The profile lives under `<home>/.secret-desk/browser-profile` (Windows:
`%USERPROFILE%\.secret-desk\browser-profile`); POSIX mode 700, on Windows protection via the user profile.

## Limits

Most bundled recipes have been run against the real sites only recently (four on 2026-11-03, see the `# STATUS:` comment of each); the rest is tested against
local replicas of the forms only. The first real run is a trial run with a throwaway token and human supervision;
select fields that a provider changes abort the run instead of guessing. Providers may restrict automation of their interface in their
terms of use: the team decides per provider whether to use the recipe.

## Implementation status

Built (package `packages/automation`, recipes in `recipes/`, CLI `packages/cli/src/browser.ts`):

- `RecipeSchema` (zod) with the step kinds `goto`, `fill`, `select`, `check`, `click` (`createsToken: true` marks the point from which
  something is created at the provider), `press`, `waitFor` (`url`/`visible`/`text`), `pause` (`human` + an `until` condition) and `screenshot`. Every step (except goto,
  waitFor, pause, screenshot) may carry `each: repos` and then runs once per repository with `{{item}}`. Selectors: `role`+`name`, `label`, `text`,
  `placeholder`, `testid`, `css` (last resort). Additional variables: `permissionsQuery` (the already-encoded query part of the permissions), `externalId` (`revoke` only), `item`.
- The schema checks: unknown variables, `http` only for localhost, a fixed host in `goto` (host or `allowHosts`, also `*.example.com`), at least one
  `createsToken`. `loadRecipes(dirs)` throws with file name and path (`file.yaml: steps.3.click: ...`); `loadRecipesDetailed` collects errors. Without protection, later folders override equal ids; the runtime protects bundled ids (a recipe from another folder with a bundled id is reported as an error and not loaded).
- `renderTemplate`: an unknown variable is an error; in `goto`, every value is encoded with `encodeURIComponent`.
- `BrowserDriver` with `PlaywrightDriver` (visible Chrome, `launchPersistentContext`, profile mode 700, `slowMoMs`; Chrome lookup: `chromePath`, macOS/Linux/Windows default paths,
  otherwise `channel: "chrome"`; no download) and `FakeDriver` (tests, no browser).
- `runRecipe` / `dryRunRecipe` / `revokeRecipe`: login waiting (`login.expect` after the first `goto`, after which the target page is reloaded), timeout,
  AbortSignal, host check before every action, masking in every screenshot (Playwright `mask`, plus an automatic evidence image `nach-erzeugen`), errors without page content,
  `RecipeRunError.createdName` after `createsToken`.
- `createBrowserProvider({ recipe, driverFactory, hooks?, runOptions?, evidence? })` fits the `Provider` interface (`kind: "automatic"`, plus `automation.recipeId`).
- Recipes: `github-fine-grained-token`, `supabase-access-token`, `revenuecat-secret-api-key`, `stripe-restricted-key`, `openai-admin-key` (facade, not verified live). Each carries a `# STATUS:` comment; `supabase-access-token`, `vesselapi-api-key`, `openai-api-key` (owner *You*) and `revenuecat-secret-api-key` ran end to end against the live pages on 2026-11-03 (the sign-in form steps after the email are not verified), and `stripe-restricted-key` in the sandbox (2026-11-03: wizard, result view with the key in `data-text`, expiry; full run, sign-in form and live mode not verified), the rest is not verified.
- Recipe `params` (per-entry values such as a project id) become template variables and provider parameter specs; see [RECIPES.md](RECIPES.md#parameters).
- CLI: `secret-desk browser doctor`, `secret-desk browser run <id> --dry [--name --owner --days --repos --out ...]`.
- Tests: schema, template, host, fake runs, loading recipes, provider, integration with `PlaywrightDriver` against a local form (only with Chrome, headless, no internet).

### Wiring in runtime and portal (built)

- **Configuration** (`packages/core/src/config.ts`): `automation: { enabled (true), chromePath?, profileDir? (~/.secret-desk/browser-profile), loginTimeoutMinutes (10), signInFreshHours (12), slowMoMs?, recipesDirs?: string[], allowExternalRecipes (false) }`. Recipes outside the bundled folder (`<inventory folder>/recipes`, `recipesDirs`) load only with `allowExternalRecipes: true`; a recipe never overrides a bundled id.
  Relative paths are resolved from the configuration file, `~` is expanded. Example: `examples/secret-desk.config.example.yaml`.
- **Runtime** (`packages/runtime/src/automation.ts`): `rt.automation` (`AutomationManager`). `createRuntime` loads the recipes (bundled from `<repo>/recipes` via
  `bundledRecipesDir()`, plus `<inventory folder>/recipes` and `recipesDirs`; later folders override equal ids) and registers the provider `<id>-browser` per recipe.
  Invalid recipes do not abort anything; they are listed in `rt.automation.problems`. Without Chrome/Playwright the provider is still present; the run fails with a message including an installation hint.
- **Run state** per `secretId`: `idle | running | waiting-human | done | failed | cancelled` with text, the page's host (without path/query), step `n of m`, start time, on `done` the review id,
  on errors `createdName`. Only **one** run at a time (one profile, one window); a second start returns 409. The state lives in the runtime, not in the portal's browser:
  reloading the page does not orphan the run, and the page keeps polling. Values never appear in the state; error texts are redacted.
- **Flow**: `requestIssuance` (and the approval of an agent request) runs `prepareIssuance` for a browser provider as a tracked run and then attaches the evidence
  (`attachScreenshots`) to the report. The request runs up to the login timeout; the Next handler has `maxDuration = 3600` for this.
- **Agents** (MCP/agent API) get only an approval in the portal for a browser provider in **every** stage (a window opens on the machine), even with `agentStages: [dev]`.
  State and cancel are portal-only routes.
- **Portal routes** (only `/api/ui`, cookie + CSRF): `GET automation` (Chrome, profile folder, wait time, recipes with status comment, problems, runs),
  `GET automation/runs/:secretId`, `POST automation/runs/:secretId/cancel`. Runs are started through the existing route `POST renewal-requests`.
- **UI**: secret page with a run panel (every 2 s, hint about signing in yourself, "Recipe not verified against the real site", Cancel, link to the review);
  Integrations with a "Browser automation" section; a "Browser" chip on the secret and in the provider picker. All texts are bilingual (DE/EN).
- **Build note**: `apps/desk` lists `@secret-desk/automation` and `playwright-core` in `serverExternalPackages` so that Next does not bundle the browser driver.

### API for the integration (runtime and portal)

```ts
import {
  createBrowserProvider, loadRecipesDetailed, PlaywrightDriver, RecipeRunError,
  type RunHooks, type RunOptions, type BrowserProvider,
} from "@secret-desk/automation";

const { recipes, errors } = await loadRecipesDetailed([bundledRecipesDir, join(inventoryDir, "recipes")]);
for (const { recipe } of recipes) {
  registry.register(createBrowserProvider({
    recipe,
    driverFactory: () => new PlaywrightDriver({ chromePath, profileDir, slowMoMs }),   // from config.automation
    hooks: (secretId) => ({ onWaitingForHuman: (w) => portal.setStatus(secretId, w), onResumed: () => portal.clear(secretId) }),
    runOptions: (secretId) => ({ loginTimeoutMinutes, signal: portal.abortSignal(secretId) }),
    evidence,
  }));
}
// After prepareIssuance: attach the evidence to the report (the report only exists after issue):
await (provider as BrowserProvider).attachScreenshots(secret.id, report.id);
```

- The runtime names the provider `<recipe.id>-browser` (label `<label> (Browser)`) and does not replace the existing guide provider for the same recipe: both stay selectable.
- `RecipeRunError` (`kind`: abort | timeout | host | step | capture; `createdName`) belongs in the error report and the portal: with `createdName`, show the name so the human can delete it at the provider.
- The evidence attachment goes through `attachScreenshots` because `EvidenceStore.attach` needs an existing report, whereas `issue` runs before the report.

### Open items

- `next build` and a real run in the portal have not yet been verified together (bundling of `playwright-core`, path of the bundled recipes in the production build).

- Verify recipes against the real sites (trial run with a throwaway token, supervised); in particular the GitHub confirmation dialog, the token element and the Supabase expiry field.
- A dedicated step for elements inside a dialog (selectors have no notion of a scope); until then use `css`.
- Stripe: a free permission list (today two presets: `webhooks` and `full-except-sensitive`).
- Write revocation via recipe (`revoke.steps`) for GitHub and Supabase; so far a hint for the human.
- Clarify each provider's terms of use regarding automation (a team decision).
