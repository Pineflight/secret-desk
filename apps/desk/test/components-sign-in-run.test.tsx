import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStatus, SignInFields, Stepper, useNow } from "@/components/SignInRun";
import type { FacadeInfo, FacadeMethodId, FacadeState } from "@/lib/facade";
import { runState } from "./helpers/run";
import { renderApp } from "./helpers/render";

afterEach(() => vi.useRealTimers());

const noop = () => {};
const status = (over: Partial<FacadeState> = {}) => runState({ startedAt: new Date(Date.now() - 65_000).toISOString(), ...over });
const run = (state: FacadeState, props: Partial<Parameters<typeof RunStatus>[0]> = {}) => (
  <RunStatus run={state} name="Peecho" method="github" now={Date.now()} codePending={false} onCode={noop} confirmPending={false} onConfirm={noop} {...props} />
);

describe("useNow", () => {
  function Clock({ active }: { active: boolean }) {
    return <p data-testid="now">{useNow(active)}</p>;
  }

  it("ticks every second while active and stands still otherwise", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { rerender } = renderApp(<Clock active={false} />);
    const first = Number(screen.getByTestId("now").textContent);
    act(() => void vi.advanceTimersByTime(3000));
    expect(Number(screen.getByTestId("now").textContent)).toBe(first);
    rerender(<Clock active />);
    act(() => void vi.advanceTimersByTime(3000));
    expect(Number(screen.getByTestId("now").textContent)).toBeGreaterThanOrEqual(first + 3000);
    rerender(<Clock active={false} />);
    const stopped = Number(screen.getByTestId("now").textContent);
    act(() => void vi.advanceTimersByTime(5000));
    expect(Number(screen.getByTestId("now").textContent)).toBe(stopped);
  });
});

describe("Stepper", () => {
  it("shows pending steps for no run and marks sign-in only runs without key steps", () => {
    const { rerender } = renderApp(<Stepper state={null} />);
    const all = within(screen.getByRole("list", { name: "Schritte" })).getAllByRole("listitem").length;
    rerender(<Stepper state={null} signInOnly />);
    expect(within(screen.getByRole("list", { name: "Schritte" })).getAllByRole("listitem").length).toBeLessThan(all);
  });

  it("marks done, active, waiting, failed and pending steps", () => {
    const timeline = [
      { phase: "opening", state: "done" as const },
      { phase: "username", state: "active" as const },
    ];
    const { rerender } = renderApp(<Stepper state={status({ timeline })} />);
    const items = () => within(screen.getByRole("list", { name: "Schritte" })).getAllByRole("listitem");
    expect(items()[0]).not.toHaveAttribute("aria-current");
    expect(items()[1]).toHaveAttribute("aria-current", "step");
    expect(items()[2]).toHaveClass("text-muted");
    rerender(<Stepper state={status({ status: "waiting-human", timeline })} />);
    expect(items()[1]).toHaveAttribute("aria-current", "step");
    rerender(<Stepper state={status({ status: "failed", timeline: [{ phase: "opening", state: "done" }, { phase: "username", state: "failed" }] })} />);
    expect(items()[1]).toHaveClass("text-danger-text");
  });
});

