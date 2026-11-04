# Developing integrations

For people who add a provider to secret-desk. If you only use the portal, you do not need this page. The portal shows the
state of the browser and its recipes under *Settings*, *Developer*.

Read first: [RECIPES.md](RECIPES.md) (the recipe format), [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md) (the design),
[PROVIDERS.md](PROVIDERS.md) (what exists) and [SECURITY-MODEL.md](SECURITY-MODEL.md). The rule that overrides everything
below: **a secret value must never reach a log, report, response, error message, screenshot, fixture or commit.**

## 1. Which parts does a provider need?

A provider is up to four separate things. Most need one or two.

| Part | Where | Use it when |
|---|---|---|
| **Provider module** | `packages/providers/src/<name>.ts`, registered in `packages/providers/src/index.ts` | The provider has an API that creates, checks and revokes a value. The module implements `issue`, `verify`, `revoke`, optionally `discover` and `preflight`. Its connection (the key the portal uses for the API) gets a guide in `packages/runtime/src/connection-guides.ts`. |
| **Recipe** | `recipes/<id>.yaml` | The value exists only in the provider's web interface. A recipe is data: a list of steps the browser walks through. It becomes the provider `<id>-browser`. See [RECIPES.md](RECIPES.md). |
| **Facade descriptor** | `FACADES` in `packages/runtime/src/facade.ts` | The portal itself needs a key from the provider, and the provider offers none without a user account (RevenueCat, Stripe). The facade signs in through the remote browser, creates that key with a recipe, stores it as the connection and tests it. It needs a recipe with `login.form`. |
| **Vendor catalog entry** | `packages/core/src/vendors.ts` | Always, for a provider that should be a card on *Integrations*. It says which connections, provider definitions and recipes belong to the card, and its category. |

A provider with an API: module + connection guide + vendor entry. A provider without an API where a human
copies the value: recipe + vendor entry. A provider like Stripe: recipe (with `login.form`) + facade descriptor +
vendor entry (the vendor id equals the facade id).

For the vendor entry also add:

- the purpose text `vendor.<id>.purpose` to `apps/desk/src/messages/providers.de.ts` and `providers.en.ts` (a test fails
  without it);
- the logo: the slug of the `simple-icons` package in `icon` (or `null` for a monogram), then `pnpm icons` (and
  `pnpm icons:check` to verify the bundle);
- a test in `packages/core/test/vendors.test.ts` if you add a rule, not only data.

## 2. Explore the page with the remote browser

> The remote browser and its viewer exist so you can **write recipes**. A person who connects a provider never leaves the
> portal: the sign-in runs through the recipe's script, and email, password, codes and approvals are handled in the portal.

