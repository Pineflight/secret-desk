# Stages

A **stage** is a place in your delivery path, such as `dev`, `staging` or `production`. Every secret, variable and `.env` template belongs to one stage. Stages are **freely configurable**: you choose the names, and behavior follows the stage's **kind**, never its name.

Defined in `stages:` of the inventory (portal: **Settings**, tab *Stages*). Source: [`packages/core/src/stages.ts`](../packages/core/src/stages.ts).

## Definition

```yaml
stages:
  - { id: dev,        kind: dev,    environment: null }
  - { id: staging,    label: Staging,    kind: test, environment: staging }
  - { id: production, label: Production, kind: live, environment: production }
  - { id: shared,     kind: shared, environment: null }
```

| Field | Description |
|---|---|
| `id` | Slug (`^[a-z0-9][a-z0-9-]{0,30}$`), used everywhere else. |
| `label` | Display name, 1 to 40 characters. Default: the id. |
| `kind` | `dev`, `test`, `live` or `shared`. |
| `environment` | Name of the GitHub environment, or `null` for none. |
| `tone` | Color of the stage chip: `info`, `ki`, `stage-prod`, `neutral`, `primary`, `success`, `warn`. Default by kind: `dev` info, `test` ki, `live` stage-prod, `shared` neutral. |

Without a `stages:` section (or with an empty one), the four stages above apply. At most **12** stages; ids must be unique.

## Kinds

| kind | Meaning and effects |
|---|---|
| `dev` | Local development. A secret needs no GitHub target. Agents may act directly (default `policy.agentStages` = all stages of this kind). Dev `.env` templates and exports are for this kind. |
| `test` | Sandbox or test. Provider keys are expected to be in test mode (for example Stripe `rk_test_`). Agents need an approval unless you list the stage in `policy.agentStages`. Compared for parity by default. |
| `live` | Production grade. Agents **always** need an approval, even if the policy lists it. Provider keys must be in live mode. Warning styling. The write test never preselects targets used by live entries. Compared for parity by default. |
| `shared` | Applies to all stages, for example a repository-level secret. The mode of provider keys is not checked. Owns the repository level in [Compare](COMPARE.md#targets). |

An unknown stage id is treated as `live`: when in doubt the strictest handling applies.

## Environment derivation

A place with `scope: environment` and no `environment` name takes the name from the stage:

- If the stage defines `environment: <name>`, that name is used.
- If `environment` is omitted: the stage `id` for kinds `test` and `live`, none for `dev` and `shared`.
- `environment: null` means explicitly none.
- A place with `scope: environment`, no name, on a stage without an environment is an **error** ("stage has no GitHub environment: give the place a name or use another stage").

```yaml
- id: stripe-webhook-staging
  stage: staging
  places:
    - { repo: acme-web, scope: environment }   # becomes environment "staging"
```

An explicit `environment` on the place always wins. Staging and production never share a value: each has its own secret.

## Your own stages

Add a stage in **Settings** (*Add stage*) or in the YAML. Example with a canary stage that behaves like production:

```yaml
stages:
  - { id: dev, kind: dev, environment: null }
  - { id: qa, label: QA, kind: test, environment: qa-env }
  - { id: canary, kind: live, environment: canary }
  - { id: production, kind: live, environment: production }
  - { id: shared, kind: shared, environment: null }
```

Rules when changing stages in the portal:

- You can reorder stages; lists and filters follow the order of definition within one kind.
- A stage can only be **removed** when no secret, variable or template uses it and it does not appear in `policy.agentStages` (the portal tells you the counts).
- At least one stage must remain.
- Only a human can change stages; agents can read them (`desk_list_stages`).

## Team export

The stage definitions are part of the team file ([TEAM.md](TEAM.md)). On `team import` (merge), unknown stage ids are added and existing ones stay unchanged, so kind and environment are never changed silently. `--replace` takes the list over completely.
