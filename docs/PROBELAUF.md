# Probelauf mit echten Diensten

Ziel: Alle Wege einmal mit **echten** Konten ausprobieren, ohne etwas Wichtiges anzufassen. Alles geht in das Wegwerf-Repo
`Pineflight/secret-desk-sandbox` (privat, leer, Environment `staging`). Es gibt dort nichts, das geschuetzt werden muss.
Bereits geprueft (Selbsttest gegen das echte GitHub, 27.10.2026): Verschluesselung, Anlegen, Ueberschreiben, Loeschen von Secrets
und Variablen am Repo und am Environment.

Tipp: Im Portal steht an jedem manuellen Secret der Knopf "Seite des Anbieters mit Vorgaben oeffnen". Bei GitHub sind Name, Eigentuemer, Ablauf und Rechte (`params.permissions` im Inventar) vorausgefuellt; nur das Repository waehlst du selbst. Beim ersten Token (secret-desk selbst) nimm diesen Link:
`https://github.com/settings/personal-access-tokens/new?name=secret-desk-sandbox&description=secret-desk+Probelauf&target_name=Pineflight&expires_in=7&secrets=write&variables=write&environments=read&metadata=read`

## 0. Was du vorher anlegst (alles kurzlebig und mit minimalen Rechten)

| Was | Wo | Rechte | Ablauf |
|---|---|---|---|
| **GitHub-Token fuer secret-desk** | GitHub, Settings, Developer settings, Fine-grained tokens | Resource owner `Pineflight`, **nur Repo `secret-desk-sandbox`**; Secrets: Read and write, Variables: Read and write, Environments: Read, Metadata: Read | 7 Tage |
| **Cloudflare-Start-Token** (nur fuer Test B) | Cloudflare, My Profile, API Tokens, Custom token | **User > API Tokens > Edit** (sonst nichts) | 1 Tag |
| **Cloudflare-Konto-ID** (Test B) | Cloudflare Dashboard, Konto, "Copy account ID" | – | – |
| **Wegwerf-Token zum Einfuegen** (Test C, optional) | GitHub, Fine-grained token, Resource owner dein Konto, **keine** Rechte ausser Public Repositories (read-only) | keine | 1 Tag |

Die Werte kommen in 1Password oder in Umgebungsvariablen, nie in Dateien und nie in den Chat.

## 1. Vorbereiten

Vorlagen kopieren: `mkdir -p ~/.secret-desk/trial && cp examples/trial/config.example.yaml ~/.secret-desk/trial/secret-desk.config.yaml && cp examples/trial/inventory.yaml ~/.secret-desk/trial/`

```bash
cd ~/Projekte/Privat/Pineflight/secret-desk         # gebaut: pnpm install && pnpm build
export SECRET_DESK_GITHUB_TOKEN=...                 # Token aus Zeile 1
export SECRET_DESK_CLOUDFLARE_TOKEN=...             # Token aus Zeile 2 (nur fuer Test B)
```

In `~/.secret-desk/trial/inventory.yaml` bei `trial-cloudflare` die Zeile `accountId: DEINE_CLOUDFLARE_ACCOUNT_ID` ersetzen.
Ohne Cloudflare lass `trial-cloudflare` einfach weg bzw. ueberspringe Test B.

## 2. Vorpruefung (liest nur, schreibt nichts)

```bash
node packages/cli/dist/bin.js doctor --config ~/.secret-desk/trial/secret-desk.config.yaml
```

Erwartet: `[ok  ]` bei Inventar, Verbindung github, Ziel `secret-desk-sandbox/env:staging` und `.../repo`, bei Cloudflare
"aktiv", am Ende "Bereit fuer den Probelauf.". Bei `[fail]` steht der Grund daneben (fehlendes Recht, falsches Repo).

## 3. Portal starten

```bash
SECRET_DESK_CONFIG=~/.secret-desk/trial/secret-desk.config.yaml pnpm dev      # http://127.0.0.1:4747
```

## 4. Abnahmeliste

