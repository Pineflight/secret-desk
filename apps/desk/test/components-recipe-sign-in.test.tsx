import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeSignInFlow } from "@/components/RecipeSignIn";
import type { RecipeSignInSubject } from "@/lib/facade";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";
import { runState } from "./helpers/run";

const subject = (over: Partial<RecipeSignInSubject> = {}): RecipeSignInSubject => ({ id: "peecho", available: true, methods: [], passwordless: false, hosts: [{ value: "live", host: "live.peecho.test" }, { value: "test", host: "test.peecho.test" }], ...over });
const BASE = "recipes/peecho/sign-in";
const flow = (props: Partial<Parameters<typeof RecipeSignInFlow>[0]> = {}) => <RecipeSignInFlow subject={subject()} name="Peecho" onChanged={() => {}} onDone={() => {}} {...props} />;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("RecipeSignInFlow form", () => {
  it("asks for the portal, email and password, sends them once and clears the fields", async () => {
    let state = runState();
    const portal = fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: { error: "none" } }, [`POST ${BASE}`]: () => state });
    const { user } = renderApp(flow());
    expect(screen.getByText(/meldet sich für dich bei Peecho an/)).toBeInTheDocument();
    expect(screen.getByText(/nur auf dem Host des gewählten Portals eingetippt/)).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Anmelden" });
    expect(submit).toBeDisabled();
    await pickOption(user, "Portal", "live (live.peecho.test)");
    expect(screen.getByText(/nur auf live\.peecho\.test eingetippt/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("E-Mail bei Peecho"), "me@example.test");
    await user.type(screen.getByLabelText("Passwort bei Peecho"), "password-for-tests");
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(portal.callsTo("POST", BASE)).toHaveLength(1));
    expect(portal.callsTo("POST", BASE)[0]?.body).toEqual({ method: "email", username: "me@example.test", password: "password-for-tests", host: "live" });
    expect(await screen.findByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("password-for-tests")).toBeNull();
    state = runState({ status: "done" });
  });

  it("preselects the only portal or the wanted one and hides the picker for one portal", () => {
    fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: {} } });
    const { unmount } = renderApp(flow({ subject: subject({ hosts: [{ value: "live", host: "live.peecho.test" }] }) }));
    expect(screen.queryByText("Portal")).toBeNull();
    expect(screen.getByText(/nur auf live\.peecho\.test eingetippt/)).toBeInTheDocument();
    unmount();
    const second = renderApp(flow({ portal: "test" }));
    expect(second.container.textContent).toContain("test.peecho.test");
    second.unmount();
    renderApp(flow({ subject: subject({ hosts: [] }) }));
    expect(screen.getByText(/nur auf Peecho eingetippt/)).toBeInTheDocument();
  });

  it("explains an unavailable recipe and keeps the button disabled", () => {
    fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: {} } });
    renderApp(flow({ subject: subject({ available: false, hosts: [] }) }));
    expect(screen.getByText(/Nicht verfügbar: Die Browser-Automatisierung ist aus/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeDisabled();
  });

  it("offers several sign-in methods, and skips the password for a passwordless email sign-in", async () => {
    const portal = fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: {} }, [`POST ${BASE}`]: runState() });
    const methods = [{ id: "email" as const, label: null, labelEn: null }, { id: "google" as const, label: "Mit Google", labelEn: "With Google" }];
    const { user, unmount } = renderApp(flow({ subject: subject({ hosts: [], methods, passwordless: true }) }));
    expect(screen.getByText(/meldet dich mit einem Code an/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Passwort bei Peecho")).toBeNull();
    await user.type(screen.getByLabelText("E-Mail bei Peecho"), "me@example.test");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() => expect(portal.callsTo("POST", BASE)).toHaveLength(1));
    expect(portal.callsTo("POST", BASE)[0]?.body).toEqual({ method: "email", username: "me@example.test", password: "" });
    unmount();
    const second = renderApp(flow({ subject: subject({ hosts: [], methods, passwordless: true }) }));
    await second.user.click(screen.getByRole("radio", { name: "Mit Google" }));
    expect(screen.getByLabelText("Google-Passwort")).toBeInTheDocument();
    expect(screen.getByText(/über Google anmelden/)).toBeInTheDocument();
  });

  it("shows the server's error and keeps the form usable", async () => {
    fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: {} }, [`POST ${BASE}`]: { status: 409, body: { error: "a run is already going" } } });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.type(screen.getByLabelText("E-Mail bei Peecho"), "me@example.test");
    await user.type(screen.getByLabelText("Passwort bei Peecho"), "password-for-tests");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByText("a run is already going")).toBeInTheDocument();
  });

  it("ignores a submit while the form is not ready", async () => {
    const portal = fakePortal({ [`GET ${BASE}/state`]: { status: 404, body: {} } });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.type(screen.getByLabelText("E-Mail bei Peecho"), "me@example.test");
    fireEvent.submit(screen.getByLabelText("E-Mail bei Peecho").closest("form")!);
    expect(portal.callsTo("POST", BASE)).toHaveLength(0);
  });
});

