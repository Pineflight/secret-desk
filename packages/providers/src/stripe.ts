import {
  contextKind,
  listStripeAccounts,
  SecretValue,
  STRIPE_ACCOUNT_PATTERN,
  stripeConnectionId,
  stripeModeForStage,
  type Check,
  type ConnectionStore,
  type DiscoverContext,
  type DiscoveredOption,
  type ParamSpec,
  type PreflightContext,
  type PreflightResult,
  type Provider,
  type StageKind,
} from "@secret-desk/core";
import { check, isRecord, probeWithConnection, sameSet, step, strings } from "./checks.js";
import { unknownKind } from "./discover.js";
import { badResponse, callWithToken, optionalString, ProviderError, requireString, requireStringArray, seg, type CallContext } from "./http.js";

const API = "https://api.stripe.com/v1/webhook_endpoints";
const ACCOUNT_API = "https://api.stripe.com/v1/account";
const ID = "stripe-webhook-secret";

const specs: ParamSpec[] = [
  { key: "url", label: "Endpunkt-Adresse", labelEn: "Endpoint URL", type: "url", required: true, help: "https-Adresse, an die Stripe die Ereignisse sendet.", helpEn: "https address Stripe sends the events to." },
  { key: "events", label: "Ereignisse", labelEn: "Events", type: "stringList", required: true, help: "Abonnierte Ereignisse, zum Beispiel checkout.session.completed.", helpEn: "Subscribed events, for example checkout.session.completed." },
  {
    key: "account",
    label: "Stripe-Konto",
    labelEn: "Stripe account",
    type: "string",
    required: false,
    pattern: "^acct_[A-Za-z0-9]+$",
    discover: "stripe.account",
    help: "Konto-Id (acct_...) des Produkts. Mit Angabe nutzt der Eintrag die Verbindung dieses Kontos im Modus der Stage und lehnt jedes andere Konto ab. Ohne Angabe richtet sich die Verbindung nur nach der Stage.",
    helpEn: "Account id (acct_...) of the product. With it, the entry uses that account's connection in the stage's mode and refuses any other account. Without it, the connection follows the stage only.",
  },
  {
    key: "connection",
    label: "Verbindung",
    labelEn: "Connection",
    type: "enum",
    required: false,
    help: "Nur setzen, um die Verbindung zu erzwingen. Sonst richtet sie sich nach der Art der Stage.",
    helpEn: "Only set to force the connection. Otherwise it follows the kind of the stage.",
    options: [
      { value: "stripe", label: "Stripe (allgemein)", labelEn: "Stripe (general)" },
      { value: "stripe-test", label: "Stripe (Sandbox)", labelEn: "Stripe (sandbox)" },
      { value: "stripe-live", label: "Stripe (Live)", labelEn: "Stripe (live)" },
    ],
  },
];

/** Account the entry is bound to (`account`), if any. */
function accountOf(params: Record<string, unknown>): string | undefined {
  const a = optionalString(ID, params, "account");
  if (a !== undefined && !STRIPE_ACCOUNT_PATTERN.test(a)) throw new ProviderError(ID, null, 'Parameter "account" muss eine Konto-Id wie acct_1AbC sein');
  return a;
}

/**
 * Verbindung des Eintrags: ausdruecklicher Parameter `connection`; sonst mit `account` die Verbindung dieses Kontos im Modus
 * der Stage (live -> live, test und dev -> sandbox); sonst nach Art der Stage die getrennte Verbindung (test -> stripe-test,
 * live -> stripe-live), falls verbunden, sonst die allgemeine Verbindung `stripe`.
 */
async function connectionOf(ctx: { params: Record<string, unknown>; connections: ConnectionStore }, kind: StageKind): Promise<string> {
  const explicit = optionalString(ID, ctx.params, "connection");
  if (explicit) return explicit;
  const account = accountOf(ctx.params);
  if (account) {
    const mode = stripeModeForStage(kind);
    if (!mode) throw new ProviderError(ID, null, 'Eine Stage der Art shared hat keinen Stripe-Modus: den Parameter "connection" setzen');
    return stripeConnectionId(account, mode);
  }
  const specific = kind === "test" ? "stripe-test" : kind === "live" ? "stripe-live" : null;
  if (specific && (await ctx.connections.status(specific)).connected) return specific;
  return "stripe";
}

