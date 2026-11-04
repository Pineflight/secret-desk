/** Splits a list of place labels into the chips shown inline and the number hidden behind a "+N" chip. */
export function splitPlaceChips(labels: string[], max = 2): { shown: string[]; hidden: number } {
  const limit = Math.max(1, max);
  if (labels.length <= limit) return { shown: labels, hidden: 0 };
  return { shown: labels.slice(0, limit), hidden: labels.length - limit };
}

export interface ChipSplit {
  shown: string[];
  hidden: number;
}

/**
 * The three chip sets of a row whose room is only known to CSS (one, two or three chips plus "+N"). The row renders every set
 * and a container query shows the one that fits, so a narrow cell shows "#a +3" where a wide one shows "#a #b #c +1".
 */
export function chipTiers(labels: string[]): [ChipSplit, ChipSplit, ChipSplit] {
  return [splitPlaceChips(labels, 1), splitPlaceChips(labels, 2), splitPlaceChips(labels, 3)];
}
