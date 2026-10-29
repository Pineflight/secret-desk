# Secrets and variables

The portal lists secrets and variables in **one table** at `/entries` (sidebar: *Secrets and variables*). Source: [`apps/desk/src/app/entries/page.tsx`](../apps/desk/src/app/entries/page.tsx), logic in [`apps/desk/src/lib/entries-list.ts`](../apps/desk/src/lib/entries-list.ts). The detail page of a secret stays at `/secrets/:id`; variables open their details in a dialog.

## Old addresses

`/secrets` and `/variables` redirect permanently (HTTP 308) to `/entries?kind=secret` and `/entries?kind=variable`. The query string is kept, so old bookmarks such as `/variables?repo=web&q=url` still work. The old German `/variablen` redirects the same way, and `?neu=1` still opens the new-entry dialog.

## The kind switch

*Kind: All | Secrets | Variables* sits above the filters; the numbers show how many entries each choice would list under the other filters. The choice is in the URL: `?kind=secret` or `?kind=variable` (anything else means all).

Other filters in the URL: `stage`, `status`, `repo`, `tag`, `q`. Example: `/entries?stage=production&status=missing` (used by links from Compare, Overview and Repositories). *Group by* and *Sort by* apply to both kinds.

## Columns

Name (id, description, tags), Kind, Stage, Target value / expiry, Targets, Status / comparison, Actions. The actions column stays at the right edge when a narrow window has to scroll. The header counts the visible rows: for example "117 secrets, 93 variables".

| | Secret | Variable |
| --- | --- | --- |
| Target value / expiry | expiry date and days left | the target value |
| Status / comparison | expiry state, provider, last confirmation | comparison with GitHub (after *Compare*) |
| Actions | open details | compare, set in GitHub, adopt, edit, remove |

Secret values are never shown or searched. The list receives metadata only.

## Filters that exist for one kind only

* **Status** has expiry states for secrets (*OK*, *Expiring soon*, *Due*, *Expired*, *Missing in GitHub*, *Date missing*, *Expiry unclear*) and comparison states for variables (*Not compared*, *Differs*, *Unreachable*, ...). *OK* and *Missing in GitHub* exist for both (for a variable, *OK* means *In sync*). Under *All* the one-kind values are marked "secrets only" or "variables only".
* **Provider** (automatic or manual) and **Parameters** exist for secrets only.

A filter is never applied silently to the other kind: when it hides a kind, a notice names the filter and the kind. With *Kind: Variables* the secret-only filters are hidden and not applied. Comparison states are only known after a comparison, so a status filter that needs one shows a notice with **Compare now** for the variables that were not compared yet.

## New

**New** opens one dialog with *Kind: Secret | Variable* at the top, preselected from the kind filter (secret under *All*) or from `?new=secret|variable` (`?new=1` takes the kind filter). The forms are the same as before.

## Bulk actions

The **Actions** menu holds *Sync secrets with GitHub*, *Complete parameters*, and for variables *Compare all*, *Adopt all from GitHub* and *Suggest values from providers*. They act on the rows that are visible.
