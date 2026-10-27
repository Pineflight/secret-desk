# Sicherheit

## Grundsatz
Werte werden nie gespeichert. Das Portal haelt sie nur im Arbeitsspeicher, nur solange es fuer die Pruefung und Bestaetigung noetig ist
(15 Minuten), und gibt sie nur an zwei Stellen weiter: an die Anbieter-API und verschluesselt an GitHub.

## Was geschuetzt ist
- **`SecretValue`**: Der Wert steckt in einem privaten Feld und erscheint in keiner Ausgabe (`toString`, JSON, `util.inspect`).
- **Berichte und Antworten** enthalten nie einen Wert. Statt dessen ein Fingerabdruck (12 Zeichen eines SHA-256) zum spaeteren Abgleich.
- **Fehlermeldungen** werden bereinigt (bekannte Tokens, typische Praefixe und JSON-Felder wie `token`, `secret`, `api_key`).
- **GitHub-Upload** verschluesselt den Wert mit dem oeffentlichen Schluessel des Ziels (libsodium sealed box) vor dem Senden.
- **Variablen** sind im Klartext lesbar. Werte, die wie Schluessel aussehen (Stripe-Keys, GitHub-Tokens, Service-Role-JWT, private Schluessel),
  werden abgelehnt, verdaechtige nur nach ausdruecklicher Bestaetigung durch einen Menschen.
- **`.env`-Dateien** entstehen mit Modus 600 und nur in freigegebenen Ordnern. Das Portal warnt, wenn Git die Datei nicht ignoriert.
- **Anlagen** (Screenshots) sind nur PNG, JPEG, WebP bis 5 MB und werden mit `nosniff` und `sandbox` ausgeliefert.

## Ordner-Verknuepfungen
- Pfade sind rechnerspezifisch und stehen nur in der lokalen Datei `repo-links.json` (Modus 600), nie im Inventar oder im Team-Export.
- Erlaubt sind nur Ordner **unterhalb** des Home-Ordners oder von `policy.envRoots` (nach Aufloesung von Symlinks), die ein `.git` enthalten.
  Der Remote wird mit `execFile` gelesen (keine Shell); ein abweichender Remote warnt nur.
- Nur das Portal setzt und entfernt Verknuepfungen. Agenten sehen die Liste ohne Pfade und koennen nichts verknuepfen.
- Der verknuepfte Ordner gilt beim `env-export` als erlaubte Wurzel, aber nur fuer sein eigenes Repository. Die Verknuepfung wird bei jeder
  Nutzung erneut geprueft (Ordner vorhanden, noch unter Home oder `envRoots`).

## Dateirechte und Plattformen
- **macOS/Linux:** Tresor, Agenten-Token, Verknuepfungsdatei, `.env`-Dateien und Anlagen entstehen mit Modus 600, ihre Ordner (`~/.secret-desk`,
  Browser-Profil, Beleg-Ordner) mit 700. Zentral in `securePrivateFile`, `ensurePrivateDir` und `writePrivateFile` (core, `platform.ts`).
- **Windows:** POSIX-Modi gibt es nicht (`chmod` wirkt nur auf das Schreibschutz-Bit). Die Helfer tun dort nichts Falsches und versprechen nichts:
  Der Schutz kommt vom Benutzerprofil (`%USERPROFILE%` ist per ACL nur fuer das Konto, SYSTEM und Administratoren lesbar). Dateien ausserhalb des Profils
  (z. B. ein `.env` in einem frei gewaehlten Ordner auf einem anderen Laufwerk) erben die ACL des Ordners: dort die Rechte selbst pruefen.
- **Tresor-Schluessel:** macOS Keychain, Linux `secret-tool`, Windows DPAPI (`ProtectedData`, Scope `CurrentUser`): ein zufaelliger 32-Byte-Schluessel
  wird mit DPAPI geschuetzt und als Blob in `<tresor>.key` abgelegt. Er laesst sich nur mit demselben Windows-Konto auf demselben Rechner oeffnen.
  Daten gehen nur ueber stdin an PowerShell (`-NoProfile -NonInteractive`), nie ueber Argumente. Eine vorhandene Blob-Datei, die sich nicht oeffnen
  laesst, wird nie ueberschrieben. Wer DPAPI-Zugriff als dasselbe Konto hat (Malware im Benutzerkontext), kommt an den Schluessel: DPAPI schuetzt vor
  anderen Benutzern und vor Diebstahl der Dateien, nicht vor Code im eigenen Konto.
- **Linux ohne `secret-tool`:** klare Fehlermeldung, nie stilles Klartext-Speichern. Optionen: `SECRET_DESK_VAULT_KEY` oder die ausdrueckliche
  Konfiguration `vault.keyFile` (Schluesseldatei, Modus 600, wird bei zu offenen Rechten abgelehnt). Letzteres legt Schluessel und Daten auf denselben
  Datentraeger: nur wenn kein Schluesselbund vorhanden ist.
- **Pfadpruefungen:** Vergleiche (`liegt unterhalb von Home/envRoots`) loesen Symlinks auf und vergleichen unter Windows ohne Gross-/Kleinschreibung und
  mit Laufwerk; UNC-/`\\?\`-Pfade und reservierte Namen werden unter Windows abgelehnt. Namen im Beleg-Ordner sind auf `[A-Za-z0-9._-]` begrenzt,
  ohne Punkt am Ende und ohne Windows-Geraetenamen.
- **Prozesse:** alle externen Befehle (`git`, `op`, `security`, `secret-tool`, `powershell.exe`, Chrome ueber Playwright) laufen mit `execFile` ohne Shell
  und mit `windowsHide`.

## Zugriff auf das Portal
- Lauscht nur auf `127.0.0.1` (auf allen Systemen; erlaubte Host-Werte `127.0.0.1`, `localhost`, `[::1]` jeweils mit Port). Host-Pruefung gegen DNS-Rebinding, Ursprungspruefung bei Aenderungen.
- Portal-Sitzung: Cookie (`HttpOnly`, `SameSite=Strict`) plus CSRF-Token in jedem Aufruf.
- Agenten-Schnittstelle: eigener Bearer-Token (`~/.secret-desk/agent-token`, Modus 600; unter Windows `%USERPROFILE%\.secret-desk\agent-token`, geschuetzt durch das Benutzerprofil). Agenten koennen **nichts bestaetigen**,
  keine Verbindungen setzen, keine Anlagen hochladen, keine Werte uebergeben und in staging/production nichts ohne Freigabe ausloesen.

## Zugangs-Tokens der Anbieter
Pro Sitzung im Portal eingeben (Arbeitsspeicher), oder per Umgebungsvariable, oder per 1Password-Referenz (`op://`). Nie in der Konfiguration.
Fuer Cloudflare braucht es einen Token mit dem Recht *API Tokens Write*: Das ist maechtig, bewahre ihn nur in der Sitzung auf.

## Grenzen
- Wer Zugriff auf deinen Rechner und den laufenden Prozess hat, kann den Arbeitsspeicher lesen.
- Die Erkennung von Geheimnissen in Variablen ist eine Heuristik.
- Anbieter-Endpunkte sind teils nur gegen Mocks getestet (siehe ANBIETER.md).
