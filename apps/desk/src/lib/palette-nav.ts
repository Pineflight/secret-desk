/** Tastaturbedienung der Befehlspalette als reine Funktionen (testbar ohne Browser). */

/** Neuer aktiver Index fuer eine Taste im Suchfeld; null = Taste gehoert nicht zur Navigation. */
export function nextActive(active: number, count: number, key: string): number | null {
  if (count <= 0) return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End" ? 0 : null;
  switch (key) {
    case "ArrowDown": return Math.min(count - 1, active + 1);
    case "ArrowUp": return Math.max(0, active - 1);
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** Tab springt zur naechsten Gruppe (am Ende zur ersten). groupSizes = Zeilen je Gruppe. */
export function nextGroupStart(active: number, groupSizes: readonly number[]): number {
  if (groupSizes.length === 0) return 0;
  let start = 0;
  for (let g = 0; g < groupSizes.length; g++) {
    if (active < start + groupSizes[g]!) {
      let next = g + 1;
      next = next >= groupSizes.length ? 0 : next;
      return groupSizes.slice(0, next).reduce((a, b) => a + b, 0);
    }
    start += groupSizes[g]!;
  }
  return 0;
}

/** Fokusfalle: wohin springt der Fokus bei Tab/Shift+Tab? null = Browser entscheidet. `index` = Position des fokussierten Elements (-1 = ausserhalb). */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift && index <= 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}
