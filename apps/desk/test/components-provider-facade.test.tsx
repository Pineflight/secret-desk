import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacadeCheckContext, FacadeFlow, FacadeSection } from "@/components/ProviderFacade";
import type { FacadeInfo, FacadeState } from "@/lib/facade";
import type { CheckOutcome } from "@/lib/sign-in-check";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";
import { facadeInfo, runState } from "./helpers/run";

const BASE = "facades/stripe";
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const SIGNED_OUT = { signedIn: false, checkedAt: "2026-01-01T00:00:00Z" };
const SIGNED_IN = { signedIn: true, checkedAt: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

type Props = Partial<Parameters<typeof FacadeFlow>[0]>;
const flow = (props: Props = {}) => <FacadeFlow facade={facadeInfo()} onChanged={() => {}} onDone={() => {}} {...props} />;
const noRun = { [`GET ${BASE}/state`]: { status: 404, body: { error: "none" } } };

async function fillSignIn(user: ReturnType<typeof renderApp>["user"]) {
  await user.type(await screen.findByLabelText("E-Mail bei Stripe"), "me@example.test");
  await user.type(screen.getByLabelText("Passwort bei Stripe"), "password-for-tests");
}

describe("FacadeFlow browser check", () => {
  it("says it is checking, then offers the sign-in form for a signed-out browser", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: async () => { await gate; return SIGNED_OUT; } });
    renderApp(flow());
    expect(await screen.findByText("Prüfe die Anmeldung im Browser …")).toBeInTheDocument();
    release();
    expect(await screen.findByText(/Der Browser ist bei Stripe nicht angemeldet/)).toBeInTheDocument();
    expect(screen.getByText(/nur auf dashboard\.stripe\.test eingetippt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anmelden und verbinden" })).toBeDisabled();
  });

  it("shows the promise line and falls back to the label as host", async () => {
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_OUT });
    renderApp(flow({ facade: facadeInfo({ host: null, promise: "facade.promise.stripe" }) }));
    expect(await screen.findByText(/nur auf Stripe eingetippt/)).toBeInTheDocument();
    expect(screen.getByText(/Eingeschränkter Schlüssel mit nur den Rechten/)).toBeInTheDocument();
  });

  it("connects directly with a signed-in browser, sending inputs and project", async () => {
    const portal = fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_IN, [`POST ${BASE}/connect`]: runState({ status: "running", kind: "connect" }) });
    const facade = facadeInfo({ needsProject: true, inputs: [{ param: "mode", label: "Modus", labelEn: "Mode", options: ["sandbox", "other"], pattern: null, help: null }, { param: "account", label: "Konto", labelEn: "Account", options: null, pattern: null, help: "Konto-ID" }] });
    const { user } = renderApp(flow({ facade, initialInputs: { account: "acct_1" } }));
    const connect = await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" });
    expect(screen.getByText(/Der Browser ist bei Stripe schon angemeldet/)).toBeInTheDocument();
    expect(connect).toBeDisabled();
    const modeBoxes = screen.getAllByRole("combobox", { name: /Modus/ });
    await user.click(modeBoxes[0]!);
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: "Sandbox" })).toBeInTheDocument();
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "other" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Sandbox" }));
    await user.type(screen.getAllByLabelText(/Projekt-ID/)[0]!, "proj_1");
    expect(connect).toBeEnabled();
    await user.click(connect);
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/connect`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/connect`)[0]?.body).toEqual({ projectId: "proj_1", inputs: { mode: "sandbox", account: "acct_1" } });
    expect(await screen.findByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
  });

  it("folds the typed sign-in and the pasted key under 'Other ways' next to a signed-in browser", async () => {
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_IN });
    renderApp(flow({ fallback: <p>paste a key here</p> }));
    await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" });
    expect(screen.getByText("Andere Wege")).toBeInTheDocument();
    expect(screen.getByText("Mit E-Mail und Passwort anmelden")).toBeInTheDocument();
    expect(screen.getByText("Ich habe schon einen Schlüssel")).toBeInTheDocument();
    expect(screen.getByText("paste a key here")).toBeInTheDocument();
  });

  it("offers only the pasted key as another way when signed out, and none without a fallback", async () => {
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_OUT });
    const { unmount } = renderApp(flow({ fallback: <p>paste a key here</p> }));
    await screen.findByText(/nicht angemeldet/);
    expect(screen.getByText("Ich habe schon einen Schlüssel")).toBeInTheDocument();
    expect(screen.queryByText("Mit E-Mail und Passwort anmelden")).toBeNull();
    unmount();
    renderApp(flow());
    await screen.findByText(/nicht angemeldet/);
    expect(screen.queryByText("Andere Wege")).toBeNull();
  });

  it("explains a check that could not be made and checks again on request", async () => {
    let step = 0;
    const portal = fakePortal({
      ...noRun,
      [`POST ${BASE}/check`]: () => (step++ === 0 ? { signedIn: false, checkedAt: "x", failure: { code: "captcha", message: "Sicherheitsprüfung im Weg.", messageEn: "Captcha." } } : SIGNED_IN),
    });
    const { user } = renderApp(flow());
    expect(await screen.findByText("Der Anbieter zeigt eine Sicherheitsprüfung (CAPTCHA)", { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    expect(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" })).toBeInTheDocument();
    expect(portal.callsTo("POST", `${BASE}/check`)).toHaveLength(2);
  });

  it("shows the server's text when the check request itself fails", async () => {
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: { status: 502, body: { error: "browser unreachable" } } });
    renderApp(flow());
    expect(await screen.findByText("browser unreachable")).toBeInTheDocument();
  });

  it("says the check is impossible when the provider is unavailable", async () => {
    const portal = fakePortal({ ...noRun });
    renderApp(flow({ facade: facadeInfo({ available: false, reason: "automation is off" }) }));
    expect(await screen.findByText("Nicht verfügbar: automation is off")).toBeInTheDocument();
    // The notice renders at once; the "could not be checked" text is set by an effect after it, so wait for it instead of reading it synchronously.
    expect(await screen.findByText("Die Anmeldung im Browser ließ sich nicht prüfen. Du kannst dich unten anmelden.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Anmelden und verbinden" })).toBeDisabled();
    expect(portal.callsTo("POST", `${BASE}/check`)).toHaveLength(0);
  });

  it("shows an empty reason as nothing", async () => {
    fakePortal({ ...noRun });
    renderApp(flow({ facade: facadeInfo({ available: false, reason: null }) }));
    expect(await screen.findByText("Nicht verfügbar:")).toBeInTheDocument();
  });

  it("asks the page's check queue when one is provided", async () => {
    const check = vi.fn<(id: string) => Promise<CheckOutcome | undefined>>().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ signedIn: true, failure: null, error: null });
    const portal = fakePortal({ ...noRun });
    const { user } = renderApp(<FacadeCheckContext.Provider value={{ check }}>{flow()}</FacadeCheckContext.Provider>);
    expect(await screen.findByText("Unbekannter Fehler")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    expect(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" })).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith("stripe");
    expect(portal.callsTo("POST", `${BASE}/check`)).toHaveLength(0);
  });

  it("drops a check answer that arrives after it was closed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: async () => { await gate; return SIGNED_IN; } });
    const { unmount } = renderApp(flow());
    await screen.findByText("Prüfe die Anmeldung im Browser …");
    unmount();
    release();
    await advance(10);
  });
});

