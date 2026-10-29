import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { SecretValue, type Check, type ParamSpec, type Provider, type VerifyContext } from "@secret-desk/core";
import { check } from "./checks.js";
import { ProviderError } from "./http.js";

function bytesParam(id: string, params: Record<string, unknown>): number {
  const v = params["bytes"] ?? 32;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 8 || v > 128) {
    throw new ProviderError(id, null, 'Parameter "bytes" muss eine ganze Zahl von 8 bis 128 sein');
  }
  return v;
}

type Shape = (value: string, bytes: number) => { ok: boolean; expected: string; actual: string };

const hexShape: Shape = (v, n) => ({ ok: v.length === 2 * n && /^[0-9a-f]+$/i.test(v), expected: `${2 * n} Hexzeichen`, actual: `${v.length} Zeichen` });
const base64Shape: Shape = (v, n) => ({ ok: v.length === 4 * Math.ceil(n / 3) && /^[A-Za-z0-9+/]+={0,2}$/.test(v), expected: `${4 * Math.ceil(n / 3)} Zeichen base64`, actual: `${v.length} Zeichen` });
const uuidShape: Shape = (v) => ({ ok: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), expected: "UUID-Format", actual: `${v.length} Zeichen` });

function verifyLocal(shape: Shape) {
  return async (ctx: VerifyContext): Promise<Check[]> => {
    const raw = ctx.params["bytes"] ?? 32;
    const bytes = typeof raw === "number" && Number.isInteger(raw) ? raw : 32;
    const r = shape(ctx.value.reveal(), bytes);
    return [
      check("shape", "Laenge und Format", r.ok ? "pass" : "fail", { expected: r.expected, actual: r.actual }),
      check("local", "Herkunft", "info", { detail: "Zufaellig lokal erzeugt, kein Anbieter" }),
    ];
  };
}

const LOCAL_CHECKLIST = ["Der Wert wird in allen Zielen derselbe sein", "Alle Verbraucher (Worker, Funktionen) werden nach dem Schreiben neu deployt"];

const BYTES: ParamSpec[] = [{ key: "bytes", label: "Laenge in Bytes", labelEn: "Length in bytes", type: "integer", required: false, min: 8, max: 128, help: "8 bis 128, Standard 32.", helpEn: "8 to 128, default 32." }];

function local(id: string, label: string, shape: Shape, make: (params: Record<string, unknown>) => string): Provider {
  return {
    id,
    label,
    kind: "automatic",
    ...(id === "random-uuid" ? {} : { params: BYTES }),
    verify: verifyLocal(shape),
    reviewChecklist: () => [...LOCAL_CHECKLIST],
    async issue(ctx) {
      return { value: new SecretValue(make(ctx.params)), expiresAt: null };
    },
  };
}

export const randomProviders: Provider[] = [
  local("random-hex", "Zufallswert (hex)", hexShape, (p) => randomBytes(bytesParam("random-hex", p)).toString("hex")),
  local("random-base64", "Zufallswert (base64)", base64Shape, (p) => randomBytes(bytesParam("random-base64", p)).toString("base64")),
  local("random-uuid", "Zufalls-UUID", uuidShape, () => randomUUID()),
];

/** VAPID-Schluesselpaar fuer Web Push: oeffentlich = unkomprimierter P-256-Punkt, privat = 32 Byte, beides base64url. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const priv = Buffer.alloc(32);
  ecdh.getPrivateKey().copy(priv, 32 - ecdh.getPrivateKey().length);
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: priv.toString("base64url") };
}
