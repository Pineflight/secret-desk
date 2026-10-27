# Schnittstelle des Portals (Vertrag fuer die Oberflaeche)

Alle Pfade unter `/api/ui/...` (Mensch). Vorher einmal `GET /api/session` aufrufen: Antwort `{ csrf, user }`, setzt das Cookie
`sd_session`. Jede weitere Anfrage sendet den Header `x-secret-desk-csrf: <csrf>` (Cookie geht automatisch mit). Aenderungen (POST, PATCH,
DELETE) senden zusaetzlich einen `Origin`-Header (macht der Browser). Antworten sind JSON, Fehler `{ error: string }`; `409` mit `code: "not-connected"`
heisst: Anbieter-Verbindung fehlt (`connection`, `hint`).

Typen kommen aus `@secret-desk/runtime` und `@secret-desk/core` (nur `import type`).

| Methode Pfad | Antwort / Zweck |
|---|---|
| GET `overview` | `Overview` (Summen je Stage und Status, `attention`, `variables`, `pendingReviews`, `pendingApprovals`) |
| GET `secrets?stage&repo&product&status&provider&live=1` | `SecretView[]` |
| GET `secrets/:id` | `SecretView` |
| POST `secrets` | `SecretView` anlegen (Metadaten) |
| PATCH `secrets/:id` | Metadaten aendern (`expires`, `notes`, `ttlDays`, `title`) |
| POST `renewal-requests` `{ secretId, dryRun? }` | `awaiting-review` + `IssuanceView`, `pending-approval` oder `dry-run` |
| GET `reviews` / `reviews/:id` | `IssuanceView[]` / `IssuanceView` (offene Pruefungen, nur Metadaten, `report.checks`, `report.checklist`, `fingerprint`, `expiresAt`) |
| POST `reviews/:id/confirm` `{ ticks: string[], note?, force? }` | `CommitResult` (schreibt erst jetzt nach GitHub) |
| POST `reviews/:id/reject` `{ note? }` | `{ revokedNew }` |
| POST `secrets/:id/manual-value` `{ value }` | `IssuanceView` (Wert wird geprueft, nie gespeichert, wartet auf Bestaetigung) |
| GET `evidence/:secretId` | `VerificationReport[]` (Verlauf) |
| GET `evidence/:secretId/:reportId` | `VerificationReport` |
| GET `evidence/:secretId/:reportId/svg` | Beleg als Bild (`image/svg+xml`, in `<img>` einbinden) |
| POST `evidence/:secretId/:reportId/attachments` (multipart `file`, `note`) | `Attachment` (PNG/JPEG/WebP bis 5 MB) |
| GET `evidence/:secretId/:reportId/attachments/:file` | Bild |
| GET `variables?stage&repo&product` | `VariableView[]` |
| POST `variables` | Variable anlegen (`acknowledgedPublic` bei Warnung) |
| PATCH `variables/:id` `{ value?, description?, acknowledgedPublic? }` | Sollwert im Inventar aendern |
| GET `variables/:id/status` | `{ variable, drift: VariableDrift[] }` (Soll gegen Ist in GitHub) |
| POST `variables/:id/apply` `{ acknowledgedPublic? }` | `applied` (+ Ergebnisse) oder `pending-approval` |
| POST `variables/:id/adopt` | Istwert aus GitHub als Sollwert uebernehmen |
| DELETE `variables/:id` | aus dem Inventar entfernen |
| GET `approvals` / POST `approvals/:id/approve|deny` | `Approval[]` / `Approval` |
| GET `providers` | Anbieter (`kind`, `connection`, `guide`) |
| GET `connections` | `ConnectionStatus[]` (nur ja/nein) |
| POST `connections/:id/token` `{ token }` / DELETE | Token nur fuer diese Sitzung (Arbeitsspeicher) setzen/loeschen |
| POST `env-export` `{ repo, stage?, template?, path, overwrite?, prompts? }` | `DevEnvResult` (schreibt Datei, Modus 600) |
| GET `team-export` | YAML-Download ohne Werte |
| POST `team-import` `{ text, replace? }` | `{ added, skipped }` |

Fehlercodes: 400 ungueltige Eingabe, 401 Sitzung, 403 Richtlinie/Host, 404, 409 Zustand (auch Anbieter nicht verbunden), 502 GitHub.

Nie vorhanden in einer Antwort: der Wert eines Secrets, ein Token einer Verbindung, der Agenten-Token.
