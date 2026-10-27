# secret-desk, Regeln fuer Claude

- **Nie einen Wert anfassen, lesen, loggen oder in Tests/Fixtures fest eintragen.** Testwerte sind erfundene Zeichenfolgen. `SecretValue` nie in
  Ausgaben umgehen (`reveal()` nur dort, wo der Wert wirklich weitergegeben wird).
- Jede neue Antwort, jeder Bericht, jede Fehlermeldung bekommt einen Test, dass kein Wert und kein Verbindungs-Token darin steht.
- Richtlinie lebt in `packages/runtime/src/agent-api.ts` (Agenten: nur `policy.agentStages` direkt, nie bestaetigen, keine Werte).
- GitHub wird erst nach der Bestaetigung eines Menschen beschrieben; der alte Wert erst danach widerrufen.
- Variablen: Geheimnis-Schutz (`guards.ts`) nie abschwaechen.
- Pruefen vor dem Commit: `pnpm run verify`.
