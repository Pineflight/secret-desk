import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StageView } from "@secret-desk/runtime";
import { SecretForm } from "@/components/SecretForm";
import { invalidateRepoList } from "@/lib/repo-list";
import type { Prefill } from "@/lib/prefill";
import { publishStages } from "@/lib/use-stages";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { spec } from "./helpers/params";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

const STAGES = [
  { id: "dev", kind: "dev", label: "Entwicklung", environmentName: null },
  { id: "staging", kind: "test", environmentName: "staging" },
  { id: "production", kind: "live", environmentName: "production" },
] as unknown as StageView[];

const view = (specs = [spec({ key: "project", type: "string", required: true })], over: Record<string, unknown> = {}) => ({
  provider: "acme",
  providerLabel: "Acme Cloud",
  connection: "acme",
  connected: true,
  specs,
  values: {},
  defaults: {},
  effective: {},
  unknown: {},
  problems: [],
  complete: false,
  resources: {},
  ...over,
});

const PROVIDERS = [{ id: "manual", label: "Manual", kind: "manual" }, { id: "acme", label: "Acme", kind: "automatic" }, { id: "hand", label: "Hand", kind: "manual" }, { id: "web", label: "Webby", kind: "automatic", browser: true }];

const routes = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  "GET providers": PROVIDERS,
  "GET repos?live=1": { owner: "acme", github: "off", repos: [] },
  "GET providers/acme/params*": view(),
  "POST secrets": { name: "API_KEY" },
  "POST secrets?preflight=1": { name: "API_KEY" },
  ...over,
});

const form = (props: Partial<Parameters<typeof SecretForm>[0]> = {}) => <SecretForm onClose={() => {}} onCreated={() => {}} {...props} />;

async function fillBasics(user: ReturnType<typeof renderApp>["user"], repo = "web") {
  await user.type(screen.getByLabelText(/^Kennung/), "api-key");
  await user.type(screen.getByLabelText(/^Name im Ziel/), "api_key");
  await user.type(screen.getByLabelText(/^Dienst/), "acme");
  if (repo) await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), repo);
}

beforeEach(() => {
  invalidateRepoList();
  publishStages(STAGES);
});

