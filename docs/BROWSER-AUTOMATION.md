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
- Provider mit `kind: "browser"`, der `issue` über ein Rezept ausführt und `IssuedSecret` zurückgibt (Beleg-PNGs gehen an den
  `EvidenceStore`). `createDefaultRegistry` registriert Rezepte aus `recipes/` (mitgeliefert) und `<Inventarordner>/recipes/` (eigene).
- Rezepte mitgeliefert: `github-fine-grained-token`, `supabase-access-token`; `stripe-restricted-key` als Gerüst (ungeprüft markiert).
- Portal: Anbieter-Chip „Browser“, beim Lauf Status „Browser läuft, bitte im Fenster anmelden/bestätigen“ mit Abbrechen, Zeitlimit.
- CLI: `secret-desk browser doctor` (Chrome gefunden, Profil, Rezepte gültig), `secret-desk browser run <rezept> --dry` (nur bis vor „Erzeugen“).
- Konfiguration: `automation: { chromePath?, profileDir?, loginTimeoutMinutes?, slowMoMs? }`.

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

- Die Provider-Id ist `recipe.provider ?? recipe.id`; die Rezept-Ids entsprechen den Ids der bisherigen Anleitungs-Anbieter und ersetzen sie in der Registry.
- `RecipeRunError` (`kind`: abort | timeout | host | step | capture; `createdName`) gehoert in Fehlerbericht und Portal: bei `createdName` den Namen anzeigen, damit der Mensch ihn beim Anbieter loescht.
- Konfiguration `automation` (`chromePath`, `profileDir`, `loginTimeoutMinutes`, `slowMoMs`) ist noch nicht im Config-Schema des Core; sie wird von der Integration an `PlaywrightDriver` bzw. `RunOptions` gereicht.
- Der Beleg-Anhang geht ueber `attachScreenshots`, weil `EvidenceStore.attach` einen bestehenden Bericht braucht, `issue` aber vor dem Bericht laeuft.

### Offene Punkte

- Rezepte gegen die echten Seiten pruefen (Probelauf mit Wegwerf-Token, Aufsicht); besonders GitHub-Bestaetigungsdialog, Token-Element, Supabase-Ablauffeld.
- Eigener Schritt fuer Elemente innerhalb eines Dialogs (Selektoren kennen keinen Bereich); bis dahin `css`.
- Stripe: Rechtematrix je Ressource aus `params` abbilden.
- Widerruf per Rezept (`revoke.steps`) fuer GitHub und Supabase schreiben; bisher Hinweis fuer den Menschen.
- Core: `automation`-Block im Config-Schema, Registry-Verdrahtung, Portalstatus mit Abbrechen.
- Anbieter-Nutzungsbedingungen zur Automatisierung pro Anbieter klaeren (Entscheidung des Teams).
