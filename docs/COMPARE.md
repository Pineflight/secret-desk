# Compare

The **Compare** page shows which secrets and variables exist on which stage and where something is missing, in one matrix. It is available in the portal (**Compare**), as `GET /api/agent/compare` and as the MCP tool `desk_compare_stages`.

The comparison is **read-only** and never returns or reads a secret value. Variables are the one exception in spirit: their values are configuration, and they are read only to compare them with the expected value.

Source: pure logic in [`packages/core/src/compare.ts`](../packages/core/src/compare.ts) (testable without network); network part in [`packages/runtime/src/compare.ts`](../packages/runtime/src/compare.ts); workflow parsing in [`packages/core/src/workflow-needs.ts`](../packages/core/src/workflow-needs.ts).

![Compare, live](images/compare-live.png)

## The matrix

- **Rows** are a repository and a name, per kind (secret or variable). The name is the place's `name` or else the entry's `name`.
- **Columns** are all configured [stages](STAGES.md).
- Each cell has a **state**. Each row has a **parity** result.

By default the comparison is **offline**: cells show `unknown` where an expectation exists, because nothing was read. Switch on **Check live against GitHub** to read the actual state. The portal never reads GitHub just because you opened the page.

### Targets

A stage lives in the GitHub environment of its definition. Stages without an environment (`dev`, `shared`) have no target, with one exception: the **repository level** belongs to the first environment-less stage of kind `shared` (otherwise the first environment-less stage). Other environment-less stages show `not-applicable`. An inventory entry always counts for its own stage and is checked at its own places (repository, environment or organization).

## Cell states

| State | Meaning |
|---|---|
| `ok` | Expected by the inventory and present in GitHub. |
| `missing` | Expected, but absent in GitHub (also when the environment does not exist). |
| `unexpected` | Present in GitHub, but unknown to the inventory for that stage ("only in GitHub"). |
| `different` | Variable only: the value in GitHub differs from the expected value. |
| `unknown` | Not checked live: only the expectation is known. |
| `error` | The target could not be read (for example 403 or 429); the message is shown. |
| `not-expected` | Neither expected nor present. |
| `not-applicable` | The stage has no target in this repository (no environment, not the repository-level stage). |
| `needed` | A workflow uses the name here, and it exists neither in the inventory nor (as far as known) in GitHub. |
| `level-mismatch` | A workflow reads the name here, but the inventory knows it for this repository only on another level or stage. Usually a level difference, not a missing entry. |
| `optional` | A workflow only checks the name (`if:`, `!= ''`), it does not require it. |

## Parity

Parity answers "is this name present on all stages I care about?" per row.

- The **compared stages** are by default all stages of kind `test` and `live` (change them with the chips on the page, or `compare=a,b`).
- Live, the actual presence counts; offline, the expectation. Cells with `error` or `not-applicable` are left out.
- With fewer than two comparable stages, or if the name is present nowhere: `n/a`.
- Present on all compared stages: `consistent`.
- Otherwise `gap`, with `missingIn` listing the stages.

Names that differ only by a stage word (`SUPABASE_STAGING_URL` and `SUPABASE_PRODUCTION_URL`) are **not** equated, unless you switch on **Normalize names** (`normalize=1`): it drops `STAGING`, `PRODUCTION`, `PROD`, `DEV` and the stage ids and environment names (single words) from names and merges the rows.

## Orphans and adding to the inventory

With live reading, names found in GitHub at a stage target but not in the inventory get their own rows (`unexpected`, no inventory ids). They count in `summary.orphans`. The portal can add such rows to the inventory (metadata only: provider `manual`, expiry unknown, **no value**), one at a time through the prefilled *New entry* dialog or all at once.

## All repositories

With **All repositories of the organization** (`all=1`, MCP `all_repos`), requires live: the organization's repository list is read as well. Archived repositories and ignored repositories are hidden. Repositories without any inventory entry are read at repository level and in every GitHub environment (one list call, then for each kind one read for the repository level and one per environment; four repositories in parallel). Environment names map to stages by name (case-insensitive); other environments go to an *other environments* column. Everything found there is `unexpected` ("only in GitHub"). Repositories with nothing found are listed in a collapsible card with name, visibility, last push and counters. A 403 or 404 on one repository becomes a note for that repository, never a global error.