You need a browser that is signed in. The Docker setup runs one next to the portal ([DOCKER.md](DOCKER.md#browser-on-the-pi));
on a desktop `secret-desk browser run` opens a local Chrome.

1. Open the browser window: *Settings*, *Developer*, *Open browser*. The viewer is a tool for **recipe authors** only; it is
   not part of the normal portal (provider cards and the connect dialog never send anyone there). You see the
   Chromium that secret-desk drives (the noVNC window). It is a normal Chromium; open its developer tools there.
2. Sign in to the provider yourself, including 2FA. The session stays in the browser's profile. Never type a password
   into a recipe, a chat or a file.
3. Walk through the task by hand once and write down every page address and every control. For each control find the
   **accessible role and name** (the developer tools' accessibility tab shows them). Prefer `role` + `name`, then `label`,
   then `text`; use `css` last, because it breaks with every redesign.
4. Note what appears when: a dialog after a click, a value shown only once, a truncated value that is complete in an
   attribute (see `capture.token.attribute`), a row you must find by the entry's name.
5. Note which element shows the value, for `capture.token.find` and for `mask`.
6. Use a **throwaway account or sandbox** wherever the provider has one, and only create things you delete again.

Do not try to be clever around bot checks. No stealth plugins, no CAPTCHA services: a CAPTCHA or a code is solved by a
human in the window.

## 3. Dry-run a recipe

A dry run walks the recipe up to, but not including, the step marked `createsToken: true`. Nothing is created.

```bash
# desktop, local Chrome
secret-desk browser run my-recipe --dry --recipes ./my-recipes --param projectId=proj1a2b3c --out ./evidence-probe

# remote browser (the sidecar's DevTools endpoint; never expose this port)
secret-desk browser run my-recipe --dry --recipes ./my-recipes --cdp http://browser:9222 --param k=v
```

Without a global install, run `node packages/cli/dist/bin.js browser run ...` from a built checkout (`pnpm install && pnpm build`).

- `--param key=value` (repeatable) sets the parameters the recipe declares under `params`. A missing required one aborts
  before the browser opens.
- `--out <dir>` writes the evidence screenshots as PNG files, so you can check that the value is masked.
- `secret-desk browser doctor` first: it finds Chrome (or asks the remote endpoint for its version), loads and validates
  every recipe and prints each `# STATUS` comment.
- `automation.slowMoMs: 150` in the configuration slows every action while you watch.

Fix the recipe, dry-run again, repeat until the run reaches the creating click without a failure.

## 4. Run one entry for real

A full run creates a value at the provider. Do it on a **throwaway** entry in a throwaway repository, with the provider in
sandbox or on an account you can clean up.

```bash
secret-desk renew <secret-id> --config ./secret-desk.config.yaml --dry-run   # plan only, nothing created
secret-desk renew <secret-id> --config ./secret-desk.config.yaml             # creates, verifies, asks, then writes
```

`renew` asks you to confirm each item of the review report before anything is written to GitHub; only `--yes` skips the
questions, so use it only for a throwaway entry. Not confirmed means the new value is discarded again.

### Inside the Docker container

The CLI is in the image. Use the configuration inside the volume:

```bash
docker compose exec secret-desk node /app/packages/cli/dist/bin.js browser doctor
docker compose exec secret-desk node /app/packages/cli/dist/bin.js renew <secret-id> --config /data/config/secret-desk.config.yaml
```

(`docker exec -it <container> sh -c 'cd /app && node packages/cli/dist/bin.js <command> --config /data/config/secret-desk.config.yaml'`
is the same without compose.) The remote browser is reached through `SECRET_DESK_BROWSER_CDP`, which the compose file already
sets. `--dry` works the same way with `--cdp` or that variable.

### Throwaway-token probes and cleanup

- Give probe entries a name that says so (`probe-<recipe>-<date>`), a short expiry and the smallest permissions.
- After every full run check at the provider that the token you created exists exactly once, that the old one is gone
  (when the recipe revokes) and **delete the probe token**. A failed run names the token it may have created in its
  message ("a token named ... may already exist"); delete it by hand.
- Never paste a created value into a chat, an issue or a pull request, and never take a screenshot of one. Compare by
  fingerprint or by the provider's own list.

## 5. Masking and the status comment

- Put every element that shows a value into `mask`. Evidence images are taken **before** the value becomes visible, or with
  the masked regions. Check the PNGs from `--out` before you trust them.
- The first line of every recipe is `# STATUS: ...`. It says honestly what was checked against the live page, on which
  date, and what was not (for example *full run checked on 2026-11-03 with owner You; service account not checked*). Update
  it in the same pull request as the change; `browser doctor` and the portal show it. A test checks only the format
  (`# STATUS:` followed by text). The bundled recipes' comments are in German; keep the language of the file you edit.
- Mark parts of a recipe you did not verify with a `# STATUS:` comment next to them, as `login.form` in the bundled
  recipes does.

## 6. Fail-closed rules

These are not options; a recipe or provider that bends them is not merged.

- The browser must be on the recipe's `host` (or `allowHosts`) before every action and before a value is read. A `goto` to a
  foreign host is rejected when the recipe loads.
- Any unexpected state aborts: element missing, wrong page, timeout, an option that does not exist. Nothing is written to
  GitHub then. `select` never guesses.
- Exactly the click that creates something carries `createsToken: true`. A dry run stops right before it.
- Only one browser run at a time (one profile, one window). A second one is refused with "a browser run is already in
  progress"; the portal queues *Check sign-in* so this does not happen from a click.
- A recipe never contains a token, password or code. The guided sign-in types the credentials the human entered for that run,
  only on the recipe's hosts, and wipes them afterwards.
- Error text is redacted and never contains page content or a value.
- Agents never start a browser run without a human approval.

## 7. Tests

Tests never use a real value, the network, a real browser profile or the home folder. Inject `fetch`, `env`, a temporary
directory and the fake driver.

- **Recipes:** `FakeDriver` (`packages/automation/src/fake-driver.ts`) is a scripted browser without a browser. Give it the
  elements that are visible (`describeSelector` text such as `button "Generate"`), texts and attributes to read, and an `on`
  callback that reacts to `goto`/`click`/`fill` by changing its state (a click makes the key list appear). Look at
  `packages/automation/test/revenuecat.test.ts` for a complete example and `helpers.ts` for `sampleRecipe`. Test: the
  happy path reads the value, a wrong page aborts, a foreign host aborts, the value is masked in the screenshots, and
  the made-up value appears in no error.
- **Providers with an API:** pass a `fetch` mock; see `packages/providers/test/resend.test.ts`. Test `issue`, `verify`, `revoke`,
  the idempotent revoke and the error paths, and assert that no value is in any error or finding.
- **Facades:** `packages/runtime/test/facade.test.ts` and `apps/desk/test/router-facade.test.ts` run a whole sign-in against a fake
  site. Add the new descriptor to the same patterns.
- **Interface:** every new UI text goes into `apps/desk/src/messages/*.de.ts` and `*.en.ts` (a test requires both languages
  and the same placeholders); new backend messages get an English entry in `packages/runtime/src/i18n-en.ts`.
- **Every new response, report and error message** gets a test asserting that no value and no connection token is in it.

```bash
pnpm --filter @secret-desk/automation test      # recipes and the fake driver
pnpm --filter @secret-desk/providers test
pnpm --filter @secret-desk/runtime test
pnpm run verify                                  # build + typecheck + all tests
```

## 8. Checklist before a pull request

- [ ] Parts chosen on purpose (section 1): module, recipe, facade, vendor entry; the vendor entry lists the new ids.
- [ ] Naming: identifiers, file names, routes, config keys, error codes and test names are English. Comments and docs are English.
- [ ] Dry run reaches the creating click on the live page; a throwaway full run worked, the probe token is deleted.
- [ ] `# STATUS:` updated and honest; `docs/ROADMAP.md` and the status tables in `docs/RECIPES.md` / `docs/PROVIDERS.md` match.
- [ ] Mask set for every element that shows a value; evidence PNGs checked.
- [ ] Fail-closed rules kept (section 6); `createsToken` on exactly the creating click.
- [ ] Tests with the fake driver or a `fetch` mock; no real value, no network; a no-leak assertion for new output.
- [ ] UI texts in both languages; vendor purpose text and logo (`pnpm icons`).
- [ ] `pnpm run verify` exits 0 (check the exit code, not the last line of the output).
- [ ] `CHANGELOG.md` under *Unreleased*; no real account names, hosts or values in code, tests, docs or the pull request text. Use neutral examples such as `acme-app`.
- [ ] Checked the provider's terms of use on automating its interface (a team decision per provider).

## Sign-in methods and single sign-on

A recipe's `login.form` is its `email` method. A provider that also offers "Sign in with Apple / Google / Microsoft /
GitHub" declares that in `login.methods`; the identity-provider part is **built in** (`packages/automation/src/idp.ts`),
so the recipe declares only the provider-side buttons:

```yaml
login:
  expect: { url: "^https://platform\\.openai\\.com/(settings|home)" }
  methods:
    - id: apple                      # google | apple | microsoft | github (email is login.form)
      steps:                         # click and waitFor only, no variables, on the provider's own sign-in page
        - waitFor: { visible: { role: button, name: "Continue with Apple" } }
        - click: { role: button, name: "Continue with Apple" }
  form: { ... }                      # needed for any methods: its `start` page and the email method
```

What the built-in flow does once the browser stands on the identity provider: types the identity-provider account and
password the human entered in the portal (only on that provider's hosts), asks the portal for the two-factor code,
shows "Approve the sign-in on your device ..." (with the number the page shows, if any), takes the code fallback of a
passkey prompt, clicks "trust this browser" where there is one, and hands back to the provider. GitHub's first-use
**OAuth consent** ("Authorize ...") is never clicked silently: the portal shows the requested access and the human confirms
or declines there (`POST facades/:id/confirm`). A CAPTCHA fails the run with a message and *Try again*.

Hosts: credentials are typed only on the recipe's `host`/`allowHosts` (method `email`) or on the identity provider's
hosts (Apple `appleid.apple.com`, `idmsa.apple.com`; Google `accounts.google.com`; Microsoft `login.microsoftonline.com`,
`login.live.com`; GitHub `github.com`). Add the provider's own sign-in host (for example an `auth.` host, or `*.auth.us-east-1.amazoncognito.com` for a hosted Cognito login page, whose tenant name varies) to `allowHosts`
when it serves the hand-over. Every identity-provider selector and text is **not verified** until a live run; verify them
with the viewer (above), never by typing real credentials into a recipe.

## Confirmations in the middle of a recipe

When a provider asks to confirm access while a recipe runs (GitHub *Confirm access*), do not use `pause` (it sends the human to the browser window). Use `confirmAccess` with a built-in flow; the portal answers the questions. To add a flow, add it to `SUDO_FLOWS` in `packages/automation/src/sudo.ts` with its selectors (mark what you did not verify), and test it with the fake driver as in `packages/automation/test/sudo.test.ts`. A recipe run that starts signed out can sign in through the portal on its own open browser with `RunHooks.signIn` (see `packages/runtime/src/team-token.ts`); the recipe needs `login.form`. Sign-in methods per recipe come from a live survey of the provider's sign-in page: only the provider-side button is declared in `login.methods`, everything else stays marked not verified.

