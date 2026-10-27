# Team

## Konfigurationsdatei verteilen
`secret-desk team export --config secret-desk.config.yaml --out secret-desk.team.yaml` (oder im Portal: Team, Herunterladen).
Die Datei enthaelt die Struktur: Stage-Definitionen (`stages:`), Secrets (Name, Stage, Anbieter, Ziele), Variablen mit Sollwerten, Dev-Vorlagen, eigene Anbieter.
**Keine Werte** und keine anbieterinternen Kennungen.

## Neues Teammitglied
1. Repo klonen, `pnpm install`, `pnpm build`.
2. `secret-desk team import secret-desk.team.yaml --inventory inventory.yaml`.
3. Eigene Konfiguration anlegen (GitHub-Zugang, Anbieter-Verbindungen).
4. Dev-Umgebung je Repo: `secret-desk env export --config secret-desk.config.yaml --repo <repo>`.
   Sie enthaelt Defaults und Variablen aus dem Inventar, Zufallswerte und **persoenliche** Dev-Tokens, die dein Konto beim Anbieter erzeugt.
   Werte, die du selbst liefern musst (zum Beispiel ein Sandbox-Key), werden abgefragt (`--prompt KEY=WERT`).

Die `.env` entsteht auf deinem Rechner mit Modus 600. Das Portal speichert sie nicht.

## Stages im Team
Die Stage-Definitionen werden mit exportiert. Beim Import (merge) kommen unbekannte Stage-Ids dazu, vorhandene bleiben unveraendert (keine stille Aenderung von Art oder Environment); `--replace` uebernimmt die Liste der Datei komplett.
