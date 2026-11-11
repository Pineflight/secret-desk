import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveCheckReport } from "@secret-desk/runtime";
import { LiveCheckPanel, type LiveCheckState } from "@/components/LiveCheckPanel";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

afterEach(() => {
  vi.useRealTimers();
});

const report = (over: Partial<LiveCheckReport> = {}): LiveCheckReport => ({
  startedAt: "2026-11-09T10:00:00.000Z",
  finishedAt: "2026-11-09T10:05:00.000Z",
  ok: true,
  trigger: "schedule",
  connections: [{ id: "openai", result: "ok" }],
  recipes: [{ id: "peecho-api-keys", result: "ok", detail: "3 steps ran; stopped before creating anything." }],
  summary: { connections: { ok: 1, failed: 0, notConnected: 0 }, recipes: { ok: 1, failed: 0, needsSignIn: 0, skipped: 0 } },
  ...over,
});
const state = (over: Partial<LiveCheckState> = {}): LiveCheckState => ({ reports: [report()], running: false, intervalDays: 7, stale: false, ...over });

describe("LiveCheckPanel", () => {
  it("says so when no check ran yet, without an extra warning, and starts one with the button", async () => {
    let current = state({ reports: [], stale: true });
    const portal = fakePortal({
      "GET live-check": () => current,
      "POST live-check": () => {
        current = state({ reports: [], running: true });
        return current;
      },
    });
    const { user } = renderApp(<LiveCheckPanel />);
    expect(await screen.findByText("Noch nie gelaufen")).toBeInTheDocument();
    expect(screen.queryByText(/Es gibt noch keinen Lauf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Letzter Lauf/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jetzt prüfen" }));
    await waitFor(() => expect(portal.callsTo("POST", "live-check")).toHaveLength(1));
    expect(await screen.findByText("Läuft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jetzt prüfen/ })).toBeDisabled();
  });

  it("shows the last run, the counts and the items, failures first, with step, kind and sanitized detail", async () => {
    fakePortal({
      "GET live-check": state({
        reports: [
          report({
            ok: false,
            trigger: "manual",
            connections: [{ id: "openai", result: "ok" }, { id: "resend", result: "failed", detail: "Key valid: HTTP 401" }, { id: "github", result: "not-connected" }],
            recipes: [
              { id: "ok-recipe", result: "ok" },
              { id: "sign-recipe", result: "needs-sign-in", step: "goto", detail: "The browser is signed out at this provider." },
              { id: "broken-recipe", result: "failed", step: "click button \"Create\"", kind: "step", detail: "Step 2 failed." },
              { id: "skipped-recipe", result: "skipped", detail: "Inputs cannot be derived." },
            ],
            summary: { connections: { ok: 1, failed: 1, notConnected: 1 }, recipes: { ok: 1, failed: 1, needsSignIn: 1, skipped: 1 } },
          }),
        ],
      }),
    });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText("Fehler gefunden")).toBeInTheDocument();
    expect(screen.getByText(/Letzter Lauf: 09\.11\.2026, \d\d:\d\d \(von Hand\)/)).toBeInTheDocument();
    expect(screen.getByText(/Integrationen: 1 in Ordnung, 1 fehlgeschlagen, 1 nicht verbunden\. Rezepte: 1 in Ordnung, 1 fehlgeschlagen, 1 brauchen Anmeldung, 1 übersprungen\./)).toBeInTheDocument();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("span")?.textContent)).toEqual(["resend", "broken-recipe", "sign-recipe", "skipped-recipe", "github", "openai", "ok-recipe"]);
    expect(within(items[1]!).getByText('click button "Create" · step · Step 2 failed.')).toBeInTheDocument();
    expect(within(items[0]!).getByText("Key valid: HTTP 401")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Anmeldung nötig")).toBeInTheDocument();
    expect(within(items[4]!).getByText("Nicht verbunden")).toBeInTheDocument();
    expect(screen.queryByText(/älter als/)).not.toBeInTheDocument();
  });

  it("keeps title, badge, last run and the button in one bar, with the explanation in a closed disclosure", async () => {
    fakePortal({ "GET live-check": state() });
    renderApp(<LiveCheckPanel />);
    const button = await screen.findByRole("button", { name: "Jetzt prüfen" });
    const bar = button.parentElement!;
    expect(within(bar).getByRole("heading", { name: "Live-Check" })).toBeInTheDocument();
    expect(within(bar).getByText("In Ordnung")).toBeInTheDocument();
    expect(within(bar).getByText(/Letzter Lauf/)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Details und Erklärung" });
    expect(bar.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details).toHaveAttribute("hidden");
    expect(within(details).getByText(/Prüft gegen die echten Konten/)).toBeInTheDocument();
    expect(bar.contains(details)).toBe(false);
  });

  it("opens and closes the details with the toggle on the bar", async () => {
    fakePortal({ "GET live-check": state() });
    const { user } = renderApp(<LiveCheckPanel />);
    const toggle = await screen.findByRole("button", { name: "Details und Erklärung" });
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(details).not.toHaveAttribute("hidden");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(details).toHaveAttribute("hidden");
  });

  it("opens the list on its own when something failed, and caps its height", async () => {
    fakePortal({ "GET live-check": state({ reports: [report({ ok: false, connections: [{ id: "resend", result: "failed", detail: "HTTP 401" }], summary: { connections: { ok: 0, failed: 1, notConnected: 0 }, recipes: { ok: 1, failed: 0, needsSignIn: 0, skipped: 0 } } })] }) });
    renderApp(<LiveCheckPanel />);
    const toggle = await screen.findByRole("button", { name: "Details und Erklärung" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details).not.toHaveAttribute("hidden");
    expect(within(details).getByRole("list")).toHaveClass("max-h-[50vh]");
  });

  it("warns with the count when recipes could not be checked because they need a sign-in", async () => {
    fakePortal({ "GET live-check": state({ reports: [report({ summary: { connections: { ok: 1, failed: 0, notConnected: 0 }, recipes: { ok: 0, failed: 0, needsSignIn: 3, skipped: 0 } } })] }) });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText(/3 Rezepte konnten nicht geprüft werden: bitte anmelden/)).toBeInTheDocument();
  });

  it("shows a good automatic run as all good", async () => {
    fakePortal({ "GET live-check": state() });
    renderApp(<LiveCheckPanel />);
    expect((await screen.findAllByText("In Ordnung")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\(automatisch\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jetzt prüfen" })).toBeEnabled();
  });

  it("warns when the last run is older than twice the interval", async () => {
    fakePortal({ "GET live-check": state({ stale: true, intervalDays: 7 }) });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText(/Der letzte Lauf ist älter als 14 Tage/)).toBeInTheDocument();
  });

  it("does not repeat the never-run badge as a stale warning", async () => {
    fakePortal({ "GET live-check": state({ reports: [], stale: true }) });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText("Noch nie gelaufen")).toBeInTheDocument();
    expect(screen.queryByText(/älter als/)).not.toBeInTheDocument();
  });

  it("tells that the automatic check is off and does not warn", async () => {
    fakePortal({ "GET live-check": state({ intervalDays: 0 }) });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText(/Die automatische Prüfung ist aus/)).toBeInTheDocument();
    expect(screen.queryByText(/älter als/)).not.toBeInTheDocument();
  });

  it("looks again every few seconds while a check runs, and shows the result when it is done", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let n = 0;
    const portal = fakePortal({ "GET live-check": () => (++n < 3 ? state({ running: true }) : state({ reports: [report({ trigger: "manual" })] })) });
    renderApp(<LiveCheckPanel />);
    expect(await screen.findByText("Läuft")).toBeInTheDocument();
    for (let i = 0; i < 4 && screen.queryByText("Läuft"); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
    }
    await waitFor(() => expect(screen.queryByText("Läuft")).not.toBeInTheDocument());
    expect(screen.getByText(/\(von Hand\)/)).toBeInTheDocument();
    const reads = portal.callsTo("GET", "live-check").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    // Not running any more: no more looking.
    expect(portal.callsTo("GET", "live-check")).toHaveLength(reads);
  });

  it("explains a refused start (409) and a failed one apart", async () => {
    const portal = fakePortal({ "GET live-check": state(), "POST live-check": { status: 409, body: { error: "A live check is already running." } } });
    const { user } = renderApp(<LiveCheckPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt prüfen" }));
    expect(await screen.findByText(/Es läuft schon ein Live-Check oder ein anderer Browser-Lauf/)).toBeInTheDocument();
    expect(portal.callsTo("POST", "live-check")).toHaveLength(1);
  });

  it("shows a generic message when the start fails otherwise", async () => {
    fakePortal({ "GET live-check": state(), "POST live-check": { status: 500, body: { error: "boom" } } });
    const { user } = renderApp(<LiveCheckPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt prüfen" }));
    expect(await screen.findByText("Der Live-Check konnte nicht gestartet werden.")).toBeInTheDocument();
  });

  it("offers a retry when the state cannot be loaded and keeps the button off until it is", async () => {
    let fail = true;
    fakePortal({ "GET live-check": () => (fail ? { status: 500, body: { error: "down" } } : state()) });
    const { user } = renderApp(<LiveCheckPanel />);
    expect(await screen.findByText(/Der Live-Check konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jetzt prüfen" })).toBeDisabled();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect((await screen.findAllByText("In Ordnung")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/nicht geladen werden/)).not.toBeInTheDocument();
  });
});