describe("SecretForm manual entry", () => {
  it("creates a manual entry on the default test stage with an upper-cased name and reports it", async () => {
    const onCreated = vi.fn();
    const portal = fakePortal(routes());
    const { user } = renderApp(form({ onCreated }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("staging");
    await fillBasics(user);
    expect(screen.getByLabelText(/^Name im Ziel/)).toHaveValue("API_KEY");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("„API_KEY“ wurde angelegt.")).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(portal.callsTo("POST", "secrets")[0]?.body).toEqual({ id: "api-key", name: "API_KEY", stage: "staging", service: "acme", provider: "manual", expiry: "unknown", places: [{ repo: "web", scope: "repository" }] });
  });

  it("sends the optional fields, a numeric-only lifetime and the expiry date", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user);
    await user.type(screen.getByLabelText("Bezeichnung (optional)"), "  My key ");
    await user.type(screen.getByLabelText("Produkt (optional)"), "shop");
    await pickOption(user, "Ablauf", "Kann ablaufen");
    fireEvent.change(screen.getByLabelText("Läuft ab am (optional)"), { target: { value: "2031-02-03" } });
    await user.type(screen.getByLabelText("Gültigkeit in Tagen (optional)"), "3x0");
    expect(screen.getByLabelText("Gültigkeit in Tagen (optional)")).toHaveValue("30");
    await user.type(screen.getByLabelText(/^Beschreibung/), "Used by the shop");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]?.body).toMatchObject({ title: "My key", product: "shop", expiry: "possible", expires: "2031-02-03", ttlDays: 30, description: "Used by the shop" });
  });

  it("disables the expiry date for an entry that never expires and does not send it", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user);
    fireEvent.change(screen.getByLabelText("Läuft ab am (optional)"), { target: { value: "2031-02-03" } });
    await pickOption(user, "Ablauf", "Läuft nie ab");
    expect(screen.getByLabelText("Läuft ab am (optional)")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]?.body).not.toHaveProperty("expires");
  });

  it("allows a dev entry without a target and explains it", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    expect(screen.queryByText("dev-Einträge dürfen ohne Ziel angelegt werden.")).toBeNull();
    await pickOption(user, "Stage", "Entwicklung");
    expect(screen.getByText("dev-Einträge dürfen ohne Ziel angelegt werden.")).toBeInTheDocument();
    await fillBasics(user, "");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]?.body).toMatchObject({ stage: "dev", places: [] });
  });

  it("closes through the cancel button", async () => {
    fakePortal(routes());
    const onClose = vi.fn();
    const { user } = renderApp(form({ onClose }));
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SecretForm validation", () => {
  it("asks for a target outside dev, then clears the message once fixed", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user, "");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Für staging, production und shared braucht der Eintrag mindestens ein Ziel.");
    expect(portal.callsTo("POST", "secrets")).toHaveLength(0);
    await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), "web");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an incomplete target row", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user, "");
    await pickOption(user, "Bereich, Ziel 1", "Umgebung");
    await user.type(screen.getByLabelText("Umgebungsname, Ziel 1"), "preview");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bei einem Ziel fehlt das Repository.");
    expect(portal.callsTo("POST", "secrets")).toHaveLength(0);
  });

  it("reports an invalid link of the description fields", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user);
    await user.type(screen.getByLabelText("Link"), "ftp://example.test");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Link muss mit http:// oder https:// beginnen.");
    expect(portal.callsTo("POST", "secrets")).toHaveLength(0);
  });

  it("rejects a lifetime of zero days", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user);
    await user.type(screen.getByLabelText("Gültigkeit in Tagen (optional)"), "0");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Gültigkeit in Tagen muss eine ganze Zahl über 0 sein.");
    expect(portal.callsTo("POST", "secrets")).toHaveLength(0);
  });

  it("shows the server error of a failed create and keeps the form open", async () => {
    const onCreated = vi.fn();
    fakePortal(routes({ "POST secrets": { status: 409, body: { error: "Kennung vergeben" } } }));
    const { user } = renderApp(form({ onCreated }));
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Kennung vergeben");
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("SecretForm prefill", () => {
  const initial: Prefill = { id: "from-compare", name: "FROM_COMPARE", repo: "web", stage: "production", description: "Found in the comparison" };

  it("starts with the values of the link and an environment target for a stage with an environment", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form({ initial }));
    expect(screen.getByLabelText(/^Kennung/)).toHaveValue("from-compare");
    expect(screen.getByLabelText(/^Name im Ziel/)).toHaveValue("FROM_COMPARE");
    expect(screen.getByLabelText(/^Dienst/)).toHaveValue("github-actions");
    expect(screen.getByLabelText(/^Beschreibung/)).toHaveValue("Found in the comparison");
    expect(screen.getByRole("combobox", { name: "Repository, Ziel 1" })).toHaveValue("web");
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("production");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]?.body).toMatchObject({ stage: "production", places: [{ repo: "web", scope: "environment" }] });
  });

  it("falls back to a repository target when the link names no stage", () => {
    fakePortal(routes());
    renderApp(form({ initial: { ...initial, stage: "" } }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("staging");
    expect(screen.getByRole("combobox", { name: "Bereich, Ziel 1" })).toHaveTextContent("Repository");
  });
});

