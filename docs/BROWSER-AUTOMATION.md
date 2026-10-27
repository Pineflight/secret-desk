# Browser-Automatisierung (Anbieter ohne API)

Für Anbieter, bei denen ein Token nur über die Weboberfläche entsteht (GitHub fine-grained PAT, Supabase Access Token,
Stripe Restricted Key), führt secret-desk einen echten Browser durch das Formular. Es ist derselbe Ablauf wie bei API-Anbietern:
Wert erzeugen, prüfen, Bericht mit Beleg, **Mensch bestätigt**, erst dann Schreiben nach GitHub.

## Grundsätze

1. **Der Mensch meldet sich selbst an.** Der Browser ist ein sichtbares Fenster (kein Headless) mit eigenem dauerhaften Profil
   (`~/.secret-desk/browser-profile`, Modus 700). secret-desk tippt nie ein Passwort, kein 2FA, löst kein CAPTCHA. Erscheint
   Anmeldung, 2FA, CAPTCHA oder eine Passwortbestätigung, wartet es (Standard 10 Minuten) und macht danach weiter.
2. **Der Wert bleibt im Arbeitsspeicher.** Der Token wird aus der Seite gelesen und als `SecretValue` an `prepareIssuance` gegeben.
   Er steht nie in Logs, Rezeptausgaben, Fehlermeldungen oder Screenshots. Screenshots werden aufgenommen, bevor der Wert
   sichtbar ist, oder mit maskierten Bereichen (`mask`).
3. **Fail closed.** Jeder unerwartete Zustand (Element fehlt, falsche Seite, Zeitüberschreitung) bricht ab, es wird nichts nach GitHub
   geschrieben. Wurde beim Anbieter schon ein Token erzeugt, steht im Fehler und im Bericht der Name, damit er dort gelöscht werden kann.
4. **Rezepte sind Daten, kein Code.** Eine Weboberfläche ändert sich; die Korrektur ist dann eine YAML-Änderung per Pull Request.
   Andere im Team können Anbieter ergänzen, ohne TypeScript zu schreiben.
5. **Nur lokal, nur Systembrowser.** `playwright-core` mit dem installierten Chrome/Chromium (`channel: "chrome"` oder
   `automation.chromePath`), kein Download von Browsern.
6. **Keine Umgehung.** Keine Stealth-Plugins, keine CAPTCHA-Dienste, keine Anmeldedaten aus Dateien. Verlangt eine Seite Bot-Prüfung,
   macht der Mensch sie im Fenster.

## Rezept (YAML)

```yaml
id: github-fine-grained-token
label: GitHub Fine-grained Token
host: github.com                   # Seiten außerhalb dieses Hosts (und listed hosts) werden nicht bedient
login:
  # Angemeldet, wenn nach goto dieser Test besteht; sonst auf den Menschen warten.
  expect: { url: "^https://github\\.com/settings/" }
steps:
  - goto: "https://github.com/settings/personal-access-tokens/new?name={{name}}&target_name={{owner}}&expires_in={{days}}"
  - fill: { label: "Token name", value: "{{name}}" }
  - click: { role: button, name: "Generate token" }
  - screenshot: form-before            # Beleg vor dem Wert
capture:
  token:
    find: { css: "#new-access-token" }  # role/label/text/testid bevorzugt, css nur wenn nötig
    pattern: "^github_pat_[A-Za-z0-9_]+$"
  externalId: { from: name }            # Kennung für späteres Widerrufen
  expires: { from: days }
mask: [{ css: "#new-access-token" }]    # in allen späteren Screenshots verdeckt
revoke:
  steps: [ ... ]                         # optional; sonst Hinweis für den Menschen
```

Schritte: `goto`, `fill` (label/role/placeholder/testid, `value`), `select`, `check`, `click`, `press`, `waitFor` (url/visible/text),
`pause: human` (Mensch muss etwas tun, Text wird im Portal gezeigt), `screenshot: <name>`. Variablen in `{{ }}`: `name`, `owner`,
`days`, `date`, `description`, `repos`, `permissions`, `stage`, `secretId`. Unbekannte Variablen sind ein Fehler.

