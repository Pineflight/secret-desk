import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamsView, SecretView } from "@secret-desk/runtime";
import { ParamsCard } from "@/components/ParamsCard";
import { fakePortal } from "./helpers/portal";
import { okState, spec } from "./helpers/params";
import { renderApp } from "./helpers/render";

const secret = (over: Partial<SecretView> = {}): SecretView => ({ id: "s1", stage: "dev", places: [{ repo: "acme-app", scope: "repository" }], ...over }) as SecretView;

const specs = [
  spec({ key: "account", type: "string", required: true, discover: "cloudflare.account", integrationDefault: true }),
  spec({ key: "name", type: "string", required: true }),
  spec({ key: "note", type: "string" }),
];

const view = (over: Partial<ParamsView> = {}): ParamsView => ({
  secretId: "s1",
  provider: "acme",
  providerLabel: "Acme",
  connection: "acme-conn",
  connected: true,
  specs,
  values: { account: "a1", name: "n1" },
  defaults: {},
  effective: {},
  unknown: {},
  problems: [],
  complete: true,
  resources: { account: okState([{ value: "a1", label: "Account One" }, { value: "a2", label: "Account Two" }]) },
  preflight: null,
  ...over,
});

describe("ParamsCard view mode", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows a skeleton while loading and nothing for a provider without parameters", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ "GET secrets/s1/params": async () => { await gate; return view({ specs: [] }); } });
    const { container } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    expect(container.querySelector(".h-24")).not.toBeNull();
    release();
    await waitFor(() => expect(container.querySelector(".h-24")).toBeNull());
    expect(screen.queryByText("Parameter")).toBeNull();
  });

  it("shows the load error with retry", async () => {
    let fail = true;
    fakePortal({ "GET secrets/s1/params": () => (fail ? { status: 500, body: { error: "boom" } } : view()) });
    const { user } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Vollständig")).toBeInTheDocument();
  });

  it("shows the complete state with resource names, defaults and unset values", async () => {
    fakePortal({
      "GET secrets/s1/params": view({
        values: { name: "" },
        defaults: { account: "a2" },
        unknown: { legacy: 1, other: 2 },
        preflight: { status: "ok", resource: "Account Two (a2)", findings: [{ id: "f1", level: "ok", label: "Token valid" }, { id: "f2", level: "warn", label: "Close to limit", detail: "90%" }, { id: "f3", level: "fail", label: "No access" }] },
      }),
    });
    renderApp(<ParamsCard secret={secret()} focusSignal={0} notice="Look here" onChanged={() => {}} />);
    expect(await screen.findByText("Vollständig")).toBeInTheDocument();
    expect(screen.getByText("Look here")).toBeInTheDocument();
    expect(screen.getByText("Account Two (a2)", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("(Standardwert der Integration)")).toBeInTheDocument();
    expect(screen.getAllByText("nicht gesetzt")).toHaveLength(2);
    expect(screen.getByText("Weitere Einträge in params (bleiben erhalten): legacy, other")).toBeInTheDocument();
    expect(screen.getByText("Ressource beim Anbieter:")).toBeInTheDocument();
    expect(screen.getByText("Vorabcheck in Ordnung")).toBeInTheDocument();
    expect(screen.getByText("Token valid")).toHaveClass("text-success-text");
    expect(screen.getByText("Close to limit")).toHaveClass("text-warn-text");
    expect(screen.getByText("(90%)")).toBeInTheDocument();
    expect(screen.getByText("No access")).toHaveClass("text-danger-text");
  });

  it("badges missing and invalid parameters and warns about a missing connection", async () => {
    fakePortal({
      "GET secrets/s1/params": view({ complete: false, connected: false, connection: "acme-conn", problems: [{ key: "name", code: "missing", message: "m", label: "n", labelEn: "n" }, { key: "ghost", code: "missing", message: "m", label: "g", labelEn: "g" }] }),
    });
    const { unmount } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    expect(await screen.findByText("Parameter fehlen: name de, ghost")).toBeInTheDocument();
    expect(screen.getByText(/Integration acme-conn nicht verbunden/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Integrationen" })).toHaveAttribute("href", "/connections");
    unmount();
    fakePortal({ "GET secrets/s1/params": view({ complete: false, connected: false, connection: null, problems: [{ key: "name", code: "wrong_type", message: "m", label: "n", labelEn: "n" }] }) });
    renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    expect(await screen.findByText("Parameter ungültig")).toBeInTheDocument();
    expect(screen.getByText(/Integration \? nicht verbunden/)).toBeInTheDocument();
  });

  it("titles every preflight outcome", async () => {
    const cases: [ParamsView["preflight"], string][] = [
      [{ status: "warn", resource: null, findings: [] }, "Vorabcheck mit Hinweisen"],
      [{ status: "fail", resource: null, findings: [] }, "Vorabcheck mit Fehlbefund"],
      [{ status: "skipped", skippedReason: "params", resource: null, findings: [] }, "Vorabcheck übersprungen: Pflichtparameter fehlen"],
      [{ status: "skipped", skippedReason: "not-connected", resource: null, findings: [] }, "Vorabcheck übersprungen: Integration nicht verbunden"],
      [{ status: "not-connected", resource: null, findings: [] }, "Vorabcheck übersprungen: Integration nicht verbunden"],
      [{ status: "skipped", skippedReason: "none", resource: null, findings: [] }, "Dieser Anbieter hat keinen Vorabcheck"],
    ];
    for (const [preflight, title] of cases) {
      fakePortal({ "GET secrets/s1/params": view({ preflight }) });
      const { unmount } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.queryByRole("list")).toBeNull();
      unmount();
    }
  });
});

