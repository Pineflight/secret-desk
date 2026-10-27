# Anbieter

`automatic` = das Portal erzeugt den Wert per API. `manual` = du legst ihn beim Anbieter an und fuegst ihn ein, das Portal prueft ihn.
Jeder Anbieter liefert eigene Pruefungen und Pruefpunkte. Die Spalte *Belegt* sagt, wie sicher der Endpunkt ist.

| Id | Art | Verbindung | Belegt |
|---|---|---|---|
| `random-hex`, `random-base64`, `random-uuid` | automatic | keine | lokal |
| `cloudflare-token` | automatic | `cloudflare` (Token mit *API Tokens Write*) | Referenz gelesen, `expires_on` nur aus Drittquelle |
| `cloudflare-turnstile` | automatic | `cloudflare` | **nicht verifiziert** |
| `supabase-api-key`, `supabase-service-role` | automatic | `supabase` | Dokumentation gelesen, Feldnamen **nicht verifiziert** |
| `stripe-webhook-secret` | automatic | `stripe` (Schluessel des jeweiligen Kontos) | Suche, Felder **nicht verifiziert** |
| `resend-api-key` | automatic | `resend` | **nicht verifiziert** |
| `grafana-service-account-token` | automatic | `grafana` | **nicht verifiziert** |
| `stripe-restricted-key`, `supabase-access-token`, `github-fine-grained-token`, `openai`, `peecho`, `vesselapi`, `dip-bundestag`, `telegram-bot`, `awin`, `revenuecat` | manual | – | Anleitungen; Startseiten wo keine Unterseite bekannt |

**Vor dem ersten echten Einsatz** jeden `automatic`-Anbieter mit einem Wegwerf-Eintrag in dev oder staging testen.

## Was die Anbieter nicht hergeben
Supabase Access Tokens, GitHub-Tokens (Fine-grained PATs) und Stripe Restricted Keys lassen sich nicht per API anlegen. Dafuer gibt es den
manuellen Weg. Bei GitHub lohnt sich eine **GitHub App**: Das Portal und deine Workflows holen sich dann pro Lauf einen Token fuer eine Stunde.

## Eigenen Anbieter hinzufuegen
Ohne API: im Inventar unter `providers` (Name, Adresse, Schritte), oder per MCP-Werkzeug `desk_add_provider`.
Mit API: ein `Provider` mit `issue`, `revoke`, `verify`, `reviewChecklist` registrieren (siehe `packages/providers/src`).
