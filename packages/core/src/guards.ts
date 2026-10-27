/**
 * Schutz fuer Variablen: Sie sind in GitHub im Klartext lesbar und stehen im Inventar. Ein Geheimnis darf dort
 * nicht landen. Die Pruefung ist eine Heuristik: block = sieht eindeutig geheim aus, warn = der Mensch muss
 * bestaetigen, dass der Wert oeffentlich ist.
 */
export interface SecretLikeFinding {
  level: "block" | "warn";
  reason: string;
}

const BLOCK_PREFIXES: [RegExp, string][] = [
  [/^sk_(live|test)_/, "Stripe Secret Key"],
  [/^rk_(live|test)_/, "Stripe Restricted Key"],
  [/^whsec_/, "Stripe Webhook-Secret"],
  [/^gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub-Token"],
  [/^github_pat_/, "GitHub-Token"],
  [/^xox[abprs]-/, "Slack-Token"],
  [/^AKIA[0-9A-Z]{16}$/, "AWS-Zugangsschluessel"],
  [/^re_[A-Za-z0-9_]{20,}/, "Resend-Key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "privater Schluessel"],
];

function jwtRole(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 3 || !value.startsWith("eyJ")) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { role?: string };
    return payload.role ?? "";
  } catch {
    return null;
  }
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function looksSecret(name: string, value: string): SecretLikeFinding | null {
  for (const [re, label] of BLOCK_PREFIXES) if (re.test(value)) return { level: "block", reason: `Sieht aus wie ein ${label}. Als Secret anlegen, nicht als Variable.` };
  const role = jwtRole(value);
  if (role === "service_role") return { level: "block", reason: "Supabase Service-Role-Schluessel. Als Secret anlegen." };
  if (role !== null) return { level: "warn", reason: "JWT (zum Beispiel Supabase Anon Key). Nur in Ordnung, wenn der Schluessel oeffentlich ist." };
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value) && entropy(value) > 4) {
    return { level: "warn", reason: "Lange zufaellige Zeichenfolge. Ist der Wert wirklich oeffentlich (zum Beispiel ein Site-Key)?" };
  }
  if (/(PASSWORD|PASSWD|PRIVATE|SECRET|_TOKEN)$/.test(name) && value.length >= 8) {
    return { level: "warn", reason: `Der Name ${name} deutet auf ein Geheimnis hin.` };
  }
  return null;
}
