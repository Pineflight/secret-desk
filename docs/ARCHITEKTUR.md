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

## Stages

`dev` (lokal, kein GitHub-Ziel), `staging`, `production`, `shared` (Repository-Secret, gilt fuer alle). Staging und Production teilen nie einen Wert.

## Pakete

`core` kennt keine Oberflaeche. `runtime` fasst die Operationen zusammen und setzt die Richtlinie durch (`agent-api.ts`).
CLI, Portal-API und MCP-Server nutzen nur `runtime`. Das Portal und der MCP-Server sprechen dieselbe Routing-Schicht
(`apps/desk/src/server/router.ts`): `/api/ui/*` fuer den Menschen, `/api/agent/*` fuer Agenten.