describe("SignInFields", () => {
  const info = (over: Partial<Pick<FacadeInfo, "methods" | "passwordless">> = {}): Pick<FacadeInfo, "methods" | "passwordless"> => ({ methods: [], passwordless: false, ...over });
  const fields = (props: Partial<Parameters<typeof SignInFields>[0]> = {}) => (
    <SignInFields info={info()} name="Peecho" method="email" onMethod={noop} email="" onEmail={noop} password="" onPassword={noop} idPrefix="t" {...props} />
  );

  it("asks for email and password for a single email sign-in and reports typing", () => {
    const onEmail = vi.fn();
    const onPassword = vi.fn();
    renderApp(fields({ onEmail, onPassword, before: <p>before slot</p> }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText("before slot")).toBeInTheDocument();
    expect(screen.queryByText(/Bei Peecho kannst du dich über/)).toBeNull();
    fireEvent.change(screen.getByLabelText("E-Mail bei Peecho"), { target: { value: "me@example.test" } });
    fireEvent.change(screen.getByLabelText("Passwort bei Peecho"), { target: { value: "password-for-tests" } });
    expect(onEmail).toHaveBeenCalledWith("me@example.test");
    expect(onPassword).toHaveBeenCalledWith("password-for-tests");
  });

  it("asks only for the email for a passwordless email sign-in", () => {
    renderApp(fields({ info: info({ passwordless: true }) }));
    expect(screen.queryByLabelText("Passwort bei Peecho")).toBeNull();
    expect(screen.getByText(/Peecho meldet dich mit einem Code an/)).toBeInTheDocument();
  });

  it("lets the user choose among several methods and explains single sign-on", async () => {
    const onMethod = vi.fn();
    const methods = [{ id: "email" as FacadeMethodId, label: "Eigenes Konto", labelEn: null }, { id: "github" as FacadeMethodId, label: null, labelEn: "GitHub (en)" }];
    const { user, rerender } = renderApp(fields({ info: info({ methods }), onMethod }));
    expect(screen.getByRole("radio", { name: "Eigenes Konto" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Mit GitHub anmelden" }));
    expect(onMethod).toHaveBeenCalledWith("github");
    rerender(fields({ info: info({ methods }), method: "github" }));
    expect(screen.getByText(/Bei Peecho kannst du dich über GitHub anmelden/)).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub-Benutzername oder E-Mail")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub-Passwort")).toBeInTheDocument();
  });

  it("uses the English method label in the English interface", () => {
    localStorage.setItem("sd-locale", "en");
    const methods = [{ id: "email" as FacadeMethodId, label: "Eigenes Konto", labelEn: "Own account" }, { id: "github" as FacadeMethodId, label: null, labelEn: null }];
    renderApp(fields({ info: info({ methods }) }));
    expect(screen.getByRole("radio", { name: "Own account" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });
});

describe("RunStatus", () => {
  it("shows the elapsed time and, while running with a limit, the remaining time", () => {
    const now = Date.now();
    renderApp(run(status({ startedAt: new Date(now - 65_000).toISOString(), timeoutAt: new Date(now + 120_000).toISOString() }), { now }));
    expect(screen.getByText(/Laufzeit 1:05/)).toHaveTextContent("Zeitlimit in 2:00");
  });

  it("omits the remaining time without a limit or after the run ended", () => {
    const now = Date.now();
    const { rerender } = renderApp(run(status({ timeoutAt: null }), { now }));
    expect(screen.getByText(/Laufzeit/)).not.toHaveTextContent("Zeitlimit");
    rerender(run(status({ status: "done", timeoutAt: new Date(now + 60_000).toISOString() }), { now }));
    expect(screen.getByText(/Laufzeit/)).not.toHaveTextContent("Zeitlimit");
  });

  it("asks for the one-time code and passes it on", async () => {
    const onCode = vi.fn();
    const { user } = renderApp(run(status({ needs: "mfa-code" }), { onCode }));
    await user.type(screen.getByLabelText("Einmalcode"), "123456");
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    expect(onCode).toHaveBeenCalledWith("123456");
  });

  it("asks to approve on the device and to consent to the access", async () => {
    const onConfirm = vi.fn();
    const { user, rerender } = renderApp(run(status({ needs: "approval", detail: "17" })));
    expect(screen.getByText("Wenn dein Gerät nach einer Zahl fragt, wähle 17.")).toBeInTheDocument();
    rerender(run(status({ needs: "consent", detail: "repo; user" }), { onConfirm }));
    await user.click(screen.getByRole("button", { name: "Autorisieren" }));
    expect(onConfirm).toHaveBeenCalledWith(true);
    expect(screen.getByText(/GitHub fragt, ob secret-desk/)).toBeInTheDocument();
  });

  it("shows the access question only when a handler is given", async () => {
    const onAccess = vi.fn();
    const ask = { type: "access" as const, stage: "choose" as const, methods: ["mobile" as const], attempt: 1, maxAttempts: 3 };
    const { user, rerender } = renderApp(run(status({ ask })));
    expect(screen.queryByText(/verlangt eine Bestätigung/)).toBeNull();
    rerender(run(status({ ask }), { onAccess, accessPending: false }));
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(onAccess).toHaveBeenCalledWith({ method: "mobile" });
    rerender(run(status({ ask: { type: "credentials", methods: [] } }), { onAccess }));
    expect(screen.queryByText(/verlangt eine Bestätigung/)).toBeNull();
  });

  it("shows no prompt once the run is not running anymore", () => {
    renderApp(run(status({ status: "done", needs: "mfa-code" })));
    expect(screen.queryByLabelText("Einmalcode")).toBeNull();
  });

  it("shows a failure as an alert with a title and a cancellation as a plain note", () => {
    const failure = { code: "rejected", message: "Abgelehnt vom Anbieter", messageEn: "Refused" };
    const { rerender } = renderApp(run(status({ status: "failed", failure })));
    expect(screen.getByRole("alert")).toHaveTextContent("Das hat nicht geklappt");
    expect(screen.getByRole("alert")).toHaveTextContent("Abgelehnt vom Anbieter");
    rerender(run(status({ status: "cancelled", failure })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Abgelehnt vom Anbieter");
    rerender(run(status({ status: "failed" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
