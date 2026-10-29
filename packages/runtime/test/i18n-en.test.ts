import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateDeep, translateEn } from "../src/i18n-en.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("translateEn: spot checks", () => {
  const cases: [string, string][] = [
    ["Ungueltiges JSON", "Invalid JSON"],
    ["Feld fehlt: secretId", "Field missing: secretId"],
    ["Secret nicht gefunden: hmac-acme-app", "Secret not found: hmac-acme-app"],
    ["Stage production ist fuer diese Anfrage nicht freigegeben.", "Stage production is not approved for this request."],
    ["Verbindung \"github\" ist nicht hergestellt. Token fuer diese Sitzung eingeben", "Connection \"github\" is not established. Enter a token for this session"],
    ["Anbieter \"manual\" kann nicht automatisch erzeugen. Wert von Hand eingeben.", "Provider \"manual\" cannot generate automatically. Enter the value by hand."],
    ["Name beim Anbieter beginnt mit \"x\" und traegt das heutige Datum", "Name at the provider starts with \"x\" and carries today's date"],
    ["Ablauf ist 30 Tage nach heute", "Expiry is 30 days from today"],
    ["64 Zeichen", "64 characters"],
    ["Schluessel funktioniert", "Key works"],
    ["Fehlt: a, b", "Missing: a, b"],
    ["Fehlt: a; Zusaetzlich: b", "Missing: a; Additional: b"],
    ["Konfiguration ungueltig: server.port: Datum als JJJJ-MM-TT", "Invalid configuration: server.port: Date as YYYY-MM-DD"],
    ["Schritt 2 (click Feld \"Name\") fehlgeschlagen: Aktion nicht moeglich.", "Step 2 (click Field \"Name\") failed: Action not possible."],
    ["Die Vorlage ws-dev verweist mit \"../x\" aus dem verknuepften Ordner hinaus.", "The template ws-dev points outside the linked folder with \"../x\"."],
    ["Schluesseldatei ~/x/vault.key", "Key file ~/x/vault.key"],
    ["Already English text", "Already English text"],
    ["", ""],
  ];
  for (const [de, en] of cases) it(JSON.stringify(de), () => expect(translateEn(de)).toBe(en));
});

describe("translateDeep", () => {
  const value = { error: "Ungueltiges JSON", "Ungueltiges JSON": "x", n: 3, ok: true, none: null, list: ["Datei", { hint: "Nicht konfiguriert" }] };
  it("translates strings recursively, keys and non-strings stay", () => {
    expect(translateDeep(value, "en")).toEqual({ error: "Invalid JSON", "Ungueltiges JSON": "x", n: 3, ok: true, none: null, list: ["File", { hint: "Not configured" }] });
  });
  it("de is identical", () => {
    expect(translateDeep(value, "de")).toBe(value);
  });
  it("does not change the input", () => {
    const copy = JSON.parse(JSON.stringify(value));
    translateDeep(value, "en");
    expect(value).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Abdeckung: jeder deutsche Text im Quelltext braucht einen Katalogeintrag.
// ---------------------------------------------------------------------------

type Literal = { text: string; line: number };

/** Kleiner Scanner: Kommentare, Regex-Literale, Strings, verschachtelte Templates. `${...}` wird durch "1" ersetzt. */
function scanLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  const n = src.length;
  let i = 0;
  let prev = "";
  const lineOf = (pos: number): number => src.slice(0, pos).split("\n").length;
  const unescape = (c: string | undefined): string => (c === "n" ? "\n" : c === "t" ? "\t" : (c ?? ""));

  function readString(q: string): void {
    const start = i;
    i++;
    let s = "";
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") {
        s += unescape(src[i + 1]);
        i += 2;
      } else s += src[i++];
    }
    i++;
    out.push({ text: s, line: lineOf(start) });
  }
  function readTemplate(): void {
    const start = i;
    i++;
    const parts: string[] = [];
    let s = "";
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") {
        s += unescape(src[i + 1]);
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        parts.push(s);
        s = "";
        scanCode(true);
      } else s += src[i++];
    }
    i++;
    parts.push(s);
    out.push({ text: parts.join("1"), line: lineOf(start) });
  }
  function scanCode(inTemplate: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i = src.indexOf("*/", i + 2) + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        readString(c);
        prev = "str";
        continue;
      }
      if (c === "`") {
        readTemplate();
        prev = "str";
        continue;
      }
      if (c === "/") {
        const operandBefore = prev === "id" || prev === "num" || prev === ")" || prev === "]" || prev === "str" || prev === "}";
        if (!operandBefore) {
          i++;
          let inClass = false;
          while (i < n) {
            if (src[i] === "\\") {
              i += 2;
              continue;
            }
            if (src[i] === "[") inClass = true;
            else if (src[i] === "]") inClass = false;
            else if (src[i] === "/" && !inClass) break;
            i++;
          }
          i++;
          while (/[a-z]/.test(src[i] ?? "")) i++;
          prev = "regex";
          continue;
        }
        i++;
        prev = "op";
        continue;
      }
      if (inTemplate) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) {
            i++;
            prev = "}";
            return;
          }
          depth--;
        }
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (/[\w$]/.test(src[j] ?? "")) j++;
        prev = /^(return|typeof|case|in|of|else|do|void|throw|new|delete|yield|await)$/.test(src.slice(i, j)) ? "kw" : "id";
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (/[\w.]/.test(src[i] ?? "")) i++;
        prev = "num";
        continue;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      prev = c === ")" || c === "]" || c === "}" ? c : "op";
      i++;
    }
  }
  scanCode(false);
  return out;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Umlaute oder typische (transliterierte) deutsche Woerter. */
