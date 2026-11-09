import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlacesEditor } from "@/components/PlacesEditor";
import { invalidateRepoList } from "@/lib/repo-list";
import { emptyPlaceRow, type PlaceRow } from "@/lib/places";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);

function Harness({ initial, stage = "staging", allowWorker = false, spy }: { initial: PlaceRow[]; stage?: string; allowWorker?: boolean; spy?: (rows: PlaceRow[]) => void }) {
  const [rows, setRows] = useState(initial);
  return <PlacesEditor rows={rows} stage={stage} allowWorker={allowWorker} onChange={(r) => { setRows(r); spy?.(r); }} />;
}

const resources = (over: { defaults?: Record<string, unknown>; account?: unknown; script?: unknown } = {}) => ({
  connection: "cloudflare",
  connected: true,
  defaultSpecs: [],
  defaults: over.defaults ?? {},
  resources: {
    ...(over.account !== undefined ? { "cloudflare.account": over.account } : {}),
    ...(over.script !== undefined ? { "cloudflare.workerScript": over.script } : {}),
  },
});
const okState = (options: { value: string; label: string; detail?: string }[]) => ({ status: "ok", options, suggested: null });

describe("PlacesEditor repository and environment rows", () => {
  beforeEach(() => {
    invalidateRepoList();
    fakePortal({ "GET repos?live=1": { inventory: [{ name: "acme-app" }], github: [], linked: [] } });
  });

  it("edits the repository, adds and removes rows", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness initial={[emptyPlaceRow()]} spy={spy} />);
    expect(screen.getByText("Ziele in GitHub")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 1" }), "acme-x");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ repo: "acme-x" })]);
    await user.click(screen.getByRole("button", { name: "Ziel hinzufügen" }));
    expect(screen.getByRole("combobox", { name: "Repository, Ziel 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ziel 1 entfernen" }));
    expect(screen.queryByRole("combobox", { name: "Repository, Ziel 2" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Repository, Ziel 1" })).toHaveValue("");
  });

  it("changes only the row that was edited", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness initial={[{ repo: "first", scope: "repository", environment: "" }, emptyPlaceRow()]} spy={spy} />);
    await user.type(screen.getByRole("combobox", { name: "Repository, Ziel 2" }), "x");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ repo: "first" }), expect.objectContaining({ repo: "x" })]);
  });

  it("offers no Worker scope unless allowed and uses the plain legend", async () => {
    const { user } = renderApp(<Harness initial={[emptyPlaceRow()]} />);
    await user.click(screen.getByRole("combobox", { name: "Bereich, Ziel 1" }));
    const names = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Repository", "Umgebung"]);
  });

  it("derives the environment from the stage and lets the user override it", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness initial={[emptyPlaceRow()]} spy={spy} />);
    await pickOption(user, "Bereich, Ziel 1", "Umgebung");
    expect(screen.getByText("GitHub-Environment: staging (aus der Stage staging)")).toBeInTheDocument();
    await user.click(screen.getByText("Anderer Environment-Name"));
    await user.type(screen.getByLabelText("Umgebungsname, Ziel 1"), "qa");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ scope: "environment", environment: "qa" })]);
    expect(screen.queryByText(/GitHub-Environment: staging/)).toBeNull();
  });

  it("warns when the stage has no environment and no override is set", () => {
    renderApp(<Harness initial={[{ repo: "r", scope: "environment", environment: "" }]} stage="dev" />);
    expect(screen.getByText(/Die Stage dev hat keine GitHub-Environment/)).toBeInTheDocument();
    expect(screen.getByLabelText("Umgebungsname, Ziel 1")).toHaveAttribute("placeholder", "Umgebungsname");
  });

  it("shows the derived name as placeholder and keeps an own name visible", () => {
    renderApp(<Harness initial={[{ repo: "r", scope: "environment", environment: "custom" }]} />);
    expect(screen.getByLabelText("Umgebungsname, Ziel 1")).toHaveValue("custom");
    expect(screen.getByLabelText("Umgebungsname, Ziel 1")).toHaveAttribute("placeholder", expect.stringContaining("staging"));
    expect(screen.queryByText(/GitHub-Environment: staging/)).toBeNull();
    expect(screen.queryByText(/hat keine GitHub-Environment/)).toBeNull();
  });
});