## Bausteine

- Paket `@secret-desk/automation` (optionale Abhängigkeit `playwright-core`):
  `RecipeSchema` (zod), `loadRecipes(dirs)`, `renderTemplate`, `runRecipe(recipe, vars, driver, hooks)`,
  `BrowserDriver`-Schnittstelle (Playwright-Implementierung `PlaywrightDriver`, Testimplementierung ohne Browser),
  Maskierung, Anmeldewarten mit Zeitlimit, Abbruch.
- Provider, der `issue` über ein Rezept ausführt und `IssuedSecret` zurückgibt (Beleg-PNGs gehen an den `EvidenceStore`). Die Runtime
  (`createRuntime`) registriert Rezepte aus `recipes/` (mitgeliefert), `<Inventarordner>/recipes/` und `automation.recipesDirs` als Anbieter `<rezept-id>-browser`.
- Rezepte mitgeliefert: `github-fine-grained-token`, `supabase-access-token`; `stripe-restricted-key` als Gerüst (ungeprüft markiert).
- Portal: Anbieter-Chip „Browser“, beim Lauf Status „Browser läuft, bitte im Fenster anmelden/bestätigen“ mit Abbrechen, Zeitlimit.
- CLI: `secret-desk browser doctor` (Chrome gefunden, Profil, Rezepte gültig), `secret-desk browser run <rezept> --dry` (nur bis vor „Erzeugen“).
- Konfiguration: `automation: { enabled?, chromePath?, profileDir?, loginTimeoutMinutes?, slowMoMs?, recipesDirs? }` (Details unten).

## Plattformen
Chrome wird an den ueblichen Orten gesucht: macOS (`/Applications`), Linux (`google-chrome`, `chromium`, `chromium-browser`, Edge unter `/usr/bin`, Snap, Flatpak),
Windows (`%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%LOCALAPPDATA%`: Chrome, Chromium, Edge). Sonst `--chrome-path`/`automation.chromePath`. Snap- und
Flatpak-Browser sind sandboxed und lassen sich oft nicht steuern. Das Profil liegt unter `<Home>/.secret-desk/browser-profile` (Windows:
`%USERPROFILE%\.secret-desk\browser-profile`); POSIX Modus 700, Windows Schutz ueber das Benutzerprofil.

## Grenzen

Die mitgelieferten Rezepte sind nicht gegen die echten Seiten geprüft (kein Zugang zu Konten in der Entwicklung). Sie sind gegen
lokale Nachbildungen der Formulare getestet. Der erste echte Lauf ist ein Probelauf mit Wegwerf-Token und menschlicher Aufsicht;
Auswahlfelder, die ein Anbieter ändert, brechen den Lauf ab statt zu raten. Anbieter dürfen Automatisierung ihrer Oberfläche in den
Nutzungsbedingungen einschränken: das Team entscheidet pro Anbieter, ob es das Rezept nutzt.

## Stand der Umsetzung

Gebaut (Paket `packages/automation`, Rezepte in `recipes/`, CLI `packages/cli/src/browser.ts`):

- `RecipeSchema` (zod) mit Schrittarten `goto`, `fill`, `select`, `check`, `click` (`createsToken: true` markiert den Punkt, ab dem beim Anbieter
  etwas entsteht), `press`, `waitFor` (`url`/`visible`/`text`), `pause` (`human` + `until`-Bedingung) und `screenshot`. Jeder Schritt (ausser goto,
  waitFor, pause, screenshot) darf `each: repos` tragen und laeuft dann je Repository mit `{{item}}`. Selektoren: `role`+`name`, `label`, `text`,
  `placeholder`, `testid`, `css` (letzte Wahl). Zusatzvariablen: `permissionsQuery` (schon kodierter Query-Teil der Rechte), `externalId` (nur `revoke`), `item`.
