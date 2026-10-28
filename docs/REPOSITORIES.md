# Repositories

The **Repositories** page (`/repos`) lists every repository secret-desk knows, and lets you link each one to a folder on **this machine**. Source: [`packages/runtime/src/repos.ts`](../packages/runtime/src/repos.ts).

![Repositories](images/repositories.png)

## Where the list comes from

The list combines three sources:

1. The **inventory**: every repository named in a place of a secret or variable, or in a template (with counters for secrets, variables and templates).
2. **GitHub, live**: with a GitHub connection, *Compare with GitHub* adds the owner's repositories (names, visibility, archived, last push). Only metadata is read. Without a connection, or if GitHub fails, the page quietly falls back to inventory and links.
3. The **local links**.

A repository that is in the inventory but no longer in GitHub's list under that name is checked for a **rename**, see [below](#renames).

## Selection

Wherever a form asks for a repository (new entry, Dev environment, links), the field is a **select with search** that offers repositories from the inventory, from GitHub and from your links. Free input remains possible, so you can name a repository that is not listed yet.

## Local links

A link maps a repository to a folder on this machine. It is stored in `~/.secret-desk/repo-links.json` (mode 600; set another location with `linksFile`) and **never** in the inventory or the team file, because paths are machine-specific.

Links are used for:

- the **default path** of the dev `.env`: `<folder>/<template file>`; an explicit path wins,
- reading **workflow files** locally for [Compare](COMPARE.md#workflow-needs) (no token permission needed).

### Path rules

When you link a folder, the portal checks, in this order:

1. The path is expanded (`~` becomes the home directory) and must be **absolute**.
2. On Windows, network paths (`\\server\share`), `\\?\` paths, characters Windows forbids (`< > : " | ? *`) and reserved names (`CON`, `NUL`, `COM1`, ...) are rejected.
3. The folder must exist and be a directory. Symlinks are resolved first, and the check uses the real path.
4. It must lie **strictly below** your home folder or one of the `policy.envRoots` (not equal to them).
5. It must be a Git repository (`.git` exists).
6. The remote `origin` is read with `git remote get-url origin` (no shell). If it is missing or points to another repository than `<owner>/<name>`, you get a **warning**, not an error.

Repository names in links must match `^[A-Za-z0-9._-]{1,100}$`. The link is **re-checked on every use** (folder still exists, still below home or `envRoots`), because the file could have been edited by hand.

For `env-export`, a linked folder counts as an allowed root, but only for its own repository.

Only the portal sets and removes links (`PUT repos/:name/link`, `DELETE repos/:name/link`). Agents see that a folder is linked, not its path, and cannot link anything.

## Find locally

**Find locally** (`POST repos/scan`) searches each `policy.envRoots` folder down to depth 2 for Git folders whose `origin` points to the configured owner, and proposes links. It skips folders starting with `.` and `node_modules`, `dist`, `build`, `target`, `vendor`, and does not descend into a Git folder. **Nothing is applied until you click**; when two folders share a repository name, the first one found is proposed. An empty `envRoots` means nothing is searched.

## Search

The search box on the page filters the table by repository name. The global search in the top bar finds secrets and variables by name, repository or product.

## Renames

GitHub redirects the old name of a renamed repository. When a repository is in your inventory but not in GitHub's list, secret-desk asks GitHub for the current name (at most four requests in parallel; a failure for one repository just leaves it out). A differing name appears as "renamed to ..." here and in [Compare](COMPARE.md#renamed-repositories). The human-only action **Rename in inventory** (`POST repos/:name/rename`) rewrites the places of secrets and variables and the repository of templates, and moves a local link to the new name. It never changes anything in GitHub. Old and new name must differ.
