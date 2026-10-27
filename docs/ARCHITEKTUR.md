# Architektur

## Der Weg eines neuen Werts

```
Anbieter-API ──> Wert im Arbeitsspeicher ──> Pruefung ──> Pruefbericht + Beleg-Bild
                                                              │
                     Mensch hakt Pruefpunkte ab (Anlage optional)
                                                              ▼
                     GitHub schreiben (verschluesselt) ──> Nachpruefung ──> alten Wert widerrufen ──> Inventar + Bericht
```

1. **Vorbereiten** (`prepareIssuance`): Der Anbieter-Baustein erzeugt den Wert (oder der Mensch fuegt ihn ein). Das Portal prueft:
   Laenge, Ziele erreichbar mit Schreibrecht, anbieterspezifische Befunde (aktiv, Rechte, Ablauf, Modus). Ergebnis ist ein
   **Pruefbericht** (nur Metadaten) und ein **Beleg-Bild** (SVG). Der Wert bleibt **hoechstens 15 Minuten im Arbeitsspeicher**.
   In GitHub ist nichts geschrieben, am alten Wert nichts widerrufen.
2. **Bestaetigen** (`commitIssuance`): Alle Pruefpunkte muessen abgehakt sein, ein fehlgeschlagener automatischer Befund blockiert
   (ausser mit `force`). Dann: in alle Ziele schreiben, nachpruefen (Name vorhanden, gerade geaendert), alten Wert beim Anbieter
   widerrufen, `rotatedAt`, `expires`, `verifiedAt`, `verifiedBy` im Inventar eintragen, Bericht mit Bestaetigung speichern.
   Schlaegt ein Ziel fehl, bleibt der alte Wert gueltig und die Pruefung offen.
3. **Verwerfen** (`discardIssuance`): bei Ablehnen oder Zeitablauf wird der neue Wert beim Anbieter wieder geloescht. Nichts wurde geschrieben.

## Daten

- **Inventar** (`inventory.yaml`, Git): Secrets (Name, Stage, Anbieter, Ablauf, Ziele), Variablen (inkl. Sollwert), Dev-Vorlagen, eigene Anbieter.
  Nur Metadaten und Konfiguration, nie ein geheimer Wert.
- **Pruefberichte und Anlagen** (`.secret-desk-evidence/`, nicht im Git): Berichte als JSON, Screenshots als PNG/JPEG/WebP bis 5 MB.
- **Arbeitsspeicher:** ausgestellte, noch nicht bestaetigte Werte, Zugangs-Tokens der Sitzung, offene Freigaben.

## Plattformen
Pfad-, Rechte- und Schluesselfragen stecken in `packages/core/src/platform.ts` (`securePrivateFile`, `ensurePrivateDir`, `writePrivateFile`,
`expandHome`, `isPathInside`, `realpathLoose`, `localPathProblem`, `sanitizeFileName`) und in den `KeySource`s von `vault.ts` (macOS Keychain,
Linux `secret-tool`, Windows DPAPI per PowerShell, optionale Schluesseldatei). Alles nimmt `platform` (und bei Befehlen eine `exec`-Funktion) als
Parameter, damit sich Windows- und Linux-Verhalten auf jedem System mit `path.win32`/`path.posix` und einem gefaelschten Exec testen laesst.
Befehle starten nur: `git` (runtime/core), `op` (core), `security`/`secret-tool`/`powershell.exe` (core, Tresor), Chrome (Playwright). Skripte im Repo
sind Node-Dateien unter `scripts/` (`clean.mjs`, `demo.mjs`), keine Shell-Zeilen.

## Repositories und Verknuepfungen

- Die Seite **Repositories** (`/repos`) fuehrt Inventar (Secrets, Variablen, Vorlagen), GitHub live (`GET repos?live=1`, nur Name und Metadaten)
  und lokale Verknuepfungen zusammen. Ohne GitHub-Verbindung bleibt es still bei Inventar und Verknuepfungen.
- Eine **Verknuepfung** ordnet einem Repository einen Ordner auf diesem Rechner zu. Sie steht in `~/.secret-desk/repo-links.json`
  (Modus 600, Ordner 700; Konfigurationsfeld `linksFile`), nie im geteilten Inventar. Der Server prueft Pfad, `.git` und den Remote
  (`git remote get-url origin`, Abweichung nur als Warnung).
- **Lokal suchen** durchsucht `policy.envRoots` bis Tiefe 2 nach Git-Ordnern, deren origin auf den konfigurierten Eigentuemer zeigt, und
  schlaegt Verknuepfungen vor. Uebernommen wird nur auf Klick.
- Dev-Seite und `env-export` nehmen bei verknuepftem Repository `<Ordner>/<Vorlagendatei>` als Standardpfad. Ein angegebener Pfad geht vor.
- Endpunkte (nur Portal): `PUT repos/:name/link`, `DELETE repos/:name/link`, `POST repos/scan`. Agenten duerfen nur `GET repos` (ohne Pfade).
- Die Repository-Felder in den Formularen sind Auswahlfelder (Inventar, GitHub, verknuepft); freie Eingabe bleibt moeglich.

## Stages

Stages sind frei konfigurierbar: Abschnitt `stages:` im Inventar (Portal: Einstellungen). Eine Definition: `id` (Slug), `label` (Anzeigename), `kind`, `environment` (Name der GitHub-Environment) und `tone` (Farbe). Ohne `stages:` gelten `dev`, `staging`, `production`, `shared`.

Das Verhalten haengt am `kind`, nie am Namen:

| kind | Bedeutung |
|---|---|
| `dev` | lokal: kein GitHub-Ziel noetig, Agenten duerfen direkt (nach `policy.agentStages`, Standard alle dev-Stages), Dev-.env |
| `test` | Sandbox/Test: Anbieter-Schluessel sollen im Test-Modus sein |
| `live` | Produktionsgrad: Agenten brauchen immer eine Freigabe, Schluessel im Live-Modus, warnende Optik |
| `shared` | gilt fuer alle (zum Beispiel Repository-Secret), Modus wird nicht geprueft |

`environment` fehlt: bei `test`/`live` die `id`, bei `dev`/`shared` keine. `null` = ausdruecklich keine. Bei Bereich `environment` ohne Namen setzt secret-desk die Environment der Stage ein (nur mit Namen, wenn abweichend). Staging und Production teilen nie einen Wert. Maximal 12 Stages; Entfernen geht nur, wenn kein Secret, keine Variable, keine Vorlage und keine Richtlinie die Stage nennt. Der Bereich `organization` ist im Schema, aber nicht im Portal-Formular: Org-Secrets brauchen eine Repository-Auswahl, die noch nicht modelliert ist.

## Pakete

`core` kennt keine Oberflaeche. `runtime` fasst die Operationen zusammen und setzt die Richtlinie durch (`agent-api.ts`).
CLI, Portal-API und MCP-Server nutzen nur `runtime`. Das Portal und der MCP-Server sprechen dieselbe Routing-Schicht
(`apps/desk/src/server/router.ts`): `/api/ui/*` fuer den Menschen, `/api/agent/*` fuer Agenten.