- Das Schema prueft: unbekannte Variablen, `http` nur fuer localhost, fester Host in `goto` (Host oder `allowHosts`, auch `*.beispiel.de`), mindestens ein
  `createsToken`. `loadRecipes(dirs)` wirft mit Dateiname und Pfad (`datei.yaml: steps.3.click: ...`); `loadRecipesDetailed` sammelt Fehler. Spaetere Ordner ueberstimmen gleiche Ids.
- `renderTemplate`: unbekannte Variable = Fehler, in `goto` wird jeder Wert mit `encodeURIComponent` kodiert.
- `BrowserDriver` mit `PlaywrightDriver` (sichtbares Chrome, `launchPersistentContext`, Profil Modus 700, `slowMoMs`; Chrome-Suche: `chromePath`, macOS/Linux/Windows-Standardpfade,
  sonst `channel: "chrome"`; kein Download) und `FakeDriver` (Tests, ohne Browser).
- `runRecipe` / `dryRunRecipe` / `revokeRecipe`: Anmeldewarten (`login.expect` nach dem ersten `goto`, danach wird die Zielseite erneut geladen), Zeitlimit,
  AbortSignal, Host-Pruefung vor jeder Aktion, Maskierung in jedem Screenshot (Playwright-`mask`, zusaetzlich automatischer Beleg `nach-erzeugen`), Fehler ohne Seiteninhalt,
  `RecipeRunError.createdName` nach `createsToken`.
- `createBrowserProvider({ recipe, driverFactory, hooks?, runOptions?, evidence? })` passt zum `Provider`-Interface (`kind: "automatic"`, zusaetzlich `automation.recipeId`).
- Rezepte: `github-fine-grained-token`, `supabase-access-token`, `stripe-restricted-key` (Geruest). Alle tragen `# STATUS: nicht gegen die echte Seite geprueft`.
- CLI: `secret-desk browser doctor`, `secret-desk browser run <id> --dry [--name --owner --days --repos --out ...]`.
- Tests: Schema, Template, Host, Fake-Laeufe, Rezepte laden, Provider, Integration mit `PlaywrightDriver` gegen ein lokales Formular (nur mit Chrome, headless, kein Internet).

### Verdrahtung in Runtime und Portal (gebaut)

- **Konfiguration** (`packages/core/src/config.ts`): `automation: { enabled (true), chromePath?, profileDir? (~/.secret-desk/browser-profile), loginTimeoutMinutes (10), slowMoMs?, recipesDirs?: string[] }`.
  Relative Pfade gelten ab der Konfigurationsdatei, `~` wird aufgelöst. Beispiel: `examples/secret-desk.config.example.yaml`.
- **Runtime** (`packages/runtime/src/automation.ts`): `rt.automation` (`AutomationManager`). `createRuntime` lädt die Rezepte (mitgeliefert aus `<Repo>/recipes` über
  `bundledRecipesDir()`, dazu `<Inventarordner>/recipes` und `recipesDirs`, spätere Ordner überstimmen gleiche Ids) und registriert je Rezept den Anbieter `<id>-browser`.
  Ungültige Rezepte brechen nichts ab, sie stehen in `rt.automation.problems`. Ohne Chrome/Playwright ist der Anbieter trotzdem da; der Lauf scheitert mit der Meldung samt Installationshinweis.
- **Laufzustand** je `secretId`: `idle | running | waiting-human | done | failed | cancelled` mit Text, Host der Seite (ohne Pfad/Query), Schritt `n von m`, Startzeit, bei `done` die Prüfungs-id,
  bei Fehlern `createdName`. Nur **ein** Lauf gleichzeitig (ein Profil, ein Fenster); ein zweiter Start gibt 409. Der Zustand liegt in der Runtime, nicht im Browser des Portals:
  ein Neuladen der Seite verwaist den Lauf nicht, die Seite fragt weiter ab. Werte stehen nie im Zustand; Fehlertexte sind geschwärzt.
- **Ablauf**: `requestIssuance` (und die Freigabe eines Agentenantrags) führt bei einem Browser-Anbieter `prepareIssuance` als verfolgten Lauf aus und hängt danach die Belege
  (`attachScreenshots`) an den Bericht. Die Anfrage läuft bis zum Anmelde-Zeitlimit; der Next-Handler hat dafür `maxDuration = 3600`.
