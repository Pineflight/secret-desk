import { getDesk } from "@/server/desk";
import { checkHost } from "@/server/security";
import { route } from "@/server/router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handler(req: Request): Promise<Response> {
  const desk = await getDesk();
  const url = new URL(req.url);
  if (url.pathname === "/api/session") {
    if (!checkHost(req, desk.hosts)) return Response.json({ error: "Host nicht erlaubt" }, { status: 403 });
    return Response.json({ csrf: desk.session.csrf, user: process.env.SECRET_DESK_USER ?? "niklas", demo: desk.demo, owner: desk.rt.owner }, { headers: { "set-cookie": desk.session.cookieHeader(), "cache-control": "no-store" } });
  }
  return route(req, desk);
}

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
