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

## Zugriff auf das Portal
- Lauscht nur auf `127.0.0.1`. Host-Pruefung gegen DNS-Rebinding, Ursprungspruefung bei Aenderungen.
- Portal-Sitzung: Cookie (`HttpOnly`, `SameSite=Strict`) plus CSRF-Token in jedem Aufruf.
- Agenten-Schnittstelle: eigener Bearer-Token (`~/.secret-desk/agent-token`, Modus 600). Agenten koennen **nichts bestaetigen**,
  keine Verbindungen setzen, keine Anlagen hochladen, keine Werte uebergeben und in staging/production nichts ohne Freigabe ausloesen.

## Zugangs-Tokens der Anbieter
Pro Sitzung im Portal eingeben (Arbeitsspeicher), oder per Umgebungsvariable, oder per 1Password-Referenz (`op://`). Nie in der Konfiguration.
Fuer Cloudflare braucht es einen Token mit dem Recht *API Tokens Write*: Das ist maechtig, bewahre ihn nur in der Sitzung auf.

## Grenzen
- Wer Zugriff auf deinen Rechner und den laufenden Prozess hat, kann den Arbeitsspeicher lesen.
- Die Erkennung von Geheimnissen in Variablen ist eine Heuristik.
- Anbieter-Endpunkte sind teils nur gegen Mocks getestet (siehe ANBIETER.md).