- **Agenten** (MCP/Agent-API) bekommen für einen Browser-Anbieter in **jeder** Stage nur eine Freigabe im Portal (es öffnet sich ein Fenster am Rechner), auch bei `agentStages: [dev]`.
  Zustand und Abbruch sind reine Portal-Routen.
- **Portal-Routen** (nur `/api/ui`, Cookie + CSRF): `GET automation` (Chrome, Profilordner, Wartezeit, Rezepte mit Status-Kommentar, Probleme, Läufe),
  `GET automation/runs/:secretId`, `POST automation/runs/:secretId/cancel`. Gestartet wird über die bestehende Route `POST renewal-requests`.
- **Oberfläche**: Secret-Seite mit Lauf-Panel (alle 2 s, Hinweis zur eigenen Anmeldung, „Rezept nicht gegen die echte Seite geprüft“, Abbrechen, Link zur Prüfung);
  Integrationen mit Abschnitt „Browser-Automatisierung“; Chip „Browser“ bei Secret und in der Anbieter-Auswahl. Alle Texte zweisprachig.
- **Build-Hinweis**: `apps/desk` markiert `@secret-desk/automation` und `playwright-core` in `serverExternalPackages`, damit Next den Browser-Treiber nicht bündelt.

### API fuer die Integration (Runtime und Portal)

```ts
import {
  createBrowserProvider, loadRecipesDetailed, PlaywrightDriver, RecipeRunError,
  type RunHooks, type RunOptions, type BrowserProvider,
} from "@secret-desk/automation";

const { recipes, errors } = await loadRecipesDetailed([bundledRecipesDir, join(inventoryDir, "recipes")]);
for (const { recipe } of recipes) {
  registry.register(createBrowserProvider({
    recipe,
    driverFactory: () => new PlaywrightDriver({ chromePath, profileDir, slowMoMs }),   // aus config.automation
    hooks: (secretId) => ({ onWaitingForHuman: (w) => portal.setStatus(secretId, w), onResumed: () => portal.clear(secretId) }),
    runOptions: (secretId) => ({ loginTimeoutMinutes, signal: portal.abortSignal(secretId) }),
    evidence,
  }));
}
// Nach prepareIssuance: Belege an den Bericht haengen (der Bericht entsteht erst nach issue):
await (provider as BrowserProvider).attachScreenshots(secret.id, report.id);
```

- Die Runtime benennt den Anbieter `<recipe.id>-browser` (Label `<Label> (Browser)`) und ersetzt den bisherigen Anleitungs-Anbieter gleichen Rezepts nicht: beide bleiben wählbar.
- `RecipeRunError` (`kind`: abort | timeout | host | step | capture; `createdName`) gehoert in Fehlerbericht und Portal: bei `createdName` den Namen anzeigen, damit der Mensch ihn beim Anbieter loescht.
- Der Beleg-Anhang geht ueber `attachScreenshots`, weil `EvidenceStore.attach` einen bestehenden Bericht braucht, `issue` aber vor dem Bericht laeuft.

### Offene Punkte

- `next build` und ein echter Lauf im Portal sind noch nicht gemeinsam geprüft (Bündelung von `playwright-core`, Pfad der mitgelieferten Rezepte im Produktionsbuild).

- Rezepte gegen die echten Seiten pruefen (Probelauf mit Wegwerf-Token, Aufsicht); besonders GitHub-Bestaetigungsdialog, Token-Element, Supabase-Ablauffeld.
- Eigener Schritt fuer Elemente innerhalb eines Dialogs (Selektoren kennen keinen Bereich); bis dahin `css`.
- Stripe: Rechtematrix je Ressource aus `params` abbilden.
- Widerruf per Rezept (`revoke.steps`) fuer GitHub und Supabase schreiben; bisher Hinweis fuer den Menschen.
- Anbieter-Nutzungsbedingungen zur Automatisierung pro Anbieter klaeren (Entscheidung des Teams).
