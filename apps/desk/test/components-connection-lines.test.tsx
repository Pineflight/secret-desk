import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionLinesList } from "@/components/ConnectionLines";
import type { AccountBlock, AccountLine, ConnectionLines } from "@/lib/provider-cards";
import { ActivityHost } from "./helpers/activity";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const dayFromNow = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const line = (over: Partial<AccountLine> = {}): AccountLine => ({ id: "stripe:acct1:sandbox", account: "Acme", accountId: "acct1", mode: "sandbox", daysLeft: 30, expires: dayFromNow(30), level: "ok", ...over });
const block = (over: Partial<AccountBlock> = {}): AccountBlock => ({ account: "Acme", accountId: "acct1", modes: { sandbox: line(), live: null }, other: [], ...over });
const noLines: ConnectionLines = { accounts: [], legacy: null, others: [] };

type Props = Partial<Parameters<typeof ConnectionLinesList>[0]>;
const list = (props: Props = {}) => (
  <ActivityHost><ConnectionLinesList lines={noLines} blocks={[block()]} cardId="stripe" onRemove={() => {}} onOpen={() => {}} removingId={null} {...props} /></ActivityHost>
);

describe("ConnectionLinesList blocks", () => {
  it("renders nothing without blocks and offers the first connection when allowed", async () => {
    const onConnectAnother = vi.fn();
    const { user, container, rerender } = renderApp(list({ blocks: [] }));
    expect(container.querySelector("ul")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(list({ blocks: [], onConnectAnother }));
    await user.click(screen.getByRole("button", { name: "Konto verbinden" }));
    expect(onConnectAnother).toHaveBeenCalled();
    rerender(list({ onConnectAnother }));
    expect(screen.getByRole("button", { name: "Weiteres Konto verbinden" })).toBeInTheDocument();
  });

  it("shows a connected sandbox row and a missing live row that connects exactly that mode", async () => {
    const onConnectMode = vi.fn();
    const { user, rerender } = renderApp(list({ onConnectMode }));
    expect(screen.getByText("Konto Acme")).toBeInTheDocument();
    expect(screen.getByText("Noch kein Schlüssel")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Konto Acme im Modus Live verbinden" }));
    expect(onConnectMode).toHaveBeenCalledWith("acct1", "live");
    rerender(list({ onConnectMode, blocks: [block({ modes: { sandbox: null, live: line({ id: "stripe:acct1:live", mode: "live" }) } })] }));
    await user.click(screen.getByRole("button", { name: "Konto Acme im Modus Sandbox verbinden" }));
    expect(onConnectMode).toHaveBeenLastCalledWith("acct1", "sandbox");
    rerender(list());
    expect(screen.queryByRole("button", { name: /verbinden/ })).toBeNull();
  });

  it("lists lines of other modes after the two, with and without a mode", () => {
    const other = [line({ id: "stripe:acct1:restricted", mode: "restricted" }), line({ id: "stripe:acct1", mode: null, account: "Plain Name" })];
    renderApp(list({ blocks: [block({ other })] }));
    expect(screen.getByText("Restricted")).toBeInTheDocument();
    expect(screen.getByText("Plain Name")).toBeInTheDocument();
    expect(screen.getAllByText("Schlüssel verbunden")).toHaveLength(3);
  });

  it("folds legacy connections under a disclosure and opens the first one", async () => {
    const onOpen = vi.fn();
    const { user } = renderApp(list({ blocks: [], onOpen, lines: { ...noLines, legacy: { ids: ["old-1", "old-2"], labels: ["Old One", "Old Two"] } } }));
    expect(screen.getByText("Old One, Old Two")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(onOpen).toHaveBeenCalledWith("old-1");
  });
});

describe("ConnectionLinesList line actions", () => {
  it("removes and reconnects a line and shows the removing state", async () => {
    const onRemove = vi.fn();
    const onReconnect = vi.fn();
    const l = line();
    const { user, rerender } = renderApp(list({ onRemove, onReconnect }));
    await user.click(screen.getByRole("button", { name: "Acme Sandbox entfernen" }));
    expect(onRemove).toHaveBeenCalledWith(l.id);
    await user.click(screen.getByRole("button", { name: "Acme Sandbox neu verbinden" }));
    expect(onReconnect).toHaveBeenCalledWith(l);
    rerender(list({ onReconnect, removingId: l.id }));
    expect(screen.getByRole("button", { name: "Acme Sandbox entfernen" })).toBeDisabled();
    rerender(list());
    expect(screen.queryByRole("button", { name: /neu verbinden/ })).toBeNull();
  });

  it("reconnects lines of other modes as well", async () => {
    const onReconnect = vi.fn();
    const extra = line({ id: "stripe:acct1:restricted", mode: "restricted" });
    const { user } = renderApp(list({ onReconnect, blocks: [block({ other: [extra] })] }));
    await user.click(screen.getByRole("button", { name: "Acme Restricted neu verbinden" }));
    expect(onReconnect).toHaveBeenCalledWith(extra);
  });

  it("shows the stored expiry with its level", () => {
    renderApp(list({ blocks: [block({ modes: { sandbox: line({ level: "soon", expires: dayFromNow(10), daysLeft: 10 }), live: line({ id: "stripe:acct1:live", mode: "live", level: "expired", expires: dayFromNow(-2), daysLeft: -2 }) }, other: [line({ id: "stripe:acct1:x", mode: "x", level: "critical", daysLeft: 3 })] })] }));
    expect(screen.getAllByText(/^Gültig bis/)[0]).toHaveClass("text-warn-text");
    expect(screen.getAllByText(/^Gültig bis/)[1]).toHaveClass("text-danger");
    expect(screen.getAllByText(/^Gültig bis/)[2]).toHaveClass("text-danger");
  });

  it("tests a line: spinner while running, result mark after, and the provider expiry replaces the stored one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const portal = fakePortal({ "POST connections/stripe%3Aacct1%3Asandbox/check": async () => { await gate; return { id: "x", ok: true, checks: [{ id: "c", label: "Key valid", status: "pass" }], expires: dayFromNow(3) }; } });
    const { user } = renderApp(list());
    await user.click(screen.getByRole("button", { name: "Acme Sandbox testen" }));
    expect(await screen.findByText("Acme Sandbox wird geprüft …")).toBeInTheDocument();
    release();
    expect(await screen.findByText("Key valid")).toBeInTheDocument();
    expect(portal.callsTo("POST", "connections/stripe%3Aacct1%3Asandbox/check")).toHaveLength(1);
    expect(screen.getByLabelText(/Letzte Prüfung bestanden um \d\d:\d\d/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Gültig bis/)[0]).toHaveClass("text-danger");
    await user.click(screen.getByRole("button", { name: "Ergebnis ausblenden" }));
    expect(screen.queryByText("Key valid")).toBeNull();
  });

  it("keeps the stored expiry when the provider names none, and uses the provider's 'never expires'", async () => {
    fakePortal({ "POST connections/stripe%3Aacct1%3Asandbox/check": { id: "x", ok: false, checks: [{ id: "c", label: "Revoked", status: "fail" }] } });
    const { user, unmount } = renderApp(list());
    await user.click(screen.getByRole("button", { name: "Acme Sandbox testen" }));
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(/^Gültig bis/)).not.toHaveClass("text-danger");
    expect(screen.getByLabelText(/Letzte Prüfung fehlgeschlagen um/)).toBeInTheDocument();
    unmount();

    fakePortal({ "POST connections/stripe%3Aacct1%3Asandbox/check": { id: "x", ok: true, checks: [], expires: null } });
    const second = renderApp(list());
    await second.user.click(screen.getByRole("button", { name: "Acme Sandbox testen" }));
    expect(await screen.findByText("Läuft nie ab")).toBeInTheDocument();
  });

  it("shows unknown expiry and a failed request without a result", async () => {
    fakePortal({ "POST connections/stripe%3Aacct1%3Asandbox/check": { status: 500, body: { error: "check crashed" } } });
    const { user } = renderApp(list({ blocks: [block({ modes: { sandbox: line({ expires: undefined, daysLeft: null, level: null }), live: null } })] }));
    expect(screen.getByText("Gültigkeit nicht angegeben")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acme Sandbox testen" }));
    await waitFor(() => expect(screen.getByLabelText(/Letzte Prüfung fehlgeschlagen/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Ergebnis ausblenden" })).toBeNull();
    expect(within(screen.getByText("Konto Acme").closest("li")!).getByText("Gültigkeit nicht angegeben")).toBeInTheDocument();
  });

  it("uses the account name for a line without a mode", async () => {
    renderApp(list({ blocks: [block({ modes: { sandbox: null, live: null }, other: [line({ id: "stripe:plain", mode: null, account: "Plain Name" })] })] }));
    expect(screen.getByRole("button", { name: "Plain Name testen" })).toBeInTheDocument();
  });
});
