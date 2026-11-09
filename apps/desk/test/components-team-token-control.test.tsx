import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamTokenControl } from "@/components/TeamTokenControl";
import type { FacadeState } from "@/lib/facade";
import type { TeamTokenInfo } from "@/lib/team-token";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { runState } from "./helpers/run";
import { activeToken, tokenInfo } from "./helpers/team-token";

const TOKEN = "team-sync/token";
const running = (over: Partial<FacadeState> = {}): TeamTokenInfo["run"] => runState({ status: "running", timeline: [{ phase: "opening", state: "done", at: "x" }, { phase: "signin", state: "active", at: "x" }], ...over });
const control = (props: Partial<Parameters<typeof TeamTokenControl>[0]> = {}) => <TeamTokenControl repo="acme/team" mode="pull" strategy="pull-request" {...props} />;
const info = (i: TeamTokenInfo, extra: Record<string, FakeHandler> = {}) => fakePortal({ [`GET ${TOKEN}`]: i, ...extra });

describe("TeamTokenControl idle states", () => {
  it("shows nothing while loading and a warning when the state cannot be read", async () => {
    fakePortal({ [`GET ${TOKEN}`]: { status: 500, body: { error: "state unreadable" } } });
    const view = renderApp(control());
    expect(view.container.querySelector("[data-testid=team-token]")).toBeNull();
    expect(await screen.findByText("state unreadable")).toBeInTheDocument();
  });

  it("shows nothing at all while the first answer is pending", () => {
    fakePortal({ [`GET ${TOKEN}`]: new Promise(() => {}) as never });
    renderApp(control());
    expect(screen.queryByTestId("team-token")).toBeNull();
  });

  it("describes the token and its rights for the chosen mode, with a heading on request", async () => {
    info(tokenInfo());
    const { rerender } = renderApp(control({ heading: true }));
    expect(await screen.findByText("Team-Token")).toBeInTheDocument();
    expect(screen.getByText("secret-desk erstellt ein eigenes Token nur für dieses Repository, 30 Tage gültig.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Rechte des Team-Tokens" })).toHaveTextContent("Contents: read");
    rerender(control({ mode: "pull-push" }));
    expect(screen.getByRole("list", { name: "Rechte des Team-Tokens" })).toHaveTextContent("Pull requests: write");
    expect(screen.queryByText("Team-Token", { exact: true })).toBeNull();
  });

  it("starts the creation with repository, mode, strategy and branch", async () => {
    const onCreated = vi.fn();
    const portal = info(tokenInfo(), { [`POST ${TOKEN}`]: {} });
    const { user } = renderApp(control({ branch: "main", mode: "pull-push", strategy: "direct", onCreated }));
    await user.click(await screen.findByRole("button", { name: "Team-Token erstellen" }));
    await waitFor(() => expect(portal.callsTo("POST", TOKEN)).toHaveLength(1));
    expect(portal.callsTo("POST", TOKEN)[0]?.body).toEqual({ repo: "acme/team", mode: "pull-push", strategy: "direct", branch: "main" });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("starts without a branch when none is chosen and shows a failed start", async () => {
    const portal = info(tokenInfo(), { [`POST ${TOKEN}`]: { status: 409, body: { error: "run already going" } } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Team-Token erstellen" }));
    expect(await screen.findByText("run already going")).toBeInTheDocument();
    expect(portal.callsTo("POST", TOKEN)[0]?.body).toEqual({ repo: "acme/team", mode: "pull", strategy: "pull-request" });
  });

  it("disables the button without a repository", async () => {
    info(tokenInfo());
    renderApp(control({ repo: "" }));
    expect(await screen.findByRole("button", { name: "Team-Token erstellen" })).toBeDisabled();
  });

  it.each([
    ["automation-off", /Die Browser-Automatisierung ist aus/],
    ["recipe-missing", /Das Rezept für GitHub-Tokens ist nicht geladen/],
  ] as const)("explains why the token cannot be created (%s)", async (reason, text) => {
    info(tokenInfo({ available: false, reason }));
    renderApp(control());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Team-Token erstellen" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Anmeldung prüfen" })).toBeNull();
  });

  it("shows a valid token with its date, and warns when it does not cover the mode", async () => {
    info(tokenInfo({ active: activeToken({ mode: "pull", expires: "2030-05-06" }) }));
    renderApp(control({ mode: "pull-push" }));
    expect(await screen.findByText(/✓ Team-Token secret-desk-team für acme\/team, gültig bis 06\.05\.2030/)).toHaveTextContent("es deckt den gewählten Modus nicht ab");
    expect(screen.getByRole("button", { name: "Neues Team-Token erstellen" })).toBeInTheDocument();
  });

  it("shows a covering token without a warning and one without expiry date", async () => {
    info(tokenInfo({ active: activeToken({ expires: null }) }));
    renderApp(control({ mode: "pull-push" }));
    const line = await screen.findByText(/✓ Team-Token secret-desk-team/);
    expect(line).not.toHaveTextContent("es deckt den gewählten Modus nicht ab");
  });

  it("tells that an expired token needs a new one", async () => {
    info(tokenInfo({ active: activeToken({ valid: false }) }));
    renderApp(control());
    expect(await screen.findByText("Das Team-Token secret-desk-team ist abgelaufen oder wurde entfernt. Erstelle ein neues.")).toBeInTheDocument();
  });
});

