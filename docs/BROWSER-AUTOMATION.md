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

Principle 1 has one exception: a recipe with `login.form` can be driven by the guided sign-in. The human enters email and password in the portal; they are used for that run only (memory, typed only on the recipe's hosts, wiped afterwards, never logged or stored). The run state (`AutomationRunState`) then carries `phase`, `timeline`, `needs` (`mfa-code`, `approval` or `consent`) with `detail` (the number an approval shows, or the access a consent asks for), `timeoutAt`, `failure` and `result`; the portal polls it. A one-time code is typed in the portal and entered once. A CAPTCHA cannot be solved by the script: the run ends with a message and *Try again*; nobody is sent to the browser window and nothing is circumvented. The dialog first checks whether the browser is already signed in and then connects directly, without credentials. Besides `login.form` (method `email`) a recipe can declare `login.methods` for single sign-on with Apple, Google, Microsoft or GitHub (built-in identity-provider flows, see [DEVELOPING-INTEGRATIONS.md](DEVELOPING-INTEGRATIONS.md#sign-in-methods-and-single-sign-on)); an OAuth consent is shown in the portal and confirmed there. Afterwards the key recipe runs in the same browser profile. Routes (human-only): `GET facades`, `GET facades/:id/state`, `POST facades/:id/sign-in|code|confirm|connect|cancel|check` (sign-in takes `method`). Only one browser run at a time. A recipe with a `login.form` but no facade (a browser-only vendor such as Peecho, VesselAPI or Supabase) has the same sign-in without the key part: `POST recipes/:id/sign-in` takes `method`, the credentials and, for a recipe with several portals (`hostBy`/`hosts`), `host` (a value of the host parameter or the host; none or an unknown one is a 400), and starts a run keyed `recipe-signin:<id>` that only signs in; `GET recipes/:id/sign-in/state` and `POST recipes/:id/sign-in/code|confirm|cancel` follow, answer and cancel it, all human-only (agents get 404, no CSRF header 401). It uses the facade's sign-in engine (`signIn`, the code, approval and consent prompts, credentials in memory only and wiped when the run ends, never in a state, a log or a response) and on success records the sign-in at the recipe's host with source `connect`; a busy browser is a 409. `GET automation` lists `signInMethods` and `signInPasswordless` per recipe so the portal can show the right form. The team token run signs in on its own open browser the same way (it asks for the method and credentials in the portal when GitHub is signed out) and uses `RunHooks.signIn`; its questions are in `AutomationRunState.ask` and answered through `POST team-sync/token/credentials|code|confirm|access`. See [RECIPES.md](RECIPES.md#guided-sign-in-loginform) and [SECURITY-MODEL.md](SECURITY-MODEL.md#guided-sign-in).

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
`days`, `date`, `description`, `repos`, `permissions`, `stage`, `secretId`. Unknown variables are an error. `repos` comes from the entry's GitHub places, or from `params.repos` (a list or comma-separated text) when the token must reach other repositories than the ones it is stored in.

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
- Configuration: `automation: { enabled?, chromePath?, cdpEndpoint?, profileDir?, loginTimeoutMinutes?, signInFreshHours?, signInCheckHours?, renewalWarnDays?, liveCheckDays?, liveCheckNotify?, slowMoMs?, recipesDirs?, allowExternalRecipes? }` (see [CONFIGURATION.md](CONFIGURATION.md#automation)).

## Remote browser (headless host)

On a host without a display, such as a Raspberry Pi with Raspberry Pi OS Lite, the browser runs in a sidecar container and secret-desk connects to it:

- `automation.cdpEndpoint` (or the environment variable `SECRET_DESK_BROWSER_CDP`, which wins), for example `http://browser:9222`. Only `http`, `https`, `ws` and `wss` are accepted. The address is never logged or shown with credentials, query or fragment.
- The driver uses `chromium.connectOverCDP` and the browser's **default context**, so the persistent profile (cookies) lives in the sidecar, not in secret-desk. `chromePath`, `profileDir` and `headless` are ignored.
- Every run opens **its own tab** (and closes it, with popups it opened, at the end) and then only **disconnects**. The remote browser, its profile and the tabs you keep open are never closed. Cancelling a run behaves the same.
- A host name is resolved to an IP address before connecting, because Chromium answers DevTools requests only for IP or `localhost` in the `Host` header.
- The viewer (noVNC window, *Settings*, *Developer*) is a tool for recipe authors. Normal sign-ins run through the recipe script with credentials typed in the portal; when a recipe run needs a human step only the browser can give (for example a password confirmation), the facade run ends with a message and the human tries again.
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
- Recipes: `peecho-api-keys` (`kind: read`: reads two fixed keys, creates nothing; full read verified live 2026-11-04 on both portals with an existing sign-in, sign-in form not verified), `github-fine-grained-token`, `supabase-access-token`, `revenuecat-secret-api-key`, `stripe-restricted-key`, `openai-admin-key` (facade, not verified live), `grafana-cloud-access-policy` (facade, nothing verified). Each carries a `# STATUS:` comment; `supabase-access-token`, `vesselapi-api-key`, `openai-api-key` (owner *You*) and `revenuecat-secret-api-key` ran end to end against the live pages on 2026-11-03 (the sign-in form steps after the email are not verified), and `stripe-restricted-key` in the sandbox (2026-11-03: wizard, result view with the key in `data-text`, expiry; full run, sign-in form and live mode not verified), the rest is not verified.
- Recipe `params` (per-entry values such as a project id) become template variables and provider parameter specs; see [RECIPES.md](RECIPES.md#parameters).
- CLI: `secret-desk browser doctor`, `secret-desk browser run <id> --dry [--name --owner --days --repos --out ...]`.
- Tests: schema, template, host, fake runs, loading recipes, provider, integration with `PlaywrightDriver` against a local form (only with Chrome, headless, no internet).

### Wiring in runtime and portal (built)

- **Configuration** (`packages/core/src/config.ts`): `automation: { enabled (true), chromePath?, profileDir? (~/.secret-desk/browser-profile), loginTimeoutMinutes (10), signInFreshHours (12), signInCheckHours (6), renewalWarnDays (7), liveCheckDays (7), liveCheckNotify?, slowMoMs?, recipesDirs?: string[], allowExternalRecipes (false) }`. Recipes outside the bundled folder (`<inventory folder>/recipes`, `recipesDirs`) load only with `allowExternalRecipes: true`; a recipe never overrides a bundled id.
- **Sign-in memory and scheduled checks** (`packages/runtime/src/sign-in-store.ts`, `sign-in-schedule.ts`): the last answer per recipe host (`host`, `signedIn`, `checkedAt`, `source` = `check` | `run` | `connect`) is kept in `sign-in-state.json` in the data directory (next to the repository links file, mode 600, temp file plus rename; no cookies, no credentials, no URLs; a missing or damaged file is ignored). `SignInScheduler` ticks every minute and, when `automation.enabled` is on and `signInCheckHours` is above 0, runs the normal session check (`checkSession`, the same as *Check sign-in*) for every recipe host without an answer or with one older than `signInCheckHours`: one at a time, only when `AutomationManager.isBusy()` is false, one recipe per host (a recipe with `hostBy`/`hosts` once per host, each checked with its own `host`), a failed host again after 30 minutes. In local-Chrome mode a scheduled check opens that window as well; the intended setup is the remote browser sidecar. A recipe with several portals (`hostBy` + `hosts`, see [RECIPES.md](RECIPES.md#several-hosts-hostby-and-hosts)) is turned into a single-host recipe for the chosen portal by `resolveRecipe` before a run, a check or a sign-in, so the allowlist, the host guard, the sign-in memory and the lifetime measurement see exactly one host; `POST recipes/:id/check` and `POST facades/:id/check` take `host` in the body (a value of the host parameter or the host itself; none or an unknown one is a 400), and `GET automation` lists `hostBy` and `hosts` per recipe, `GET secrets` the entry's `browserHost`. `GET automation` returns `signInChecks` (with `source`), `signInLifetimes` (`host`, `averageMinutes`, `samples`, `measuredAt`, the newest five measurements per host), `signInCheckHours` and `renewalWarnDays`.

- **Live check** (`packages/runtime/src/live-check.ts`, `live-check-store.ts`): `runLiveCheck` tests every connected integration with `checkConnection` (never `deep`) and dry-runs every loaded recipe with `dryRunRecipe`, one recipe after the other while it holds the browser queue (`AutomationManager.begin("live-check")`; it does not start while `isBusy()`). The recipe runs with placeholder variables (`name` = `secret-desk-live-check`, the recipe's own parameter defaults, the first option of a required choice, no repositories: steps with `each` are left out; a required parameter without a default that cannot be taken from an inventory entry of the recipe's provider (non-live stages first, then by id; the report names the entry id and the parameter names, never values) makes the recipe `skipped`) on a wrapped driver that refuses `readText`, refuses `readAttribute` other than `href` and returns an empty picture, so even a recipe that tried would get no page text. No `signIn` and no `access` hook is passed: when the run would wait for a person (signed out, MFA, `confirmAccess`, CAPTCHA) the hook ends it at once and the recipe is `needs-sign-in`. Each recipe has its own timeout (120 s, kind `timeout`, the browser is closed). `LiveCheckScheduler` ticks every minute and starts a check when the newest stored report is older than `automation.liveCheckDays`; `LiveCheckStore` keeps the last 12 reports in `live-check-state.json` next to `sign-in-state.json`. A failed check with `automation.liveCheckNotify` set POSTs `{ ok, failedConnections, failedRecipes, needsSignIn, finishedAt }` (ids only; also sent when a recipe only needs a sign-in) to the address read from the configured source. Portal routes `GET`/`POST live-check` (human only), CLI `secret-desk live-check`. How to read a report: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#reading-the-live-check).
  Relative paths are resolved from the configuration file, `~` is expanded. Example: `examples/secret-desk.config.example.yaml`.
- **Runtime** (`packages/runtime/src/automation.ts`): `rt.automation` (`AutomationManager`). `createRuntime` loads the recipes (bundled from `<repo>/recipes` via
  `bundledRecipesDir()`, plus `<inventory folder>/recipes` and `recipesDirs`; later folders override equal ids) and registers the provider `<id>-browser` per recipe.
  Invalid recipes do not abort anything; they are listed in `rt.automation.problems`. Without Chrome/Playwright the provider is still present; the run fails with a message including an installation hint.
- **Run state** per `secretId`: `idle | running | waiting-human | done | failed | cancelled` with text, the page's host (without path/query), step `n of m`, start time, on `done` the review id,
  on errors `createdName`. Only **one** run at a time (one profile, one window); a second start returns 409. The state lives in the runtime, not in the portal's browser:
  reloading the page does not orphan the run, and the page keeps polling. Values never appear in the state; error texts are redacted.
- **Signed out during an issuance run.** A local browser keeps the run waiting for the person at the window (kind `login`, `waiting-human`). With a remote browser (`cdpEndpoint` / `SECRET_DESK_BROWSER_CDP`) and a recipe that has a guided sign-in (`login.form`), a signed-out run does not wait for a window nobody sees: it ends at once with the run error kind `signin` (`RunOptions.signInOutsideWindow`, `RecipeRunError.kind`). The run state is then `failed` with `failure.code` `needs-sign-in` and `signInRecipeId` (the recipe whose sign-in the portal starts with `POST recipes/:id/sign-in`); the thrown `AutomationError.kind` is `signin`. Nothing is typed and no credential is involved. Recipes without `login.form` still wait for the person in the window. Browser issuance runs are always started by a human (an agent request needs a portal approval first), so an agent never answers or triggers a sign-in prompt.
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

## Confirming access (`confirmAccess`)

The principle is that the human never leaves the portal: the remote browser viewer is a developer tool. Every confirmation a provider asks for in the middle of a recipe runs through a built-in flow (`packages/automation/src/sudo.ts`), triggered by the step `confirmAccess: { flow: <github-sudo | stripe-verify | generic-verify>, until: <page the recipe wants> }`. A flow is data (`SUDO_FLOWS`), not code: the run, the runtime and the portal know no provider. The portal asks the human for the ways the page offers (GitHub Mobile, a code, a password) and the answer is typed once. The step passes at once when `until` holds, so a recipe can put it after any click that *may* trigger a verification.

**GitHub *Confirm access* (sudo mode).** Seen on the live page on 2026-11-03: heading *Confirm access*, *Signed in as @user*, the default view *Use GitHub Mobile*, links *Use your passkey*, *Use your authenticator app*, *Use your password*, the fields `sudo_app_otp` (button *Verify*) and `sudo_password` (button *Confirm*), and after *Use GitHub Mobile* the text *Enter the digits shown below* with a one or two digit number. The portal asks how to confirm:

- **GitHub Mobile** (default): the flow clicks *Use GitHub Mobile*, reads the number and the portal shows *Open GitHub Mobile and tap 17*; the step ends when the page leaves *Confirm access* (timeout 120 s, then a clear message and *Try again*).
- **Authenticator code**: typed into `sudo_app_otp`, *Verify*.
- **Password**: held in memory for the run only (like the facade password), typed into `sudo_password`, *Confirm*; never logged, the field is masked in screenshots.
- **Passkey**: not possible in the remote browser and not offered.

**Flow shape.** A flow lists its `methods`, how to `detect` the page (a text, plain or `/pattern/flags`, plus one visible element), what `present` keeps true while it is open (a text or elements), the `code` / `password` ways (field, submit buttons, optional `switchTo`), and optionally `mobile`, `prepare` (clicks made once before the first question), `discover` (ask only for the ways whose field is visible now and follow a page that moves on to a further factor), `keepPage` (do not reload between tries) and `maxAttempts`. A flow with `discover` that finds no field it knows ends with the kind `unrecognized`, and the recipe then waits for the human in the browser window (like `pause`) instead of failing.

**Stripe *Verification required* (`stripe-verify`).** Seen live on 2026-11-04 after *Create key* in live mode: title *Verification required*, text *To make changes to your account, verify your identity using one of these options.*, two option cards *Use a security key* (preselected, a passkey: not possible in the remote browser and never chosen) and *Verify by email + more verification*, button *Continue*. The flow clicks the email option, then *Continue* (scoped to `[role=dialog]`), asks the portal for the code Stripe sent by email, types it and clicks the submit button; if the dialog goes on to a further factor ("more verification") it asks again (password or another code, up to 5 questions) without reloading. **Not verified** (guesses scoped to the dialog, each step waits for its element so a wrong guess fails visibly or hands over to the human): the code field (`input[autocomplete="one-time-code"]` or `input[inputmode="numeric"]` in the dialog; a plain text input is not guessed at, the human finishes then), the password field (`input[type="password"]`), the submit button (*Continue*, *Verify*, *Submit* or *Confirm*), the second factor itself, and whether the dialog stays open between the steps.

**Any other provider (`generic-verify`).** For re-verification pages that are not known yet: the page shows a password field (`input[type="password"]`) or a one-time-code field (`input[autocomplete="one-time-code"]`, or a numeric input in a dialog) inside a dialog, or on the page together with a tight verification wording (`/verif|confirm your identity|two-factor|2FA|enter the code|re-?enter your password/i`; the bare words "password" and "code" do not count). The flow asks the portal for the matching way, types, clicks *Continue* / *Verify* / *Submit* / *Confirm* (dialog first, then the page) and asks again while the field stays (up to 5 questions). Nothing about it is verified live; a password field inside an unrelated dialog would also match, so recipes use it only right after a click that may ask. In every screenshot of a recipe that uses `confirmAccess`, the password and code fields and every input inside a dialog are masked.

A refused code or password and a missed GitHub Mobile approval ask the portal again (three tries). After a failed try the page is reloaded to get back to the first view. Not verified live: the place of the digits on the page (read from the text after the sentence), the buttons *Verify* and *Confirm*, and the view switches. A run without a portal to answer in (CLI, MCP) waits for the human in the browser window instead. Hooks: `RunHooks.access` (`request`, `onEvent`); timing options `RunOptions.access`.

### Sign-in and verification per integration

Sign-in MFA via the portal = the recipe has a `login.form.mfa` block (the portal asks for the one-time code). Mid-run verification = the `confirmAccess` step after the click that creates the key. "Verified live" says whether that part was seen working against the real site; everything marked "no" uses selectors that are guesses.

| Recipe | Sign-in MFA via portal | Mid-run verification | Verified live |
|---|---|---|---|
| `github-fine-grained-token` | yes (two-factor pages) | `github-sudo` before and during create and delete | page text and field names seen 2026-11-03; flow not run end to end |
| `stripe-restricted-key` | yes (`mfa` block, guessed selectors) | `generic-verify` before *Create key* (live, password), then `stripe-verify` and `generic-verify` after *Create key* (live, single-page form) | dialog seen 2026-11-04; everything after the email option no |
| `anthropic-admin-key` | yes (email code) | `generic-verify` after the create click | sign-in code step yes (2026-11-04); verification no |
| `anthropic-api-key` | shares the sign-in with `anthropic-admin-key` (same host; the recipe has no form of its own) | none | n/a |
| `openai-admin-key` | yes (guessed selectors) | `generic-verify` after the create click | no |
| `openai-api-key` | shares the sign-in with `openai-admin-key` (same host; no form of its own) | none | n/a |
| `grafana-cloud-access-policy` | yes (guessed selectors) | `generic-verify` after the create click | no |
| `revenuecat-secret-api-key` | yes (guessed selectors) | `generic-verify` after *Generate* | no |
| `supabase-access-token` | yes (guessed selectors) | `generic-verify` after *Create token* | no |
| `vesselapi-api-key` | yes (`mfa` block added, Cognito field names guessed) | `generic-verify` after *Generate API Key* | no |
| `peecho-api-keys` | yes (`mfa` block added, guessed selectors; no one-time-code step was ever seen) | none (the recipe only reads) | no |
