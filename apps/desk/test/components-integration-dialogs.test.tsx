import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddProviderDialog, IntegrationPicker } from "@/components/IntegrationDialogs";
import type { Connection } from "@/lib/connections-shared";
import type { ProviderCard } from "@/lib/provider-cards";
import { fakePortal } from "./helpers/portal";
import { card, key, recipe } from "./helpers/cards";
import { facadeInfo } from "./helpers/run";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: "acme",
  connected: false,
  source: "none",
  label: "Acme key",
  vendor: "acme",
  role: "primary",
  description: "Used for the API.",
  url: "https://acme.test/keys",
  openUrl: "https://acme.test/keys?expires_in=90&name=desk",
  steps: ["Open the page", "Create the key"],
  permissions: ["read:projects"],
  canRemember: true,
  ...over,
});

const byHand = { id: "acme-hand", label: "Hand value", kind: "manual", vendor: "acme", guide: { url: "https://guide.test/", steps: ["Ask support"] } };
const acme = (over: Partial<ProviderCard> = {}): ProviderCard => card({ keys: [key({ id: "acme", label: "Acme key", connected: false, daysLeft: null, expires: undefined, level: null }), key({ id: "acme-extra", label: "Extra", role: "optional", connected: true }), key({ id: "acme-old", label: "Old", role: "legacy", connected: true })], byHand: [byHand], ...over });
const other = card({ id: "zeta", label: "Zeta", category: "database" });

type PickerProps = Partial<Parameters<typeof IntegrationPicker>[0]>;
const picker = (props: PickerProps = {}) => (
  <IntegrationPicker initial={{ vendor: null }} cards={[acme(), other]} conns={[conn(), conn({ id: "acme-extra", label: "Extra", connected: true, role: "optional" })]} facades={[]} categories={["hosting", "database"]} signedIn={new Set()} onClose={() => {}} onChanged={() => {}} onNewProvider={() => {}} {...props} />
);

beforeEach(() => {
  fakePortal({});
});
afterEach(() => vi.useRealTimers());

