# Writing browser recipes

A **recipe** is a YAML file that tells secret-desk how to create a token in a provider's web interface, for providers that offer no API (GitHub fine-grained tokens, Supabase access tokens, Stripe restricted keys). secret-desk drives a visible Chrome through the form; **you sign in yourself** (password, 2FA, CAPTCHA stay with you). The value is read from the page into memory and then follows the normal [review and confirm flow](ARCHITECTURE.md#the-path-of-a-new-value).

This page is the how-to. The design, principles and implementation status are in [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md). Schema source: [`packages/automation/src/recipe.ts`](../packages/automation/src/recipe.ts).

> **Status of the bundled recipes.** None has been verified against the live provider pages. Each starts with a `# STATUS: nicht gegen die echte Seite geprueft` comment (the bundled recipes' comments are still in German). Do a supervised trial run with a throwaway token first.

## Where recipes live

| Location | Notes |
|---|---|
| `recipes/` in the repository | Bundled. Their ids can never be overridden by other folders. |
| `<inventory folder>/recipes/` | Always read, but only loaded when `automation.allowExternalRecipes: true`. |
| Folders in `automation.recipesDirs` | Same: only with `allowExternalRecipes: true`. |

Each `*.yaml` becomes a provider named `<recipe-id>-browser` ("<label> (Browser)"). Use that id as `provider` of a secret. An invalid recipe never stops secret-desk; it is listed as a problem on **Integrations** and by `secret-desk browser doctor`.

**Recipes are executable browser scripts.** Only load recipes from sources you trust and review them like code.

## Structure

```yaml
# STATUS: <free text, shown by `browser doctor` and in the portal>
id: github-fine-grained-token        # lowercase-with-hyphens
label: GitHub Fine-grained Token
provider: github-fine-grained-token  # optional: provider id the recipe serves, if not the recipe id
host: github.com                     # the only host the browser may be on (plus allowHosts)
allowHosts: []                       # optional: more hosts, "*.example.com" allows subdomains
login:                               # optional
  expect: { url: "^https://github\\.com/settings/" }   # signed in when this holds
  message: Sign in to GitHub (password, 2FA).           # shown while waiting for you
steps: [ ... ]                       # required, at least one; see below
capture:                             # required
  token:
    find: { css: "#new-access-token" }
    pattern: "^(github_pat_[A-Za-z0-9_]+)$"   # value must match, group 1 if present, else abort
    timeoutSeconds: 30                          # default 30, max 600
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
| `role` (+ optional `name`) | ARIA role with accessible name, e.g. `{ role: button, name: "Generate token" }`. `name` belongs only to `role`. |
| `label` | Form field by its label. |
| `text` | Element by visible text. |
| `placeholder` | Field by placeholder. |
| `testid` | `data-testid`. |
| `css` | CSS selector. **Last resort**: it breaks with every redesign. |

Prefer `role`, `label` or `text`.

## Step kinds

Every step has exactly one kind.

| Step | Form | What it does |
|---|---|---|
| `goto` | `goto: "https://github.com/settings/..."` | Opens a page. Must start with `https://` and a **fixed host** (no variable in the host) that is `host` or in `allowHosts`. `http` only for `localhost` and `127.0.0.1`. |
| `fill` | `fill: { <selector>, value: "{{name}}" }` | Types into a field. |
| `select` | `select: { <selector>, value: "30" }` | Chooses an option. If the option does not exist the run aborts instead of guessing. |
| `check` | `check: { <selector>, checked: true }` | Ticks or clears a checkbox (default ticks). |
| `click` | `click: { <selector>, createsToken: true }` | Clicks. **Exactly the click after which something is created at the provider must carry `createsToken: true`**; at least one is required. A dry run stops right before it. |
| `press` | `press: { key: "Enter", <selector>? }` | Presses a key, optionally on an element. |
| `waitFor` | `waitFor: { url \| visible \| text, timeoutSeconds? }` | Waits for a URL (regular expression), a visible selector, or text on the page. Max 3600 s. |
| `pause` | `pause: { human: "Do X in the window", until: <condition> }` | Waits for **you** to do something (shown in the portal) until the condition holds. |
| `screenshot` | `screenshot: form-before` | Saves an evidence image under that name (`[A-Za-z0-9][A-Za-z0-9._-]{0,60}`). Take it **before** the value becomes visible. |

`fill`, `select`, `check`, `click` and `press` can carry `each: repos`: the step then runs once per repository with `{{item}}` set. An empty list aborts before the first click.

A **condition** (for `login.expect`, `waitFor`, `pause.until`) has exactly one of `url` (regular expression against the current address), `visible` (a selector) or `text` (text anywhere on the page).

## Variables

Use `{{name}}` in text. Unknown variables are an error. In `goto`, every value is URL-encoded, except `permissionsQuery` which is already encoded.

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

- There is no step for elements inside a dialog (selectors have no notion of a scope); use `css` until then.
- The Stripe recipe is a scaffold: the permission matrix per resource is not modeled yet.
- Revocation through a recipe (`revoke.steps`) exists in the schema, but the bundled recipes leave revoking to the human.
