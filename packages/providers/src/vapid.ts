import { createECDH } from "node:crypto";
import { SecretValue, type Check, type ParamSpec, type Provider } from "@secret-desk/core";
import { check } from "./checks.js";
import { ProviderError, requireString } from "./http.js";
import { generateVapidKeys } from "./random.js";

const ID = "vapid-keypair";

const specs: ParamSpec[] = [
  {
    key: "publicKeyVariable",
    label: "Variable fuer den oeffentlichen Schluessel",
    labelEn: "Variable for the public key",
    type: "string",
    required: true,
    pattern: "^[a-z0-9][a-z0-9-]*$",
    help: "Id der Variable (Inventar), die den oeffentlichen Schluessel aus derselben Ausstellung bekommt, zum Beispiel VAPID_PUBLIC_KEY.",
    helpEn: "Inventory id of the variable that receives the public key from the same issuance, for example VAPID_PUBLIC_KEY.",
  },
];

/** Public key (uncompressed P-256 point, base64url) belonging to a private key (raw 32-byte scalar, base64url). */
export function vapidPublicKeyOf(privateKey: string): string {
  const raw = Buffer.from(privateKey, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== privateKey) throw new ProviderError(ID, null, "Privater Schluessel ist kein base64url-Wert von 32 Byte");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(raw);
  return ecdh.getPublicKey().toString("base64url");
}

export const vapidProvider: Provider = {
  id: ID,
  label: "VAPID-Schluesselpaar fuer Web Push (privat als Secret, oeffentlich als Variable)",
  kind: "automatic",
  params: specs,
  companionParams: ["publicKeyVariable"],
  async issue(ctx) {
    const target = requireString(ID, ctx.params, "publicKeyVariable");
    const keys = generateVapidKeys();
    // The pair is checked before anything is shown: a private key that does not derive the public key is never offered.
    if (vapidPublicKeyOf(keys.privateKey) !== keys.publicKey) throw new ProviderError(ID, null, "Das erzeugte Schluesselpaar passt nicht zusammen");
    return {
      value: new SecretValue(keys.privateKey),
      expiresAt: null,
      companions: [{ entryId: target, value: new SecretValue(keys.publicKey), kind: "variable" }],
    };
  },
  async verify(ctx) {
    const v = ctx.value.reveal();
    const out: Check[] = [];
    let derived: string | undefined;
    try {
      derived = vapidPublicKeyOf(v);
      out.push(check("shape", "Privater Schluessel", "pass", { expected: "32 Byte, base64url", actual: `${v.length} Zeichen` }));
    } catch {
      out.push(check("shape", "Privater Schluessel", "fail", { expected: "32 Byte, base64url", actual: `${v.length} Zeichen` }));
    }
    if (derived) {
      const point = Buffer.from(derived, "base64url");
      out.push(check("public", "Oeffentlicher Schluessel ableitbar", point.length === 65 && point[0] === 4 ? "pass" : "fail", { expected: "65 Byte, unkomprimierter Punkt", actual: `${point.length} Byte` }));
    }
    out.push(check("local", "Herkunft", "info", { detail: "Lokal erzeugt, kein Anbieter" }));
    out.push(check("subscriptions", "Bestehende Push-Abonnements", "warn", { detail: "Ein neues Paar macht alle bestehenden Abonnements ungueltig; Nutzer muessen sich neu anmelden" }));
    return out;
  },
  reviewChecklist(secret) {
    const target = typeof secret.params["publicKeyVariable"] === "string" ? secret.params["publicKeyVariable"] : undefined;
    return [
      target ? `Der oeffentliche Schluessel geht an die Variable ${target} und an keine andere` : "Der oeffentliche Schluessel geht an die vorgesehene Variable",
      "Achtung: Ein neues Paar macht alle bestehenden Push-Abonnements ungueltig, die Nutzer muessen sich neu anmelden",
      "Server und Client bekommen das neue Paar gleichzeitig (Server den privaten, Client den oeffentlichen Schluessel)",
    ];
  },
};

export const vapidProviders: Provider[] = [vapidProvider];
