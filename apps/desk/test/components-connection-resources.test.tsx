import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionDefaultsSummary, ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { fakePortal } from "./helpers/portal";
import { okState, spec } from "./helpers/params";
import { renderApp } from "./helpers/render";

const ROUTE = "GET connections/cloudflare/resources";
const accountSpec = spec({ key: "accountId", type: "string", discover: "cloudflare.account" });
const urlSpec = spec({ key: "baseUrl", type: "url" });

const data = (over: Record<string, unknown> = {}) => ({
  connection: "cloudflare",
  connected: true,
  defaultSpecs: [accountSpec],
  defaults: {},
  resources: { "cloudflare.account": okState([{ value: "a1", label: "Acme", detail: "first" }, { value: "a2", label: "Beta" }]) },
  ...over,
});

const errorState = (error?: string) => ({ status: "error", options: [], suggested: null, ...(error ? { error } : {}) });

describe("ConnectionDefaultsSummary", () => {
  it("shows a loading line first and renders nothing for a 4xx answer", async () => {
    fakePortal({ [ROUTE]: { status: 404, body: { error: "no such connection" } } });
    const { container } = renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    expect(screen.getByText("Ressourcen werden gelesen …")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Ressourcen werden gelesen …")).toBeNull());
    expect(container.querySelector("p")).toBeNull();
  });

  it("shows the message of a server error", async () => {
    fakePortal({ [ROUTE]: { status: 500, body: { error: "provider unreachable" } } });
    renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    expect(await screen.findByText("provider unreachable")).toBeInTheDocument();
  });

  it("renders nothing when the integration has neither defaults, nor resources, nor read errors", async () => {
    fakePortal({ [ROUTE]: data({ defaultSpecs: [], resources: {} }) });
    renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    await waitFor(() => expect(screen.queryByText("Ressourcen werden gelesen …")).toBeNull());
    expect(screen.queryByText("Standardwerte")).toBeNull();
  });

  it("lists the defaults with resource names, unset ones, and notes unreadable lists", async () => {
    fakePortal({
      [ROUTE]: data({
        defaultSpecs: [accountSpec, urlSpec],
        defaults: { accountId: "a1" },
        resources: { "cloudflare.account": okState([{ value: "a1", label: "Acme" }]), "cloudflare.zone": errorState(), "custom.thing": errorState("denied") },
      }),
    });
    renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    expect(await screen.findByText("Acme (a1)")).toBeInTheDocument();
    expect(screen.getByText("nicht gesetzt")).toBeInTheDocument();
    expect(screen.getByText(/Nicht lesbar: Cloudflare-Zonen, custom.thing\./)).toBeInTheDocument();
  });

  it("says no defaults are needed when the integration has none but resources", async () => {
    fakePortal({ [ROUTE]: data({ defaultSpecs: [] }) });
    renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    expect(await screen.findByText("Diese Integration braucht keine Standardwerte.")).toBeInTheDocument();
  });

  it("opens the editor dialog and closes it", async () => {
    fakePortal({ [ROUTE]: data(), "GET resource-map": { kinds: [], entries: [] } });
    const { user } = renderApp(<ConnectionDefaultsSummary id="cloudflare" />);
    await user.click(await screen.findByRole("button", { name: "Ressourcen und Standardwerte" }));
    const dialog = await screen.findByRole("dialog", { name: "Ressourcen und Standardwerte" });
    expect(await within(dialog).findByText("Standardwerte speichern", { selector: "button" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Fertig" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ressourcen und Standardwerte" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConnectionResourcesPanel", () => {
  const panel = (props: Partial<Parameters<typeof ConnectionResourcesPanel>[0]> = {}) => <ConnectionResourcesPanel id="cloudflare" {...props} />;

  it("shows a skeleton, the load error with retry, and the not-connected notice", async () => {
    let step = 0;
    fakePortal({ [ROUTE]: () => (step++ === 0 ? { status: 500, body: { error: "read failed" } } : data({ connected: false })), "GET resource-map": { kinds: [], entries: [] } });
    const { user } = renderApp(panel());
    expect(await screen.findByText("read failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Integration nicht verbunden.")).toBeInTheDocument();
  });

  it("lists every discovered kind with counts, options, empty hints and read errors", async () => {
    fakePortal({
      [ROUTE]: data({
        defaultSpecs: [],
        resources: {
          "openai.project": okState([{ value: "a1", label: "Acme", detail: "first" }, { value: 2, label: "Beta" }]),
          "cloudflare.account": okState([]),
          "cloudflare.zone": okState([]),
          "custom.empty": okState([]),
          "cloudflare.workerScript": errorState("HTTP 403"),
          "supabase.project": errorState(),
          "resend.domain": { status: "not-connected", options: [], suggested: null },
          "grafana.serviceAccount": { status: "needs-params", options: [], suggested: null },
        },
      }),
      "GET resource-map": { kinds: [], entries: [] },
    });
    renderApp(panel());
    expect(await screen.findByText("OpenAI-Projekte")).toBeInTheDocument();
    expect(screen.getByText("2 gefunden")).toBeInTheDocument();
    expect(screen.getByText("Acme · first")).toBeInTheDocument();
    expect(screen.getByText(/Keine Konten gefunden\. Das ist normal/)).toBeInTheDocument();
    expect(screen.getByText(/Keine Zonen gefunden\. Das ist normal/)).toBeInTheDocument();
    expect(screen.getByText(/custom\.empty: keine gefunden\./)).toBeInTheDocument();
    expect(screen.getByText(/Worker: nicht lesbar \(HTTP 403\)\./)).toBeInTheDocument();
    expect(screen.getByText(/Supabase-Projekte: nicht lesbar\. Das Token/)).toBeInTheDocument();
    expect(screen.getByText("Integration nicht verbunden.")).toBeInTheDocument();
    expect(screen.queryByText("Grafana-Service-Accounts")).toBeNull();
    expect(screen.getByText("Diese Integration braucht keine Standardwerte.")).toBeInTheDocument();
  });

  it("shows only the defaults when no resource list is available", async () => {
    fakePortal({ [ROUTE]: data({ defaultSpecs: [urlSpec], resources: { "cloudflare.account": { status: "unsupported", options: [], suggested: null } } }), "GET resource-map": { kinds: [], entries: [] } });
    renderApp(panel());
    expect(await screen.findByLabelText(/baseUrl de/)).toBeInTheDocument();
    expect(screen.queryByText("Cloudflare-Konten")).toBeNull();
  });

  it("edits and saves defaults, then confirms and reloads", async () => {
    let current = data({ defaultSpecs: [accountSpec, urlSpec], defaults: { baseUrl: "https://old.test" } });
    const portal = fakePortal({
      [ROUTE]: () => current,
      "PUT connections/cloudflare/defaults": (call) => { current = data({ defaultSpecs: [accountSpec, urlSpec], defaults: (call.body as { values: Record<string, unknown> }).values }); return {}; },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const onSaved = vi.fn();
    const { user } = renderApp(panel({ onSaved }));
    const base = await screen.findByLabelText(/baseUrl de/);
    await waitFor(() => expect(base).toHaveValue("https://old.test"));
    const save = screen.getByRole("button", { name: "Standardwerte speichern" });
    expect(save).toBeDisabled();
    await user.clear(base);
    await user.type(base, "http://not-https.test");
    expect(save).toBeDisabled();
    await user.clear(base);
    await user.type(base, "https://new.test");
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(portal.callsTo("PUT", "connections/cloudflare/defaults")[0]?.body).toEqual({ values: { baseUrl: "https://new.test" } });
    expect(await screen.findByText("Standardwerte gespeichert.")).toBeInTheDocument();
  });

  it("works without an onSaved callback and shows a plain error or field problems", async () => {
    const portal = fakePortal({
      [ROUTE]: data({ defaultSpecs: [urlSpec] }),
      "PUT connections/cloudflare/defaults": { status: 500, body: { error: "write failed" } },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const { user } = renderApp(panel());
    await user.type(await screen.findByLabelText(/baseUrl de/), "https://x.test");
    await user.click(screen.getByRole("button", { name: "Standardwerte speichern" }));
    expect(await screen.findByText("write failed")).toBeInTheDocument();
    expect(portal.callsTo("PUT", "connections/cloudflare/defaults")).toHaveLength(1);
  });

  it("maps server problems to the field instead of a general error", async () => {
    fakePortal({
      [ROUTE]: data({ defaultSpecs: [urlSpec] }),
      "PUT connections/cloudflare/defaults": { status: 400, body: { error: "invalid", code: "params_invalid", problems: [{ key: "baseUrl", code: "wrong_type", message: "m", label: "Base", labelEn: "Base" }] } },
      "GET resource-map": { kinds: [], entries: [] },
    });
    const { user } = renderApp(panel({ onSaved: () => {} }));
    await user.type(await screen.findByLabelText(/baseUrl de/), "https://x.test");
    await user.click(screen.getByRole("button", { name: "Standardwerte speichern" }));
    expect(await screen.findByText("Base hat ein ungültiges Format.")).toBeInTheDocument();
    expect(screen.queryByText("invalid")).toBeNull();
  });
});