describe("FacadeFlow sign-in run", () => {
  it("signs in, follows the run and shows the result with counts, check and resources", async () => {
    let current: FacadeState = runState({ status: "running" });
    const done = runState({ status: "done", result: { connected: true, storedIn: "vault", keyName: "secret-desk-key", projectId: null, counts: { projects: 2 }, check: { id: "stripe", ok: true, checks: [{ id: "c", label: "Key works", status: "pass" }] } } });
    const portal = fakePortal({
      [`GET ${BASE}/state`]: () => (current.status === "done" ? current : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_OUT,
      [`POST ${BASE}/sign-in`]: () => current,
      "GET connections/stripe/resources": { connection: "stripe", connected: true, defaultSpecs: [], defaults: {}, resources: {} },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const onChanged = vi.fn();
    const onDone = vi.fn();
    const { user } = renderApp(flow({ onChanged, onDone, facade: facadeInfo({ needsProject: true }) }));
    await fillSignIn(user);
    await user.click(screen.getByText("Erweitert: Projekt-ID"));
    await user.type(screen.getByLabelText(/Projekt-ID/), " proj_9 ");
    await user.click(screen.getByRole("button", { name: "Anmelden und verbinden" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/sign-in`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/sign-in`)[0]?.body).toEqual({ username: "me@example.test", password: "password-for-tests", method: "email", projectId: "proj_9" });
    await screen.findByRole("button", { name: "Abbrechen" });
    expect(screen.queryByDisplayValue("password-for-tests")).toBeNull();
    current = done;
    await advance(1100);
    expect(await screen.findByText("Verbunden", { selector: "p.font-medium" })).toBeInTheDocument();
    expect(screen.getByText("2 Projekte")).toBeInTheDocument();
    expect(screen.getByText("Schlüssel secret-desk-key, gespeichert im Tresor.")).toBeInTheDocument();
    expect(screen.getByText("Key works")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(portal.callsTo("GET", "connections/stripe/resources")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the plain result for a session-only key without counts, check or resource panel (account inputs)", async () => {
    const result = { connected: true, connectionId: "stripe:acct:live", storedIn: "session" as const, keyName: "k", projectId: null, counts: {}, check: null };
    const facade = facadeInfo({ inputs: [{ param: "account", label: "Konto", labelEn: "Account", options: null, pattern: null, help: null }] });
    // A finished run is not picked up on open; start one that the next poll reports as done.
    let phase: FacadeState = runState({ status: "running" });
    fakePortal({
      [`GET ${BASE}/state`]: () => (phase.status === "done" ? phase : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_IN,
      [`POST ${BASE}/connect`]: () => runState({ status: "running" }),
    });
    const { user } = renderApp(flow({ facade, initialInputs: { account: "acct_1" } }));
    await user.click(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    phase = runState({ status: "done", result });
    await advance(1100);
    expect(await screen.findByText("Schlüssel k, gespeichert im Arbeitsspeicher (nur diese Sitzung).")).toBeInTheDocument();
    expect(screen.queryByText("Ressourcen und Standardwerte")).toBeNull();
  });

  it("shows the browser-only result when the account cannot create the key", async () => {
    let phase: FacadeState = runState({ status: "running" });
    fakePortal({
      [`GET ${BASE}/state`]: () => (phase.status === "done" ? phase : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_IN,
      [`POST ${BASE}/connect`]: () => runState({ status: "running" }),
    });
    const onDone = vi.fn();
    const { user } = renderApp(flow({ onDone }));
    await user.click(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    phase = runState({ status: "done", result: { connected: false, storedIn: "session", keyName: "", projectId: null, counts: {}, check: null, browserOnly: true } });
    await advance(1100);
    expect(await screen.findByText("Angemeldet. API-Schlüssel kommen aus dem Browser")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("returns to the form when a run ends done without a connection", async () => {
    let phase: FacadeState = runState({ status: "running" });
    fakePortal({
      [`GET ${BASE}/state`]: () => (phase.status === "done" ? phase : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_IN,
      [`POST ${BASE}/connect`]: () => runState({ status: "running" }),
    });
    const { user } = renderApp(flow());
    await user.click(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    phase = runState({ status: "done" });
    await advance(1100);
    expect(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" })).toBeInTheDocument();
  });

  it("picks up a run that is already going when the dialog opens", async () => {
    fakePortal({ [`GET ${BASE}/state`]: runState({ status: "running", needs: "approval", detail: "42" }), [`POST ${BASE}/check`]: SIGNED_OUT });
    renderApp(flow());
    expect(await screen.findByText("Wenn dein Gerät nach einer Zahl fragt, wähle 42.")).toBeInTheDocument();
    expect(screen.queryByText(/Prüfe die Anmeldung/)).toBeNull();
  });

  it("answers a one-time code, a consent question and an access question", async () => {
    let state: FacadeState = runState({ needs: "mfa-code" });
    const portal = fakePortal({
      [`GET ${BASE}/state`]: () => state,
      [`POST ${BASE}/code`]: () => { state = runState({ needs: "consent", detail: "read projects" }); return state; },
      [`POST ${BASE}/confirm`]: () => { state = runState({ needs: null, ask: { type: "access", stage: "choose", methods: ["mobile", "code"], attempt: 1, maxAttempts: 3 } }); return state; },
      [`POST ${BASE}/access`]: () => runState({ needs: null }),
    });
    const { user } = renderApp(flow());
    await user.type(await screen.findByLabelText("Einmalcode"), "123456");
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/code`)).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/confirm`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/confirm`)[0]?.body).toEqual({ accept: false });
    await advance(1100);
    const send = await screen.findByRole("button", { name: "Bestätigen" });
    await user.click(send);
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/access`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/access`)[0]?.body).toEqual({ method: "mobile" });
  });

  it("cancels a running run and shows the failure with a retry", async () => {
    const portal = fakePortal({
      [`GET ${BASE}/state`]: runState({ status: "running" }),
      [`POST ${BASE}/cancel`]: runState({ status: "cancelled", failure: { code: "cancelled", message: "Abgebrochen.", messageEn: "Cancelled." } }),
    });
    const { user } = renderApp(flow());
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/cancel`)).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });

  it("shows a failed run with the created key, the project question and the way out", async () => {
    let started = false;
    let connectStep = 0;
    const portal = fakePortal({
      [`GET ${BASE}/state`]: () => (started ? runState({ status: "failed", createdName: "secret-desk-9", failure: { code: "project-unknown", message: "Projekt unbekannt.", messageEn: "Unknown project." } }) : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_OUT,
      [`POST ${BASE}/sign-in`]: () => { started = true; return runState({ status: "running" }); },
      [`POST ${BASE}/connect`]: () => (connectStep++ === 0 ? { status: 500, body: { error: "project invalid" } } : runState({ status: "running", kind: "connect" })),
    });
    const { user } = renderApp(flow({ fallback: <p>paste a key here</p> }));
    await fillSignIn(user);
    await user.click(screen.getByRole("button", { name: "Anmelden und verbinden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    await advance(1100);
    expect(await screen.findByText(/Beim Anbieter kann schon ein Schlüssel namens „secret-desk-9“ angelegt sein/)).toBeInTheDocument();
    expect(screen.getByText("paste a key here")).toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Mit dieser Projekt-ID verbinden" });
    expect(connect).toBeDisabled();
    fireEvent.submit(connect.closest("form")!);
    expect(portal.callsTo("POST", `${BASE}/connect`)).toHaveLength(0);
    await user.type(screen.getByLabelText("Projekt-ID"), "proj_7");
    await user.click(connect);
    expect(await screen.findByText("project invalid")).toBeInTheDocument();
    await user.click(connect);
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/connect`)).toHaveLength(2));
    expect(portal.callsTo("POST", `${BASE}/connect`)[1]?.body).toEqual({ projectId: "proj_7", inputs: {} });
    expect(await screen.findByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
  });

  it("returns to the form with Erneut versuchen after a failure", async () => {
    let started = false;
    fakePortal({
      [`GET ${BASE}/state`]: () => (started ? runState({ status: "failed", failure: { code: "rejected", message: "Abgelehnt.", messageEn: "Rejected." } }) : { status: 404, body: {} }),
      [`POST ${BASE}/check`]: SIGNED_OUT,
      [`POST ${BASE}/sign-in`]: () => { started = true; return runState({ status: "running" }); },
    });
    const { user } = renderApp(flow());
    await fillSignIn(user);
    await user.click(screen.getByRole("button", { name: "Anmelden und verbinden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    await advance(1100);
    await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("button", { name: "Anmelden und verbinden" })).toBeInTheDocument();
  });

  it("shows the server error of a failed sign-in start and ignores a submit that is not ready", async () => {
    const portal = fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_OUT, [`POST ${BASE}/sign-in`]: { status: 409, body: { error: "browser busy" } } });
    const { user } = renderApp(flow());
    const email = await screen.findByLabelText("E-Mail bei Stripe");
    fireEvent.submit(email.closest("form")!);
    expect(portal.callsTo("POST", `${BASE}/sign-in`)).toHaveLength(0);
    await fillSignIn(user);
    await user.click(screen.getByRole("button", { name: "Anmelden und verbinden" }));
    expect(await screen.findByText("browser busy")).toBeInTheDocument();
  });

  it("shows the error of a failed cancel request", async () => {
    fakePortal({ [`GET ${BASE}/state`]: runState({ status: "running" }), [`POST ${BASE}/cancel`]: { status: 500, body: { error: "cancel failed" } } });
    const { user } = renderApp(flow());
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByText("cancel failed")).toBeInTheDocument();
  });

  it("sends typed inputs with the sign-in and labels them in English", async () => {
    window.localStorage.setItem("sd-locale", "en");
    const portal = fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_OUT, [`POST ${BASE}/sign-in`]: runState({ status: "running" }) });
    const facade = facadeInfo({ inputs: [{ param: "account", label: "Konto", labelEn: "Account", options: null, pattern: null, help: null }] });
    const { user } = renderApp(flow({ facade }));
    await user.type(await screen.findByLabelText("Account"), "acct_5");
    await user.type(screen.getByLabelText("Email at Stripe"), "me@example.test");
    await user.type(screen.getByLabelText("Password at Stripe"), "password-for-tests");
    await user.click(screen.getByRole("button", { name: "Sign in and connect" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/sign-in`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/sign-in`)[0]?.body).toMatchObject({ inputs: { account: "acct_5" } });
  });

  it("shows the error of a failed connect with the signed-in browser", async () => {
    fakePortal({ ...noRun, [`POST ${BASE}/check`]: SIGNED_IN, [`POST ${BASE}/connect`]: { status: 500, body: { error: "connect failed" } } });
    const { user } = renderApp(flow());
    await user.click(await screen.findByRole("button", { name: "Mit angemeldetem Browser verbinden" }));
    expect((await screen.findAllByText("connect failed")).length).toBeGreaterThan(0);
  });

  it("keeps following when a poll fails and drops a late answer after closing", async () => {
    let mode: "ok" | "fail" | "hold" = "ok";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const portal = fakePortal({
      [`GET ${BASE}/state`]: async () => {
        if (mode === "fail") return { status: 500, body: { error: "hiccup" } };
        if (mode === "hold") await gate;
        return runState({ status: "running" });
      },
    });
    const { unmount } = renderApp(flow());
    await screen.findByRole("button", { name: "Abbrechen" });
    mode = "fail";
    await advance(1100);
    mode = "hold";
    await advance(1100);
    const calls = portal.callsTo("GET", `${BASE}/state`).length;
    unmount();
    release();
    await advance(10);
    expect(portal.callsTo("GET", `${BASE}/state`).length).toBe(calls);
  });

  it("drops the pick-up answer when closed before it arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ [`GET ${BASE}/state`]: async () => { await gate; return runState({ status: "running" }); } });
    const { unmount } = renderApp(flow());
    unmount();
    release();
    await advance(10);
  });
});

const section = (facades: FacadeInfo[], onOpen: (id: string) => void = () => {}) => <FacadeSection facades={facades} onOpen={onOpen} />;

describe("FacadeSection", () => {
  it("renders nothing without providers", () => {
    const { container } = renderApp(section([]));
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows an unavailable provider without a reason", () => {
    renderApp(section([facadeInfo({ available: false, reason: null })]));
    expect(screen.getByText("Nicht verfügbar:")).toBeInTheDocument();
  });

  it("lists providers with their state and opens one", async () => {
    const onOpen = vi.fn();
    const { user } = renderApp(section([facadeInfo({ recipeStatus: "ok", connected: true }), facadeInfo({ id: "other", label: "Other", available: false, reason: "no recipe" })], onOpen));
    expect(screen.getByText("Rezept: ok")).toBeInTheDocument();
    expect(screen.getByText("Nicht verbunden")).toBeInTheDocument();
    expect(screen.getByText("Nicht verfügbar: no recipe")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Anmeldung prüfen" })[1]).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Erneut mit Anmeldung verbinden" }));
    expect(onOpen).toHaveBeenCalledWith("stripe");
    expect(screen.getByRole("button", { name: "Mit Anmeldung verbinden" })).toBeDisabled();
  });

  it("checks the browser sign-in and reports yes or no, or the error", async () => {
    let answer: { status: number; body: unknown } | { signedIn: boolean; checkedAt: string } = { signedIn: true, checkedAt: "x" };
    fakePortal({ "POST facades/stripe/check": () => answer });
    const { user } = renderApp(section([facadeInfo()]));
    await user.click(screen.getByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("Der Browser ist angemeldet.")).toBeInTheDocument();
    answer = { signedIn: false, checkedAt: "x" };
    await user.click(screen.getByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("Der Browser ist nicht angemeldet.")).toBeInTheDocument();
    answer = { status: 500, body: { error: "check broke" } };
    await user.click(screen.getByRole("button", { name: "Anmeldung prüfen" }));
    expect(await screen.findByText("check broke")).toBeInTheDocument();
  });
});