const GERMAN =
  /[äöüß]|\b(nicht|ist|der|die|das|und|fuer|wird|werden|kein|keine|keinen|fehlt|fehlgeschlagen|ungueltig\w*|ungueltige\w*|existiert|schon|oder|ohne|muss|nur|beim|vom|zum|zur|noch|bitte|gefunden|erwartet|Schluessel\w*|Anbieter|Pruefung\w*|Pruefen|Ordner|Pfad|Datei|Wert\w*|Rechte|Ablauf\w*|Ziel\w*|Anfrage|Freigabe\w*|Zeichen|Praefix|Verbindung|Bestaetig\w*|abgelaufen|Tage|Tagen|Hinweis\w*|Zugang|Konto|Fehler|Von Hand|Sollwert|Kennung|Modus|Herkunft|Ereignisse|Endpunkt\w*|unbekannt\w*|gesetzt|leer|Abgebrochen|Abgelehnt|Berechtigung|Tresor\w*|Schluesselbund)\b/i;

/** Bewusst nicht uebersetzt: Dateien, in denen nutzerlesbare Texte rohe Ausgabe sind (kein JSON-Body). */
const EXEMPT_FILES = [
  // Beleg als SVG: Markup und Labels werden unveraendert als image/svg+xml ausgeliefert.
  "core/src/verification.ts",
];
/** Bewusst nicht uebersetzt: einzelne Literale (exakt), jeweils mit Grund. */
const EXEMPT_LITERALS: Record<string, string> = {
  // .env-Datei-Kommentare und Team-YAML-Kopf: Dateiinhalt, kein API-Text.
  "# Erzeugt von secret-desk am 1 fuer 1 (1).": "env-export.ts: Kopfzeile der .env-Datei",
  "# Enthaelt Geheimnisse. Nicht committen, nicht weitergeben.": "env-export.ts: Kommentar in der .env-Datei",
  "# secret-desk Team-Konfiguration": "team.ts: YAML-Kopf",
  "# Enthaelt KEINE Werte. Import: secret-desk team import <datei>": "team.ts: YAML-Kopf",
  "# Danach Konten verbinden und `secret-desk env export --repo <repo> --stage dev` ausfuehren.": "team.ts: YAML-Kopf",
  // Kennungen, Klassen, Header (enthalten deutsche Woerter, sind aber Code).
  "Stripe Webhook-Secret": "Produktname",
  "1Password": "Produktname",
};

describe("coverage: every German source text has an English catalog entry", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const pkg of ["core", "providers", "runtime", "automation"]) {
    for (const file of tsFiles(join(PACKAGES, pkg, "src"))) {
      const rel = relative(PACKAGES, file).split("\\").join("/");
      if (rel.endsWith("runtime/src/i18n-en.ts") || EXEMPT_FILES.includes(rel)) continue;
      for (const lit of scanLiterals(readFileSync(file, "utf8"))) {
        if (!GERMAN.test(lit.text) || lit.text.includes("\u0000")) continue;
        if (lit.text in EXEMPT_LITERALS) continue;
        checked++;
        if (translateEn(lit.text) === lit.text) missing.push(`${rel}:${lit.line}  ${JSON.stringify(lit.text)}`);
      }
    }
  }
  it("scanner finds the texts (plausibility)", () => {
    expect(checked).toBeGreaterThan(250);
  });
  it("no German text without an entry", () => {
    expect(missing).toEqual([]);
  });
});