/** The account id the connection's key belongs to (`GET /v1/account`). */
async function connectionAccount(ctx: CallContext, connection: string): Promise<string> {
  const res = await callWithToken<{ id?: string }>(ID, ctx, connection, ACCOUNT_API, { method: "GET" });
  if (!res || typeof res.id !== "string") throw badResponse(ID);
  return res.id;
}

function accountMismatchText(connection: string, want: string, have: string): string {
  return `Die Verbindung ${connection} gehoert zum Stripe-Konto ${have}, der Eintrag verlangt ${want}`;
}

async function discoverStripe(kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  if (kind !== "stripe.account") return unknownKind(kind);
  const modeText = (m: string): string => (m === "live" ? "Live" : "Sandbox");
  return (await listStripeAccounts(ctx.connections)).map((a) => ({ value: a.id, label: a.name ?? a.id, detail: `${a.id}, ${a.modes.map(modeText).join(" + ")}` }));
}

async function preflightStripe(ctx: PreflightContext): Promise<PreflightResult> {
  const account = accountOf(ctx.params);
  if (!account) return { resource: null, findings: [] };
  const connection = await connectionOf(ctx, contextKind(ctx));
  const have = await connectionAccount(ctx, connection);
  if (have !== account) return { resource: `Stripe-Konto ${account}`, findings: [{ id: "account", level: "fail", label: "Die Verbindung gehoert zu einem anderen Stripe-Konto", detail: accountMismatchText(connection, account, have) }] };
  return { resource: `Stripe-Konto ${account}`, findings: [{ id: "account", level: "ok", label: `Die Verbindung ${connection} gehoert zum Stripe-Konto ${account}` }] };
}

export const stripeWebhookProvider: Provider = {
  id: ID,
  label: "Stripe Webhook-Secret",
  kind: "automatic",
  connection: "stripe",
  params: specs,
  discover: discoverStripe,
  preflight: preflightStripe,
  async issue(ctx) {
    const url = requireString(ID, ctx.params, "url");
    const events = requireStringArray(ID, ctx.params, "events");
    const connection = await connectionOf(ctx, contextKind(ctx));
    // The mistake this guards against: a webhook created in the wrong Stripe account. Refuse before anything is created.
    const account = accountOf(ctx.params);
    if (account) {
      const have = await connectionAccount(ctx, connection);
      if (have !== account) throw new ProviderError(ID, null, accountMismatchText(connection, account, have));
    }
    const form = new URLSearchParams();
    form.append("url", url);
    for (const e of events) form.append("enabled_events[]", e);
    const res = await callWithToken<{ id?: string; secret?: string }>(ID, ctx, connection, API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res || typeof res.secret !== "string" || typeof res.id !== "string") throw badResponse(ID);
    return { value: new SecretValue(res.secret), externalId: res.id, expiresAt: null };
  },
  verify(ctx) {
    return step(ctx, "status", "Endpunkt beim Anbieter", async () => {
      const connection = await connectionOf(ctx, contextKind(ctx));
      const accountChecks: Check[] = [];
      const account = accountOf(ctx.params);
      if (account) {
        const a = await probeWithConnection(ID, ctx, connection, ACCOUNT_API);
        const have = a.status >= 200 && a.status < 300 && isRecord(a.json) && typeof a.json["id"] === "string" ? a.json["id"] : undefined;
        accountChecks.push(
          have === undefined
            ? check("account", "Stripe-Konto", "warn", { expected: account, actual: `HTTP ${a.status}`, detail: "Konto der Verbindung nicht lesbar" })
            : check("account", "Stripe-Konto", have === account ? "pass" : "fail", { expected: account, actual: have, ...(have === account ? {} : { detail: accountMismatchText(connection, account, have) }) }),
        );
      }
      if (!ctx.externalId) return [...accountChecks, check("status", "Endpunkt beim Anbieter", "warn", { detail: "Keine Endpunkt-Kennung, nichts abrufbar" })];
      const r = await probeWithConnection(ID, ctx, connection, `${API}/${seg(ctx.externalId)}`);
      if (r.status < 200 || r.status >= 300 || !isRecord(r.json)) {
        return [...accountChecks, check("status", "Endpunkt beim Anbieter", r.status === 404 ? "fail" : "warn", { actual: `HTTP ${r.status}`, detail: "Endpunkt konnte nicht gelesen werden" })];
      }
      const e = r.json;
      const out: Check[] = [...accountChecks];
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
      typeof secret.params["account"] === "string" ? `Das Stripe-Konto ist ${secret.params["account"]}` : "Das Stripe-Konto ist das des richtigen Produkts",
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
