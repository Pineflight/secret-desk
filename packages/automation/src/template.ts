export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Variablen, die ein Rezept kennt. `externalId` nur beim Widerrufen, `item` nur in Schritten mit `each`. */
export const KNOWN_VARS = [
  "name",
  "owner",
  "days",
  "date",
  "description",
  "repos",
  "permissions",
  "permissionsQuery",
  "stage",
  "secretId",
  "externalId",
  "item",
] as const;

/** Schon fertig kodierte Variablen: in URLs nicht noch einmal kodieren. */
const PRE_ENCODED = new Set(["permissionsQuery"]);

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/**
 * Ersetzt {{name}} durch den Wert. Unbekannte Variable = Fehler.
 * Mit `url: true` wird jeder Wert mit encodeURIComponent kodiert (ausser schon kodierte Variablen).
 */
export function renderTemplate(text: string, vars: Record<string, string>, opts: { url?: boolean } = {}): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
    if (value === undefined) throw new TemplateError(`Unbekannte Variable {{${key}}}`);
    return opts.url && !PRE_ENCODED.has(key) ? encodeURIComponent(value) : value;
  });
}
