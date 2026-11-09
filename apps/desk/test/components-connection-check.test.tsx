import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheckList, ConnectionCheckPanel, type CheckResult } from "@/components/ConnectionCheck";
import { ActivityHost } from "./helpers/activity";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const ok: CheckResult = { id: "acme", ok: true, checks: [{ id: "c1", label: "Token valid", status: "pass", detail: "reads fine" }, { id: "c2", label: "Scope note", status: "info" }] };

const panel = (props: Partial<Parameters<typeof ConnectionCheckPanel>[0]> = {}) => (
  <ActivityHost><ConnectionCheckPanel id="acme" onResult={() => {}} {...props} /></ActivityHost>
);

describe("CheckList", () => {
  it("renders the verdict, every check and the optional expiry and scopes", () => {
    const { rerender } = renderApp(<CheckList result={ok} />);
    expect(screen.getByText("Die Verbindung funktioniert.")).toBeInTheDocument();
    expect(screen.getByText("Token valid")).toBeInTheDocument();
    expect(screen.getByText("reads fine")).toBeInTheDocument();
    expect(screen.queryByText(/Laut Anbieter/)).toBeNull();
    expect(screen.queryByText(/Rechte:/)).toBeNull();

    rerender(<CheckList result={{ ...ok, ok: false, expires: null, scopes: [] }} />);
    expect(screen.getByText("Die Verbindung hat Probleme.")).toBeInTheDocument();
    expect(screen.getByText("Laut Anbieter ohne Ablauf.")).toBeInTheDocument();
    expect(screen.queryByText(/Rechte:/)).toBeNull();

    rerender(<CheckList result={{ ...ok, expires: "2099-01-31", scopes: ["repo", "read:org"] }} />);
    expect(screen.getByText(/Laut Anbieter gültig bis 31\.01\.2099 \(in \d+ Tagen\)\./)).toBeInTheDocument();
    expect(screen.getByText("Rechte: repo, read:org")).toBeInTheDocument();
  });
});

describe("ConnectionCheckPanel", () => {
  it("runs the check, shows the result, reports it and can hide it again", async () => {
    const portal = fakePortal({ "POST connections/acme/check": ok });
    const onResult = vi.fn();
    const { user } = renderApp(panel({ onResult }));
    await user.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText("Die Verbindung funktioniert.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "connections/acme/check")[0]?.body).toEqual({});
    expect(onResult).toHaveBeenCalledWith(ok);
    expect(await screen.findByText("Verbindungstest bestanden.", { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ergebnis ausblenden" }));
    expect(screen.queryByText("Die Verbindung funktioniert.")).toBeNull();
    expect(onResult).toHaveBeenLastCalledWith(null);
  });

  it("shows the spinner state while the check runs and names the first failing check in the failure toast", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ "POST connections/acme/check": async () => { await gate; return { id: "acme", ok: false, checks: [{ id: "c", label: "No access", status: "fail" }] }; } });
    const { user } = renderApp(panel({ cardId: "card-x", name: "Acme live" }));
    await user.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByRole("button", { name: "Teste …" })).toBeDisabled();
    release();
    expect(await screen.findByText("Acme live: Verbindungstest meldet ein Problem. Details: No access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verbindung testen" })).toBeEnabled();
  });

  it("shows nothing and reports nothing when the request fails", async () => {
    fakePortal({ "POST connections/acme/check": { status: 502, body: { error: "upstream down" } } });
    const onResult = vi.fn();
    const { user } = renderApp(panel({ onResult }));
    await user.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText(/upstream down/)).toBeInTheDocument();
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Ergebnis ausblenden" })).toBeNull();
  });

  it("offers no write test for other connections", () => {
    renderApp(panel());
    expect(screen.queryByText("Schreibtest")).toBeNull();
  });
});

describe("ConnectionCheckPanel write test (github)", () => {
  const targets = [
    { id: "acme/app:staging", repo: "acme/app", scope: "environment", environment: "staging", live: false, stages: ["staging"] },
    { id: "acme/app:production", repo: "acme/app", scope: "environment", environment: "production", live: true, stages: ["production"] },
  ];
  const open = async () => {
    const view = renderApp(panel({ id: "github" }));
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    return view;
  };

  it("lists the targets without selecting live ones, lets the user change the choice and runs the deep check", async () => {
    const portal = fakePortal({ "GET connections/github/write-targets": targets, "POST connections/github/check": ok });
    const { user } = await open();
    const staging = await screen.findByRole("checkbox", { name: /acme\/app:staging/ });
    const live = screen.getByRole("checkbox", { name: /acme\/app:production/ });
    expect(staging).toBeChecked();
    expect(live).not.toBeChecked();
    expect(screen.getByText("Live-Ziele sind nicht vorausgewählt. Der Test legt dort kurz einen Probe-Eintrag an.", { exact: false })).toBeInTheDocument();
    await user.click(live);
    await user.click(staging);
    await user.click(staging);
    await user.click(screen.getByRole("button", { name: "Schreibtest ausführen" }));
    await waitFor(() => expect(portal.callsTo("POST", "connections/github/check")).toHaveLength(1));
    expect(portal.callsTo("POST", "connections/github/check")[0]?.body).toEqual({ deep: true, targets: ["acme/app:staging", "acme/app:production"] });
  });

  it("asks for at least one target when none is selected", async () => {
    fakePortal({ "GET connections/github/write-targets": targets });
    const { user } = await open();
    await user.click(await screen.findByRole("checkbox", { name: /acme\/app:staging/ }));
    expect(screen.getByText("Wähle mindestens ein Ziel.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schreibtest ausführen" })).toBeDisabled();
  });

  it("says so when the inventory has no target and shows load errors", async () => {
    fakePortal({ "GET connections/github/write-targets": [] });
    const { unmount } = await open();
    expect(await screen.findByText("Im Inventar ist noch kein Ziel eingetragen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schreibtest ausführen" })).toBeDisabled();
    unmount();
    fakePortal({ "GET connections/github/write-targets": { status: 500, body: { error: "no targets today" } } });
    await open();
    expect(await screen.findByText("no targets today")).toBeInTheDocument();
  });

  it("closes the details again without loading more", async () => {
    const portal = fakePortal({ "GET connections/github/write-targets": [targets[0]] });
    const view = await open();
    await screen.findByRole("checkbox");
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(within(details).getByText("Schreibtest")).toBeInTheDocument();
    expect(portal.callsTo("GET", "connections/github/write-targets")).toHaveLength(1);
  });
});
