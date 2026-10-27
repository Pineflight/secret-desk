---
name: secret-desk
description: Use when you need to add, rename, expire or renew a token, key or secret for a project, set up the dev .env of a repo, check what is about to expire, or onboard a teammate. Works through the secret-desk MCP tools (desk_*), never touches secret values, and respects stages (dev, staging, production).
---

# secret-desk fuer Agenten

secret-desk verwaltet Tokens und Secrets eines Teams: Ablauf im Blick, Erzeugen beim Anbieter, Schreiben in den
GitHub-Secret-Speicher des Projekts. **Werte werden nie im Portal gespeichert und nie an Agenten gegeben.** Du arbeitest
mit Metadaten und stellst Anfragen.

## Regeln, die immer gelten

1. **Nie einen Wert anfassen.** Du bekommst keinen, du fragst keinen ab, du bittest den Menschen nicht, einen im Chat zu nennen.
   Eine erzeugte `.env` liest du nicht aus und gibst sie nicht wieder.
2. **Stages:** `dev` darfst du direkt anfassen (Metadaten und lokale `.env`). `staging` und `production` loesen nie sofort aus:
   `desk_request_renewal` und `desk_apply_variable` erzeugen dort eine Freigabe-Anfrage, die ein Mensch im Portal erteilt. Auch ein neuer Wert wird
   nie sofort geschrieben: Er wird erzeugt, geprueft und wartet auf die Bestaetigung eines Menschen (Pruefbericht, Beleg). Nenne ihm die Anfrage und frage nicht
   nach der Bestaetigung im Chat.
3. **`production` nie ohne ausdruecklichen Auftrag des Menschen** und nie als Nebeneffekt eines anderen Auftrags.
4. **Neue Eintraege nur mit Zielen:** ausser `dev` braucht jeder Eintrag `places` (Repo, `repository` oder `environment` mit Name).
5. **Namen:** `id` in kleinbuchstaben-mit-bindestrich, `name` GROSSBUCHSTABEN_MIT_UNTERSTRICH. Ein Secret je Stage und Repo-Gruppe; staging und
   production teilen nie ein Secret.
6. **Neue Eintraege immer beschreiben:** `description` (wofuer, wo genutzt, 1-2 Saetze), `owner` und, wenn vorhanden, `link` zur Anbieter-Seite oder Doku, dazu 1-3 `tags` (kleinbuchstaben-mit-bindestrich). Gilt fuer Secrets und Variablen. Frag den Menschen, wenn du den Zweck nicht kennst, statt etwas zu erfinden.
7. **Defaults in `.env`-Vorlagen** nur fuer Nicht-Geheimes (URLs, Flags). Alles Geheime ist `generate`, `issue` oder `prompt`.

## Typische Ablaeufe

**Was laeuft bald ab?** `desk_overview`, dann `desk_list_secrets` mit `status: due` oder `soon`. Fasse zusammen, was zu tun ist
(Anbieter, Ziel, Anleitung bei manuellen).

**Neues Secret fuer ein Projekt:**
1. `desk_list_providers` (gibt es einen automatischen Anbieter? sonst `manual`), `desk_list_connections` (ist die Verbindung hergestellt?).
2. `desk_add_secret` mit Stage, Ziel und Anbieter, `ttlDays`/`expires`, wenn der Anbieter einen Ablauf hat.
3. Automatisch: `desk_request_renewal` (dryRun zuerst). Manuell: dem Menschen die `guide` aus `desk_get_secret` nennen, er traegt den Wert im Portal ein.

**Neuer Anbieter ohne API:** `desk_add_provider` mit Seite und Schritten, dann Eintraege mit `provider: <id>`.

**Dev-Umgebung eines Repos:**
1. `desk_export_dev_env` mit `repo` und `path` (Ordner des Repos, muss in der Freigabe des Portals liegen).
2. Antwort `needs-input`: nenne dem Menschen die fehlenden Schluessel, er traegt sie im Portal oder mit `secret-desk env export` ein.
3. Antwort `written`: nur die Schluesselnamen weitergeben. Warnung zu Git beachten (`.gitignore`).
4. Fehlt eine Vorlage: `desk_add_env_template`, dann wiederholen.

**Neues Teammitglied:** `desk_team_export` liefert die Konfiguration ohne Werte. Er importiert sie mit `secret-desk team import`, verbindet seine Konten
und erzeugt seine Dev-Dateien.

**Variablen (vars.*, Konfiguration, kein Geheimnis):** `desk_list_variables`, `desk_variable_status` (Soll gegen Ist in GitHub),
`desk_add_variable` / `desk_set_variable_value` / `desk_update_variable_meta` (Sollwert und Beschreibung im Inventar), `desk_apply_variable` (nach GitHub). Nie ein Geheimnis als Variable
anlegen, das ist dort im Klartext lesbar: Schluessel, Tokens, Passwoerter gehoeren in ein Secret. Das Portal lehnt Werte ab, die wie Schluessel aussehen.

**Nachweis:** `desk_list_reviews` zeigt, was auf die Bestaetigung eines Menschen wartet, `desk_list_evidence` die frueheren Pruefberichte eines Secrets.

## Fehler

- `Portal nicht erreichbar`: Portal laeuft nicht (`pnpm dev` im secret-desk-Repo), sag es dem Menschen.
- `not-connected`: Der Mensch muss die Verbindung im Portal unter Verbindungen herstellen.
- HTTP 403 bei Stage: Du darfst diese Stage nicht direkt anfassen, stelle eine Anfrage.