| # | Test | Schritte | Erwartung |
|---|---|---|---|
| A | Ablauf ohne Anbieter | Secrets, `SD_TRIAL_RANDOM`, "Neuen Wert erzeugen" | Pruefseite mit Beleg-Bild, Befund "Ziel erreichbar mit Schreibrecht", Checkliste. Knopf erst nach allen Haken aktiv. Nach "Bestaetigen": im Sandbox-Repo steht unter Environments > staging das Secret `SD_TRIAL_RANDOM` (`gh secret list -R Pineflight/secret-desk-sandbox --env staging`). Am Secret "Zuletzt bestaetigt von ...". |
| B | Echter Anbieter | `SD_TRIAL_CLOUDFLARE`, "Neuen Wert erzeugen" | Befunde "Token aktiv", "Rechte exakt: Account Settings Read", "Nur Konto ...", Ablauf in 7 Tagen. **Im Cloudflare-Dashboard** (My Profile, API Tokens) steht jetzt ein Token namens `trial-cloudflare-<Datum>` mit genau diesem einen Recht. Vor dem Bestaetigen ist in GitHub noch **nichts** geschrieben. Nach dem Bestaetigen ist `SD_TRIAL_CLOUDFLARE` im Sandbox-Repo. |
| B2 | Alten Wert widerrufen | B wiederholen | Nach dem Bestaetigen steht im Bericht "Alter Wert beim Anbieter widerrufen", und im Cloudflare-Dashboard ist der **erste** Token verschwunden, der zweite da. |
| B3 | Ablehnen | B starten, "Ablehnen und neuen Wert loeschen" | Der neue Token ist im Cloudflare-Dashboard **wieder weg**, in GitHub ist nichts geschrieben, am Secret steht noch der alte Stand. |
| C | Von Hand | `SD_TRIAL_MANUAL`, "Wert einfuegen", Wegwerf-Token einfuegen | Befunde "funktioniert (Anmeldename)" und Ablaufdatum aus der Antwort von GitHub; Feld wird geleert; nach dem Bestaetigen steht das Secret im Repo. |
| D | Variablen | Variablen, `SD_TRIAL_URL`: "Mit GitHub vergleichen" -> "Fehlt in GitHub"; "In GitHub setzen"; erneut vergleichen -> "Stimmt ueberein"; Sollwert aendern -> "Weicht ab" | Variable erscheint unter Environment staging. |
| D2 | Uebernehmen | In GitHub (Browser) `SD_TRIAL_FLAG` als Repository-Variable setzen, im Portal "Aus GitHub uebernehmen" | Sollwert wird eingetragen. |
| D3 | Geheimnis-Schutz | `SD_TRIAL_URL` auf `sk_live_aaaaaaaaaaaaaaaaaaaaaaaa` setzen | Wird abgelehnt: "Das sieht nach einem Geheimnis aus". |
| E | Dev-`.env` | Dev-Umgebung, Vorlage `trial-dev`, Pfad `~/secret-desk-trial/.env.local`, Testwert eintragen | Datei mit Modus 600 (`ls -l`), Variable und Zufallswert drin, im Portal nur Schluesselnamen. |
| F | Agent (optional) | MCP-Server einbinden, `desk_request_renewal` fuer `trial-random` | Es entsteht eine Freigabe (staging), nichts wird geschrieben, bis du im Portal freigibst **und** bestaetigst. |
| G | Verlauf | Secret `trial-random` ansehen | Zwei Berichte mit Beleg-Bild und Bestaetigung. |

## 5. Aufraeumen

```bash
gh repo delete Pineflight/secret-desk-sandbox --yes            # braucht das Recht delete_repo, sonst im Browser
rm -rf ~/.secret-desk/trial ~/secret-desk-trial
```

Und: Cloudflare-Token `trial-cloudflare-*` und den Start-Token widerrufen, den GitHub-Token fuer secret-desk und den Wegwerf-Token loeschen.

## 6. Wenn etwas nicht klappt

Schick die Ausgabe von `doctor` und die Meldung aus dem Portal (nie einen Wert). Besonders interessant sind Abweichungen bei den
Cloudflare-Befunden (Namen der Berechtigungsgruppen, Feld `expires_on`): Sie sind bisher nur aus der Dokumentation umgesetzt.
