import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { SecretValue, type Provider } from "@secret-desk/core";
import { ProviderError } from "./http.js";

function bytesParam(id: string, params: Record<string, unknown>): number {
  const v = params["bytes"] ?? 32;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 8 || v > 128) {
    throw new ProviderError(id, null, 'Parameter "bytes" muss eine ganze Zahl von 8 bis 128 sein');
  }
  return v;
}

function local(id: string, label: string, make: (params: Record<string, unknown>) => string): Provider {
  return {
    id,
    label,
    kind: "automatic",
    async issue(ctx) {
      return { value: new SecretValue(make(ctx.params)), expiresAt: null };
    },
  };
}

export const randomProviders: Provider[] = [
  local("random-hex", "Zufallswert (hex)", (p) => randomBytes(bytesParam("random-hex", p)).toString("hex")),
  local("random-base64", "Zufallswert (base64)", (p) => randomBytes(bytesParam("random-base64", p)).toString("base64")),
  local("random-uuid", "Zufalls-UUID", () => randomUUID()),
];

/** VAPID-Schluesselpaar fuer Web Push: oeffentlich = unkomprimierter P-256-Punkt, privat = 32 Byte, beides base64url. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const priv = Buffer.alloc(32);
  ecdh.getPrivateKey().copy(priv, 32 - ecdh.getPrivateKey().length);
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: priv.toString("base64url") };
}