describe("PlacesEditor Worker rows", () => {
  const workerRow = (over: Partial<PlaceRow> = {}): PlaceRow => ({ repo: "", scope: "cloudflare-worker", environment: "", ...over });
  const OPTIONS = "GET connections/cloudflare/resources?kind=cloudflare.account";

  beforeEach(() => invalidateRepoList());

  it("offers the Worker scope when allowed, with the mixed legend and hint", async () => {
    fakePortal({ [OPTIONS]: resources() });
    const { user } = renderApp(<Harness initial={[emptyPlaceRow()]} allowWorker />);
    expect(screen.getByText("Ziele (GitHub oder Cloudflare Worker)")).toBeInTheDocument();
    await pickOption(user, "Bereich, Ziel 1", "Cloudflare Worker");
    expect(screen.getByText(/Schreibt den Wert als Worker-Secret/)).toBeInTheDocument();
    expect(screen.getByLabelText("Worker-Name, Ziel 1")).toBeInTheDocument();
  });

  it("keeps the Worker scope option for an existing Worker row even when not allowed", async () => {
    fakePortal({ [OPTIONS]: resources() });
    const { user } = renderApp(<Harness initial={[workerRow()]} />);
    await user.click(screen.getByRole("combobox", { name: "Bereich, Ziel 1" }));
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: "Cloudflare Worker" })).toBeInTheDocument();
  });

  it("falls back to free text and warns when the connection is missing", async () => {
    fakePortal({ [OPTIONS]: resources({ account: { status: "not-connected", options: [], suggested: null } }) });
    const spy = vi.fn();
    const { user } = renderApp(<Harness initial={[workerRow()]} spy={spy} />);
    expect(await screen.findByText(/Die Cloudflare-Verbindung ist nicht eingerichtet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cloudflare-Konto, Ziel 1"), "acc");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ accountId: "acc" })]);
    await user.type(screen.getByLabelText("Worker-Name, Ziel 1"), "w");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ accountId: "acc", script: "w" })]);
  });

  it("presets the integration default account, suggests deployed Workers and lets the user pick another account", async () => {
    const portal = fakePortal({
      [OPTIONS]: resources({ defaults: { accountId: ACCOUNT_A }, account: okState([{ value: ACCOUNT_A, label: "Acme", detail: ACCOUNT_A }, { value: ACCOUNT_B, label: "Other", detail: "second" }]) }),
      [`GET connections/cloudflare/resources?kind=cloudflare.workerScript&param.accountId=${ACCOUNT_A}`]: resources({ script: okState([{ value: "api-worker", label: "api-worker" }]) }),
      "GET connections/cloudflare/resources?kind=cloudflare.workerScript*": resources({ script: okState([]) }),
    });
    const spy = vi.fn();
    const { user, container } = renderApp(<Harness initial={[workerRow()]} spy={spy} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith([expect.objectContaining({ accountId: ACCOUNT_A })]));
    await waitFor(() => expect(container.querySelector("datalist option[value='api-worker']")).not.toBeNull());
    await pickOption(user, "Cloudflare-Konto, Ziel 1", "Other · second");
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ accountId: ACCOUNT_B })]);
    await waitFor(() => expect(portal.callsTo("GET", `connections/cloudflare/resources?kind=cloudflare.workerScript&param.accountId=${ACCOUNT_B}`)).toHaveLength(1));
  });

  it("takes the only account the token sees and lists an unknown stored account first", async () => {
    fakePortal({
      [OPTIONS]: resources({ account: okState([{ value: ACCOUNT_A, label: "Only" }]) }),
      "GET connections/cloudflare/resources?kind=cloudflare.workerScript*": resources({ script: okState([]) }),
    });
    const spy = vi.fn();
    const { unmount } = renderApp(<Harness initial={[workerRow()]} spy={spy} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith([expect.objectContaining({ accountId: ACCOUNT_A })]));
    unmount();

    renderApp(<Harness initial={[workerRow({ accountId: ACCOUNT_B })]} />);
    expect(await screen.findByRole("combobox", { name: "Cloudflare-Konto, Ziel 1" })).toHaveTextContent(ACCOUNT_B);
  });

  it("shows the placeholder option while no account is chosen and several exist", async () => {
    fakePortal({ [OPTIONS]: resources({ account: okState([{ value: ACCOUNT_A, label: "A" }, { value: ACCOUNT_B, label: "B" }]) }) });
    const { user } = renderApp(<Harness initial={[workerRow()]} />);
    const combo = await screen.findByRole("combobox", { name: "Cloudflare-Konto, Ziel 1" });
    expect(combo).toHaveTextContent("Cloudflare-Konto");
    await user.click(combo);
    expect(within(await screen.findByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  });
});
