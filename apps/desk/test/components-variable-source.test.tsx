import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SourceSection, SuggestSourcesDialog, useVariableSources } from "@/components/VariableSource";
import { EMPTY_SOURCE, type SourceDef, type SourceDraft, type SuggestionRow, type VariableFrom } from "@/lib/variable-source";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { drainRequestsAfterEach } from "./helpers/drain";
import { okState } from "./helpers/params";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

drainRequestsAfterEach();

const field = (f: string, label = f.toUpperCase()) => ({ field: f, label, labelEn: `${label} en` });
const SOURCES: SourceDef[] = [
  { kind: "supabase.project", connection: "supabase", label: "Supabase-Projekt", labelEn: "Supabase project", fields: [field("url", "URL"), field("anonKey", "Anon-Schlüssel")], connected: true },
  { kind: "cloudflare.zone", connection: "cloudflare", label: "Cloudflare-Zone", labelEn: "Cloudflare zone", fields: [field("id", "Kennung")], connected: true },
  { kind: "resend.domain", connection: "resend", label: "Resend-Domain", labelEn: "Resend domain", fields: [field("name", "Name")], connected: false },
];
const RES = (connection: string) => `GET connections/${connection}/resources*`;
const resources = (kind: string, state: unknown, defaults: Record<string, unknown> = {}) => ({ connection: "x", connected: true, defaultSpecs: [], defaults, resources: { [kind]: state } });
const projects = okState([{ value: "p1", label: "Project one" }, { value: "p2", label: "Project two", detail: "eu" }]);

interface HarnessProps {
  mode?: "create" | "edit";
  sources?: SourceDef[];
  initial?: SourceDraft;
  sourcesError?: Error | null;
  variableId?: string;
  stored?: VariableFrom | null;
  repo?: string;
  stage?: string;
  onUseValue?: (v: string) => void;
  onChanged?: () => void;
  spy?: (d: SourceDraft) => void;
}
function Harness({ mode = "create", sources = SOURCES, initial = EMPTY_SOURCE, spy, ...rest }: HarnessProps) {
  const [d, setD] = useState(initial);
  return <SourceSection mode={mode} sources={sources} value={d} onChange={(x) => { setD(x); spy?.(x); }} {...rest} />;
}
const supabase: SourceDraft = { kind: "supabase.project", resource: "p1", field: "url" };
const routes = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({ [RES("supabase")]: resources("supabase.project", projects), ...over });

describe("useVariableSources", () => {
  function Probe() {
    const { sources, error } = useVariableSources();
    return <p>{error ? `error:${error.message}` : sources.map((s) => s.kind).join(",") || "none"}</p>;
  }

  it("lists the allowed sources and starts empty", async () => {
    fakePortal({ "GET variable-sources": { sources: SOURCES } });
    renderApp(<Probe />);
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(await screen.findByText("supabase.project,cloudflare.zone,resend.domain")).toBeInTheDocument();
  });

  it("reports an error", async () => {
    fakePortal({ "GET variable-sources": { status: 500, body: { error: "list failed" } } });
    renderApp(<Probe />);
    expect(await screen.findByText("error:list failed")).toBeInTheDocument();
  });
});

