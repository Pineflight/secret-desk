import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VariableDrift } from "@secret-desk/core";
import type { StageView, VariableView } from "@secret-desk/runtime";
import { RemoveDialog, SecretGuard, VariableDetail, VariableForm } from "@/components/VariableDialogs";
import { ApiError } from "@/lib/api";
import { invalidateRepoList } from "@/lib/repo-list";
import type { Prefill } from "@/lib/prefill";
import { publishStages } from "@/lib/use-stages";
import type { SourceDef } from "@/lib/variable-source";
import { drainRequestsAfterEach } from "./helpers/drain";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { okState } from "./helpers/params";
import { renderApp } from "./helpers/render";

drainRequestsAfterEach();

const STAGES = [
  { id: "dev", kind: "dev", environmentName: null },
  { id: "staging", kind: "test", environmentName: "staging" },
  { id: "production", kind: "live", environmentName: "production" },
] as unknown as StageView[];
const SOURCES: SourceDef[] = [{ kind: "supabase.project", connection: "supabase", label: "Supabase-Projekt", labelEn: "Supabase project", fields: [{ field: "url", label: "URL", labelEn: "URL" }], connected: true }];

const variable = (over: Partial<VariableView> = {}): VariableView => ({
  id: "api-url",
  name: "API_URL",
  description: "Base URL of the API",
  owner: "anna",
  link: "https://docs.example.test/api",
  tags: [],
  product: "shop",
  stage: "staging",
  value: "https://api.example.test",
  from: null,
  places: [{ repo: "acme/web", scope: "repository" }, { repo: "acme/web", scope: "environment", environment: "staging" }],
  ...over,
} as VariableView);

const base = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  "GET normalization": { changes: [] },
  "GET stages": [],
  "GET repos?live=1": { owner: "acme", github: "off", repos: [] },
  "GET connections/supabase/resources*": { connection: "supabase", connected: true, defaultSpecs: [], defaults: {}, resources: { "supabase.project": okState([{ value: "p1", label: "Project one" }]) } },
  ...over,
});

beforeEach(() => {
  invalidateRepoList();
  publishStages(STAGES);
});

