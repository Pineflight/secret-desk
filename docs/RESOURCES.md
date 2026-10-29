# Parameters and resources

A token is only useful if it is created for the right thing: the right Cloudflare account, the right Supabase project, the right domain. secret-desk therefore asks every provider which **parameters** an entry needs, helps you pick them from what the connected integration actually has, and checks the choice before anything is issued.

Parameters are configuration (ids, addresses, permission names), never secret values. Everything the portal reads for this is read-only.

## Terms

| Term | Meaning |
|---|---|
| **Parameter** | A setting of an entry under `params` in the inventory, for example `accountId` or `projectRef`. Each provider declares its own list ([table below](#parameters-per-provider)). |
| **Resource** | The thing a parameter points to at the provider: an account, a project, a zone, a domain, a service account. |
| **Discovery** | The portal reads the resources of the connected integration (read-only) so you can choose from a list instead of typing an id. A parameter with a list has a *Choose from the list* mode and an *Enter the value by hand* mode. |
| **Suggestion** | At most one list entry that fits the repository and stage of the entry. It is only a proposal: it is applied when you click **Use suggestion**, never by itself. |
| **Preflight** | A read-only check at the provider before issuing: does the chosen resource belong to the connected integration? It names the resource it found. |
| **Integration default** | A non-secret parameter value stored once per integration (`integrationDefaults` in the inventory) that applies to every entry that does not set the parameter itself. Only parameters marked as such qualify: `accountId` for Cloudflare, `baseUrl` for Grafana. |

## Rules

- **No silent guessing.** A suggestion needs a click. If the match is ambiguous or weak, there is no suggestion and you choose by hand.
- **No issuing with incomplete parameters.** Missing required parameters, a wrong type or a value outside the allowed options are rejected before any call to the provider, with a plain message instead of a misleading provider error.
- **No issuing against a sure mismatch.** If the preflight finds that the chosen resource does not belong to the integration, nothing is issued. Unreadable lists and soft findings are only warnings.
- **You can always type the value.** If the integration token may not read a list, enter the id or address by hand.

## In the portal

### 1. Connect the integration and look at its resources

Open **Integrations**, connect the token ([INTEGRATIONS.md](INTEGRATIONS.md#connecting-a-token)). Once the card shows *Connected*, the portal reads what the integration offers. Open **Resources and defaults** on the card:

- **Found** lists the accounts, projects, zones, domains or service accounts the token can read, with a count per kind.
- If a list is not readable, the card says so (for example "the token probably lacks read permission for this list") and shows the way out: enter the value by hand below.
- **Defaults** shows the parameters this integration may carry as default (Cloudflare `accountId`, Grafana `baseUrl`). Enter them and choose **Save defaults**. Integrations without defaults say "This integration needs no defaults."

### 2. Create a secret

In **New entry**, choose an automatic provider. A **Parameters of the provider** section appears:

1. Required parameters are marked *required*. A parameter with a list shows the entries of the integration; **Reload list** reads it again, **Enter the value by hand** switches to a text field.
2. If a list entry fits the repository and stage, it is tagged *Suggestion* with the reason. Choose **Use suggestion** to take it. Without a repository there are no suggestions, but the lists still work.
3. Parameters that depend on another one (the Cloudflare zone and Turnstile widget on the account, the Grafana service account on the Grafana address) stay empty until you have chosen that one first ("Choose the parameter this list depends on first").
4. Presets set several parameters at once, for example *Worker deploy* for Cloudflare. A preset that needs a further parameter says "Also choose: zoneId".
5. If required parameters are missing, the dialog lists them ("Required parameters missing: ...") and does not create the entry. Manual and random providers have no parameters and are not affected.

After the entry is created the portal runs the preflight and reports "Preflight at the provider: ... looks fine", "Preflight with notes" or "Preflight reports a problem". In the last case the entry **is** created, but nothing is issued until the parameters are fixed. If the integration is not connected, the preflight is skipped and says so.

### 3. The Parameters card on the secret page

Every secret page has a **Parameters** card:

- Status: *Complete*, *Parameters missing: ...* or *Parameters invalid*.
- **Edit** opens the same pickers as in the create dialog; **Save parameters** stores them. Values already in `params` that the provider does not know are kept ("Other entries in params (kept)").
- Values that come from the integration default are marked *Integration default*.
- The preflight result of the chosen resource is shown below, with its findings.

While the status is not *Complete*, **Generate new value** is **locked**. The card explains why ("A new value can only be generated once the required parameters are set: ...") and the locked button reads *Complete the parameters first* / *Go to parameters*. Server side the same rule applies: a renewal request with incomplete parameters is answered with `400` / `params_invalid`.

A dry run (`dryRun: true`, humans only) shows *Parameters complete* or the missing keys, the preflight result and the chosen resource in the plan.

### 4. Complete parameters for many entries

The **Secrets** list marks entries with missing parameters (*Parameters missing* badge) and has a filter *Parameters*, *All* or *Parameters missing*. **Complete parameters** opens a dialog that reads the accounts, projects, zones and domains of all connected integrations once and shows, per entry, what it found:

| Status | Meaning |
|---|---|
| *Unambiguous suggestion* | Every missing parameter has a suggestion. |
| *Partial suggestion only* | Some parameters have one; you complete the rest by hand. |
| *No unambiguous suggestion* | Choose by hand (**Complete by hand**). |
| *Integration not connected* | Connect the integration first. |

**Apply** takes the suggestion for one entry, **Apply all unambiguous (n)** for all that are clear. Nothing is saved without your click and nothing is written to GitHub.

### 5. Variables from a provider

A variable can take its expected value from a resource of an integration instead of being typed (for example a Supabase project URL, a Cloudflare zone id, a Turnstile sitekey). In the variable dialog open **Load from provider**, choose the source, the resource and the field, then **Load value** and **Use as value**. For an existing variable, **Load value** shows the stored value, the proposed one and **Apply**.

- The source is remembered on the variable (`from`), so the **Variables** page can compare all sources with what the provider says now: **Suggest values from providers**, one **Apply** per variable.
- **Apply** changes the expected value in the **inventory** only. To write it to GitHub use the normal apply of the variable.
- Only public fields and ids are offered, from a fixed allowlist:

| Source (`kind`) | Integration | Fields |
|---|---|---|
| `supabase.project` | `supabase` | `ref`, `url`, `publishableKey` (public key of type publishable or anon) |
| `cloudflare.account` | `cloudflare` | `accountId` |
| `cloudflare.zone` | `cloudflare` | `zoneId`, `name` |
| `cloudflare.turnstileWidget` | `cloudflare-turnstile` | `sitekey` |
| `resend.domain` | `resend` | `domainId`, `name` |

Not offered: the Grafana stack address and a Stripe publishable key (no usable read endpoint).

## Parameters per provider

The same list as in [PROVIDERS.md](PROVIDERS.md#parameters-per-provider), with the origin of the choices.

| Provider | Parameter | Required | List comes from | Suggestion |
|---|---|---|---|---|
| `cloudflare-token` | `accountId` | yes (integration default allowed) | accounts of the token | only if the token sees exactly one account |
| | `permissions` | yes | permission group names; the detail says whether a group applies to an account or a zone | never |
| | `zoneId` | only for zone-bound permissions (for example *Workers Routes Write*) | zones, filtered by the chosen account | zone name contains the repository, exactly one hit |
| `cloudflare-turnstile` | `accountId` | yes (integration default allowed) | accounts of the token | only if exactly one account |
| | `sitekey` | yes | Turnstile widgets of the account | none |
| `supabase-api-key` | `projectRef` | yes | projects of the access token | project name contains repository and stage, exactly one hit |
| | `type` | no, default `secret` | fixed: `secret`, `publishable` | none |
| | `url` | no | typed by hand (`https://<ref>.supabase.co`, enables the function test) | none |
| `supabase-service-role` | `projectRef`, `url` | `projectRef` yes | as above | as above |
| `resend-api-key` | `permission` | no, default `sending_access` | fixed: `sending_access`, `full_access` | none |
| | `domainId` | yes if `permission` is `sending_access` (also when omitted), not used for `full_access` | domains of the account | domain name contains the repository, exactly one hit |
| `grafana-service-account-token` | `baseUrl` | yes (integration default allowed) | typed by hand | none |
| | `serviceAccountId` | yes | service accounts of the stack at `baseUrl` | only if the stack has exactly one |
| `stripe-webhook-secret` | `url`, `events` | yes | typed by hand | none |
| | `connection` | no | fixed: `stripe`, `stripe-test`, `stripe-live` | none |
| `random-*`, manual providers | see [PROVIDERS.md](PROVIDERS.md#parameters-per-provider) | | no discovery | none |

### How a suggestion is chosen

Exactly one list entry or none. A tie, a weak match or no match gives no suggestion.

| Kind | Rule |
|---|---|
| Supabase project | The name contains the repository **and** a word for the stage, and exactly one project matches. Words for the stage: its id, plus `production`, `prod`, `live` for kind live; `staging`, `stage`, `test`, `qa` for kind test; `dev`, `development`, `local` for kind dev. A stage without words (kind shared) matches on the repository alone. |
| Cloudflare zone, Resend domain | The name contains the repository (ignoring case and separators), exactly one match. Repository names shorter than three characters are ignored. |
| Cloudflare account, Grafana service account | Only if the list has exactly one entry. |
| Cloudflare permissions | Never. |

Example: repository `acme-app`, stage `staging` (kind test): a project `acme-app-staging` is suggested, `acme-app-production` is not, and with both `acme-app-staging` and `acme-app-staging-eu` there is no suggestion.

### Mapping repositories to resources

Name matching cannot always work: a Resend domain `example.com` does not contain the repository `acme-app`, and a Supabase production project may carry the repository name alone. For these cases you keep an explicit **mapping** from repository (and optionally stage) to a resource. It is stored in the inventory as `resourceMap` and is not a secret.

```yaml
resourceMap:
  - { kind: resend.domain, repo: acme-app, value: dom_123, label: example.com }
  - { kind: supabase.project, repo: acme-app, stage: production, value: abcdefgh, label: acme-app }
```

| Field | Meaning |
|---|---|
| `kind` | The discovery kind: `supabase.project`, `cloudflare.zone`, `cloudflare.account`, `resend.domain`, `grafana.serviceAccount`. |
| `repo` | Repository the entry applies to (a repository of one of the places of the secret). |
| `stage` | Optional stage id. Without it the entry applies to all stages; an entry with a matching stage wins over one without. |
| `value` | The id of the resource, the same value the list returns. |
| `label` | The display name at the time of choosing. Display only. |

Rules:

- A mapping takes precedence over the name rules above and is unambiguous by itself: exactly that list entry is marked as the suggestion, with the reason *Mapping*. It is still only a suggestion that you apply with a click.
- If the secret has places in several repositories that map to different resources, the mapping is ignored for that entry and the name rules apply.
- If the mapped `value` is not in the list (wrong account, resource deleted), nothing is suggested and the portal shows *The mapping points to a resource the provider does not know*. The API returns `mapMismatch: { value, label? }` for that list.
- In the portal: **Resources and defaults** of an integration has a section *Mapping repository → resource* (table with remove, and a row to add one). In the Parameters card and the create dialog, a resource you chose that was not a suggestion offers *Remember for <repo>* (optionally only for the stage).
- The mapping is part of the team file ([TEAM.md](TEAM.md)).

## What the preflight checks

| Provider | Checks | Fails (blocks issuing) | Warns only |
|---|---|---|---|
| Cloudflare token | account belongs to the token; permission groups exist; zone required for zone-bound groups; zone belongs to the account | account not in the token's accounts; unknown permission groups; `zoneId` missing for a zone-bound group; zone not in the account | lists not readable; no accounts returned |
| Cloudflare Turnstile | account belongs to the token | account not in the token's accounts | list not readable |
| Supabase | project belongs to the access token | project not in the list | project name suggests another stage than the entry; list not readable; no projects returned |
| Resend | domain exists in the account | domain not found | domain not verified; `full_access` (applies to the whole account); list not readable |
| Grafana | address allowed and reachable; service account exists | address not allowed or not reachable; service account not in the stack | list not readable; no service accounts returned |
| Stripe, random, manual | none | | |

The preflight needs the integration to be connected and the required parameters to be complete; otherwise it is skipped (*Preflight skipped: required parameters missing* / *integration not connected*).

## Error messages

Both appear in the portal as plain text and in the API as JSON ([`apps/desk/API.md`](../apps/desk/API.md)).

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| 400 | `params_invalid` | Parameters missing, of the wrong type, outside the allowed options, or (when saving) not known to the provider. `problems` lists each one with `key`, `code` (`missing`, `wrong_type`, `not_in_options`, `unknown_key`) and the labels. | Complete the parameters on the card. Nothing was issued and, for a save, nothing was stored. |
| 409 | `preflight_failed` | The preflight found that the chosen resource does not belong to the integration (or a required permission group does not exist). `findings` lists them. | Choose the right resource, or connect the right account. Nothing was issued. |

See also [TROUBLESHOOTING.md](TROUBLESHOOTING.md#parameters-and-resources).

## Security

- All provider calls for lists and the preflight are **read-only** `GET`s with the stored token of the integration. They are made by the portal for a human; agents get no discovery, no preflight and no route to change parameters. An agent only sees `params: { status, missing }` on a secret.
- Only **ids, names and public fields** are read. Variable sources come from a fixed allowlist; `service_role`, secret keys and Turnstile secrets are never selected. The Supabase public key is read from the key list without revealing values and only from entries of type publishable or anon.
- Resource values are shown in the portal and kept in memory for the request. They are not stored anywhere except where you save them: parameters in the inventory, a variable's expected value in the inventory. Secret values are not involved at all.
- A suggestion is never applied without your click, and nothing in this flow writes to GitHub.
- The Grafana address is restricted to `*.grafana.net` and the hosts in `providers.grafana.allowedHosts`, because the integration token is sent to it.

## Inventory example

Neutral example with an integration default, a Cloudflare token, a Supabase key, a Resend key and a variable that takes its value from a provider:

```yaml
version: 1
integrationDefaults:
  cloudflare:
    accountId: "0123456789abcdef0123456789abcdef"
  grafana:
    baseUrl: https://my-stack.grafana.net

secrets:
  - id: cloudflare-deploy-staging
    name: CLOUDFLARE_API_TOKEN
    stage: staging
    service: cloudflare
    provider: cloudflare-token
    params:                       # accountId comes from integrationDefaults
      permissions: ["Workers Scripts Write", "Account Settings Read", "Workers Routes Write"]
      zoneId: "fedcba9876543210fedcba9876543210"   # Workers Routes Write applies to a zone
    places:
      - { repo: acme-app, scope: environment, environment: staging }

  - id: supabase-secret-key-staging
    name: SUPABASE_SECRET_KEY
    stage: staging
    service: supabase
    provider: supabase-api-key
    params:
      projectRef: abcdefghijklmnopqrst   # project my-project-staging
      type: secret
    places:
      - { repo: acme-app, scope: environment, environment: staging }

  - id: resend-sending-staging
    name: RESEND_API_KEY
    stage: staging
    service: resend
    provider: resend-api-key
    params:
      permission: sending_access
      domainId: "11111111-2222-3333-4444-555555555555"   # example.com
    places:
      - { repo: acme-app, scope: environment, environment: staging }

variables:
  - id: supabase-url-staging
    name: NEXT_PUBLIC_SUPABASE_URL
    stage: staging
    value: "https://abcdefghijklmnopqrst.supabase.co"
    from:                          # remembered source: loaded from the integration, never a secret field
      connection: supabase
      kind: supabase.project
      resource: abcdefghijklmnopqrst
      field: url
    places:
      - { repo: acme-app, scope: environment }
```

Field reference: [CONFIGURATION.md](CONFIGURATION.md#inventory-inventoryyaml). Provider details: [PROVIDERS.md](PROVIDERS.md).