describe("SourceSection choosing a source", () => {
  it("offers all sources, marks the unconnected one and shows only the kind selector first", async () => {
    fakePortal(routes());
    const { user } = renderApp(<Harness />);
    expect(screen.getByRole("heading", { name: "Aus Anbieter laden" })).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Quelle" }));
    const names = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Keine Quelle", "Supabase-Projekt", "Cloudflare-Zone", "Resend-Domain (nicht verbunden)"]);
    expect(screen.queryByRole("combobox", { name: "Feld" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wert laden" })).toBeNull();
  });

  it("uses the English labels in the English interface", async () => {
    localStorage.setItem("sd-locale", "en");
    fakePortal(routes());
    const { user } = renderApp(<Harness initial={supabase} />);
    await user.click(screen.getByRole("combobox", { name: "Source" }));
    expect(await screen.findByRole("option", { name: "Supabase project" })).toBeInTheDocument();
  });

  it("points to the integrations for a source that is not connected", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness spy={spy} />);
    fakePortal(routes());
    await pickOption(user, "Quelle", /Resend-Domain/);
    expect(spy).toHaveBeenLastCalledWith({ kind: "resend.domain", resource: "", field: "name" });
    expect(screen.getByText(/Diese Quelle braucht die verbundene Integration/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Integrationen" })).toHaveAttribute("href", "/connections");
    expect(screen.queryByRole("button", { name: "Wert laden" })).toBeNull();
  });

  it("selects the only field of a source and asks for the field when there are several", async () => {
    const spy = vi.fn();
    fakePortal(routes({ [RES("cloudflare")]: resources("cloudflare.zone", okState([])) }));
    const { user } = renderApp(<Harness spy={spy} />);
    await pickOption(user, "Quelle", "Cloudflare-Zone");
    expect(spy).toHaveBeenLastCalledWith({ kind: "cloudflare.zone", resource: "", field: "id" });
    await pickOption(user, "Quelle", "Supabase-Projekt");
    expect(spy).toHaveBeenLastCalledWith({ kind: "supabase.project", resource: "", field: "" });
    await pickOption(user, "Feld", "Anon-Schlüssel");
    expect(spy).toHaveBeenLastCalledWith({ kind: "supabase.project", resource: "", field: "anonKey" });
  });

  it("shows the field names in English", async () => {
    localStorage.setItem("sd-locale", "en");
    fakePortal(routes());
    const { user } = renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "" }} />);
    await user.click(screen.getByRole("combobox", { name: "Field" }));
    expect(await screen.findByRole("option", { name: "URL en" })).toBeInTheDocument();
  });

  it("shows a warning when the list of sources could not be read", () => {
    fakePortal(routes());
    renderApp(<Harness sourcesError={new Error("allowlist down")} />);
    expect(screen.getByText("Die Liste ließ sich nicht lesen: allowlist down")).toBeInTheDocument();
  });
});

