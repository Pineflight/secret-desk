import { contextKind, SecretValue, type Check, type ConnectionStore, type Provider, type StageKind } from "@secret-desk/core";
import { check, isRecord, probeWithConnection, sameSet, step, strings } from "./checks.js";
import { badResponse, callWithToken, optionalString, requireString, requireStringArray, seg } from "./http.js";

const API = "https://api.stripe.com/v1/webhook_endpoints";
const ID = "stripe-webhook-secret";

/**
 * Verbindung des Eintrags: ausdruecklicher Parameter `connection`, sonst nach Art der Stage die getrennte Verbindung
 * (test -> stripe-test, live -> stripe-live), falls verbunden, sonst die allgemeine Verbindung `stripe`.
 */
async function connectionOf(ctx: { params: Record<string, unknown>; connections: ConnectionStore }, kind: StageKind): Promise<string> {
  const explicit = optionalString(ID, ctx.params, "connection");
  if (explicit) return explicit;
  const specific = kind === "test" ? "stripe-test" : kind === "live" ? "stripe-live" : null;
  if (specific && (await ctx.connections.status(specific)).connected) return specific;
  return "stripe";
}

export const stripeWebhookProvider: Provider = {
  id: ID,
  label: "Stripe Webhook-Secret",
  kind: "automatic",
  connection: "stripe",
  async issue(ctx) {
    const url = requireString(ID, ctx.params, "url");
    const events = requireStringArray(ID, ctx.params, "events");
    const form = new URLSearchParams();
    form.append("url", url);
    for (const e of events) form.append("enabled_events[]", e);
    const res = await callWithToken<{ id?: string; secret?: string }>(ID, ctx, await connectionOf(ctx, contextKind(ctx)), API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res || typeof res.secret !== "string" || typeof res.id !== "string") throw badResponse(ID);
    return { value: new SecretValue(res.secret), externalId: res.id, expiresAt: null };
  },
  verify(ctx) {
    return step(ctx, "status", "Endpunkt beim Anbieter", async () => {
      if (!ctx.externalId) return [check("status", "Endpunkt beim Anbieter", "warn", { detail: "Keine Endpunkt-Kennung, nichts abrufbar" })];
      const r = await probeWithConnection(ID, ctx, await connectionOf(ctx, contextKind(ctx)), `${API}/${seg(ctx.externalId)}`);
      if (r.status < 200 || r.status >= 300 || !isRecord(r.json)) {
        return [check("status", "Endpunkt beim Anbieter", r.status === 404 ? "fail" : "warn", { actual: `HTTP ${r.status}`, detail: "Endpunkt konnte nicht gelesen werden" })];
      }
      const e = r.json;
      const out: Check[] = [];
      out.push(check("status", "Endpunkt ist aktiv", e["status"] === "enabled" ? "pass" : "fail", { expected: "enabled", actual: String(e["status"] ?? "unbekannt") }));
      const wantUrl = typeof ctx.params["url"] === "string" ? ctx.params["url"] : undefined;
      if (wantUrl) out.push(check("url", "Endpunkt-URL", e["url"] === wantUrl ? "pass" : "fail", { expected: wantUrl, actual: typeof e["url"] === "string" ? e["url"] : "unbekannt" }));
      const wantEvents = strings(ctx.params["events"]);
      const haveEvents = strings(e["enabled_events"]);
      if (wantEvents && haveEvents) {
        const { missing, extra } = sameSet(haveEvents, wantEvents);
        const parts = [extra.length ? `Zusaetzlich: ${extra.join(", ")}` : "", missing.length ? `Fehlt: ${missing.join(", ")}` : ""].filter(Boolean);
        out.push(check("events", "Ereignisse", parts.length ? "fail" : "pass", { expected: [...wantEvents].sort().join(", "), actual: [...haveEvents].sort().join(", "), ...(parts.length ? { detail: parts.join("; ") } : {}) }));
      } else {
        out.push(check("events", "Ereignisse", "warn", { detail: "Ereignisliste fehlt in Parametern oder Antwort" }));
      }
      const live = e["livemode"];
      const actual = live === true ? "Live" : live === false ? "Sandbox" : "unbekannt";
      if (typeof live !== "boolean") out.push(check("mode", "Modus", "warn", { actual }));
      else if (contextKind(ctx) === "live") out.push(check("mode", "Modus passt zur Stage", live ? "pass" : "fail", { expected: "Live", actual }));
      else if (contextKind(ctx) === "shared") out.push(check("mode", "Modus", "info", { actual, detail: "Stage shared: Modus bitte selbst beurteilen" }));
      else out.push(check("mode", "Modus passt zur Stage", live ? "fail" : "pass", { expected: "Sandbox", actual }));
      return out;
    });
  },
  reviewChecklist(secret, ctx) {
    const url = typeof secret.params["url"] === "string" ? secret.params["url"] : undefined;
    return [
      "Das Stripe-Konto ist das des richtigen Produkts",
      (ctx?.stageKind ?? contextKind({ stage: secret.stage })) === "live" ? "Der Endpunkt liegt im Live-Modus" : "Der Endpunkt liegt in der Sandbox, nicht im Live-Modus",
      url ? `Endpunkt-URL ist ${url}` : "Endpunkt-URL stimmt mit dem Dienst ueberein",
      "Die abonnierten Ereignisse sind genau die, die der Dienst verarbeitet",
    ];
  },
  async revoke(ctx) {
    await callWithToken(ID, ctx, await connectionOf(ctx, contextKind({ stage: ctx.secret.stage })), `${API}/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

export const stripeProviders: Provider[] = [stripeWebhookProvider];
