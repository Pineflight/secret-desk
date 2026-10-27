# KI-Agenten (MCP und Skill)

Der MCP-Server `secret-desk-mcp` ist ein duenner Client der lokalen Portal-Schnittstelle (`/api/agent`). Er liefert **nur Metadaten**.

```json
{ "mcpServers": { "secret-desk": { "command": "node", "args": ["/PFAD/secret-desk/packages/mcp/dist/server.js"] } } }
```

Der Agenten-Token liegt in `~/.secret-desk/agent-token` (wird beim ersten Start des Portals angelegt), oder `SECRET_DESK_AGENT_TOKEN`.
Das Portal muss laufen (`pnpm dev`).

## Werkzeuge
`desk_overview`, `desk_list_secrets`, `desk_get_secret`, `desk_add_secret`, `desk_update_secret`, `desk_list_providers`, `desk_list_connections`,
`desk_add_provider`, `desk_add_env_template`, `desk_add_env_entry`, `desk_request_renewal`, `desk_list_reviews`, `desk_list_evidence`,
`desk_list_variables`, `desk_variable_status`, `desk_update_variable_meta`, `desk_add_variable`, `desk_set_variable_value`, `desk_apply_variable`, `desk_get_approval`,
`desk_export_dev_env`, `desk_team_export`.

## Regeln der Richtlinie (erzwingt das Portal, nicht der Agent)
- Stages in `policy.agentStages` (Standard nur `dev`) darf ein Agent direkt anfassen, alles andere nur per **Freigabe** eines Menschen.
- Ein neuer Wert wird **nie** sofort geschrieben: Er wartet auf die **Bestaetigung eines Menschen** (Reiter Pruefen).
- Agenten bestaetigen nicht, geben keine Werte ein, setzen keine Verbindungen, laden keine Anlagen hoch.
- `.env`-Dateien nur fuer `dev` und nur in `policy.envRoots`. Der Agent bekommt Pfad und Schluesselnamen, nie Inhalte.

## Skill
`skills/secret-desk/SKILL.md` beschreibt dem Agenten die Regeln und typischen Ablaeufe. In `~/.claude/skills/secret-desk/` kopieren oder als Plugin einbinden.

## Browser-Anbieter

Anbieter, die ihren Wert über ein Browserfenster erzeugen (Id `<rezept>-browser`), starten Agenten nie selbst: `renewal-requests` liefert in jeder Stage `pending-approval`, weil sich ein Fenster am Rechner des Menschen öffnet. Ein Mensch gibt im Portal frei und meldet sich im Fenster selbst an. Zustand und Abbruch eines Laufs sind nur im Portal verfügbar. Siehe [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md).