describe("SourceSection resources", () => {
  it("reads the resources of the chosen source and offers them with details", async () => {
    const portal = fakePortal(routes());
    const { user } = renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("Liste wird gelesen …");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("Bitte wählen"));
    expect(portal.callsTo("GET", "connections/supabase/resources?kind=supabase.project")).toHaveLength(1);
    await user.click(screen.getByRole("combobox", { name: "Ressource" }));
    expect(await screen.findByRole("option", { name: "Project two · eu" })).toBeInTheDocument();
  });

  it("keeps a chosen resource that the provider no longer lists", async () => {
    fakePortal(routes());
    renderApp(<Harness initial={{ kind: "supabase.project", resource: "gone-id", field: "url" }} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("gone-id"));
  });

  it("retries once with the default value of the integration when the list needs a parameter", async () => {
    const portal = fakePortal({
      [RES("supabase")]: (call) => (call.path.includes("param.org") ? resources("supabase.project", projects, { org: "o1" }) : resources("supabase.project", { status: "needs-params", options: [], suggested: null }, { org: "o1", ignored: 5, empty: "" })),
    });
    const { user } = renderApp(<Harness initial={{ kind: "supabase.project", resource: "p1", field: "url" }} />);
    await waitFor(() => expect(portal.callsTo("GET", "connections/supabase/resources?kind=supabase.project&param.org=o1")).toHaveLength(1));
    expect(portal.calls.filter((c) => c.path.startsWith("connections/supabase/resources"))).toHaveLength(2);
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    await waitFor(() => expect(portal.callsTo("POST", "variable-sources/value")).toHaveLength(1));
  });

  it("asks to set the integration default when no default exists for the needed parameter", async () => {
    fakePortal(routes({ [RES("supabase")]: resources("supabase.project", { status: "needs-params", options: [], suggested: null }) }));
    renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByText(/Zuerst in den Integrationen den Standardwert/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Zu den Integrationen" })).toHaveLength(1);
  });

  it("explains a failed listing with and without a message", async () => {
    fakePortal(routes({ [RES("supabase")]: resources("supabase.project", { status: "error", options: [], suggested: null, error: "token lacks read right" }) }));
    const first = renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByText(/Die Liste ließ sich nicht lesen: token lacks read right/)).toBeInTheDocument();
    first.unmount();
    fakePortal(routes({ [RES("supabase")]: resources("supabase.project", { status: "error", options: [], suggested: null }) }));
    renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByText(/Die Liste ließ sich nicht lesen\. Hat das Token/)).toBeInTheDocument();
  });

  it("says so when the integration returns no resources", async () => {
    fakePortal(routes({ [RES("supabase")]: resources("supabase.project", okState([])) }));
    renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByText("Die Integration liefert keine Ressourcen.")).toBeInTheDocument();
  });

  it("shows a warning when reading the list fails", async () => {
    fakePortal(routes({ [RES("supabase")]: { status: 502, body: { error: "provider down" } } }));
    renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByText("Die Liste ließ sich nicht lesen: provider down")).toBeInTheDocument();
  });

  it("changes the chosen resource", async () => {
    const spy = vi.fn();
    fakePortal(routes());
    const { user } = renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} spy={spy} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveTextContent("Bitte wählen"));
    await pickOption(user, "Ressource", "Project one");
    expect(spy).toHaveBeenLastCalledWith({ kind: "supabase.project", resource: "p1", field: "url" });
  });

  it("keeps the load button disabled until resource and an allowed field are chosen", async () => {
    fakePortal(routes());
    const { rerender } = renderApp(<Harness initial={{ kind: "supabase.project", resource: "", field: "url" }} />);
    expect(await screen.findByRole("button", { name: "Wert laden" })).toBeDisabled();
    rerender(<Harness initial={{ kind: "supabase.project", resource: "p1", field: "not-allowed" }} />);
    expect(screen.getByRole("button", { name: "Wert laden" })).toBeDisabled();
  });
});

