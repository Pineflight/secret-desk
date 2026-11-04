/** Long lists render in pages: the first `size` rows, then "show more" adds another page. Pure, so it is testable. */

export const PAGE_SIZE = 50;

export interface PageView<T> {
  rows: T[];
  /** Rows not shown yet. */
  hidden: number;
  /** How many the next "show more" adds. */
  next: number;
}

/** The rows for `pages` pages (at least one). */
export function pageOf<T>(all: readonly T[], pages: number, size = PAGE_SIZE): PageView<T> {
  const count = Math.max(1, Math.floor(pages)) * size;
  const hidden = Math.max(0, all.length - count);
  return { rows: all.slice(0, count), hidden, next: Math.min(size, hidden) };
}

export interface GroupLike<T> {
  items: T[];
}

/**
 * Cuts grouped rows after `pages` pages in total: groups keep their order, the group the cut falls into is shortened, later groups
 * are dropped. `hidden` counts the rows left out.
 */
export function limitGroups<T, G extends GroupLike<T>>(groups: readonly G[], pages: number, size = PAGE_SIZE): { groups: G[]; hidden: number; next: number } {
  let budget = Math.max(1, Math.floor(pages)) * size;
  let hidden = 0;
  const out: G[] = [];
  for (const g of groups) {
    if (budget <= 0) {
      hidden += g.items.length;
      continue;
    }
    if (g.items.length <= budget) {
      out.push(g);
      budget -= g.items.length;
    } else {
      out.push({ ...g, items: g.items.slice(0, budget) });
      hidden += g.items.length - budget;
      budget = 0;
    }
  }
  return { groups: out, hidden, next: Math.min(size, hidden) };
}
