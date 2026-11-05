import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Oeffentliche Adresse der Integrations-API-Beschreibung (docs/api/openapi.yaml). */
export const OPENAPI_PATH = "/api/openapi.yaml";

/** Das Portal laeuft mit apps/desk als Arbeitsverzeichnis (dev, start, Container); vom Repo-Wurzelordner aus geht es auch. */
export function openApiCandidates(cwd = process.cwd()): string[] {
  return [resolve(cwd, "../../docs/api/openapi.yaml"), resolve(cwd, "docs/api/openapi.yaml")];
}

let cached: string | undefined;

export async function loadOpenApi(candidates = openApiCandidates(), cache = process.env.NODE_ENV === "production"): Promise<string | null> {
  if (cache && cached !== undefined) return cached;
  for (const file of candidates) {
    try {
      const text = await readFile(file, "utf8");
      if (cache) cached = text;
      return text;
    } catch {
      // naechster Kandidat
    }
  }
  return null;
}

/** Die Beschreibung ist oeffentlich (das Repository ist es auch): kein Token, aber Host- und Fetch-Site-Pruefung im Aufrufer. */
export async function openApiResponse(candidates?: string[]): Promise<Response> {
  const text = await loadOpenApi(candidates);
  if (text === null) return Response.json({ error: "OpenAPI-Beschreibung nicht gefunden" }, { status: 404 });
  return new Response(text, { headers: { "content-type": "application/yaml; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
}
