import { parse } from "yaml";
import type { SecretEntry, Stage, VariableEntry } from "./types.js";

/** Form des bisherigen Inventars aus ai-interlink (docs/secrets/secrets-inventory.yaml). */
interface LegacyPlace {
  repo: string;
  scope: string;
  status?: string;
  kind?: string;
  set_at?: string;
  note?: string;
}
interface LegacyCredential {
  name: string;
  service: string;
  expiry?: string;
  expires?: string | null;
  source?: string;
  rotation?: string;
  places: LegacyPlace[];
}

export interface LegacyImportOptions {
  /** Zuordnung Repo -> Produkt. */
  productOf?: (repo: string) => string | undefined;
  /** Zuordnung Name/Dienst -> Anbieter-Modul. */
  providerFor?: (name: string, service: string) => { provider: string; params?: Record<string, unknown>; ttlDays?: number };
}

export interface LegacyImportResult {
  secrets: SecretEntry[];
  /** Variablen aus dem alten Inventar, Sollwert unbekannt (null) bis sie aus GitHub uebernommen werden. */
  variables: VariableEntry[];
  skipped: { variables: number; nonGitHub: number };
}

const GITHUB_SCOPES: Record<string, { stage: Stage; environment?: string }> = {
  repo: { stage: "shared" },
  staging: { stage: "staging", environment: "staging" },
  production: { stage: "production", environment: "production" },
  "infrastructure-production": { stage: "production", environment: "infrastructure-production" },
};

const RANDOM = new Set(["ARTIFACT_HMAC_SECRET", "DISPATCH_HMAC_SECRET", "RATE_LIMIT_GEHEIMNIS", "LEAD_INTAKE_TOKEN", "LEAD_INTAKE_TOKENS", "LUPE_ADMIN_TOKEN", "BILLING_ABGLEICH_TOKEN", "BILLING_WORKER_TOKEN"]);
const VAPID = new Set(["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY_PRODUCTION", "VAPID_PUBLIC_KEY_PRODUCTION"]);

export function defaultProviderFor(name: string, service: string): { provider: string; params?: Record<string, unknown>; ttlDays?: number } {
  if (RANDOM.has(name)) return { provider: "random-hex", params: { bytes: 32 } };
  if (VAPID.has(name)) return { provider: "manual" };
  if (name === "RESEND_API_KEY" || name === "RESEND_SMTP_KEY" || name === "MAIL_API_KEY") return { provider: "resend-api-key" };
  if (name.startsWith("CLOUDFLARE_API_TOKEN")) return { provider: "cloudflare-token", ttlDays: 90 };
  if (service === "cloudflare-turnstile") return { provider: "cloudflare-turnstile" };
  return { provider: "manual" };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Wandelt das bisherige Inventar (ein Eintrag je Name, viele Stellen) in einzelne Secrets je Repo und Stage. */
export function importLegacyInventory(yamlText: string, options: LegacyImportOptions = {}): LegacyImportResult {
  const raw = parse(yamlText, { schema: "core" }) as { credentials?: LegacyCredential[] } | null;
  const credentials = raw?.credentials ?? [];
  const providerFor = options.providerFor ?? defaultProviderFor;
  const out = new Map<string, SecretEntry>();
  const vars = new Map<string, VariableEntry>();
  const skipped = { variables: 0, nonGitHub: 0 };

  for (const c of credentials) {
    for (const p of c.places) {
      const mapped = GITHUB_SCOPES[p.scope];
      if (p.kind === "variable") {
        if (!mapped) {
          skipped.nonGitHub += 1;
          continue;
        }
        const vid = slug(`var-${c.name}-${p.repo}-${mapped.stage === "shared" ? "repo" : mapped.environment ?? mapped.stage}`);
        if (!vars.has(vid)) {
          const product = options.productOf?.(p.repo);
          vars.set(vid, {
            id: vid,
            name: c.name,
            ...(product ? { product } : {}),
            stage: mapped.stage,
            value: null,
            places: [mapped.environment ? { repo: p.repo, scope: "environment", environment: mapped.environment } : { repo: p.repo, scope: "repository" }],
          });
        }
        continue;
      }
      if (!mapped) {
        skipped.nonGitHub += 1;
        continue;
      }
      const id = slug(`${c.name}-${p.repo}-${mapped.stage === "shared" ? "repo" : mapped.environment ?? mapped.stage}`);
      if (out.has(id)) continue;
      const prov = providerFor(c.name, c.service);
      const product = options.productOf?.(p.repo);
      const expiry = (["none", "possible", "required", "unknown"] as const).find((e) => e === c.expiry) ?? "unknown";
      out.set(id, {
        id,
        name: c.name,
        ...(product ? { product } : {}),
        stage: mapped.stage,
        service: c.service,
        provider: prov.provider,
        params: prov.params ?? {},
        expiry,
        expires: c.expires ?? null,
        ...(prov.ttlDays ? { ttlDays: prov.ttlDays } : {}),
        ...(c.source ? { source: c.source } : {}),
        ...(c.rotation ? { rotation: c.rotation } : {}),
        places: [
          mapped.environment
            ? { repo: p.repo, scope: "environment", environment: mapped.environment }
            : { repo: p.repo, scope: "repository" },
        ],
      });
    }
  }
  return { secrets: [...out.values()].sort((a, b) => a.id.localeCompare(b.id)), variables: [...vars.values()].sort((a, b) => a.id.localeCompare(b.id)), skipped };
}
