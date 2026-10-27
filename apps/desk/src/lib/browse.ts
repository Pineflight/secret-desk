import type { SecretView } from "@secret-desk/runtime";

type Place = SecretView["places"][number];

export type SortKey = "name" | "expires" | "repo" | "stage" | "product";
export type GroupKey = "none" | "repo" | "product" | "stage";

export const SORT_LABELS: Record<SortKey, string> = { name: "Name", expires: "Ablauf", repo: "Repository", stage: "Stage", product: "Produkt" };
export const GROUP_LABELS: Record<GroupKey, string> = { none: "Keine", repo: "Repository", product: "Produkt", stage: "Stage" };

const STAGE_ORDER = ["production", "staging", "dev", "shared"];

export interface Browsable {
  id: string;
  name: string;
  stage: string;
  product?: string | null;
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

export function allProducts(items: Browsable[]): string[] {
  return [...new Set(items.map((i) => i.product).filter((p): p is string => Boolean(p)))].sort((a, b) => a.localeCompare(b));
}

const cmp = (a: string, b: string) => a.localeCompare(b, "de");
const stageRank = (s: string) => {
  const i = STAGE_ORDER.indexOf(s);
  return i === -1 ? STAGE_ORDER.length : i;
};

export function sortItems<T extends Browsable>(items: T[], key: SortKey): T[] {
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
        return stageRank(a.stage) - stageRank(b.stage) || cmp(a.name, b.name);
      case "product":
        return cmp(a.product ?? "~", b.product ?? "~") || cmp(a.name, b.name);
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
export function groupItems<T extends Browsable>(items: T[], by: GroupKey): Group<T>[] {
  if (by === "none") return [{ key: "", label: "", items }];
  const map = new Map<string, T[]>();
  const add = (k: string, item: T) => map.set(k, [...(map.get(k) ?? []), item]);
  for (const item of items) {
    if (by === "repo") {
      const repos = repoNames(item.places);
      if (repos.length === 0) add("", item);
      else repos.forEach((r) => add(r, item));
    } else if (by === "product") add(item.product ?? "", item);
    else add(item.stage, item);
  }
  const keys = [...map.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : by === "stage" ? stageRank(a) - stageRank(b) : cmp(a, b)));
  return keys.map((k) => ({ key: k, label: k || (by === "repo" ? "Ohne Repository" : "Ohne Produkt"), items: map.get(k)! }));
}
