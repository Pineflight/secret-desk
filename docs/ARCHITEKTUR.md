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

`dev` (lokal, kein GitHub-Ziel), `staging`, `production`, `shared` (Repository-Secret, gilt fuer alle). Staging und Production teilen nie einen Wert.

## Pakete

`core` kennt keine Oberflaeche. `runtime` fasst die Operationen zusammen und setzt die Richtlinie durch (`agent-api.ts`).
CLI, Portal-API und MCP-Server nutzen nur `runtime`. Das Portal und der MCP-Server sprechen dieselbe Routing-Schicht
(`apps/desk/src/server/router.ts`): `/api/ui/*` fuer den Menschen, `/api/agent/*` fuer Agenten.