describe("ParamsCard editing", () => {
  const draftView = view({ resources: { account: okState([{ value: "a1", label: "Account One" }, { value: "a2", label: "Account Two" }]) } });

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("edits through the form, saves only the changes and reports it", async () => {
    let current = view();
    const portal = fakePortal({
      "GET secrets/s1/params": () => current,
      "GET providers/acme/params*": draftView,
      "PUT secrets/s1/params": (call) => { current = view({ values: { account: "a1", name: (call.body as { params: { name: string } }).params.name } }); return current; },
    });
    const onChanged = vi.fn();
    const { user } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={onChanged} />);
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    const name = await screen.findByLabelText(/name de/);
    expect(name).toHaveValue("n1");
    await user.clear(name);
    await user.type(name, "n2");
    await user.click(screen.getByRole("button", { name: "Parameter speichern" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(portal.callsTo("PUT", "secrets/s1/params")[0]?.body).toEqual({ params: { name: "n2" } });
    expect(await screen.findByText("Parameter gespeichert.")).toBeInTheDocument();
    expect(await screen.findByText("n2")).toBeInTheDocument();
    expect(portal.calls.some((c) => c.path.startsWith("providers/acme/params?") && c.path.includes("repo=acme-app") && c.path.includes("stage=dev"))).toBe(true);
  });

  it("closes the editor without a request when nothing changed, and on cancel", async () => {
    const portal = fakePortal({ "GET secrets/s1/params": view(), "GET providers/acme/params*": draftView });
    const { user } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    await user.click(await screen.findByRole("button", { name: "Parameter speichern" }));
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
    expect(portal.callsTo("PUT", "secrets/s1/params")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Bearbeiten" }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
  });

  it("blocks saving while a value is invalid and shows the plain server error", async () => {
    const specsWithUrl = [...specs, spec({ key: "base", type: "url" })];
    fakePortal({
      "GET secrets/s1/params": view({ specs: specsWithUrl }),
      "GET providers/acme/params*": { ...draftView, specs: specsWithUrl },
      "PUT secrets/s1/params": { status: 500, body: { error: "disk full" } },
    });
    const { user } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    await user.type(await screen.findByLabelText(/base de/), "http://insecure.test");
    expect(screen.getByRole("button", { name: "Parameter speichern" })).toBeDisabled();
    await user.clear(screen.getByLabelText(/base de/));
    await user.type(screen.getByLabelText(/base de/), "https://ok.test");
    await user.click(screen.getByRole("button", { name: "Parameter speichern" }));
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("disk full");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    await user.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(screen.queryByText("disk full")).toBeNull();
  });

  it("maps server problems onto the fields instead of a general error", async () => {
    fakePortal({
      "GET secrets/s1/params": view(),
      "GET providers/acme/params*": draftView,
      "PUT secrets/s1/params": { status: 400, body: { error: "invalid", code: "params_invalid", problems: [{ key: "name", code: "wrong_type", message: "bad", label: "Name", labelEn: "Name" }] } },
    });
    const { user } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    const name = await screen.findByLabelText(/name de/);
    await user.type(name, "x");
    await user.click(screen.getByRole("button", { name: "Parameter speichern" }));
    expect(await screen.findByText("Name hat ein ungültiges Format.")).toBeInTheDocument();
    expect(screen.queryByText("invalid")).toBeNull();
  });

  it("works for a secret without repository places", async () => {
    const portal = fakePortal({ "GET secrets/s1/params": view(), "GET providers/acme/params*": draftView });
    const { user } = renderApp(<ParamsCard secret={secret({ places: [{ scope: "cloudflare-worker", accountId: "a", script: "w" }] as SecretView["places"] })} focusSignal={0} notice={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Bearbeiten" }));
    await screen.findByLabelText(/name de/);
    expect(portal.calls.some((c) => c.path.startsWith("providers/acme/params?") && !c.path.includes("repo="))).toBe(true);
    const none = renderApp(<ParamsCard secret={secret({ places: [] })} focusSignal={0} notice={null} onChanged={() => {}} />);
    expect(none.container).toBeTruthy();
  });

  it("opens the editor and scrolls to the card when the focus signal fires", async () => {
    fakePortal({ "GET secrets/s1/params": view(), "GET providers/acme/params*": draftView });
    const { rerender } = renderApp(<ParamsCard secret={secret()} focusSignal={0} notice={null} onChanged={() => {}} />);
    await screen.findByText("Vollständig");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    rerender(<ParamsCard secret={secret()} focusSignal={1} notice={null} onChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Parameter speichern" })).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<ParamsCard secret={secret()} focusSignal={2} notice={null} onChanged={() => {}} />);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Parameter speichern" })).toBeInTheDocument();
  });

  it("waits for the data when the focus signal is already set at mount", async () => {
    fakePortal({ "GET secrets/s1/params": view(), "GET providers/acme/params*": draftView });
    renderApp(<ParamsCard secret={secret()} focusSignal={1} notice={null} onChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Parameter speichern" })).toBeInTheDocument();
  });
});
