import { translate } from "./i18n";
import type { SecretView } from "@secret-desk/runtime";
import { DEFAULT_ORDER, stageRank } from "./stages";

type Place = SecretView["places"][number];

export type SortKey = "name" | "expires" | "repo" | "stage";
export type GroupKey = "none" | "repo" | "stage";


export interface Browsable {
  id: string;
  name: string;
  stage: string;
  places: Place[];
  expires?: string | null;
  daysLeft?: number | null;
}

/** Repositories eines Eintrags, sortiert und ohne Dopplungen. */
export function repoNames(places: Place[]): string[] {
  return [...new Set(places.map((p) => p.repo))].sort((a, b) => a.localeCompare(b));
}

export function allRepos(items: Browsable[]): string[] {
  return [...new Set(items.flatMap((i) => repoNames(i.places)))].sort((a, b) => a.localeCompare(b));
}

const cmp = (a: string, b: string) => a.localeCompare(b, "de");

/** order = Stage-Ids in Anzeigereihenfolge (stageOrder der Definitionen). */
export function sortItems<T extends Browsable>(items: T[], key: SortKey, order: readonly string[] = DEFAULT_ORDER): T[] {
  const out = [...items];
  out.sort((a, b) => {
    switch (key) {
      case "expires": {
        const ax = a.daysLeft ?? Number.POSITIVE_INFINITY;
        const bx = b.daysLeft ?? Number.POSITIVE_INFINITY;
        return ax - bx || cmp(a.name, b.name);
      }
      case "repo":
        return cmp(repoNames(a.places)[0] ?? "~", repoNames(b.places)[0] ?? "~") || cmp(a.name, b.name);
      case "stage":
        return stageRank(order, a.stage) - stageRank(order, b.stage) || cmp(a.name, b.name);
      default:
        return cmp(a.name, b.name);
    }
  });
  return out;
}

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

/** Ein Eintrag mit mehreren Repositories erscheint in jeder Repository-Gruppe. */
export function groupItems<T extends Browsable>(items: T[], by: GroupKey, order: readonly string[] = DEFAULT_ORDER, stageLabel: (id: string) => string = (id) => id): Group<T>[] {
  if (by === "none") return [{ key: "", label: "", items }];
  const map = new Map<string, T[]>();
  const add = (k: string, item: T) => map.set(k, [...(map.get(k) ?? []), item]);
  for (const item of items) {
    if (by === "repo") {
      const repos = repoNames(item.places);
      if (repos.length === 0) add("", item);
      else repos.forEach((r) => add(r, item));
    } else add(item.stage, item);
  }
  const keys = [...map.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : by === "stage" ? stageRank(order, a) - stageRank(order, b) : cmp(a, b)));
  return keys.map((k) => ({ key: k, label: by === "stage" ? stageLabel(k) : k || translate("meta.noRepo"), items: map.get(k)! }));
}
