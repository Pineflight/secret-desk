# secret-desk

Lokales Portal fuer Tokens, Secrets und Variablen eines Teams: **Ablauf im Blick**, neue Tokens **bei den Anbietern erzeugen**,
**pruefen und bestaetigen**, direkt in den **GitHub-Secret-Speicher des Projekts** schreiben. **Werte werden nie gespeichert.**

*Local-first portal to keep track of tokens, secrets and variables: see expiry, issue new tokens at the providers via their APIs,
review and confirm them, and write them straight into the project's GitHub secret store. Secret values are never persisted.*

## Was es kann

| | |
|---|---|
| **Uebersicht** | Alle Secrets und Variablen nach Stage (dev, staging, production, shared) und Status: ok, bald faellig, abgelaufen, fehlt. Ablauf-Issues per Workflow. |
| **Neuer Wert** | Anbieter-API erzeugt den Token, das Portal **prueft ihn** (Funktionstest, Rechte, Ablauf, Ziele erreichbar) und zeigt einen **Pruefbericht mit Beleg-Bild**. |
| **Bestaetigen** | Du hakst die Pruefpunkte ab (optional mit eigenem Screenshot). **Erst dann** wird in GitHub geschrieben und der alte Wert widerrufen. Ablehnen loescht den neuen Wert beim Anbieter wieder. |
| **Von Hand** | Anbieter ohne API: Anleitung, Wert einfuegen, gleiche Pruefung, gleiche Bestaetigung. |
| **Variablen** | `vars.*` mit Sollwert im Inventar, Abgleich mit GitHub (Soll/Ist), setzen, aus GitHub uebernehmen. Ein Schutz verhindert, dass ein Geheimnis als Variable landet. |
| **Dev-`.env`** | Pro Repo eine Vorlage. Der Export erzeugt die Datei jetzt (Defaults, Zufallswerte, persoenliche Dev-Tokens, Variablen), Modus 600, nirgends gespeichert. |
| **Team** | Eine Konfigurationsdatei ohne Werte zum Verteilen. Neue Teammitglieder importieren sie, verbinden ihre Konten und legen los. |
| **Agenten** | MCP-Server und Skill fuer KI-Agenten: Metadaten pflegen, Status abfragen, Anfragen stellen. Nie Werte, nie Bestaetigen, in staging/production nur mit Freigabe. |

## Schnellstart

```bash
pnpm install
cp examples/secret-desk.config.example.yaml secret-desk.config.yaml   # anpassen
cp examples/inventory.example.yaml inventory.yaml                    # anpassen
pnpm build
pnpm dev                                                             # http://127.0.0.1:4747
```

Das Portal lauscht nur auf `127.0.0.1`. Die Zugangs-Tokens der Anbieter gibst du pro Sitzung im Portal ein oder verweist in der
Konfiguration auf Umgebungsvariablen bzw. 1Password (`op://...`). Nie der Wert in der Datei.

CLI: `node packages/cli/dist/bin.js help` (Befehle: `check`, `status`, `renew`, `vars`, `env export`, `team`, `import-legacy`, `vapid`).

## Aufbau

```
packages/core        Inventar, Status, GitHub-Upload, Pruefablauf, Variablen, Dev-Export, Team-Datei
packages/providers   Anbieter: Cloudflare, Supabase, Stripe-Webhook, Resend, Grafana, Zufall, Anleitungen
packages/runtime     Gemeinsame Operationen und Richtlinie fuer Portal, CLI und MCP
packages/cli         Kommandozeile
packages/mcp         MCP-Server fuer KI-Agenten
apps/desk            Portal (Next.js, nur lokal)
skills/secret-desk   Skill fuer Agenten
```

Mehr: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md), [docs/SICHERHEIT.md](docs/SICHERHEIT.md), [docs/ANBIETER.md](docs/ANBIETER.md),
[docs/AGENTEN.md](docs/AGENTEN.md), [docs/TEAM.md](docs/TEAM.md).

## Status

Fruehe Version. Mehrere Anbieter-Endpunkte sind aus der Dokumentation bzw. dem Gedaechtnis umgesetzt und nur gegen Mocks getestet
(siehe docs/ANBIETER.md). Vor dem ersten echten Einsatz je Anbieter mit einem Wegwerf-Token probieren.

Lizenz: MIT.
