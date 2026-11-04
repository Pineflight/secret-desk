/** Splits a list of place labels into the chips shown inline and the number hidden behind a "+N" chip. */
export function splitPlaceChips(labels: string[], max = 2): { shown: string[]; hidden: number } {
  const limit = Math.max(1, max);
  if (labels.length <= limit) return { shown: labels, hidden: 0 };
  return { shown: labels.slice(0, limit), hidden: labels.length - limit };
}