describe("SecretForm provider parameters", () => {
  it("lists the providers with their kind and loads the parameters of the chosen one", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await user.click(screen.getByRole("combobox", { name: "Anbieter" }));
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual(["von Hand (manual)", "Acme (automatisch)", "Hand (von Hand)", "Webby"]);
    await user.click(screen.getByRole("option", { name: "Acme (automatisch)" }));
    expect(await screen.findByRole("heading", { name: "Parameter von Acme Cloud" })).toBeInTheDocument();
    expect(screen.getByText("Ohne Repository gibt es keine Vorschläge; die Listen sind trotzdem wählbar.")).toBeInTheDocument();
    expect(screen.getByText("Pflichtparameter fehlen: project de")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anlegen" })).toBeDisabled();
    expect(portal.calls.some((c) => c.path.startsWith("providers/acme/params"))).toBe(true);
  });

  it("names the missing parameters in English", async () => {
    localStorage.setItem("sd-locale", "en");
    fakePortal(routes());
    const { user } = renderApp(form());
    await pickOption(user, "Provider", /Acme/);
    expect(await screen.findByText("Required parameters missing: project en")).toBeInTheDocument();
  });

  it("creates with the parameters, asks the server for a pre-check and reports a good result", async () => {
    const onCreated = vi.fn();
    const portal = fakePortal(routes({ "POST secrets?preflight=1": { name: "API_KEY", preflight: { status: "ok", resource: "Acme project", findings: [] } } }));
    const { user } = renderApp(form({ onCreated }));
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    expect(screen.queryByText(/Ohne Repository gibt es keine Vorschläge/)).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Anlegen" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Vorabcheck beim Anbieter: Acme project ist in Ordnung.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "secrets?preflight=1")[0]?.body).toMatchObject({ provider: "acme", params: { project: "p-1" } });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("falls back to the entry name when the pre-check names no resource", async () => {
    fakePortal(routes({ "POST secrets?preflight=1": { name: "API_KEY", preflight: { status: "ok", resource: null, findings: [] } } }));
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Vorabcheck beim Anbieter: API_KEY ist in Ordnung.")).toBeInTheDocument();
  });

  it.each([
    ["warn", "Vorabcheck mit Hinweisen: Quota (low)"],
    ["fail", "Vorabcheck meldet ein Problem: Quota (low)."],
  ])("reports a %s pre-check without undoing the creation", async (status, text) => {
    const onCreated = vi.fn();
    fakePortal(routes({ "POST secrets?preflight=1": { name: "API_KEY", preflight: { status, resource: null, findings: [{ level: status, label: "Quota", detail: "low" }, { level: "ok", label: "Fine" }] } } }));
    const { user } = renderApp(form({ onCreated }));
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText(new RegExp(text.replace(/[()]/g, "\\$&")))).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a skipped pre-check", { status: "skipped", resource: null, findings: [] }],
    ["no pre-check", undefined],
  ])("says the pre-check did not run for %s", async (_name, preflight) => {
    fakePortal(routes({ "POST secrets?preflight=1": { name: "API_KEY", ...(preflight ? { preflight } : {}) } }));
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText(/Der Vorabcheck lief nicht/)).toBeInTheDocument();
  });

  it("creates with a provider that has no parameters and stays quiet about the pre-check", async () => {
    const portal = fakePortal(routes({ "GET providers/acme/params*": view([]), "POST secrets?preflight=1": { name: "API_KEY", preflight: { status: "not-connected", resource: null, findings: [] } } }));
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await waitFor(() => expect(portal.calls.some((c) => c.path.startsWith("providers/acme/params"))).toBe(true));
    expect(screen.queryByRole("heading", { name: /Parameter von/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("„API_KEY“ wurde angelegt.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "secrets?preflight=1")[0]?.body).not.toHaveProperty("params");
    expect(screen.queryByText(/Der Vorabcheck lief nicht/)).toBeNull();
  });

  it("warns when the parameters cannot be loaded", async () => {
    fakePortal(routes({ "GET providers/acme/params*": { status: 502, body: { error: "provider offline" } } }));
    const { user } = renderApp(form());
    await pickOption(user, "Anbieter", /Acme/);
    expect(await screen.findByText("Die Parameter ließen sich nicht laden: provider offline")).toBeInTheDocument();
  });

  it("reloads the parameters with the repository and stage and forgets typed values when the provider changes", async () => {
    const portal = fakePortal(routes({ "GET providers/hand/params*": view([], { provider: "hand", providerLabel: "Hand" }) }));
    const { user } = renderApp(form());
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), "web");
    await waitFor(() => expect(portal.calls.some((c) => c.path.includes("repo=web") && c.path.includes("stage=staging"))).toBe(true));
    await pickOption(user, "Anbieter", "Hand (von Hand)");
    await pickOption(user, "Anbieter", /Acme/);
    expect(await screen.findByLabelText(/project de/)).toHaveValue("");
  });

  it("blocks a submit with a wrong typed parameter locally", async () => {
    const portal = fakePortal(routes({ "GET providers/acme/params*": view([spec({ key: "port", type: "integer", min: 5 })]) }));
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    const port = await screen.findByLabelText(/port de/);
    await user.type(port, "3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Anlegen" })).toBeDisabled());
    fireEvent.submit(port.closest("form")!);
    expect(await screen.findByText("Parameter hat ein ungültiges Format.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "secrets?preflight=1")).toHaveLength(0);
  });

  it("blocks a submit with missing required parameters and names them", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    const field = await screen.findByLabelText(/project de/);
    fireEvent.submit(field.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Pflichtparameter fehlen: project de");
    expect(portal.callsTo("POST", "secrets?preflight=1")).toHaveLength(0);
  });

  it("shows the field errors the server returns for the parameters", async () => {
    fakePortal(routes({ "POST secrets?preflight=1": { status: 400, body: { error: "Parameter ungültig", code: "params_invalid", problems: [{ key: "project", code: "wrong_type" }] } } }));
    const { user } = renderApp(form());
    await fillBasics(user);
    await pickOption(user, "Anbieter", /Acme/);
    await user.type(await screen.findByLabelText(/project de/), "p-1");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.some((a) => a.textContent === "Parameter ungültig")).toBe(true);
  });
});