describe("TeamTokenControl run", () => {
  it("shows the steps of a running creation and cancels it", async () => {
    let state: TeamTokenInfo = tokenInfo({ run: running() });
    const portal = info(state, { [`GET ${TOKEN}`]: () => state, [`POST ${TOKEN}/cancel`]: () => { state = tokenInfo({ run: runState({ status: "cancelled", failure: { code: "cancelled", message: "Abgebrochen", messageEn: "Cancelled" } }) }); return {}; } });
    const { user } = renderApp(control());
    const steps = await screen.findByRole("list", { name: "Schritte" });
    expect(steps).toHaveTextContent("GitHub im Browser öffnen");
    expect(steps).toHaveTextContent("Bei GitHub anmelden");
    expect(screen.queryByRole("button", { name: "Team-Token erstellen" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(portal.callsTo("POST", `${TOKEN}/cancel`)).toHaveLength(1));
    expect(await screen.findByText("Abgebrochen.")).toBeInTheDocument();
    expect(screen.queryByText("Das Team-Token wurde nicht erstellt")).toBeNull();
  });

  it("shows a failed cancel", async () => {
    info(tokenInfo({ run: running() }), { [`POST ${TOKEN}/cancel`]: { status: 500, body: { error: "cannot cancel" } } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByText("cannot cancel")).toBeInTheDocument();
  });

  it("asks for the GitHub sign-in and sends it to the run", async () => {
    const portal = info(tokenInfo({ run: running({ ask: { type: "credentials", methods: [] } }) }), { [`POST ${TOKEN}/credentials`]: {} });
    const { user } = renderApp(control());
    await user.type(await screen.findByLabelText("E-Mail bei GitHub"), "me@example.test");
    await user.type(screen.getByLabelText("Passwort bei GitHub"), "password-for-tests");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() => expect(portal.callsTo("POST", `${TOKEN}/credentials`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${TOKEN}/credentials`)[0]?.body).toEqual({ method: "email", username: "me@example.test", password: "password-for-tests" });
  });

  it("asks to confirm the access and sends the answer", async () => {
    const ask = { type: "access" as const, stage: "choose" as const, methods: ["mobile" as const], attempt: 1, maxAttempts: 3 };
    const portal = info(tokenInfo({ run: running({ ask }) }), { [`POST ${TOKEN}/access`]: {} });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(portal.callsTo("POST", `${TOKEN}/access`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${TOKEN}/access`)[0]?.body).toEqual({ method: "mobile" });
  });

  it("asks for the one-time code", async () => {
    const portal = info(tokenInfo({ run: running({ needs: "mfa-code" }) }), { [`POST ${TOKEN}/code`]: {} });
    const { user } = renderApp(control());
    await user.type(await screen.findByLabelText("Einmalcode"), "123456");
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    await waitFor(() => expect(portal.callsTo("POST", `${TOKEN}/code`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${TOKEN}/code`)[0]?.body).toEqual({ code: "123456" });
  });

  it("shows the approval number", async () => {
    info(tokenInfo({ run: running({ needs: "approval", detail: "42" }) }));
    renderApp(control());
    expect(await screen.findByText("Wenn dein Gerät nach einer Zahl fragt, wähle 42.")).toBeInTheDocument();
  });

  it("asks for the consent and sends the answer, and shows a failed answer", async () => {
    const portal = info(tokenInfo({ run: running({ needs: "consent", detail: "repo" }) }), { [`POST ${TOKEN}/confirm`]: { status: 400, body: { error: "answer rejected" } } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Ablehnen" }));
    expect(await screen.findByText("answer rejected")).toBeInTheDocument();
    expect(portal.callsTo("POST", `${TOKEN}/confirm`)[0]?.body).toEqual({ accept: false });
  });

  it.each([
    ["signin", "secret-desk ist bei GitHub nicht angemeldet. Wartet im Browserfenster."],
    ["confirm", "GitHub verlangt eine Bestätigung. Wartet im Browserfenster."],
  ])("tells the person to act in the browser window while waiting at %s", async (phase, text) => {
    info(tokenInfo({ run: running({ status: "waiting-human", phase }) }));
    renderApp(control());
    expect(await screen.findByText("Wartet auf eine Bestätigung")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("does not show the browser hint for a running run without a question", async () => {
    info(tokenInfo({ run: running() }));
    renderApp(control());
    await screen.findByRole("list", { name: "Schritte" });
    expect(screen.queryByText("Wartet auf eine Bestätigung")).toBeNull();
  });

  it("reports a finished creation, also when the replaced token was deleted", async () => {
    info(tokenInfo({ active: activeToken(), run: runState({ status: "done", result: { revoked: true } as never }) }));
    renderApp(control());
    expect(await screen.findByText("Das Team-Token secret-desk-team ist bereit und gültig bis 06.05.2030.")).toBeInTheDocument();
    expect(screen.getByText("Das ersetzte Team-Token wurde bei GitHub gelöscht.")).toBeInTheDocument();
  });

  it.each([
    ["no result", undefined],
    ["a result that is not an object", "ok"],
    ["a result without revocation", { revoked: false }],
  ])("reports a finished creation with %s but no revocation message", async (_name, result) => {
    info(tokenInfo({ active: null, run: runState({ status: "done", ...(result !== undefined ? { result: result as never } : {}) }) }));
    renderApp(control());
    expect(await screen.findByText(/^Das Team-Token\s+ist bereit und gültig bis \.$/)).toBeInTheDocument();
    expect(screen.queryByText("Das ersetzte Team-Token wurde bei GitHub gelöscht.")).toBeNull();
  });

  it("explains a failed creation in German and with the technical detail for test failures", async () => {
    info(tokenInfo({ run: runState({ status: "failed", timeline: [{ phase: "opening", state: "done", at: "x" }, { phase: "creating", state: "failed", at: "x" }], failure: { code: "test", message: "x", messageEn: "401 bad credentials" } }) }));
    renderApp(control());
    expect(await screen.findByText(/Das neue Token hat den Test nicht bestanden/)).toHaveTextContent("(401 bad credentials)");
    expect(screen.getByText("Das Team-Token wurde nicht erstellt")).toBeInTheDocument();
    expect(screen.getByText("Token bei GitHub erstellen").closest("li")).toHaveClass("text-danger-text");
  });

  it("shows nothing about the failure when the run reports none", async () => {
    info(tokenInfo({ run: runState({ status: "failed" }) }));
    renderApp(control());
    await screen.findByRole("list", { name: "Schritte" });
    expect(screen.queryByText("Das Team-Token wurde nicht erstellt")).toBeNull();
  });

  it("announces a creation that finishes while the page is open, but not one that was already done", async () => {
    let state: TeamTokenInfo = tokenInfo({ run: running() });
    const onCreated = vi.fn();
    info(state, { [`GET ${TOKEN}`]: () => state, [`POST ${TOKEN}/cancel`]: () => { state = tokenInfo({ active: activeToken(), run: runState({ status: "done" }) }); return {}; } });
    const { user } = renderApp(control({ onCreated }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("does not announce a creation that was done when the page loaded", async () => {
    const onCreated = vi.fn();
    info(tokenInfo({ active: activeToken(), run: runState({ status: "done" }) }));
    renderApp(control({ onCreated }));
    await screen.findByText(/ist bereit und gültig/);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("tolerates a missing onCreated callback when a run finishes", async () => {
    let state: TeamTokenInfo = tokenInfo({ run: running({ status: "waiting-human", phase: "confirm" }) });
    info(state, { [`GET ${TOKEN}`]: () => state, [`POST ${TOKEN}/cancel`]: () => { state = tokenInfo({ run: runState({ status: "done" }) }); return {}; } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByText(/ist bereit und gültig/)).toBeInTheDocument();
  });
});

describe("TeamTokenControl pending revocation and sign-in check", () => {
  it("shows the old token to delete at GitHub with the reason and marks it as done", async () => {
    let state = tokenInfo({ pendingRevocation: { tokenName: "old-token", repo: "acme/team", since: "2026-01-01", url: "https://github.test/settings/tokens/1", reason: "rate limited" } });
    const portal = info(state, { [`GET ${TOKEN}`]: () => state, [`POST ${TOKEN}/revocation-done`]: () => { state = tokenInfo(); return {}; } });
    const { user } = renderApp(control());
    expect(await screen.findByText("Altes Team-Token bei GitHub löschen")).toBeInTheDocument();
    expect(screen.getByText(/Das Team-Token old-token für acme\/team wurde ersetzt/)).toBeInTheDocument();
    expect(screen.getByText("Grund: rate limited")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub-Tokens öffnen/ })).toHaveAttribute("href", "https://github.test/settings/tokens/1");
    await user.click(screen.getByRole("button", { name: "Habe ich gelöscht" }));
    await waitFor(() => expect(portal.callsTo("POST", `${TOKEN}/revocation-done`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Altes Team-Token bei GitHub löschen")).toBeNull());
  });

  it("omits the reason when there is none", async () => {
    info(tokenInfo({ pendingRevocation: { tokenName: "old-token", repo: "acme/team", since: "2026-01-01", url: "https://github.test/t" } }));
    renderApp(control());
    await screen.findByText("Altes Team-Token bei GitHub löschen");
    expect(screen.queryByText(/Grund:/)).toBeNull();
  });

  it("checks the browser sign-in and reports a signed-in browser, hiding the check while it is fresh", async () => {
    const portal = info(tokenInfo(), { [`POST ${TOKEN}/check`]: { signedIn: true, checkedAt: new Date().toISOString() } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("GitHub ist im Browser angemeldet.")).toBeInTheDocument();
    expect(portal.callsTo("POST", `${TOKEN}/check`)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Anmeldung prüfen" })).toBeNull();
  });

  it("offers the check again when the answer is old or its time is unreadable", async () => {
    const answers = [{ signedIn: true, checkedAt: "2000-01-01T00:00:00Z" }, { signedIn: true, checkedAt: "garbage" }];
    let n = 0;
    info(tokenInfo(), { [`POST ${TOKEN}/check`]: () => answers[n++]! });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    await waitFor(() => expect(n).toBe(1));
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    await waitFor(() => expect(n).toBe(2));
    expect(await screen.findByRole("button", { name: "Anmeldung prüfen" })).toBeInTheDocument();
  });

  it("tells when the browser is signed out", async () => {
    info(tokenInfo(), { [`POST ${TOKEN}/check`]: { signedIn: false, checkedAt: new Date().toISOString() } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText(/secret-desk ist für Browser-Läufe nicht bei GitHub angemeldet/)).toBeInTheDocument();
    expect(screen.getByText("Im Browser nicht bei GitHub angemeldet.")).toBeInTheDocument();
  });

  it("reports a failed check with the failure message and not as signed out", async () => {
    info(tokenInfo(), { [`POST ${TOKEN}/check`]: { signedIn: false, checkedAt: new Date().toISOString(), failure: { code: "browser", message: "browser not usable" } } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("browser not usable")).toBeInTheDocument();
    expect(screen.queryByText(/secret-desk ist für Browser-Läufe nicht bei GitHub angemeldet/)).toBeNull();
  });

  it("shows an error when the check itself fails", async () => {
    info(tokenInfo(), { [`POST ${TOKEN}/check`]: { status: 500, body: { error: "check crashed" } } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("check crashed")).toBeInTheDocument();
  });

  it("shows the busy label while the check runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    info(tokenInfo(), { [`POST ${TOKEN}/check`]: async () => { await gate; return { signedIn: true, checkedAt: new Date().toISOString() }; } });
    const { user } = renderApp(control());
    await user.click(await screen.findByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByRole("button", { name: "Prüfe …" })).toBeDisabled();
    release();
    await screen.findByText("GitHub ist im Browser angemeldet.");
  });
});
