# 12. Glossary

*Purpose: shared vocabulary, with the German UI term where it differs · Audience: everyone · As of 2026-11-07 · Sources: [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`STAGES.md`](../STAGES.md), [`apps/desk/src/messages`](../../apps/desk/src/messages), [`packages/core/src`](../../packages/core/src)*

The UI is bilingual (English and German). The German column quotes the visible UI text where it differs; code,
API fields and documents are English.

| Term | Meaning | German UI term |
|---|---|---|
| value | The secret itself (token, key, password). Exists only in memory as a `SecretValue`; never stored. | no UI term |
| target (place) | Where a value is written: a GitHub repository, environment or organisation scope, or a Cloudflare Worker script. Field `places` in the inventory. | Ziel |
| provider | A module that creates, verifies and revokes a value at a service (`Provider` interface), or a manual guide for a human paste. | Anbieter |
| connection | A stored or session token that lets secret-desk call a provider or GitHub. | Verbindung |
| stage | A place in the delivery path (for example `dev`, `staging`, `production`, `shared`) with a kind (`dev`, `test`, `live`, `shared`) that decides the rules. | Stage |
| issuance | One renewal: prepare (create and verify), then confirm or discard. | no UI term |
| pending issuance | A created value waiting for a human decision; in memory for at most 15 minutes. | no UI term (listed under *Prüfen*) |
| review report | The metadata-only result of preparing an issuance: checks, checklist, fingerprint, targets. | Prüfbericht |
| evidence image | SVG (and optional PNG, JPEG or WebP attachment) that documents a review without showing the value. | Beleg |
| fingerprint | 12 hex characters of a SHA-256 of the value, for later comparison. | Fingerabdruck |
| approval | A human decision that lets an agent request run outside `policy.agentStages`; bound to the entry's content. | Freigabe |
| review (action) | The human step that ticks the checklist and confirms or rejects. | Prüfen |
| stale | A review or approval whose entry changed after it was created; it is discarded. | no UI term |
| inventory | `inventory.yaml`: names, stages, providers, expiry and targets of all secrets and variables. No values. | Inventar |
| variable | A configuration value with an expected value, compared with GitHub and applied on request. | Variable |
| companion value | A further value from the same provider answer that belongs to another entry (for example a client id). | no UI term |
| recipe | A YAML description of the steps in a provider's web form for browser automation. | Rezept |
| facade (guided sign-in) | A recipe that the portal drives with email and password the human entered for that run. | *Mit Anmeldung verbinden* (button) |
| trial run | A guided first run with real services in a throwaway repository ([TRIAL-RUN.md](../TRIAL-RUN.md)). | no UI term (*Probelauf* in the UI means a dry run) |
| desk | The portal (`apps/desk`) and, by extension, the product. | Portal |
| agent | An AI client using the Agent API or MCP server; cannot confirm and never sees values. | Agent |
| policy | Configuration `policy.agentStages` and `policy.envRoots` that bound what agents may do directly. | Richtlinie (*Richtlinie & Agenten*) |
| launch secret | Random secret printed at start; needed once to open a portal session. | Startgeheimnis |
| vault | Encrypted file for integration tokens; key in the OS keychain. | Tresor |
| team file | Value-free export of the configuration for sharing ([TEAM.md](../TEAM.md)). | Team-Datei |