describe("IntegrationPicker list", () => {
  it("lists providers by category, filters by search and reports when nothing matches", async () => {
    const { user } = renderApp(picker());
    expect(screen.getByRole("heading", { name: "Hosting und Edge" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Datenbank und Backend" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Anbieter nach Name, Kategorie oder Zweck suchen" });
    await user.type(search, "zeta");
    expect(screen.queryByRole("button", { name: /^Acme,/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Zeta,/ })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "no-such-provider");
    expect(screen.getByText("Kein Anbieter passt.")).toBeInTheDocument();
  });

  it("keeps the gap below the search field at 16px", () => {
    renderApp(picker());
    expect(screen.getByRole("searchbox")).toHaveClass("mb-4");
  });

  it("opens a provider and goes back to the list, and adds a custom provider", async () => {
    const onNewProvider = vi.fn();
    const { user } = renderApp(picker({ onNewProvider }));
    await user.click(screen.getByRole("button", { name: /^Acme,/ }));
    expect(screen.getByRole("dialog", { name: "Acme" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Zurück zu allen Anbietern" }));
    expect(screen.getByRole("dialog", { name: "Integration hinzufügen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Eigenen Anbieter anlegen" }));
    expect(onNewProvider).toHaveBeenCalled();
  });
});

describe("IntegrationPicker unknown or changing data", () => {
  it("shows the list when the asked-for provider is not known", () => {
    renderApp(picker({ initial: { vendor: "vanished" } }));
    expect(screen.getByRole("dialog", { name: "Integration hinzufügen" })).toBeInTheDocument();
  });

  it("shows nothing for a by-hand provider that disappeared while its guide was open", async () => {
    const { user, rerender } = renderApp(picker({ initial: { vendor: "acme" } }));
    await user.click(screen.getByRole("button", { name: "Hand value" }));
    expect(screen.getByText("Ask support")).toBeInTheDocument();
    rerender(picker({ initial: { vendor: "acme" }, cards: [acme({ byHand: [] })] }));
    expect(screen.queryByText("Ask support")).toBeNull();
    expect(screen.getByRole("button", { name: "← Zurück zur Auswahl" })).toBeInTheDocument();
  });

  it("shows a guide without steps as just the link", async () => {
    const { user } = renderApp(picker({ initial: { vendor: "acme" }, cards: [acme({ byHand: [{ ...byHand, guide: { url: "https://guide.test/", steps: [] } }] })] }));
    await user.click(screen.getByRole("button", { name: "Hand value" }));
    expect(screen.getByRole("link", { name: /Seite des Anbieters öffnen/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "" })).toBeNull();
  });
});

describe("IntegrationPicker provider overview", () => {
  it("shows a recipe sign-in, the keys with their roles and the by-hand values", async () => {
    const withRecipe = acme({ signIn: { state: "recipe", facade: null, recipes: [recipe()], available: true } });
    const { user } = renderApp(picker({ initial: { vendor: "acme" }, cards: [withRecipe], signedIn: new Set(["acme"]) }));
    expect(screen.getByText("Browser-Anmeldung: für Werte ohne API")).toBeInTheDocument();
    expect(screen.getByText("Rezepte: Acme console")).toBeInTheDocument();
    expect(screen.getByText(/Rezepte legen im angemeldeten Browser Werte an/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeEnabled();
    expect(screen.getByText("optional")).toBeInTheDocument();
    expect(screen.getByText("ältere Verbindung")).toBeInTheDocument();
    expect(screen.getByText("Damit ruft secret-desk die API von Acme auf. Jede Zeile sagt, wofür der Schlüssel da ist.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Einrichten" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hand value" }));
    expect(screen.getByRole("link", { name: /Seite des Anbieters öffnen/ })).toHaveAttribute("href", "https://guide.test/");
    expect(screen.getByText("Ask support")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Zurück zur Auswahl" }));
    expect(screen.getByText("Von Hand: Werte ohne API und ohne Rezept")).toBeInTheDocument();
  });

  it("shows no sign-in section for a provider without one, a coming recipe or neither button", () => {
    const { rerender } = renderApp(picker({ initial: { vendor: "acme" }, cards: [acme({ byHand: [], keys: [] })] }));
    expect(screen.queryByText(/Browser-Anmeldung/)).toBeNull();
    expect(screen.getByText("Noch kein Schlüssel.")).toBeInTheDocument();
    expect(screen.queryByText("Von Hand: Werte ohne API und ohne Rezept")).toBeNull();
    rerender(picker({ initial: { vendor: "acme" }, cards: [acme({ signIn: { state: "coming", facade: null, recipes: [], available: false } })] }));
    expect(screen.getByText(/Rezept folgt/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anmelden" })).toBeNull();
    rerender(picker({ initial: { vendor: "acme" }, cards: [acme({ signIn: { state: "recipe", facade: null, recipes: [recipe()], available: false } })] }));
    expect(screen.getByText(/Für Acme gibt es Rezepte, aber die Browser-Automatisierung ist aus/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeDisabled();
  });

  it("opens the recipe sign-in with the portal that needs it", async () => {
    const multi = recipe({ hosts: [{ value: "live", host: "live.acme.test" }, { value: "test", host: "test.acme.test" }] });
    const withRecipe = acme({ status: "signout", signIn: { state: "recipe", facade: null, recipes: [multi], available: true }, browser: { readiness: { state: "signed-out", checkedAt: null, ageMinutes: null, stale: false }, secrets: 0, expiry: null, neverExpires: false, sessionHours: null, hostLines: [{ value: "test", host: "test.acme.test", readiness: { state: "signed-out", checkedAt: null, ageMinutes: null, stale: false }, sessionHours: null }] } });
    fakePortal({ "GET recipes/acme-recipe/sign-in/state": { status: 404, body: {} } });
    const { user } = renderApp(picker({ initial: { vendor: "acme" }, cards: [withRecipe] }));
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("dialog", { name: "Acme – Browser-Anmeldung" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Portal" })).toHaveTextContent("test (test.acme.test)");
  });

  it("opens the recipe sign-in straight from the dialog options", async () => {
    const withRecipe = acme({ signIn: { state: "recipe", facade: null, recipes: [recipe()], available: true } });
    fakePortal({ "GET recipes/acme-recipe/sign-in/state": { status: 404, body: {} } });
    renderApp(picker({ initial: { vendor: "acme", signIn: true, portal: "live" }, cards: [withRecipe] }));
    expect(await screen.findByRole("dialog", { name: "Acme – Browser-Anmeldung" })).toBeInTheDocument();
  });

  it("tells the page about a finished sign-in as reconnect or, from a renewal, as renewal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase = { status: "running" };
    const state = () => ({ secretId: "s", providerId: "p", status: phase.status, text: "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "username" });
    fakePortal({ "GET recipes/acme-recipe/sign-in/state": state });
    const withRecipe = acme({ signIn: { state: "recipe", facade: null, recipes: [recipe()], available: true }, browser: { readiness: { state: "ready", checkedAt: "x", ageMinutes: 1, stale: false }, secrets: 0, expiry: null, neverExpires: false, sessionHours: null, hostLines: [] } });
    const onChanged = vi.fn();
    const first = renderApp(picker({ initial: { vendor: "acme", signIn: true, renewal: true }, cards: [withRecipe], onChanged }));
    await screen.findByRole("button", { name: "Abbrechen" });
    phase = { status: "done" };
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("acme", "renewal"));
    first.unmount();
    phase = { status: "running" };
    const second = renderApp(picker({ initial: { vendor: "acme", signIn: true }, cards: [withRecipe], onChanged }));
    await screen.findByRole("button", { name: "Abbrechen" });
    phase = { status: "done" };
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("acme", "reconnect"));
    second.unmount();
  });

  it("starts a recipe sign-in without a preselected portal when no line asks for one", async () => {
    const ready = { state: "ready" as const, checkedAt: "x", ageMinutes: 1, stale: false };
    const withRecipe = acme({ signIn: { state: "recipe", facade: null, recipes: [recipe()], available: true }, browser: { readiness: ready, secrets: 0, expiry: null, neverExpires: false, sessionHours: null, hostLines: [] } });
    fakePortal({ "GET recipes/acme-recipe/sign-in/state": { status: 404, body: {} } });
    const { user } = renderApp(picker({ initial: { vendor: "acme" }, cards: [withRecipe] }));
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("dialog", { name: "Acme – Browser-Anmeldung" })).toBeInTheDocument();
  });

  it("falls back to the overview for a sign-in that has neither a guided flow nor a recipe", () => {
    renderApp(picker({ initial: { vendor: "acme", signIn: true }, cards: [acme()] }));
    expect(screen.getByText("Damit ruft secret-desk die API von Acme auf. Jede Zeile sagt, wofür der Schlüssel da ist.")).toBeInTheDocument();
  });
});

describe("IntegrationPicker guided sign-in provider", () => {
  const facadeRow = (over: Partial<NonNullable<ProviderCard["signIn"]["facade"]>> = {}) => ({ id: "stripe", label: "Stripe", available: true, connected: false, reason: null, connectionId: "stripe", ...over });
  const stripe = (over: Partial<ProviderCard> = {}): ProviderCard =>
    card({
      id: "stripe",
      label: "Stripe",
      category: "payments",
      prefixes: ["stripe:"],
      signIn: { state: "facade", facade: facadeRow(), recipes: [], available: true },
      keys: [key({ id: "stripe:acct_1:sandbox", label: "Stripe Acme (Sandbox)", connected: true }), key({ id: "stripe-old", label: "Older", role: "legacy", connected: true })],
      ...over,
    });
  const stripeConn = conn({ id: "stripe", vendor: "stripe", label: "Stripe" });

  it("lists the accounts with their modes, connects the missing mode through the guided sign-in and offers the legacy hint", async () => {
    fakePortal({ "GET facades/stripe/state": { status: 404, body: {} }, "POST facades/stripe/check": { signedIn: false, checkedAt: "x" } });
    const { user } = renderApp(picker({ initial: { vendor: "stripe" }, cards: [stripe()], conns: [stripeConn], facades: [facadeInfo()] }));
    expect(screen.getByText("Konto Acme")).toBeInTheDocument();
    expect(screen.getByText("Browser-Anmeldung: legt den API-Schlüssel für secret-desk an")).toBeInTheDocument();
    expect(screen.getByText(/Du meldest dich einmal bei Stripe an/)).toBeInTheDocument();
    expect(screen.getByText("Von der Anmeldung angelegt und erneuert.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Ältere Verbindung\. Die Anmeldung legt einen Schlüssel pro Konto/)).toBeInTheDocument();
    expect(screen.getAllByText("Verbunden").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Konto Acme im Modus Live verbinden" }));
    expect(await screen.findByRole("dialog", { name: /Stripe –/ })).toBeInTheDocument();
    expect(await screen.findByText(/Der Browser ist bei Stripe nicht angemeldet/)).toBeInTheDocument();
  });

  it("starts the guided sign-in from the way's own button, without a pasted-key fallback when no connection matches", async () => {
    fakePortal({ "GET facades/stripe/state": { status: 404, body: {} }, "POST facades/stripe/check": { signedIn: false, checkedAt: "x" } });
    const { user } = renderApp(picker({ initial: { vendor: "stripe" }, cards: [stripe()], conns: [], facades: [facadeInfo()] }));
    await user.click(screen.getByRole("button", { name: "Mit Anmeldung verbinden" }));
    expect(await screen.findByText(/Der Browser ist bei Stripe nicht angemeldet/)).toBeInTheDocument();
    expect(screen.queryByText("Ich habe schon einen Schlüssel")).toBeNull();
  });

  it("shows the reconnect label, the signed-in state and a disabled connect for an unavailable sign-in", () => {
    const { rerender } = renderApp(picker({ initial: { vendor: "stripe" }, cards: [stripe({ signIn: { state: "facade", facade: facadeRow({ connected: true }), recipes: [], available: true } })], conns: [stripeConn], facades: [facadeInfo({ connected: true })], signedIn: new Set(["stripe"]) }));
    expect(screen.getByRole("button", { name: "Erneut mit Anmeldung verbinden" })).toBeEnabled();
    expect(screen.getAllByText("Der Browser ist angemeldet.").length).toBeGreaterThan(0);
    rerender(picker({ initial: { vendor: "stripe" }, cards: [stripe({ signIn: { state: "facade", facade: facadeRow({ available: false, reason: "automation off" }), recipes: [], available: false } })], conns: [stripeConn], facades: [facadeInfo({ available: false, reason: "automation off" })] }));
    expect(screen.getByRole("button", { name: "Mit Anmeldung verbinden" })).toBeDisabled();
    expect(screen.getAllByText("Nicht verfügbar: automation off").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Konto Acme im Modus Live verbinden" })).toBeDisabled();
    rerender(picker({ initial: { vendor: "stripe" }, cards: [stripe({ signIn: { state: "facade", facade: facadeRow({ available: false, reason: null }), recipes: [], available: false } })], conns: [stripeConn], facades: [facadeInfo({ available: false, reason: null })] }));
    expect(screen.getAllByText("Nicht verfügbar:").length).toBeGreaterThan(0);
  });

  it("does not offer buttons when the facade is not in the list", () => {
    renderApp(picker({ initial: { vendor: "stripe" }, cards: [stripe()], conns: [stripeConn], facades: [] }));
    expect(screen.queryByRole("button", { name: "Mit Anmeldung verbinden" })).toBeNull();
    expect(screen.getByRole("button", { name: "Konto Acme im Modus Live verbinden" })).toBeDisabled();
  });

  it("opens the guided sign-in with the pasted key as the way out, and pre-fills account and mode", async () => {
    fakePortal({ "GET facades/stripe/state": { status: 404, body: {} }, "POST facades/stripe/check": { signedIn: false, checkedAt: "x" } });
    renderApp(picker({ initial: { vendor: "stripe", signIn: true, inputs: { account: "acct_9" } }, cards: [stripe()], conns: [stripeConn], facades: [facadeInfo({ inputs: [{ param: "account", label: "Konto", labelEn: "Account", options: null, pattern: null, help: null }] })] }));
    expect(await screen.findByLabelText("Konto")).toHaveValue("acct_9");
    expect(screen.getByText("Ich habe schon einen Schlüssel")).toBeInTheDocument();
  });

  it("mixed key hints and signin buttons for a vendor with a pasted and a sign-in key (Grafana-like)", async () => {
    const grafana = card({
      id: "grafana",
      label: "Grafana",
      signIn: { state: "facade", facade: facadeRow({ id: "grafana", connectionId: "grafana-cloud" }), recipes: [], available: true },
      keys: [key({ id: "grafana", label: "Grafana stack", connected: false, role: "primary" }), key({ id: "grafana-cloud", label: "Grafana Cloud", connected: false, role: "primary" })],
    });
    const { user } = renderApp(picker({ initial: { vendor: "grafana" }, cards: [grafana], conns: [conn({ id: "grafana", vendor: "grafana" })], facades: [facadeInfo({ id: "grafana", connectionId: "grafana-cloud" })] }));
    expect(screen.getByText("Das Konto-Token kommt von der Anmeldung. Das Token des Stacks fügst du selbst ein.")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(1);
    const signInButtons = screen.getAllByRole("button", { name: "Mit Anmeldung verbinden" });
    expect(signInButtons.length).toBeGreaterThan(1);
    fakePortal({ "GET facades/grafana/state": { status: 404, body: {} }, "POST facades/grafana/check": { signedIn: false, checkedAt: "x" } });
    await user.click(signInButtons.at(-1)!);
    expect(await screen.findByText(/Der Browser ist bei Stripe nicht angemeldet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Zurück zur Auswahl" }));
    await user.click(screen.getByRole("button", { name: "Einrichten" }));
    expect(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben", { exact: false })).toBeInTheDocument();
  });

  it("disables the per-key sign-in button when the sign-in is unavailable", () => {
    const grafana = card({
      id: "grafana",
      label: "Grafana",
      signIn: { state: "facade", facade: facadeRow({ id: "grafana", connectionId: "grafana-cloud", available: false }), recipes: [], available: false },
      keys: [key({ id: "grafana", label: "Grafana stack", connected: false }), key({ id: "grafana-cloud", label: "Grafana Cloud", connected: false })],
    });
    renderApp(picker({ initial: { vendor: "grafana" }, cards: [grafana], conns: [], facades: [facadeInfo({ id: "grafana", connectionId: "grafana-cloud", available: false })] }));
    for (const b of screen.getAllByRole("button", { name: "Mit Anmeldung verbinden" })) expect(b).toBeDisabled();
  });
});

describe("IntegrationPicker pasted key", () => {
  const open = (props: PickerProps = {}, c: Partial<Connection> = {}) => renderApp(picker({ initial: { vendor: "acme", key: "acme" }, conns: [conn(c)], onChanged: vi.fn(), ...props }));

  it("shows an unknown key as empty content", () => {
    renderApp(picker({ initial: { vendor: "acme", key: "ghost" } }));
    expect(screen.getByRole("button", { name: "← Zurück zur Auswahl" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Zugangsschlüssel/)).toBeNull();
    expect(screen.getByRole("dialog").querySelector(".border-t.border-line")).toBeNull();
  });

  it("mounts the footer bar only when the key exists", () => {
    open();
    expect(screen.getByRole("dialog").querySelector(".border-t.border-line")).not.toBeNull();
  });

  it("describes the key, its link with the chosen lifetime and the permissions", async () => {
    const { user } = open();
    expect(screen.getByText("Used for the API.")).toBeInTheDocument();
    expect(screen.getByText("read:projects")).toBeInTheDocument();
    expect(screen.getByText("Create the key")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Zugang anlegen \(Felder sind vorausgefüllt\)/ });
    expect(link.getAttribute("href")).toContain("expires_in=90");
    await pickOption(user, "1. Laufzeit des Tokens festlegen", "30 Tage");
    expect(screen.getByRole("link", { name: /Zugang anlegen/ }).getAttribute("href")).toContain("expires_in=30");
    await pickOption(user, "1. Laufzeit des Tokens festlegen", "Läuft nie ab");
    expect(screen.getByText("Ohne Ablauf (nicht empfohlen).")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Zugang anlegen/ }).getAttribute("href")).toContain("expires_in=none");
  });

  it("uses a custom date and caps the lifetime in the link at 366 days", async () => {
    const { user } = open();
    await pickOption(user, "1. Laufzeit des Tokens festlegen", "Eigenes Datum");
    const date = screen.getByLabelText("Gültig bis");
    const far = new Date(Date.now() + 500 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(date, { target: { value: far } });
    expect(screen.getByRole("link", { name: /Zugang anlegen/ }).getAttribute("href")).toContain("expires_in=366");
  });

  it("shows the plain link text when the link carries no pre-filled fields, and no link without a URL", () => {
    const { unmount } = open({}, { openUrl: "https://acme.test/keys", url: "https://acme.test/keys" });
    expect(screen.getByRole("link", { name: /2\. Zugang beim Anbieter anlegen/ })).toHaveAttribute("href", "https://acme.test/keys");
    unmount();
    open({}, { openUrl: null, permissions: [], steps: [], description: null, hint: "Needs an admin", canRemember: false });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Needs an admin")).toBeInTheDocument();
    expect(screen.queryByText("Verschlüsselt auf diesem Rechner speichern")).toBeNull();
  });

  it("connects with the key, forgets the typed value, and then offers test, resources and Fertig", async () => {
    const portal = fakePortal({
      "POST connections/acme/token": conn({ connected: true }),
      "POST connections/acme/check": { id: "acme", ok: true, checks: [] },
      "GET connections/acme/resources": { connection: "acme", connected: true, defaultSpecs: [], defaults: {}, resources: {} },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    const { user } = renderApp(picker({ initial: { vendor: "acme", key: "acme" }, conns: [conn()], onChanged, onClose }));
    const connect = screen.getByRole("button", { name: "Verbinden" });
    expect(connect).toBeDisabled();
    const field = screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben");
    await user.type(field, "value-for-tests");
    expect(screen.getByRole("checkbox", { name: "Verschlüsselt auf diesem Rechner speichern" })).toBeChecked();
    await user.click(connect);
    await waitFor(() => expect(portal.callsTo("POST", "connections/acme/token")).toHaveLength(1));
    expect(portal.callsTo("POST", "connections/acme/token")[0]?.body).toMatchObject({ token: "value-for-tests", remember: true, expires: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(await screen.findByText("Verbunden. Das Portal liest jetzt, was diese Integration hergibt.")).toBeInTheDocument();
    expect(await screen.findByText("Acme key ist verbunden und verschlüsselt gespeichert.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith("acme", null);
    await user.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText("Die Verbindung funktioniert.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("connects for the session only when remembering is off, with a never-expires lifetime and the vendor as card", async () => {
    const portal = fakePortal({
      "POST connections/acme/token": conn({ connected: true }),
      "GET connections/acme/resources": { connection: "acme", connected: true, defaultSpecs: [], defaults: {}, resources: {} },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const { user } = renderApp(picker({ initial: { vendor: "acme", key: "acme" }, conns: [conn({ label: "" })] }));
    await pickOption(user, "1. Laufzeit des Tokens festlegen", "Läuft nie ab");
    await user.click(screen.getByRole("checkbox", { name: "Verschlüsselt auf diesem Rechner speichern" }));
    await user.type(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben"), "value-for-tests");
    await user.click(screen.getByRole("button", { name: "Verbinden" }));
    await waitFor(() => expect(portal.callsTo("POST", "connections/acme/token")).toHaveLength(1));
    expect(portal.callsTo("POST", "connections/acme/token")[0]?.body).toEqual({ token: "value-for-tests", neverExpires: true });
    expect(await screen.findByText("acme ist für diese Sitzung verbunden.")).toBeInTheDocument();
  });

  it("shows the server's error, and warns about a live key for a sandbox connection", async () => {
    fakePortal({ "POST connections/stripe-test/token": { status: 400, body: { error: "token rejected" } } });
    const liveKey = ["rk", "live", "placeholder"].join("_");
    const { user } = renderApp(picker({ initial: { vendor: "acme", key: "stripe-test" }, conns: [conn({ id: "stripe-test", label: "Stripe sandbox" })] }));
    const field = screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben");
    await user.type(field, liveKey);
    expect(screen.getByText(/Das ist ein Live-Schlüssel/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verbinden" })).toBeDisabled();
    await user.clear(field);
    await user.type(field, "value-for-tests");
    await user.click(screen.getByRole("button", { name: "Verbinden" }));
    expect(await screen.findByText("token rejected")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, ["rk", "test", "placeholder"].join("_"));
    expect(screen.queryByText(/Das ist ein Live-Schlüssel/)).toBeNull();
  });

  it("warns about a sandbox key for a live connection and ignores a submit while invalid", async () => {
    const portal = fakePortal({});
    const { user } = renderApp(picker({ initial: { vendor: "acme", key: "stripe-live" }, conns: [conn({ id: "stripe-live", label: "Stripe live" })] }));
    await user.type(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben"), ["sk", "test", "placeholder"].join("_"));
    expect(screen.getByText(/Das ist ein Sandbox-Schlüssel/)).toBeInTheDocument();
    fireEvent.submit(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben").closest("form")!);
    expect(portal.callsTo("POST", "connections/stripe-live/token")).toHaveLength(0);
  });

  it("rejects a custom date in the past", async () => {
    const { user } = open();
    await pickOption(user, "1. Laufzeit des Tokens festlegen", "Eigenes Datum");
    await user.type(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben"), "value-for-tests");
    expect(screen.getByRole("button", { name: "Verbinden" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Gültig bis"), { target: { value: "2000-01-01" } });
    expect(screen.getByRole("button", { name: "Verbinden" })).toBeDisabled();
  });

  it("asks only for the key when the provider's keys do not expire (RevenueCat-like sign-in fallback)", async () => {
    const rc = card({ id: "rc", label: "RC", signIn: { state: "facade", facade: { id: "rc", label: "RC", available: true, connected: false, reason: null, connectionId: "rc" }, recipes: [], available: true }, keys: [key({ id: "rc", connected: false })] });
    fakePortal({ "GET facades/rc/state": { status: 404, body: {} }, "POST facades/rc/check": { signedIn: false, checkedAt: "x" }, "POST connections/rc/token": conn({ id: "rc" }) });
    const { user } = renderApp(picker({ initial: { vendor: "rc", signIn: true }, cards: [rc], conns: [conn({ id: "rc", vendor: "rc", openUrl: "https://rc.test/keys" })], facades: [facadeInfo({ id: "rc", connectionId: "rc" })] }));
    await user.click(await screen.findByText("Ich habe schon einen Schlüssel"));
    expect(screen.queryByLabelText("1. Laufzeit des Tokens festlegen")).toBeNull();
    expect(screen.getByRole("link", { name: /Seite des Anbieters öffnen, auf der der Schlüssel angelegt wird/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Schlüssel einfügen"), "value-for-tests");
    expect(screen.getByRole("button", { name: "Verbinden" })).toBeEnabled();
  });

  it("covers a connection card without vendor in the post-connect test panel", async () => {
    fakePortal({
      "POST connections/acme/token": conn({ connected: true }),
      "GET connections/acme/resources": { connection: "acme", connected: true, defaultSpecs: [], defaults: {}, resources: {} },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const { user } = renderApp(picker({ initial: { vendor: "acme", key: "acme" }, conns: [conn({ vendor: null })] }));
    await user.type(screen.getByLabelText("3. Zugangsschlüssel für diese Sitzung eingeben"), "value-for-tests");
    await user.click(screen.getByRole("button", { name: "Verbinden" }));
    expect(await screen.findByRole("button", { name: "Verbindung testen" })).toBeInTheDocument();
  });
});

describe("AddProviderDialog", () => {
  const fill = async (user: ReturnType<typeof renderApp>["user"], over: { name?: string; id?: string; url?: string; steps?: string } = {}) => {
    await user.type(screen.getByLabelText(/^Name/), over.name ?? "My Service");
    await user.type(screen.getByLabelText(/^Kennung/), over.id ?? "my-service");
    await user.type(screen.getByLabelText(/^Seite, auf der man den Zugang anlegt/), over.url ?? "https://my.test/keys");
    if (over.steps) await user.type(screen.getByLabelText(/^Schritte/), over.steps);
  };

  it("keeps the button disabled until the fields are filled, adds the provider and reports it", async () => {
    const portal = fakePortal({ "POST providers": { id: "my-service", label: "My Service" } });
    const onAdded = vi.fn();
    const { user } = renderApp(<AddProviderDialog onClose={() => {}} onAdded={onAdded} />);
    const add = screen.getByRole("button", { name: "Hinzufügen" });
    expect(add).toBeDisabled();
    await fill(user, { steps: "Open the page\n\n Create the key " });
    await user.click(add);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(portal.callsTo("POST", "providers")[0]?.body).toEqual({ id: "my-service", label: "My Service", url: "https://my.test/keys", steps: ["Open the page", "Create the key"] });
    expect(await screen.findByText("„My Service“ wurde ins Inventar eingetragen.")).toBeInTheDocument();
  });

  it("rejects a bad slug and a bad URL locally, shows the server error, and cancels", async () => {
    fakePortal({ "POST providers": { status: 409, body: { error: "id taken" } } });
    const onClose = vi.fn();
    const { user } = renderApp(<AddProviderDialog onClose={onClose} onAdded={() => {}} />);
    await fill(user, { id: "Bad Id", url: "https://my.test/keys" });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("Kennung: Kleinbuchstaben, Ziffern und Bindestriche.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Kennung/));
    await user.type(screen.getByLabelText(/^Kennung/), "ok-id");
    fireEvent.change(screen.getByLabelText(/^Seite, auf der man den Zugang anlegt/), { target: { value: "not a url" } });
    // The browser would block a native submit of an invalid url field; the component's own check is what this covers.
    fireEvent.submit(screen.getByLabelText(/^Kennung/).closest("form")!);
    expect(await screen.findByText("Die Adresse ist keine gültige URL.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Seite, auf der man den Zugang anlegt/), { target: { value: "https://my.test/keys" } });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("id taken")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalled();
  });
});


