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
| **Beschreibungen** | Jedes Secret und jede Variable hat Beschreibung (wofür, wo genutzt), Verantwortlichen, Link und Schlagworte. Suche und Filter darüber. |
| **Variablen** | `vars.*` mit Sollwert im Inventar, Abgleich mit GitHub (Soll/Ist), setzen, aus GitHub uebernehmen. Ein Schutz verhindert, dass ein Geheimnis als Variable landet. |
| **Dev-`.env`** | Pro Repo eine Vorlage. Der Export erzeugt die Datei jetzt (Defaults, Zufallswerte, persoenliche Dev-Tokens, Variablen), Modus 600, nirgends gespeichert. |
| **Repositories** | Seite `/repos`: alle Repos aus Inventar und GitHub, lokal mit einem Ordner verknuepfbar (Datei `~/.secret-desk/repo-links.json`, nie im Inventar), „Lokal suchen“ findet Git-Ordner. Die Dev-Seite nimmt den verknuepften Ordner als Standardpfad. Repo-Felder sind Auswahlfelder. |
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

Unter Windows (PowerShell): `Copy-Item examples\secret-desk.config.example.yaml secret-desk.config.yaml` und
`Copy-Item examples\inventory.example.yaml inventory.yaml`, der Rest ist gleich.

Das Portal lauscht nur auf `127.0.0.1`. Die Zugangs-Tokens der Anbieter gibst du pro Sitzung im Portal ein oder verweist in der
Konfiguration auf Umgebungsvariablen bzw. 1Password (`op://...`). Nie der Wert in der Datei.

**Demo ohne Konten** (simuliertes GitHub, erfundene Daten):

```bash
pnpm build
pnpm demo                                                            # laeuft auf macOS, Linux und Windows
```

`pnpm demo` setzt `SECRET_DESK_DEMO=1` und `SECRET_DESK_CONFIG` selbst (Skript `scripts/demo.mjs`). Von Hand, je nach Shell:

```bash
# bash / zsh
SECRET_DESK_DEMO=1 SECRET_DESK_CONFIG=$PWD/examples/demo/secret-desk.config.yaml pnpm dev
```
```powershell
# PowerShell
$env:SECRET_DESK_DEMO = "1"; $env:SECRET_DESK_CONFIG = "$PWD\examples\demo\secret-desk.config.yaml"; pnpm dev
```
```bat
:: cmd
set SECRET_DESK_DEMO=1 && set SECRET_DESK_CONFIG=%CD%\examples\demo\secret-desk.config.yaml && pnpm dev
```

Aufraeumen (statt `rm -rf dist`): `pnpm clean` (Build-Ausgaben), `pnpm clean --deps` (zusaetzlich `node_modules`).

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

**Browser-Automatisierung:** Fuer Anbieter ohne API (GitHub fine-grained Token, Supabase Access Token, Stripe Restricted Key) fuehrt ein sichtbares
Chrome durch das Formular. Das Portal zeigt beim Anbieter den Chip "Browser", den Lauf mit Abbrechen und unter Verbindungen den Chrome-Status.
Anmeldung, 2FA und CAPTCHA macht immer der Mensch im Fenster. Die Rezepte sind noch nicht gegen die echten Seiten geprueft
(siehe [docs/BROWSER-AUTOMATION.md](docs/BROWSER-AUTOMATION.md), Konfigurationsblock `automation`).

Erster Einsatz mit echten Diensten: [docs/PROBELAUF.md](docs/PROBELAUF.md) (Wegwerf-Repo, `doctor`-Vorpruefung, Abnahmeliste).

Mehr: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md), [docs/SICHERHEIT.md](docs/SICHERHEIT.md), [docs/ANBIETER.md](docs/ANBIETER.md),
[docs/AGENTEN.md](docs/AGENTEN.md), [docs/TEAM.md](docs/TEAM.md).

## Plattformen

secret-desk laeuft auf **macOS, Linux und Windows 10/11** (Portal, CLI, MCP-Server, Browser-Automatisierung). Entwickelt und getestet
wird bisher auf macOS; Linux und Windows sind ueber simulierte Plattformen (injizierte `platform`/Befehle, `path.win32`) abgesichert.
Auf echten Runnern laeuft die von Hand startbare CI `Cross-Platform` (Actions, `workflow_dispatch`).

| | macOS | Linux | Windows 10/11 |
|---|---|---|---|
| Voraussetzungen | Node 24, pnpm | Node 24, pnpm | Node 24, pnpm (PowerShell 5.1 oder neuer ist dabei) |
| Tresor-Schluessel | Schluesselbund (`security`) | `secret-tool` (libsecret, z. B. GNOME Keyring/KWallet); sonst `SECRET_DESK_VAULT_KEY` oder `vault.keyFile` | DPAPI (an das Windows-Konto gebunden), Blob in `<tresor>.key` |
| Browser-Automatisierung | Chrome, Chromium, Edge | Chrome/Chromium/Edge als Distributionspaket; Snap/Flatpak sind sandboxed und gehen oft nicht | Chrome oder Edge (Program Files, Program Files (x86), `%LOCALAPPDATA%`) |
| Dateirechte | chmod 600/700 | chmod 600/700 | keine POSIX-Modi: Schutz ueber das Benutzerprofil (ACL) |
| Demo-Start | `pnpm demo` | `pnpm demo` | `pnpm demo` |

Bekannte Grenzen:
- **Windows:** Netzwerkpfade (`\\server\share`) und `\\?\`-Pfade werden abgelehnt, ebenso reservierte Namen (`CON`, `NUL`, `COM1` ...). Die Ordner-Verknuepfung
  verlangt einen lokalen Laufwerkspfad unterhalb des Benutzerordners oder von `policy.envRoots`. Der Tresorschluessel laesst sich nicht auf einen
  anderen Rechner oder ein anderes Konto mitnehmen (gewollt); dort ein neues Token eingeben.
- **Linux ohne Schluesselbund** (Server, Container, WSL ohne D-Bus): der Tresor meldet das klar und speichert nichts im Klartext. Dann
  `SECRET_DESK_VAULT_KEY` setzen (`openssl rand -base64 32`) oder `vault.keyFile` auf eine Schluesseldatei mit Modus 600 zeigen lassen.
  Achtung: Mit `vault.keyFile` liegen Schluessel und Daten auf demselben Datentraeger; das schuetzt nur das Dateisystem.
- **WSL** zaehlt als Linux: Home-Ordner, Schluesselbund und Chrome sind die der Linux-Seite, nicht die von Windows.
- Pfade in `secret-desk.config.yaml` duerfen `~` und unter Windows auch `~\` nutzen. YAML-Pfade mit Backslash in einfache Anfuehrungszeichen setzen
  (`'C:\Users\ich\Projekte'`) oder Schraegstriche nutzen (`C:/Users/ich/Projekte`).
- Zeilenenden: `.gitattributes` erzwingt LF; unter Windows kein `core.autocrlf` noetig.

## Status

Fruehe Version. Mehrere Anbieter-Endpunkte sind aus der Dokumentation bzw. dem Gedaechtnis umgesetzt und nur gegen Mocks getestet
(siehe docs/ANBIETER.md). Vor dem ersten echten Einsatz je Anbieter mit einem Wegwerf-Token probieren.

Lizenz: MIT.