describe("RecipeSignInFlow run", () => {
  it("follows a run to the end, notifies once and closes with Fertig", async () => {
    let current = runState({ status: "running" });
    const portal = fakePortal({ [`GET ${BASE}/state`]: () => current, [`POST ${BASE}`]: () => runState({ status: "running" }) });
    const onChanged = vi.fn();
    const onDone = vi.fn();
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }), onChanged, onDone }));
    // The run was already going when the dialog opened.
    expect(await screen.findByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
    expect(screen.getByText(/Laufzeit/)).toBeInTheDocument();
    current = runState({ status: "done" });
    await advance(1100);
    expect(await screen.findByText("Bei Peecho angemeldet.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    expect(onDone).toHaveBeenCalled();
    expect(portal.callsTo("GET", `${BASE}/state`).length).toBeGreaterThan(1);
  });

  it("names the portal in the done message after a sign-in started here", async () => {
    let current = runState({ status: "running" });
    fakePortal({ [`GET ${BASE}/state`]: () => (current.status === "done" ? current : { status: 404, body: {} }), [`POST ${BASE}`]: () => current });
    const { user } = renderApp(flow({ portal: "live" }));
    await user.type(screen.getByLabelText("E-Mail bei Peecho"), "me@example.test");
    await user.type(screen.getByLabelText("Passwort bei Peecho"), "password-for-tests");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await screen.findByRole("button", { name: "Abbrechen" });
    current = runState({ status: "done" });
    await advance(1100);
    expect(await screen.findByText("Bei Peecho live angemeldet.")).toBeInTheDocument();
  });

  it("does not update after it was closed before the first answer arrived", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const portal = fakePortal({ [`GET ${BASE}/state`]: async () => { await gate; return runState({ status: "running" }); } });
    const { unmount } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await waitFor(() => expect(portal.callsTo("GET", `${BASE}/state`)).toHaveLength(1));
    unmount();
    release();
    await advance(10);
  });

  it("drops a poll answer that arrives after it was closed", async () => {
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    const portal = fakePortal({ [`GET ${BASE}/state`]: async () => { if (hold) await hold; return runState({ status: "running" }); } });
    const { unmount } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await screen.findByRole("button", { name: "Abbrechen" });
    hold = new Promise<void>((r) => { release = r; });
    await advance(1100);
    const before = portal.callsTo("GET", `${BASE}/state`).length;
    unmount();
    release();
    await advance(10);
    expect(portal.callsTo("GET", `${BASE}/state`).length).toBe(before);
  });

  it("keeps following when a poll fails", async () => {
    let fail = false;
    const portal = fakePortal({ [`GET ${BASE}/state`]: () => (fail ? { status: 500, body: { error: "hiccup" } } : runState({ status: "running" })) });
    renderApp(flow({ subject: subject({ hosts: [] }) }));
    await screen.findByRole("button", { name: "Abbrechen" });
    fail = true;
    await advance(1100);
    await waitFor(() => expect(portal.callsTo("GET", `${BASE}/state`).length).toBeGreaterThan(1));
    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
  });

  it("cancels a running run", async () => {
    const portal = fakePortal({ [`GET ${BASE}/state`]: runState({ status: "running" }), [`POST ${BASE}/cancel`]: runState({ status: "cancelled", failure: { code: "cancelled", message: "Abgebrochen.", messageEn: "Cancelled." } }) });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/cancel`)).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(screen.getByText("Abgebrochen.")).toBeInTheDocument();
  });

  it("shows a failure and returns to the form on retry", async () => {
    let first = true;
    fakePortal({
      [`GET ${BASE}/state`]: () => (first ? runState({ status: "running" }) : { status: 404, body: {} }),
      [`POST ${BASE}/cancel`]: runState({ status: "failed", failure: { code: "bad", message: "Anmeldung abgelehnt.", messageEn: "Rejected." } }),
    });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByText("Anmeldung abgelehnt.")).toBeInTheDocument();
    first = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("button", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("answers a one-time code and a consent question", async () => {
    let state = runState({ needs: "mfa-code" });
    const portal = fakePortal({
      [`GET ${BASE}/state`]: () => state,
      [`POST ${BASE}/code`]: () => { state = runState({ needs: "consent", detail: "read repos" }); return state; },
      [`POST ${BASE}/confirm`]: () => runState({ needs: null }),
    });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.type(await screen.findByLabelText("Einmalcode"), "123456");
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/code`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/code`)[0]?.body).toEqual({ code: "123456" });
    await user.click(await screen.findByRole("button", { name: "Autorisieren" }));
    await waitFor(() => expect(portal.callsTo("POST", `${BASE}/confirm`)).toHaveLength(1));
    expect(portal.callsTo("POST", `${BASE}/confirm`)[0]?.body).toEqual({ accept: true });
  });

  it("shows the error of a failed cancel request", async () => {
    fakePortal({ [`GET ${BASE}/state`]: runState({ status: "running" }), [`POST ${BASE}/cancel`]: { status: 500, body: { error: "cancel failed" } } });
    const { user } = renderApp(flow({ subject: subject({ hosts: [] }) }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByText("cancel failed")).toBeInTheDocument();
  });
});