describe("SourceSection create mode", () => {
  it("loads a value with repository and stage and hands it to the form", async () => {
    const onUseValue = vi.fn();
    const portal = fakePortal(routes({ "POST variable-sources/value": { from: {}, value: "https://p1.example.test", resourceLabel: "Project one" } }));
    const { user } = renderApp(<Harness initial={supabase} repo="acme/web" stage="staging" onUseValue={onUseValue} />);
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("Gelesen aus Project one: https://p1.example.test")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variable-sources/value")[0]?.body).toEqual({ kind: "supabase.project", resource: "p1", field: "url", repo: "acme/web", stage: "staging" });
    expect(screen.queryByText(/Aktuell im Inventar/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Als Wert übernehmen" }));
    expect(onUseValue).toHaveBeenCalledWith("https://p1.example.test");
    expect(screen.queryByText(/Gelesen aus/)).toBeNull();
  });

  it("sends neither repository nor stage when they are unknown and works without a use-value handler", async () => {
    const portal = fakePortal(routes({ "POST variable-sources/value": { from: {}, value: "x", resourceLabel: "P" } }));
    const { user } = renderApp(<Harness initial={supabase} />);
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    await screen.findByText("Gelesen aus P: x");
    expect(portal.callsTo("POST", "variable-sources/value")[0]?.body).toEqual({ kind: "supabase.project", resource: "p1", field: "url" });
    await user.click(screen.getByRole("button", { name: "Als Wert übernehmen" }));
    expect(screen.queryByText(/Gelesen aus/)).toBeNull();
  });

  it("shortens a long value", async () => {
    fakePortal(routes({ "POST variable-sources/value": { from: {}, value: "v".repeat(100), resourceLabel: "P" } }));
    const { user } = renderApp(<Harness initial={supabase} />);
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText(`Gelesen aus P: ${"v".repeat(79)}…`)).toBeInTheDocument();
  });

  it("forgets the loaded value when the choice changes", async () => {
    fakePortal(routes({ "POST variable-sources/value": { from: {}, value: "x", resourceLabel: "P" } }));
    const { user } = renderApp(<Harness initial={supabase} />);
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    await screen.findByText("Gelesen aus P: x");
    await pickOption(user, "Feld", "Anon-Schlüssel");
    expect(screen.queryByText(/Gelesen aus/)).toBeNull();
  });
});

describe("SourceSection edit mode", () => {
  const edit = (props: Partial<HarnessProps> = {}) => <Harness mode="edit" variableId="v1" initial={supabase} {...props} />;
  const proposal = (over: Record<string, unknown> = {}) => ({ variableId: "v1", from: {}, current: "old", proposed: "new", resourceLabel: "Project one", changed: true, applied: false, ...over });

  it("shows the proposal against the current value and applies it after a click", async () => {
    const onChanged = vi.fn();
    let applied = false;
    const portal = fakePortal(routes({ "POST variables/v1/load-from-source": (call) => ((call.body as { apply?: boolean }).apply ? (applied = true, proposal({ applied: true })) : proposal()) }));
    const { user } = renderApp(edit({ onChanged }));
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("Gelesen aus Project one: new")).toBeInTheDocument();
    expect(screen.getByText("Aktuell im Inventar: old")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables/v1/load-from-source")[0]?.body).toEqual({ kind: "supabase.project", resource: "p1", field: "url" });
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("Wert aus dem Anbieter übernommen (nicht in GitHub geschrieben).")).toBeInTheDocument();
    expect(applied).toBe(true);
    expect(portal.callsTo("POST", "variables/v1/load-from-source")[1]?.body).toEqual({ kind: "supabase.project", resource: "p1", field: "url", apply: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
  });

  it("applies without a change handler and shows a dash for an unset current value", async () => {
    fakePortal(routes({ "POST variables/v1/load-from-source": (call) => proposal({ current: null, applied: Boolean((call.body as { apply?: boolean }).apply) }) }));
    const { user } = renderApp(edit());
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("Aktuell im Inventar: –")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText(/Wert aus dem Anbieter übernommen/)).toBeInTheDocument();
  });

  it("says when the value is already current and offers no apply button", async () => {
    fakePortal(routes({ "POST variables/v1/load-from-source": proposal({ changed: false, current: "new" }) }));
    const { user } = renderApp(edit());
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("Der Wert ist bereits aktuell.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
  });

  it("blocks a value that looks like a secret", async () => {
    fakePortal(routes({ "POST variables/v1/load-from-source": { status: 422, body: { error: "secret-like", code: "secret-blocked" } } }));
    const { user } = renderApp(edit());
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("Gesperrt")).toBeInTheDocument();
  });

  it("asks for an acknowledgement of a suspicious value and sends it with the apply call", async () => {
    let first = true;
    const portal = fakePortal(
      routes({
        "POST variables/v1/load-from-source": (call) => {
          const b = call.body as { apply?: boolean; acknowledgedPublic?: boolean };
          if (first) { first = false; return proposal(); }
          return b.acknowledgedPublic ? proposal({ applied: true }) : { status: 409, body: { error: "Wirkt wie ein Geheimnis.", code: "secret-ack" } };
        },
      }),
    );
    const { user } = renderApp(edit());
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("Achtung, möglicherweise ein Geheimnis")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText(/Wert aus dem Anbieter übernommen/)).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables/v1/load-from-source").at(-1)?.body).toMatchObject({ apply: true, acknowledgedPublic: true });
    expect(screen.queryByLabelText("Ich bestätige: Dieser Wert ist öffentlich")).toBeNull();
  });

  it("shows any other failure of the load", async () => {
    fakePortal(routes({ "POST variables/v1/load-from-source": { status: 500, body: { error: "provider exploded" } } }));
    const { user } = renderApp(edit());
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    expect(await screen.findByText("provider exploded")).toBeInTheDocument();
  });

  it("includes the resolved parameters of the listing in the load call", async () => {
    const portal = fakePortal({
      [RES("supabase")]: (call) => (call.path.includes("param.org") ? resources("supabase.project", projects) : resources("supabase.project", { status: "needs-params", options: [], suggested: null }, { org: "o1" })),
      "POST variables/v1/load-from-source": proposal(),
    });
    const { user } = renderApp(edit());
    await waitFor(() => expect(portal.callsTo("GET", "connections/supabase/resources?kind=supabase.project&param.org=o1")).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Wert laden" }));
    await screen.findByText(/Gelesen aus/);
    expect(portal.callsTo("POST", "variables/v1/load-from-source")[0]?.body).toMatchObject({ params: { org: "o1" } });
  });

  it("shows the stored source and removes it", async () => {
    const onChanged = vi.fn();
    const spy = vi.fn();
    const portal = fakePortal(routes({ "PATCH variables/v1": {} }));
    const { user } = renderApp(edit({ stored: { connection: "supabase", kind: "supabase.project", resource: "p1", field: "url" }, onChanged, spy }));
    expect(screen.getByText(/Gemerkte Quelle: Supabase-Projekt · URL/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quelle entfernen" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(EMPTY_SOURCE));
    expect(portal.callsTo("PATCH", "variables/v1")[0]?.body).toEqual({ from: null });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows a stored source of an unknown kind by its raw names, removes it without a handler and reports a failure", async () => {
    let fail = true;
    fakePortal(routes({ "PATCH variables/v1": () => (fail ? { status: 500, body: { error: "cannot clear" } } : {}) }));
    const { user } = renderApp(edit({ initial: EMPTY_SOURCE, stored: { connection: "x", kind: "legacy.kind", resource: "r", field: "oldField" } }));
    expect(screen.getByText(/Gemerkte Quelle: legacy\.kind · oldField/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quelle entfernen" }));
    expect(await screen.findByText("cannot clear")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Quelle entfernen" }));
    await waitFor(() => expect(screen.queryByText("cannot clear")).toBeNull());
  });

  it("shows no stored source in the create form", () => {
    fakePortal(routes());
    renderApp(<Harness mode="create" stored={{ connection: "x", kind: "k", resource: "r", field: "f" }} />);
    expect(screen.queryByText(/Gemerkte Quelle/)).toBeNull();
  });
});

describe("SuggestSourcesDialog", () => {
  const from = (id: string): VariableFrom => ({ connection: "supabase", kind: "supabase.project", resource: id, field: "url" });
  const ok = (id: string, over: Partial<Extract<SuggestionRow, { status: "ok" }>> = {}): SuggestionRow => ({ variableId: id, from: from(id), current: "old", proposed: "new", resourceLabel: "Project", changed: true, status: "ok", ...over });
  const failed = (id: string, error = "unreadable"): SuggestionRow => ({ variableId: id, from: from(id), status: "error", error });
  const SUGGEST = "POST variables/suggest-all";
  const dialog = (props: Partial<Parameters<typeof SuggestSourcesDialog>[0]> = {}) => <SuggestSourcesDialog names={{ v1: "API_URL" }} onClose={() => {}} onChanged={() => {}} {...props} />;

  it("shows a loading hint with a skeleton, then the empty state", async () => {
    fakePortal({ [SUGGEST]: { suggestions: [] } });
    renderApp(dialog());
    expect(screen.getByText("Das Portal liest die Quellen …")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeInTheDocument();
    expect(await screen.findByText(/Keine Variable hat eine Quelle/)).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    let fail = true;
    fakePortal({ [SUGGEST]: () => (fail ? { status: 500, body: { error: "sources offline" } } : { suggestions: [] }) });
    const { user } = renderApp(dialog());
    expect(await screen.findByRole("alert")).toHaveTextContent("sources offline");
    fail = false;
    await user.click(screen.getByRole("button", { name: /Erneut versuchen/ }));
    expect(await screen.findByText(/Keine Variable hat eine Quelle/)).toBeInTheDocument();
  });

  it("lists changed, unchanged and unreadable variables", async () => {
    fakePortal({ [SUGGEST]: { suggestions: [ok("v1"), ok("v2", { current: null, proposed: "p".repeat(80) }), ok("v3", { changed: false }), ok("v4", { changed: false }), failed("v5", "no access")] } });
    renderApp(dialog());
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("API_URL");
    expect(rows[0]).toHaveTextContent("Jetzt: old");
    expect(rows[0]).toHaveTextContent("Vorschlag (Project): new");
    expect(rows[1]).toHaveTextContent("v2");
    expect(rows[1]).toHaveTextContent("Jetzt: –");
    expect(rows[1]).toHaveTextContent(`${"p".repeat(69)}…`);
    expect(screen.getByText("2 unverändert")).toBeInTheDocument();
    expect(screen.getByText("Nicht lesbar")).toBeInTheDocument();
    expect(screen.getByText(/v5/, { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/no access/)).toBeInTheDocument();
  });

  it("applies one suggestion into the inventory and reports it", async () => {
    const onChanged = vi.fn();
    const portal = fakePortal({ [SUGGEST]: { suggestions: [ok("v1")] }, "POST variables/v1/load-from-source": {} });
    const { user } = renderApp(dialog({ onChanged }));
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("API_URL: Wert übernommen.")).toBeInTheDocument();
    expect(await screen.findByText("Wert aus dem Anbieter übernommen (nicht in GitHub geschrieben).")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables/v1/load-from-source")[0]?.body).toEqual({ kind: "supabase.project", resource: "v1", field: "url", apply: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
  });

  it("falls back to the id when the name is unknown", async () => {
    fakePortal({ [SUGGEST]: { suggestions: [ok("v9")] }, "POST variables/v9/load-from-source": {} });
    const { user } = renderApp(dialog({ names: {} }));
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("v9: Wert übernommen.")).toBeInTheDocument();
  });

  it("shows the busy state while a suggestion is being applied", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    fakePortal({ [SUGGEST]: { suggestions: [ok("v1")] }, "POST variables/v1/load-from-source": async () => { await gate; return {}; } });
    const { user } = renderApp(dialog());
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Übernehmen" })).toBeDisabled());
    release();
    await screen.findByText("API_URL: Wert übernommen.");
  });

  it("shows the error of a failed apply and keeps the button", async () => {
    fakePortal({ [SUGGEST]: { suggestions: [ok("v1")] }, "POST variables/v1/load-from-source": { status: 500, body: { error: "write failed" } } });
    const { user } = renderApp(dialog());
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("write failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ich bestätige: Dieser Wert ist öffentlich")).toBeNull();
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeEnabled();
  });

  it("asks for an acknowledgement when the server wants one and sends it on the next try", async () => {
    const portal = fakePortal({
      [SUGGEST]: { suggestions: [ok("v1")] },
      "POST variables/v1/load-from-source": (call) => ((call.body as { acknowledgedPublic?: boolean }).acknowledgedPublic ? {} : { status: 409, body: { error: "Wirkt wie ein Geheimnis.", code: "secret-ack" } }),
    });
    const { user } = renderApp(dialog());
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("Wirkt wie ein Geheimnis.")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Ich bestätige: Dieser Wert ist öffentlich"));
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("API_URL: Wert übernommen.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "variables/v1/load-from-source")[1]?.body).toMatchObject({ acknowledgedPublic: true });
  });

  it("closes through the close button", async () => {
    fakePortal({ [SUGGEST]: { suggestions: [] } });
    const onClose = vi.fn();
    const { user } = renderApp(dialog({ onClose }));
    await user.click(await screen.findByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalled();
  });
});
