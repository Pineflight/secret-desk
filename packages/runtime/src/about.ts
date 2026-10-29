import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AboutInfo {
  name: string;
  version: string;
  /** Release-Tag oder null (nur im Docker-Image per SECRET_DESK_BUILD_TAG gesetzt). */
  buildTag: string | null;
  commit: string | null;
  description: string;
  createdBy: string;
  license: string;
  licenseText: string;
  links: { source: string; issues: string; security: string; support: string };
  thirdParty: { name: string; version: string; license: string; source: string; status: string }[];
  platformFamilies: string[];
  /** Pruefbar durch den Test about.test.ts: der Quelltext enthaelt keine Telemetrie und keine Adresse eines Pineflight-Servers. */
  privacy: { telemetry: false; pineflightServers: false };
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * Angaben fuer "Ueber secret-desk": Version aus package.json (oder SECRET_DESK_VERSION), Lizenztext aus LICENSE, Drittlizenzen aus
 * third-party.json (erzeugt von scripts/licenses.mjs). Nur lokale Dateien, kein Netzwerk. `rootDir` = Repository (oder /app im Image).
 */
export function readAbout(options: { rootDir: string; thirdPartyFile: string; env?: NodeJS.ProcessEnv }): AboutInfo {
  const env = options.env ?? process.env;
  let pkg: { name?: string; version?: string; description?: string; license?: string; homepage?: string; bugs?: string; repository?: string } = {};
  try {
    pkg = JSON.parse(readText(join(options.rootDir, "package.json"))) as typeof pkg;
  } catch {
    /* ohne package.json: Standardwerte */
  }
  let third: { components?: AboutInfo["thirdParty"]; platformFamilies?: string[] } = {};
  try {
    third = JSON.parse(readText(options.thirdPartyFile)) as typeof third;
  } catch {
    /* Datei fehlt: leere Liste */
  }
  const text = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const source = "https://github.com/Pineflight/secret-desk";
  return {
    name: "secret-desk",
    version: text(env["SECRET_DESK_VERSION"]) ?? pkg.version ?? "0.0.0",
    buildTag: text(env["SECRET_DESK_BUILD_TAG"]),
    commit: text(env["SECRET_DESK_COMMIT"])?.slice(0, 12) ?? null,
    description: pkg.description ?? "",
    createdBy: "Pineflight",
    license: pkg.license ?? "MIT",
    licenseText: readText(join(options.rootDir, "LICENSE")),
    links: { source, issues: `${source}/issues`, security: `${source}/security/policy`, support: `${source}/blob/main/SUPPORT.md` },
    thirdParty: third.components ?? [],
    platformFamilies: third.platformFamilies ?? [],
    privacy: { telemetry: false, pineflightServers: false },
  };
}
