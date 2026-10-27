/** Reine Logik fuer Tab-Leisten (ohne React): Wert aus der Adresse, Pfeiltasten. */

/** Gueltiger Tab aus einem URL-Parameter, sonst der Standard (der erste). */
export function parseTab<T extends string>(ids: readonly T[], value: string | null | undefined): T {
  return ids.find((id) => id === value) ?? ids[0]!;
}

/** Ziel einer Taste in einer Tab-Leiste, null = Taste ohne Bedeutung. Ring: nach dem letzten kommt der erste. */
export function nextTab<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  if (ids.length === 0) return null;
  const i = Math.max(0, ids.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return ids[(i + 1) % ids.length]!;
    case "ArrowLeft":
    case "ArrowUp":
      return ids[(i - 1 + ids.length) % ids.length]!;
    case "Home":
      return ids[0]!;
    case "End":
      return ids[ids.length - 1]!;
    default:
      return null;
  }
}