## Workflow needs

With **Evaluate workflows** (`workflows=1`) the comparison parses `.github/workflows/*.yml|yaml` and shows which secrets and variables workflows use.

- The source is the repository's **locally linked folder** ([REPOSITORIES.md](REPOSITORIES.md)), otherwise (with live) the GitHub Contents API, which needs the optional token permission **Contents: Read**. Without it you get a note per repository ("token needs Contents: Read, or link the repository locally") and everything else keeps working.
- Only expressions `${{ ... }}` (and bare `if:` expressions) count: `secrets.NAME`, `vars.NAME`, `secrets['NAME']`. `GITHUB_TOKEN` is ignored. Words like `secrets.sh` in a script call never match. YAML comments are ignored because the file is parsed.
- The job's `environment:` (also a simple `${{ matrix.x }}`) decides which stage the name is needed on; without it the repository level applies. `secrets:` blocks of reusable workflows count.
- `secrets: inherit` and `${{ secrets }}` as a whole cannot be resolved; they only produce a note. A dynamic environment that cannot be resolved also produces a note. A file that is not valid YAML produces a note.
- A name that a workflow needs but that is neither in the inventory nor in GitHub (nor covered by the repository level for an environment job, nor by an organization secret) gets the state `needed` and counts in `summary.neededMissing`.
- If the inventory knows the name for that repository on another level or stage, the state is the weaker `level-mismatch` (`summary.levelMismatch`). Check whether the job uses an environment dynamically; otherwise create the secret at repository level.
- A name used only in `if:` or comparisons is `optional`, never `needed`.
- Rows that already exist only get a *Needed by deploy.yml* badge. At most 40 workflow files per repository, each up to 512 KB, are read.

The filter **Only needed by workflows** shows just these rows.

## Ignored repositories

`compare.ignoreRepos` in the configuration (default `[".github", ".github-private"]`) removes repositories from the comparison completely: no rows, no GitHub reads, no workflow files, not in "Repositories without entries". They are listed under *Ignored repositories (n)*. Add for example an Upptime `status` repository to silence its template workflows. In the portal you can additionally hide a repository group for the browser session only; that never writes the configuration.

## Renamed repositories

An inventory repository that is missing from GitHub's list is resolved with `GET /repos/{owner}/{name}`. GitHub answers an old name with a redirect; the client follows it only within GitHub and never sends the token elsewhere. If the current name differs, the portal shows "renamed to ..." (also on **Repositories**) and offers the human-only action **Rename in inventory**: it rewrites the places and templates and moves a local folder link. It changes nothing in GitHub.

## Reading GitHub: cost and limits

- Each target (repository level, environment per stage, organization) is read **once per kind**, at most **four requests in parallel**.
- A failing target becomes `error` cells; only a missing GitHub connection fails the whole call.
- GitHub rate limits apply. In the agent API, use `live` deliberately.
- Reads are listings of names (and variable values), never secret values (GitHub does not return those).
- A list that exceeds the client's page limit is aborted rather than shown incomplete.

## Limits

- The workflow evaluation is static: it cannot know what a reusable workflow of another repository needs or what a dynamic expression resolves to.
- Environment secrets of a repository that has no environment with the stage's name show as `missing`.
- Organization-scope entries are read at organization level; the portal form for creating them does not exist yet.
- The comparison shows presence and variable values, not whether a secret's *content* is the same across stages (that is not readable, and staging and production should never share a value anyway).

## Portal controls

Reload, **Copy as Markdown** (the current view as a table), filters by repository, type, name search, *Deviations only*, *Gaps first*, *Only needed by workflows*, *Normalize names*, compared-stage chips, and per-cell details (which entries expect it, which targets were checked, actual names, workflows that need it).
