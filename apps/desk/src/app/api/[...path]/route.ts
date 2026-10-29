import { getDesk } from "@/server/desk";
import { checkFetchSite, checkHost } from "@/server/security";
import { defaultUser, route } from "@/server/router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Ein Browser-Lauf wartet bis zum Anmelde-Zeitlimit (Standard 10 Minuten) auf den Menschen: kein vorzeitiges Zeitlimit.
export const maxDuration = 3600;

async function handler(req: Request): Promise<Response> {
  const desk = await getDesk();
  const url = new URL(req.url);
  if (!checkFetchSite(req)) return Response.json({ error: "Anfrage von fremdem Ursprung abgelehnt" }, { status: 403 });
  if (url.pathname === "/api/session") {
    if (!checkHost(req, desk.hosts)) return Response.json({ error: "Host nicht erlaubt" }, { status: 403 });
    if (!desk.session.mayIssue(req)) return Response.json({ error: "Startadresse erforderlich: bitte die Adresse mit ?launch=... aus dem Terminal oeffnen, in dem secret-desk gestartet wurde. Im Container: docker compose logs secret-desk", code: "launch-required" }, { status: 401, headers: { "cache-control": "no-store" } });
    return Response.json({ csrf: desk.session.csrf, user: defaultUser(), demo: desk.demo, owner: desk.rt.owner }, { headers: { "set-cookie": desk.session.cookieHeader(), "cache-control": "no-store" } });
  }
  return route(req, desk);
}

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
