# Writing browser recipes

A **recipe** is a YAML file that tells secret-desk how to create a token in a provider's web interface, for providers that offer no API (GitHub fine-grained tokens, Supabase access tokens, Stripe restricted keys). secret-desk drives a visible Chrome through the form; **you sign in yourself** (password, 2FA, CAPTCHA stay with you). The value is read from the page into memory and then follows the normal [review and confirm flow](ARCHITECTURE.md#the-path-of-a-new-value).

This page is the how-to. To add a whole provider, start with [DEVELOPING-INTEGRATIONS.md](DEVELOPING-INTEGRATIONS.md). The design, principles and implementation status are in [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md). Schema source: [`packages/automation/src/recipe.ts`](../packages/automation/src/recipe.ts).

> **Status of the bundled recipes.** `peecho-api-keys` (read-only) was read in full live on 2026-11-04 on both portals with an existing sign-in; its sign-in form is not verified. Four ran end to end against the live provider pages on 2026-11-03: `supabase-access-token`, `vesselapi-api-key`, `openai-api-key` (owner *You* only) and `revenuecat-secret-api-key` (the sign-in form steps after the email are still unchecked). `stripe-restricted-key` was checked in the sandbox but not run end to end, and `github-fine-grained-token` is not verified. Each recipe starts with a `# STATUS:` comment that says what is verified (the bundled recipes' comments are in German). Do a supervised trial run with a throwaway token first.

## Bundled recipes

| Recipe | Creates | Status |
|---|---|---|
| `github-fine-grained-token` | GitHub fine-grained personal access token (also used for the team token, see [TEAM.md](TEAM.md)) | form, repository picker and confirmation dialog read live 2026-11-05 (organization owner); the token display after creation not verified |
| `supabase-access-token` | Supabase access token | full run verified live 2026-11-03 (five scoped tokens) |
| `openai-admin-key` | OpenAI organization Admin API key (`sk-admin-...`) on `settings/organization/admin-keys`; used by the OpenAI facade, can revoke; includes the sign-in form | key creation verified live 2026-11-03 with the signed-in browser (admin key created, stored, tested: projects readable); the sign-in form, the single-sign-on methods (email, Google, Apple, Microsoft) and revoke are not verified |
| `grafana-cloud-access-policy` | Grafana Cloud access policy with the scopes the portal needs and a token for it (`glc_...`) on grafana.com; parameter `expiry` (`30 days`, `90 days`, `No expiry`; the facade asks for 90 days); used by the Grafana facade, can revoke; includes the sign-in form and the Google, GitHub and Microsoft buttons | **nothing verified** (every selector is a guess from memory; the status comment says so) |
| `anthropic-admin-key` | Optional Anthropic organization Admin API key (`sk-ant-admin...`) on `settings/admin-keys`; used by the Anthropic facade; includes a passwordless email sign-in (one-time code) and Google. German and English wording. On an individual organization the page has no create button: the recipe ends as `unsupported` and the facade finishes as ready | email sign-in with one-time code verified live 2026-11-04 (German Console, individual organization); the missing create button of an individual organization verified by probe; admin key creation in a real organization, the Google sign-in and revoke not verified |
| `anthropic-api-key` | Anthropic API key in a workspace (optional parameter `workspace`, empty = Default workspace; expiry from `days`, 30 by default); works without an admin key; German and English wording; revoke goes through the Admin API when the `anthropic` connection exists, else this recipe's browser steps | sign-in verified live 2026-11-04; the key dialog fields (name, expiry, workspace, submit) verified by a probe that created no key; capture of the key, other expiries, other workspaces and revoke not verified |
| `openai-api-key` | OpenAI API key (owner, expiry, permission level); can revoke | full run verified live 2026-11-03 with owner *You* (one key); *Service account* and the project choice not verified |
| `vesselapi-api-key` | VesselAPI API key (30, 60 or 90 days on the free plan); can delete the old key | full run verified live 2026-11-03 (two keys) |
| `stripe-restricted-key` | Stripe restricted key for one account and mode; parameters `account` (`acct_...`), `mode` (`sandbox` or `live`), `preset` (`webhooks`: *Webhook Endpoints, Event Destinations* Write, or `full-except-sensitive`); can revoke (*Expire key*) | sandbox wizard, result view and expiry checked 2026-11-02/03 with a throwaway key; full run, sign-in form and live mode not verified |
| `peecho-api-keys` | **Reads** (`kind: read`) the Peecho Merchant API Key and Secret key from the dashboard of the live or the test portal (parameter `portal`); creates and revokes nothing | full read verified live 2026-11-04 on both portals with an existing sign-in (application settings, tab *API*); the sign-in form is not verified |
| `revenuecat-secret-api-key` | RevenueCat secret API key (V2) with one access level per section; parameters `projectId` and `projectConfiguration`, `customerInformation`, `chartsMetrics`, `audiences`, `iam` (each `No access`, `Read only` or `Read & write`, default `No access`); can revoke | form and key list checked 2026-11-02; full run verified live 2026-11-03 (two secret keys and one integration key via the guided sign-in); password, one-time code, approval and CAPTCHA steps of the sign-in form not verified (the browser was already signed in) |

## Reading values instead of creating them (`kind: read`)

Some providers issue a fixed key once per account and offer no way to create or replace it in the dashboard (Peecho shows the *Merchant API Key* and the *Secret key* as plain text, with no button). A recipe with `kind: read` only **reads** such values:

- No step creates anything: `createsToken` is an error in a read recipe, and so are `revoke`, `capture.token`, `capture.externalId` and `capture.expires`.
- `capture.values` names one or two values (`^[a-z][A-Za-z0-9]{0,30}$`), each with a selector and a **required** `pattern`. A value that cannot be found, does not match its pattern, is empty or equals the other value ends the run (fail closed); nothing is written. Errors never contain page content or a value.
- The entry says which value it takes: `capture.pick` names a recipe parameter that is required, has no default and whose `options` are exactly the value names. With two values, `capture.companion` names an optional parameter holding the inventory id of the entry that receives the **other** value of the same read (the companion mechanism of the Cloudflare Access provider: one confirmation writes both entries). Without a companion only the picked value is written.
- `capture.fallback` (optional) is a second page with its own `steps` and `values` (same value names). The first selectors are tried first; if one is not visible within its `timeoutSeconds`, the fallback steps run and the fallback values are read. A value that was found but has the wrong shape is **not** retried on the fallback.
- The provider is marked `readOnly`. The portal labels such entries *read from the provider*, offers *Read again* instead of *Generate new value* (renewal means reading again, for example after the provider changed the key on request), and shows *does not expire · read on <date>* for entries with `expiry: none`. There is no call to test the value at the provider, so the review says *Not checked against <provider>*: only the shape was checked.

Example entries (ids, names and the repository are made up):

```yaml
secrets:
  - id: print-api-key-test
    name: PRINT_API_KEY
    stage: test
    service: peecho
    provider: peecho-api-keys-browser
    expiry: none            # the keys do not expire; verifiedAt is the date of the last read
    params: { portal: test, value: merchantKey, companionEntry: print-secret-key-test }
    places: [{ repo: acme-app, scope: repository }]
  - id: print-secret-key-test
    name: PRINT_SECRET_KEY
    stage: test
    service: peecho
    provider: peecho-api-keys-browser
    expiry: none
    params: { portal: test, value: secretKey }
    places: [{ repo: acme-app, scope: repository }]
```

Reading `print-api-key-test` fills both entries from one run and one confirmation; reading `print-secret-key-test` alone writes only the secret key. `portal` is `live` or `test`: the two portals have separate accounts and separate keys, so keep one pair of entries per portal. The dashboard login (e-mail and password) stays a manual entry.

The Peecho recipe has two portals (`hostBy: portal`, see [Several hosts](#several-hosts-hostby-and-hosts)): the guided sign-in form is declared once with `{{host}}` and works for both, and each portal has its own sign-in line, check and sign-in memory. The form is not verified live.

## Where recipes live

| Location | Notes |
|---|---|
| `recipes/` in the repository | Bundled. Their ids can never be overridden by other folders. |
| `<inventory folder>/recipes/` | Always read, but only loaded when `automation.allowExternalRecipes: true`. |
| Folders in `automation.recipesDirs` | Same: only with `allowExternalRecipes: true`. |

Each `*.yaml` becomes a provider named `<recipe-id>-browser` ("<label> (Browser)"). Use that id as `provider` of a secret. An invalid recipe never stops secret-desk; it is listed as a problem under *Settings*, *Developer* and by `secret-desk browser doctor`.

**Recipes are executable browser scripts.** Only load recipes from sources you trust and review them like code.

## Structure

```yaml
# STATUS: <free text, shown by `browser doctor` and in the portal>
id: github-fine-grained-token        # lowercase-with-hyphens
label: GitHub Fine-grained Token
provider: github-fine-grained-token  # optional: provider id the recipe serves, if not the recipe id
host: github.com                     # the only host the browser may be on (plus allowHosts)
allowHosts: []                       # optional: more hosts, "*.example.com" allows subdomains (also for typing a sign-in on a hosted login page)
                                     # (several portals with separate accounts: hostBy + hosts instead of host, see "Several hosts")
params: []                           # optional: per-entry parameters, see "Parameters" below
login:                               # optional
  expect: { url: "^https://github\\.com/settings/" }   # signed in when this holds
  message: Sign in to GitHub (password, 2FA).           # shown while waiting for you
kind: create                         # optional: create (default) or read, see "Reading values instead of creating them"
steps: [ ... ]                       # required, at least one; see below
capture:                             # required
  token:
    find: { css: "#new-access-token" }
    pattern: "^(github_pat_[A-Za-z0-9_]+)$"   # value must match, group 1 if present, else abort
    timeoutSeconds: 30                          # default 30, max 600
  # token.attribute: read this attribute of the element instead of its text, for a key the page shows truncated but carries whole
  #   (Stripe: `find: { css: '[data-text^="rk_"]' }`, `attribute: data-text`)
  # token.alternatives: other places the token may show up, each `{ find, attribute? }` (a page with two variants). The first of
  #   `find` and the alternatives that is visible wins; `pattern` applies to all; the receipt masks all of them.
  externalId: { from: name }         # for later revocation: { from: name|days|date|secretId } or { find: <selector>, pattern? }
  expires: { from: days }            # optional
mask:                                # regions hidden in every later screenshot
  - { css: "#new-access-token" }
revoke:                              # optional; otherwise the human removes the old token by hand
  steps: [ ... ]
```

Unknown keys anywhere are an error (the schema is strict).

## Selectors

A selector finds an element. Give **exactly one** of:

| Field | Meaning |
|---|---|
| `role` (+ optional `name`, `exact`) | ARIA role with accessible name, e.g. `{ role: button, name: "Generate token" }`. `name` belongs only to `role`. `exact: true` requires the whole name to match. |
| `label` (+ optional `exact`) | Form field by its label. `exact: true` requires the whole label to match (needed when a page search box also contains the word). |
| `text` | Element by visible text. |
| `placeholder` | Field by placeholder. |
| `testid` | `data-testid`. |
| `css` | CSS selector. **Last resort**: it breaks with every redesign. |

Two modifiers work with any of these:

- `first: true`: the element may match more than once (a button that appears in the header and in the empty state); take the first match instead of failing. Without it, an ambiguous match fails visibly.
- **Text in more than one interface language.** `name`, `label`, `text` and `placeholder` are plain texts, or a regular expression written as `/pattern/flags` (flags `i`, `m`, `s`, `u`; any other letters after the last slash make it a plain text). A site that renders in the account language is covered by listing both wordings: `name: '/^(Create key|Schlüssel erstellen)$/i'`. `exact` applies to plain texts only. An invalid pattern is rejected when the recipe loads. Prefer a placeholder, a type or the structure when the page has one: they do not depend on the language.

Prefer `role`, `label` or `text`.

## Step kinds

Every step has exactly one kind.

| Step | Form | What it does |
|---|---|---|
| `follow` | `follow: { css: "a.account-link" }` | Reads the `href` of the element and opens it under the same host rules as `goto` (relative links are resolved against the current page). Fails closed when the element or its address is missing or the address leaves `host`/`allowHosts`. For links whose address differs per account. |
| `goto` | `goto: "https://github.com/settings/..."` | Opens a page. Must start with `https://` and a **fixed host** (no variable in the host) that is `host` or in `allowHosts`. `http` only for `localhost` and `127.0.0.1`. |
| `fill` | `fill: { <selector>, value: "{{name}}" }` | Types into a field. |
| `select` | `select: { <selector>, value: "30" }` | Chooses an option. If the option does not exist the run aborts instead of guessing. |
| `check` | `check: { <selector>, checked: true }` | Ticks or clears a checkbox (default ticks). |
| `click` | `click: { <selector>, createsToken: true }` | Clicks. **Exactly the click after which something is created at the provider must carry `createsToken: true`**; at least one is required. A dry run stops right before it. With `optional: true` (and `timeoutSeconds`, default 3, max 30) the click is made only if the element shows up in time and can be acted on; otherwise the step is skipped (an element that is there but cannot be clicked, for example because it is covered, counts as "nothing to do"; an abort or a page outside the recipe's hosts still ends the run). For things that may or may not be there, such as a cookie banner (`{ role: button, name: "Reject all", exact: true, optional: true }`, never "Accept"). Not combinable with `createsToken`. |
| `press` | `press: { key: "Enter", <selector>? }` | Presses a key, optionally on an element. |
| `waitFor` | `waitFor: { url \| visible \| hidden \| text \| all \| any, timeoutSeconds? }` | Waits for a URL (regular expression), a visible selector, or text on the page. `any: [<condition>, ...]` (2 to 5) holds as soon as one of them holds: for a page that comes in two variants. Max 3600 s. |
| `set` | `set: { var: variant, value: wizard }` | Sets a variable of this run for the `when` of later steps (for example which variant of a page was found). The name must be new: a parameter or a fixed variable cannot be overwritten. The caller's variables are not touched. |
| `fail` | `fail: "Message"` | Ends the run with this message (a variant the recipe does not support). Put it before the click that creates something, so nothing exists yet. |
| `pause` | `pause: { human: "Do X in the window", until: <condition> }` | Waits for **you** to do something (shown in the portal) until the condition holds. |
| `confirmAccess` | `confirmAccess: { flow: github-sudo \| stripe-verify \| generic-verify, until: <condition>, timeoutSeconds? }` | The provider may ask to confirm access or verify the identity here (GitHub *Confirm access*, Stripe *Verification required*, or any password or code page with `generic-verify`). Does nothing when `until` already holds; when the confirmation page shows, the portal asks the human how to confirm and the built-in flow clicks and types (see [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md#confirming-access-confirmaccess)). A run without a portal to answer in waits for the human in the browser window like `pause`. Not allowed in `login.form`. |
| `screenshot` | `screenshot: form-before` | Saves an evidence image under that name (`[A-Za-z0-9][A-Za-z0-9._-]{0,60}`). Take it **before** the value becomes visible. |

Every step can carry a `when`: it runs only if the condition holds **when the step is reached**, otherwise it is skipped. Five forms:

- `when: { var: <variable>, equals: <value> }`: the variable (a recipe parameter, a fixed variable or one set by a `set` step; unset reads as `""`) has exactly that value. This is how one recipe serves several modes, for example a sandbox and a live address (`stripe-restricted-key` picks its `goto` by `mode`).
- `when: { visible: <selector>, timeoutSeconds? }`: an element matching the selector is visible on the page now. By default the page is looked at once; with `timeoutSeconds` (max 120) the step waits that long for the element and counts a missing element as "no". The selector may use `{{variables}}`.
- `when: { var: <variable>, notEquals: <value> }`: the variable differs from the value (give exactly one of `equals` and `notEquals`). For a parameter that is not empty, or a value other than the dialog's default (`anthropic-api-key` clicks the expiry option only when `days` is not 30).
- `when: { absent: <selector>, timeoutSeconds? }`: no element matching the selector shows up. It waits up to `timeoutSeconds` (max 120, default 0 = look once) for the element and holds when it never appears. This is how a page that lacks a feature is detected.
- `when: { all: [<var form>, <visible form>, <absent form>, ...] }`: every listed condition holds (2 to 5, evaluated in order).

A `fail` step may carry `unsupported: true`: the account or page cannot do what the recipe needs, which is not a broken recipe. The run then ends with the kind `unsupported` instead of `step`, and a caller that can live without the result (the Anthropic facade without an admin key) treats it as "nothing to do". `anthropic-admin-key` uses `fail` with `when: { absent: <create button> }` right after opening the Admin keys page.

Together with `waitFor.any` and `set`, this is how one recipe serves a page that comes in two variants: wait for either heading, `set` a variable from the one that is visible, and give each variant's steps `when: { var: variant, equals: ... }` (`stripe-restricted-key` does this for the key wizard and the older single-page form, and refuses the full-access preset on the single page with a `fail` step). A dry run stops at the first `createsToken` step whose `when` holds. Every variable must be known (a parameter, a fixed variable or the target of a `set`); `when`, `set` and `fail` are not allowed in `login.form`.

`fill`, `select`, `check`, `click` and `press` can carry `each: repos`: the step then runs once per repository with `{{item}}` set. An empty list aborts before the first click.

A **condition** (for `login.expect`, `waitFor`, `pause.until`) has exactly one of `url` (regular expression against the current address), `visible` (a selector), `hidden` (a selector; holds once no matching element is visible, for example a table row after deleting it), `text` (text anywhere on the page) or `all` (a list of two to six of the former; every one must hold). `all` is for a sign-in check where the address alone is not enough: the Anthropic Console keeps `/settings/keys` in the address while it shows its sign-in screen, so `login.expect` is `all: [ { url: ... }, { hidden: <"Continue with email" button> }, { hidden: <"Continue with Google" button> } ]`. `url` is a regular expression and is not rendered: it cannot contain `{{variables}}`.

## Parameters

Providers with several projects or accounts need a value per entry (a project id, an access level). A recipe declares them under `params`; the value comes from `params` of the inventory entry.

```yaml
params:
  - key: projectId                 # ^[a-z][A-Za-z0-9]{0,30}$, must not be a fixed variable such as name or owner
    label: RevenueCat-Projekt-ID   # German label in the portal
    labelEn: RevenueCat project ID # optional English label (default: label)
    pattern: "^[a-z0-9]{6,20}$"    # optional: the value must match (anchor it with ^ and $)
    help: Part of the dashboard address after /projects/.   # optional
  - key: iam
    label: IAM
    options: ["No access", "Read only", "Read & write"]   # optional: fixed choices
    default: No access                                     # optional: used when the entry has no value
    required: true                                         # default true; a parameter with a default is never reported missing
```

- Every declared key is a template variable `{{key}}` in steps, `capture` selectors, `mask` and `revoke`. In `goto` the value is URL-encoded like every other variable.
- Values are read from `secret.params[key]`. Strings are trimmed; numbers are stringified; anything else counts as missing.
- **Fail closed before the browser opens.** A missing required value, a value outside `options` or one that does not match `pattern` aborts with a message that names the key (never the value). This happens in the provider before the browser is opened, again in the runner, and in `browser run --dry`.
- The browser provider exposes the parameters as parameter specs (`options` as fixed choices, `pattern` as a pattern), so the portal's parameter card and the `params_invalid` check work like for API providers.
- `browser run --dry` takes them as `--param key=value` (repeatable).
- A recipe that reads `params.owner` or `params.permissions` through the fixed variables (the GitHub recipe) does not need to declare them.

## Guided sign-in (`login.form`)

`passwordless: true` marks a provider that signs in by email code (`anthropic-admin-key`): the form fills only `{{login.username}}` (and must not use `{{login.password}}`), the portal asks for the emailed code through `mfa`, and the sign-in dialog shows no password field for the email method.

Optional, next to `login.expect` (which doubles as the success condition). Used by the provider facade; the human types email and password for one run. `login.form` is the `email` method; `login.methods` adds single sign-on (`google`, `apple`, `microsoft`, `github`) by declaring only the provider-side button steps, the identity-provider flow is built in: [DEVELOPING-INTEGRATIONS.md](DEVELOPING-INTEGRATIONS.md#sign-in-methods-and-single-sign-on).

```yaml
login:
  expect: { url: "^https://app\\.example\\.com/projects/[^/]+/" }
  form:
    start: "https://app.example.com/login"    # on host; no variables (only {{host}}, see "Several hosts")
    home: "https://app.example.com/"          # optional, used by "Check sign-in"
    steps:                                     # only fill, click, waitFor
      - fill: { css: 'input[name="email"]', value: "{{login.username}}" }
      - click: { role: button, name: "Log in" }
      - waitFor: { visible: { css: 'input[type="password"]' } }
      - fill: { css: 'input[type="password"]', value: "{{login.password}}" }
      - click: { css: 'button[type="submit"]' }
    mfa: { detect: { visible: { css: "#code" } }, field: { css: "#code" }, submit: { css: "#verify" } }
    approval: { detect: { text: "Check your email" }, message: "...", messageEn: "..." }
    captcha: { detect: { visible: { css: "#challenge" } } }
    failure:
      - { detect: { text: "Incorrect password" }, message: "...", messageEn: "..." }
```

`{{login.username}}` and `{{login.password}}` are valid only in the `value` of a `fill` step here (both must be used); selectors, conditions and messages cannot contain variables, and no other part of a recipe knows them. Priority while waiting: success, `failure`, `mfa`, `approval`, `captcha`. Mark unverified parts with `# STATUS:`.

### Several hosts (`hostBy` and `hosts`)

A provider can run separate portals with separate accounts, for example a live and a test site. Instead of `host` the recipe then declares which parameter picks the portal and the host of each value (exactly one of the two forms):

```yaml
hostBy: portal
hosts: { live: app.example.com, test: sandbox.example.com }
params:
  - { key: portal, label: Portal, options: ["live", "test"] }   # exactly the keys of hosts
login:
  expect: { url: "^https://{{host}}/home" }
  form:
    start: "https://{{host}}/login"
    home: "https://{{host}}/"
```

Everything that depends on the host follows the **portal of the run or the entry**: the allowlist (a run for `live` may not leave `app.example.com`, plus `allowHosts`), the sign-in check, the guided sign-in (credentials are typed only at that host), the sign-in memory and its lifetime measurement, and the renewal warning of an entry (the host of the entry's `portal`). `{{host}}` is the portal's host and is allowed in `login.form.start`, `login.form.home` and `login.expect` only (in `expect.url` it is escaped for the regular expression). `goto` addresses stay fixed hosts and may name any host of `hosts`; pick one with `when` (a `goto` to the other portal is skipped, and one that is reached anyway is stopped by the allowlist). The scheduled sign-in checks look at every host of such a recipe on its own, and the provider card shows one sign-in line per host ("Print Co live: signed in · checked 2 hours ago", "Print Co test: sign-in needed") with a *Check live* / *Check test* button each. The sign-in dialog of a guided-sign-in provider takes the portal from the recipe parameter it asks for (or `host` in the request body).

## Variables

Use `{{name}}` in text. Variables are also available in `capture.token.find`, `capture.externalId.find` and `mask` selectors, which is how a selector names the entry's own row. Unknown variables are an error. In `goto`, every value is URL-encoded, except `permissionsQuery` which is already encoded.

| Variable | Content |
|---|---|
| `name` | Name for the new token (secret id plus date) |
| `owner` | `params.owner` of the secret, else its `owner` |
| `days` | Lifetime from `ttlDays` (1 to 366, default 30) |
| `date` | Today |
| `description` | Description for the token |
| `repos` | Repositories of the secret's places, comma-separated |
| `permissions` | `params.permissions` as `key=value,key=value` |
| `permissionsQuery` | The same, URL-encoded as a query string |
| `stage` | The secret's stage id |
| `secretId` | The secret's id |
| `externalId` | Only in `revoke` steps: the id captured earlier |
| `item` | Only in steps with `each` |
| _declared `params`_ | One variable per key, see [Parameters](#parameters) |

## Safety rules

- **Host check.** Before every action (and before reading the token) the browser's current host must be `host` or in `allowHosts`; otherwise the run aborts. A static check at load time rejects a `goto` to a foreign host.
- **Fail closed.** Any unexpected state (element missing, wrong page, timeout) aborts; nothing is written to GitHub. If a token was already created, its name is shown so you can delete it at the provider.
- **No secrets in the recipe.** Never put a token, password or 2FA code in a recipe. secret-desk never types credentials. Sign-in is yours.
- **Mask the value.** Put the element that shows the token into `mask`, so screenshots never contain it. Evidence images are taken before the value appears, or with masked regions.
- **Error text is redacted** and never contains page content.
- **No circumvention.** No stealth plugins, no CAPTCHA services. If a bot check appears, you complete it in the window.
- Only **one** browser run at a time (one profile, one window).
- Agents can never start a browser run without a human approval, in any stage.

## Testing

1. Validate: `secret-desk browser doctor --recipes ./my-recipes` loads every recipe and prints schema errors as `file.yaml: steps.3.click: ...`, plus each recipe's `# STATUS` comment.
2. Dry run: 

```bash
secret-desk browser run my-recipe --dry --recipes ./my-recipes \
  --name probe-token --owner acme --days 7 --repos acme-app \
  --permissions contents=read,metadata=read --out ./evidence-probe
```

   A Chrome window opens, you sign in, and the run proceeds up to just before the `createsToken` click. **No token is created.** `--out` saves the screenshots as PNG files so you can check masking. Press Ctrl+C to abort.
3. Real run with a **throwaway** token and supervision, from the portal (*Generate new value* on a secret that uses `<recipe>-browser`). Delete the token at the provider afterwards.

For recipes under development, `automation.slowMoMs: 150` slows every action so you can watch.

The package's tests use a fake driver (no browser) and a local replica of a form; run `pnpm --filter @secret-desk/automation test`.

## Contributing a recipe

Recipes are data, not code, so they are maintained by pull request: a web interface changes, the fix is a YAML change. Include in the pull request: the provider and the page you tested against, the date, whether the run was supervised, and update the `# STATUS` comment honestly (for example *checked against the live page on 2026-11-02, supervised*). Do not put real tokens, account names or screenshots of real values in the pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md). Check the provider's terms of use on automating its interface; that is a team decision per provider.

## Limits

- Selectors have no notion of a scope. To find an element inside a row or dialog, use Playwright CSS in `css`, for example `[role=row]:has-text("{{name}}") button[aria-label="Show key"]` or `[role=dialog] button:has-text("Confirm")`. The driver passes `css` to `page.locator()`, so `:has-text()` and `>> nth=0` work.
- The Stripe recipe offers two permission presets (`webhooks`, `full-except-sensitive`), not a free permission list. Its sandbox wizard was checked live on 2026-11-03; the live mode (and a possible password confirmation, which the recipe handles with a `pause`) and the sign-in form are not verified.
- Revocation through a recipe (`revoke.steps`) exists in the schema. `revenuecat-secret-api-key` uses it (More, Revoke, Confirm in the row of the key's name); the other bundled recipes leave revoking to the human.
