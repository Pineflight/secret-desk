/** Startgeheimnis aus einer Eingabe: die ganze Startadresse (mit ?launch=...) oder nur das Geheimnis. Nie gespeichert. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export function parseLaunchInput(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes("launch=")) {
    try {
      const url = new URL(raw, "http://placeholder.invalid");
      const launch = url.searchParams.get("launch")?.trim() ?? "";
      return SECRET_SHAPE.test(launch) ? launch : null;
    } catch {
      return null;
    }
  }
  return SECRET_SHAPE.test(raw) ? raw : null;
}