describe("SecretGuard", () => {
  const err = (code: string | undefined, message: string) => new ApiError(400, message, code ? { code } : {});

  it("renders nothing without an error", () => {
    renderApp(<SecretGuard error={null} ack={false} setAck={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("blocks a value that looks like a secret and links to the secrets", () => {
    renderApp(<SecretGuard error={err("secret-blocked", "x")} ack={false} setAck={() => {}} />);
    expect(screen.getByText("Gesperrt")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Secrets" })).toHaveAttribute("href", "/entries?kind=secret&new=1");
  });

  it.each([
    ["Wirkt wie ein Token. Zum Bestätigen acknowledgedPublic setzen.", "Wirkt wie ein Token."],
    ["Wirkt wie ein Token. Zum Bestaetigen acknowledgedPublic setzen", "Wirkt wie ein Token."],
    ["Nur ein Hinweis", "Nur ein Hinweis"],
  ])("asks for an acknowledgement and removes the technical hint from %j", async (message, shown) => {
    const setAck = vi.fn();
    const { user } = renderApp(<SecretGuard error={err("secret-ack", message)} ack={false} setAck={setAck} />);
    expect(screen.getByText("Achtung, möglicherweise ein Geheimnis")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(`${shown} Variablen sind in GitHub im Klartext lesbar.`);
    await user.click(screen.getByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    expect(setAck).toHaveBeenCalledWith(true);
  });

  it("shows any other error as it is", () => {
    renderApp(<SecretGuard error={new Error("plain failure")} ack={false} setAck={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("plain failure");
  });
});

describe("VariableDetail", () => {
  const detail = (props: Partial<Parameters<typeof VariableDetail>[0]> = {}) => (
    <VariableDetail v={variable()} sources={SOURCES} drift={undefined} comparing={false} compareError={undefined} auto={undefined} onCompare={async () => true} onChanged={() => {}} onEdit={() => {}} onRemove={() => {}} onClose={() => {}} {...props} />
  );
  const drift = (over: Partial<VariableDrift> = {}): VariableDrift => ({ variableId: "api-url", place: { repo: "acme/web", scope: "repository" } as never, placeLabel: "acme/web / Repository", state: "in-sync", expected: "a", actual: "a", updatedAt: null, ...over });

  it("shows name, id and product, stage, description, owner, link and the targets", async () => {
    fakePortal(base());
    renderApp(detail());
    const dialog = await screen.findByRole("dialog", { name: "API_URL" });
    expect(dialog).toHaveTextContent("api-url · shop");
    expect(screen.getByText("Base URL of the API")).toBeInTheDocument();
    expect(screen.getByText("Verantwortlich: anna")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /docs\.example\.test/ })).toHaveAttribute("href", "https://docs.example.test/api");
    expect(screen.getByTitle("acme/web / Repository")).toBeInTheDocument();
    expect(screen.getByTitle("acme/web / staging")).toBeInTheDocument();
    expect(screen.getByLabelText("Sollwert")).toHaveValue("https://api.example.test");
    expect(screen.getByText("Noch nicht verglichen. Mit „Mit GitHub vergleichen“ prüfst du alle Ziele.")).toBeInTheDocument();
  });

  it("shows the rename suggestion for the variable", async () => {
    fakePortal(base({ "GET normalization": { changes: [{ id: "r", kind: "rename", entryKind: "variable", entryIds: ["api-url"], before: [], after: [{ id: "api-url", entryKind: "variable", name: "NEXT_PUBLIC_API_URL", stage: "staging" }] }] } }));
    renderApp(detail());
    expect(await screen.findByText("Namensvorschlag: NEXT_PUBLIC_API_URL")).toBeInTheDocument();
  });

  it("copes with a bare variable: no product, description, owner, link and no value", async () => {
    fakePortal(base());
    renderApp(detail({ v: variable({ product: null, description: null, owner: null, link: null, value: null }) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("api-url");
    expect(dialog).not.toHaveTextContent("·");
    expect(screen.getByText("Noch keine Beschreibung.")).toBeInTheDocument();
    expect(screen.queryByText(/Verantwortlich/)).toBeNull();
    expect(screen.getByLabelText("Sollwert")).toHaveValue("");
    expect(screen.getByRole("button", { name: "In GitHub setzen" })).toBeDisabled();
  });

  it("shows only the owner or only the link when one of them is set", async () => {
    fakePortal(base());
    const { rerender } = renderApp(detail({ v: variable({ link: null }) }));
    expect(await screen.findByText("Verantwortlich: anna")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /docs\.example/ })).toBeNull();
    rerender(detail({ v: variable({ owner: null }) }));
    expect(screen.queryByText(/Verantwortlich/)).toBeNull();
    expect(screen.getByRole("link", { name: /docs\.example/ })).toBeInTheDocument();
  });

  it("saves a changed expected value, clears the acknowledgement, reloads and refreshes an open comparison", async () => {
    const onChanged = vi.fn();
    const onCompare = vi.fn(async () => true);
    const portal = fakePortal(base({ "PATCH variables/api-url": variable() }));
    const { user } = renderApp(detail({ onChanged, onCompare, drift: [drift()] }));
    const save = await screen.findByRole("button", { name: "Sollwert speichern" });
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText("Sollwert"));
    await user.type(screen.getByLabelText("Sollwert"), "https://new.example.test");
    await user.click(save);
    expect(await screen.findByText("Sollwert gespeichert.")).toBeInTheDocument();
    expect(portal.callsTo("PATCH", "variables/api-url")[0]?.body).toEqual({ value: "https://new.example.test" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  it("does not compare after saving when no comparison was made yet, and follows a value that changes from outside", async () => {
    const onCompare = vi.fn(async () => true);
    fakePortal(base({ "PATCH variables/api-url": variable() }));
    const { user, rerender } = renderApp(detail({ onCompare }));
    await user.type(await screen.findByLabelText("Sollwert"), "x");
    await user.click(screen.getByRole("button", { name: "Sollwert speichern" }));
    await screen.findByText("Sollwert gespeichert.");
    expect(onCompare).not.toHaveBeenCalled();
    rerender(detail({ onCompare, v: variable({ value: "from-outside" }) }));
    await waitFor(() => expect(screen.getByLabelText("Sollwert")).toHaveValue("from-outside"));
  });

  it("asks for the acknowledgement of a suspicious value and sends it with the next save", async () => {
    let calls = 0;
    const portal = fakePortal(base({ "PATCH variables/api-url": (call) => (calls++ === 0 ? { status: 409, body: { error: "Wirkt wie ein Geheimnis.", code: "secret-ack" } } : (call.body, variable())) }));
    const { user } = renderApp(detail());
    await user.type(await screen.findByLabelText("Sollwert"), "x");
    await user.click(screen.getByRole("button", { name: "Sollwert speichern" }));
    await user.click(await screen.findByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    await user.click(screen.getByRole("button", { name: "Sollwert speichern" }));
    await screen.findByText("Sollwert gespeichert.");
    expect(portal.callsTo("PATCH", "variables/api-url")[1]?.body).toMatchObject({ acknowledgedPublic: true });
  });

  it("compares through the button and shows the busy state and a compare error", async () => {
    const onCompare = vi.fn(async () => true);
    fakePortal(base());
    const { user, rerender } = renderApp(detail({ onCompare, compareError: "GitHub unreachable" }));
    expect(await screen.findByText("GitHub unreachable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mit GitHub vergleichen" }));
    expect(onCompare).toHaveBeenCalledTimes(1);
    rerender(detail({ onCompare, comparing: true }));
    expect(screen.getByRole("button", { name: "Mit GitHub vergleichen" })).toBeDisabled();
  });

  it("wires edit, remove and close", async () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onClose = vi.fn();
    fakePortal(base());
    const { user } = renderApp(detail({ onEdit, onRemove, onClose }));
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    await user.click(screen.getByRole("button", { name: "Entfernen" }));
    await user.click(screen.getByRole("button", { name: "Dialog schließen" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sets the value in GitHub and lists the result per target", async () => {
    const onCompare = vi.fn(async () => true);
    const portal = fakePortal(base({ "POST variables/api-url/apply": { status: "applied", outcomes: [{ place: "acme/web / Repository", outcome: "created" }, { place: "acme/web / staging", outcome: "updated" }, { place: "acme/web / x", outcome: "failed", error: "403" }, { place: "acme/web / y", outcome: "failed" }] } }));
    const { user } = renderApp(detail({ onCompare }));
    await user.click(await screen.findByRole("button", { name: "In GitHub setzen" }));
    expect(await screen.findByText("In GitHub gesetzt.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables/api-url/apply")[0]?.body).toEqual({});
    expect(screen.getByText("acme/web / Repository: neu angelegt")).toBeInTheDocument();
    expect(screen.getByText("acme/web / staging: aktualisiert")).toBeInTheDocument();
    expect(screen.getByText("acme/web / x: fehlgeschlagen (403)")).toBeInTheDocument();
    expect(screen.getByText("acme/web / y: fehlgeschlagen")).toBeInTheDocument();
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  it("tells that an approval is needed instead of listing results", async () => {
    const onCompare = vi.fn(async () => true);
    fakePortal(base({ "POST variables/api-url/apply": { status: "pending-approval", outcomes: [] } }));
    const { user } = renderApp(detail({ onCompare }));
    await user.click(await screen.findByRole("button", { name: "In GitHub setzen" }));
    expect(await screen.findByText("Freigabe nötig: Die Anfrage wartet im Reiter Freigaben.")).toBeInTheDocument();
    expect(onCompare).not.toHaveBeenCalled();
  });

  it("shows an error of the apply call, and the acknowledgement is sent with it afterwards", async () => {
    let n = 0;
    const portal = fakePortal(base({ "POST variables/api-url/apply": () => (n++ === 0 ? { status: 409, body: { error: "Wirkt wie ein Geheimnis.", code: "secret-ack" } } : { status: "applied", outcomes: [] }) }));
    const { user } = renderApp(detail());
    await user.click(await screen.findByRole("button", { name: "In GitHub setzen" }));
    await user.click(await screen.findByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    await user.click(screen.getByRole("button", { name: "In GitHub setzen" }));
    await waitFor(() => expect(portal.callsTo("POST", "variables/api-url/apply")).toHaveLength(2));
    expect(portal.callsTo("POST", "variables/api-url/apply")[1]?.body).toEqual({ acknowledgedPublic: true });
  });

  it("adopts the value from GitHub", async () => {
    const onChanged = vi.fn();
    const onCompare = vi.fn(async () => true);
    fakePortal(base({ "POST variables/api-url/adopt": variable() }));
    const { user } = renderApp(detail({ onChanged, onCompare }));
    await user.click(await screen.findByRole("button", { name: "Aus GitHub übernehmen" }));
    expect(await screen.findByText("Wert aus GitHub übernommen.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  it("shows an error when adopting fails", async () => {
    fakePortal(base({ "POST variables/api-url/adopt": { status: 404, body: { error: "not in GitHub" } } }));
    const { user } = renderApp(detail());
    await user.click(await screen.findByRole("button", { name: "Aus GitHub übernehmen" }));
    expect(await screen.findByText("not in GitHub")).toBeInTheDocument();
  });

  it.each([
    ["apply", "POST variables/api-url/apply", { status: "applied", outcomes: [] }, "In GitHub gesetzt."],
    ["adopt", "POST variables/api-url/adopt", {}, "Wert aus GitHub übernommen."],
  ] as const)("starts the %s action once on open for the row action", async (auto, route, answer, toast) => {
    const portal = fakePortal(base({ [route]: answer }));
    renderApp(detail({ auto }));
    expect(await screen.findByText(toast)).toBeInTheDocument();
    expect(portal.callsTo("POST", route.replace("POST ", ""))).toHaveLength(1);
  });

  it("does not start anything on open without an action", async () => {
    const portal = fakePortal(base());
    renderApp(detail());
    await screen.findByRole("dialog");
    expect(portal.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("lists the comparison per target with the state, the values and the reason for an unreachable target", async () => {
    fakePortal(base());
    renderApp(
      detail({
        drift: [
          drift({ placeLabel: "ok / Repository" }),
          drift({ placeLabel: "diff / Repository", state: "different", expected: "a", actual: "b" }),
          drift({ placeLabel: "diff2 / Repository", state: "different", expected: null, actual: null }),
          drift({ placeLabel: "missing / Repository", state: "missing" }),
          drift({ placeLabel: "u401 / Repository", state: "unreachable", errorStatus: 401, error: "bad credentials" }),
          drift({ placeLabel: "u403 / Repository", state: "unreachable", errorStatus: 403 }),
          drift({ placeLabel: "u404 / Repository", state: "unreachable", errorStatus: 404 }),
          drift({ placeLabel: "u500 / Repository", state: "unreachable", errorStatus: 500, error: "boom" }),
          drift({ placeLabel: "unknown / Repository", state: "unknown-expected" }),
        ],
      }),
    );
    const rows = (await screen.findAllByRole("listitem")).filter((li) => li.textContent?.includes(" / Repository"));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toHaveTextContent("Stimmt überein");
    expect(rows[1]).toHaveTextContent("Soll a, Ist b");
    expect(rows[2]).toHaveTextContent("Soll –, Ist –");
    expect(rows[3]).toHaveTextContent("Fehlt in GitHub");
    expect(rows[4]).toHaveTextContent("Der Token ist ungültig oder abgelaufen");
    expect(rows[4]).toHaveTextContent("bad credentials");
    expect(rows[5]).toHaveTextContent("Dem Token fehlt wahrscheinlich das Recht");
    expect(rows[6]).toHaveTextContent("Repository oder Umgebung wurde nicht gefunden");
    expect(rows[7]).toHaveTextContent("GitHub hat die Abfrage abgelehnt");
    expect(rows[7]).toHaveTextContent("boom");
    expect(rows[8]).toHaveTextContent("Sollwert unbekannt");
    expect(screen.queryByText("Noch nicht verglichen. Mit „Mit GitHub vergleichen“ prüfst du alle Ziele.")).toBeNull();
  });

  it("offers the source section with the stored source", async () => {
    fakePortal(base());
    renderApp(detail({ v: variable({ from: { connection: "supabase", kind: "supabase.project", resource: "p1", field: "url" } }) }));
    expect(await screen.findByText(/Gemerkte Quelle: Supabase-Projekt · URL/)).toBeInTheDocument();
  });
});

describe("VariableForm", () => {
  const form = (props: Partial<Parameters<typeof VariableForm>[0]> = {}) => <VariableForm sources={SOURCES} onClose={() => {}} onCreated={() => {}} {...props} />;
  const fill = async (user: ReturnType<typeof renderApp>["user"], repo = "web") => {
    await user.type(screen.getByLabelText(/^Kennung/), "api-url");
    await user.type(screen.getByLabelText(/^Name im Ziel/), "api_url");
    if (repo) await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), repo);
  };

  it("creates a variable on the default test stage and reports it", async () => {
    const onCreated = vi.fn();
    const portal = fakePortal(base({ "POST variables": variable() }));
    const { user } = renderApp(form({ onCreated }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("staging");
    await fill(user);
    expect(screen.getByLabelText(/^Name im Ziel/)).toHaveValue("API_URL");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("„API_URL“ wurde angelegt.")).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(portal.callsTo("POST", "variables")[0]?.body).toEqual({ id: "api-url", name: "API_URL", stage: "staging", places: [{ repo: "web", scope: "repository" }] });
  });

  it("sends product, value, description and the chosen source", async () => {
    const portal = fakePortal(base({ "POST variables": variable() }));
    const { user } = renderApp(form());
    await fill(user);
    await user.type(screen.getByLabelText("Produkt (optional)"), " shop ");
    await user.type(screen.getByLabelText("Sollwert (optional)"), "https://x.example.test");
    await user.type(screen.getByLabelText(/^Beschreibung/), "  Base URL ");
    await user.click(screen.getByRole("combobox", { name: "Quelle" }));
    await user.click(await screen.findByRole("option", { name: "Supabase-Projekt" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("Bitte wählen"));
    await user.click(screen.getByRole("combobox", { name: "Ressource" }));
    await user.click(await screen.findByRole("option", { name: "Project one" }));
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "variables")).toHaveLength(1));
    expect(portal.callsTo("POST", "variables")[0]?.body).toMatchObject({ product: "shop", value: "https://x.example.test", description: "Base URL", from: { connection: "supabase", kind: "supabase.project", resource: "p1", field: "url" } });
  });

  it("fills the value field from a loaded source value", async () => {
    fakePortal(base({ "POST variable-sources/value": { from: {}, value: "https://p1.example.test", resourceLabel: "Project one" } }));
    const { user } = renderApp(form());
    await fill(user);
    await user.click(screen.getByRole("combobox", { name: "Quelle" }));
    await user.click(await screen.findByRole("option", { name: "Supabase-Projekt" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("Bitte wählen"));
    await user.click(screen.getByRole("combobox", { name: "Ressource" }));
    await user.click(await screen.findByRole("option", { name: "Project one" }));
    await user.click(screen.getByRole("button", { name: "Wert laden" }));
    await user.click(await screen.findByRole("button", { name: "Als Wert übernehmen" }));
    expect(screen.getByLabelText("Sollwert (optional)")).toHaveValue("https://p1.example.test");
  });

  it("asks for a target, an incomplete row and an invalid link before sending anything", async () => {
    const portal = fakePortal(base({ "POST variables": variable() }));
    const { user } = renderApp(form());
    await fill(user, "");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Mindestens ein Ziel ist nötig.")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), "web");
    await user.type(screen.getByLabelText("Link"), "ftp://x");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Der Link muss mit http:// oder https:// beginnen.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables")).toHaveLength(0);
  });

  it("reports an incomplete target row", async () => {
    const portal = fakePortal(base({ "POST variables": variable() }));
    const { user } = renderApp(form());
    await fill(user, "");
    await user.click(screen.getByRole("combobox", { name: "Bereich, Ziel 1" }));
    await user.click(await screen.findByRole("option", { name: "Umgebung" }));
    await user.type(screen.getByLabelText("Umgebungsname, Ziel 1"), "preview");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Bei einem Ziel fehlt das Repository.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables")).toHaveLength(0);
  });

  it("blocks a secret-looking value and asks for the acknowledgement of a suspicious one", async () => {
    let n = 0;
    const portal = fakePortal(base({ "POST variables": (call) => (n++ === 0 ? { status: 409, body: { error: "Wirkt wie ein Geheimnis.", code: "secret-ack" } } : (call.body, variable())) }));
    const { user } = renderApp(form());
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await user.click(await screen.findByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "variables")).toHaveLength(2));
    expect(portal.callsTo("POST", "variables")[1]?.body).toMatchObject({ acknowledgedPublic: true });
  });

  it("starts from the prefill of a link with an environment target", async () => {
    const initial: Prefill = { id: "from-compare", name: "FROM_COMPARE", repo: "web", stage: "production", description: "Found in the comparison" };
    const portal = fakePortal(base({ "POST variables": variable() }));
    const { user } = renderApp(form({ initial }));
    expect(screen.getByLabelText(/^Kennung/)).toHaveValue("from-compare");
    expect(screen.getByLabelText(/^Beschreibung/)).toHaveValue("Found in the comparison");
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("production");
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(portal.callsTo("POST", "variables")).toHaveLength(1));
    expect(portal.callsTo("POST", "variables")[0]?.body).toMatchObject({ stage: "production", places: [{ repo: "web", scope: "environment" }] });
  });

  it("closes through cancel and changes the stage", async () => {
    const onClose = vi.fn();
    fakePortal(base());
    const { user } = renderApp(form({ onClose }));
    await user.click(screen.getByRole("combobox", { name: "Stage" }));
    await user.click(await screen.findByRole("option", { name: "production" }));
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent("production");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the server error of a failed creation", async () => {
    fakePortal(base({ "POST variables": { status: 409, body: { error: "Kennung vergeben" } } }));
    const { user } = renderApp(form());
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByText("Kennung vergeben")).toBeInTheDocument();
  });

  it("keeps the optional details in a disclosure, closed on create and open for a prefilled description", () => {
    fakePortal(base());
    const { container, unmount } = renderApp(form());
    expect(container.querySelector("details.sd-disclosure")).not.toHaveAttribute("open");
    unmount();
    const prefilled = renderApp(form({ initial: { id: "a", name: "A", repo: "web", stage: "staging", description: "Known" } }));
    expect(prefilled.container.querySelector("details.sd-disclosure")).toHaveAttribute("open");
  });

  it("renders the buttons into the footer host and submits through the form attribute", async () => {
    const portal = fakePortal(base({ "POST variables": variable() }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { user, container } = renderApp(form({ footerHost: host }));
    const submit = screen.getByRole("button", { name: "Anlegen" });
    expect(host).toContainElement(submit);
    expect(container).not.toContainElement(submit);
    await fill(user);
    await user.click(submit);
    await waitFor(() => expect(portal.callsTo("POST", "variables")).toHaveLength(1));
    host.remove();
  });
});

describe("RemoveDialog", () => {
  it("asks first and removes the variable after the confirmation", async () => {
    const onDone = vi.fn();
    const portal = fakePortal(base({ "DELETE variables/api-url": { ok: true } }));
    const { user } = renderApp(<RemoveDialog v={variable()} onClose={() => {}} onDone={onDone} />);
    expect(screen.getByText("„API_URL“ wird aus dem Inventar entfernt. In GitHub bleibt die Variable bestehen.")).toBeInTheDocument();
    expect(portal.callsTo("DELETE", "variables/api-url")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Entfernen" }));
    expect(await screen.findByText("Entfernt.")).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows a failed removal and keeps the dialog", async () => {
    const onDone = vi.fn();
    fakePortal(base({ "DELETE variables/api-url": { status: 409, body: { error: "still in use" } } }));
    const { user } = renderApp(<RemoveDialog v={variable()} onClose={() => {}} onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Entfernen" }));
    expect(await screen.findByText("still in use")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Entfernen" })).toBeEnabled();
  });

  it("closes through cancel", async () => {
    const onClose = vi.fn();
    fakePortal(base());
    const { user } = renderApp(<RemoveDialog v={variable()} onClose={onClose} onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
