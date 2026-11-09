import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionResources } from "@secret-desk/runtime";
import { RememberMapping, ResourceMapPanel } from "@/components/ResourceMap";
import { invalidateRepoList } from "@/lib/repo-list";
import { fakePortal } from "./helpers/portal";
import { okState } from "./helpers/params";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

const ACCOUNT = "cloudflare.account";
const ZONE = "cloudflare.zone";
const MAP = "resource-map";

const data = (resources: Record<string, unknown>): ConnectionResources => ({ connection: "cloudflare", connected: true, defaultSpecs: [], defaults: {}, resources } as unknown as ConnectionResources);
const accounts = okState([{ value: "a1", label: "Acme", detail: "first" }, { value: "a2", label: "Beta" }]);
const zones = okState([{ value: "z1", label: "acme.test" }]);
const stages = [{ id: "dev", kind: "dev", label: "Entwicklung" }, { id: "production", kind: "live" }];
const emptyList = { owner: "acme", github: "off", repos: [] };

beforeEach(() => {
  invalidateRepoList();
});

const base = (over: Record<string, unknown> = {}) => ({ "GET stages": stages, "GET repos?live=1": emptyList, ...over });

describe("ResourceMapPanel", () => {
  it("renders nothing while the map loads or when no kind of this integration can be mapped", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: ["other.kind"] } }));
    const { container } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(screen.queryByText("Zuordnung Repository → Ressource")).toBeNull();
  });

  it("lists entries with stage, resource name, unknown markers and a custom kind", async () => {
    fakePortal(
      base({
        [`GET ${MAP}`]: {
          kinds: [ACCOUNT, ZONE, "custom.thing"],
          entries: [
            { kind: ACCOUNT, repo: "web", value: "a1", label: "old label" },
            { kind: ACCOUNT, repo: "web", stage: "dev", value: "gone", label: "Removed one" },
            { kind: ZONE, repo: "api", stage: "unlabelled", value: "z-missing" },
            { kind: "custom.thing", repo: "api", value: "c1" },
            { kind: "other.kind", repo: "hidden", value: "x" },
          ],
        },
      }),
    );
    const broken = { status: "error", options: [], suggested: null };
    renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts, [ZONE]: zones, "custom.thing": broken })} />);
    expect(await screen.findByRole("heading", { name: "Zuordnung Repository → Ressource" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]!).toHaveTextContent("Acme · first");
    expect(rows[0]!).toHaveTextContent("Alle Stages");
    expect(rows[1]!).toHaveTextContent("Entwicklung");
    expect(rows[1]!).toHaveTextContent("Removed one");
    expect(rows[1]!).toHaveTextContent("Beim Anbieter nicht gefunden");
    expect(rows[2]!).toHaveTextContent("Cloudflare-Zonen");
    expect(rows[2]!).toHaveTextContent("unlabelled");
    expect(rows[2]!).toHaveTextContent("z-missing");
    expect(rows[2]!).toHaveTextContent("Beim Anbieter nicht gefunden");
    expect(rows[3]!).toHaveTextContent("custom.thing");
    expect(rows[3]!).toHaveTextContent("Alle Stages");
    expect(rows[3]!).not.toHaveTextContent("Beim Anbieter nicht gefunden");
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("shows the empty hint and keeps the add button disabled until repository and resource are set", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] } }));
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    expect(await screen.findByText("Noch keine Zuordnung.")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Zuordnung hinzufügen" });
    expect(add).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: "Art" })).toBeNull();
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "web");
    expect(add).toBeDisabled();
    await pickOption(user, "Ressource", /Acme/);
    expect(add).toBeEnabled();
  });

  it("saves a mapping with stage, reloads the map and clears the resource", async () => {
    let entries: unknown[] = [];
    const portal = fakePortal(
      base({
        [`GET ${MAP}`]: () => ({ entries, kinds: [ACCOUNT] }),
        [`PUT ${MAP}`]: (call) => {
          entries = [{ ...(call.body as object) }];
          return {};
        },
      }),
    );
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    await screen.findByText("Noch keine Zuordnung.");
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "  web  ");
    await pickOption(user, "Stage (optional)", "Entwicklung");
    await pickOption(user, "Ressource", /Beta/);
    await user.click(screen.getByRole("button", { name: "Zuordnung hinzufügen" }));
    expect(await screen.findByText("Zuordnung gespeichert.")).toBeInTheDocument();
    expect(portal.callsTo("PUT", MAP)[0]?.body).toEqual({ kind: ACCOUNT, repo: "web", stage: "dev", value: "a2", label: "Beta" });
    expect(await screen.findByRole("button", { name: "Zuordnung für web entfernen" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Zuordnung hinzufügen" })).toBeDisabled());
  });

  it("saves without a stage and shows a failed save", async () => {
    let fail = true;
    const portal = fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] }, [`PUT ${MAP}`]: () => (fail ? { status: 400, body: { error: "Unbekannte Stage" } } : {}) }));
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    await screen.findByText("Noch keine Zuordnung.");
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "web");
    await pickOption(user, "Ressource", /Acme/);
    await user.click(screen.getByRole("button", { name: "Zuordnung hinzufügen" }));
    expect(await screen.findByText("Unbekannte Stage")).toBeInTheDocument();
    expect(screen.queryByText("Zuordnung gespeichert.")).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Zuordnung hinzufügen" }));
    await waitFor(() => expect(portal.callsTo("PUT", MAP)).toHaveLength(2));
    expect(portal.callsTo("PUT", MAP)[1]?.body).toEqual({ kind: ACCOUNT, repo: "web", value: "a1", label: "Acme" });
  });

  it("does nothing when the chosen resource vanished from the list", async () => {
    const portal = fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] } }));
    const { user, rerender } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    await screen.findByText("Noch keine Zuordnung.");
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "web");
    await pickOption(user, "Ressource", /Acme/);
    rerender(<ResourceMapPanel data={data({ [ACCOUNT]: okState([{ value: "a2", label: "Beta" }]) })} />);
    await user.click(screen.getByRole("button", { name: "Zuordnung hinzufügen" }));
    expect(portal.callsTo("PUT", MAP)).toHaveLength(0);
  });

  it("removes an entry with and without a stage and reports a failure", async () => {
    let entries: Record<string, unknown>[] = [
      { kind: ACCOUNT, repo: "web", value: "a1" },
      { kind: ACCOUNT, repo: "web", stage: "dev", value: "a2" },
    ];
    let failNext = true;
    const portal = fakePortal(
      base({
        [`GET ${MAP}`]: () => ({ entries, kinds: [ACCOUNT] }),
        [`DELETE ${MAP}`]: (call) => {
          if (failNext) {
            failNext = false;
            return { status: 500, body: { error: "disk full" } };
          }
          const b = call.body as { stage?: string };
          entries = entries.filter((e) => e["stage"] !== b.stage);
          return {};
        },
      }),
    );
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    const remove = await screen.findAllByRole("button", { name: "Zuordnung für web entfernen" });
    await user.click(remove[0]!);
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Zuordnung für web entfernen" })[0]!);
    expect(await screen.findByText("Zuordnung entfernt.")).toBeInTheDocument();
    expect(portal.callsTo("DELETE", MAP)[1]?.body).toEqual({ kind: ACCOUNT, repo: "web" });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Zuordnung für web entfernen" })).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Zuordnung für web entfernen" }));
    await waitFor(() => expect(portal.callsTo("DELETE", MAP)).toHaveLength(3));
    expect(portal.callsTo("DELETE", MAP)[2]?.body).toEqual({ kind: ACCOUNT, repo: "web", stage: "dev" });
  });

  it("offers a kind switch for several kinds and resets the chosen resource", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT, ZONE] } }));
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts, [ZONE]: zones })} />);
    await screen.findByText("Noch keine Zuordnung.");
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "web");
    await pickOption(user, "Ressource", /Acme/);
    expect(screen.getByRole("button", { name: "Zuordnung hinzufügen" })).toBeEnabled();
    await pickOption(user, "Art", "Cloudflare-Zonen");
    expect(screen.getByRole("button", { name: "Zuordnung hinzufügen" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Ressource" }));
    expect(await screen.findByRole("option", { name: "acme.test" })).toBeInTheDocument();
  });

  it("shows a warning when the map cannot be reloaded after a change", async () => {
    let reloads = 0;
    fakePortal(
      base({
        [`GET ${MAP}`]: () => (reloads++ === 0 ? { entries: [], kinds: [ACCOUNT] } : { status: 500, body: { error: "store offline" } }),
        [`PUT ${MAP}`]: {},
      }),
    );
    const { user } = renderApp(<ResourceMapPanel data={data({ [ACCOUNT]: accounts })} />);
    await screen.findByText("Noch keine Zuordnung.");
    await user.type(screen.getByRole("combobox", { name: "Repository" }), "web");
    await pickOption(user, "Ressource", /Acme/);
    await user.click(screen.getByRole("button", { name: "Zuordnung hinzufügen" }));
    expect(await screen.findByText("Die Zuordnung ließ sich nicht laden: store offline")).toBeInTheDocument();
  });
});

describe("RememberMapping", () => {
  const props = { kind: ACCOUNT, repo: "web", value: "a1", label: "Acme" };

  it("renders nothing while the map loads, for an unmappable kind or without a repository", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] } }));
    const { rerender } = renderApp(<RememberMapping {...props} />);
    expect(screen.queryByRole("button")).toBeNull();
    await screen.findByRole("button", { name: "Für web merken" });
    rerender(<RememberMapping {...props} kind="other.kind" />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<RememberMapping {...props} repo="" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("saves the choice, reloads and calls onSaved", async () => {
    const onSaved = vi.fn();
    const portal = fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] }, [`PUT ${MAP}`]: {} }));
    const { user } = renderApp(<RememberMapping {...props} onSaved={onSaved} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Für web merken" }));
    expect(await screen.findByText("Zuordnung gespeichert.")).toBeInTheDocument();
    expect(portal.callsTo("PUT", MAP)[0]?.body).toEqual({ kind: ACCOUNT, repo: "web", value: "a1", label: "Acme" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(portal.callsTo("GET", MAP)).toHaveLength(2));
  });

  it("saves only for the stage when asked, works without onSaved and shows a failure", async () => {
    let fail = true;
    const portal = fakePortal(base({ [`GET ${MAP}`]: { entries: [], kinds: [ACCOUNT] }, [`PUT ${MAP}`]: () => (fail ? { status: 400, body: { error: "rejected" } } : {}) }));
    const { user } = renderApp(<RememberMapping {...props} stage="dev" />);
    await user.click(await screen.findByLabelText("nur für Stage dev"));
    await user.click(screen.getByRole("button", { name: "Für web merken" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Für web merken" }));
    await waitFor(() => expect(portal.callsTo("PUT", MAP)).toHaveLength(2));
    expect(portal.callsTo("PUT", MAP)[1]?.body).toEqual({ kind: ACCOUNT, repo: "web", stage: "dev", value: "a1", label: "Acme" });
  });

  it("confirms an already remembered choice", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [{ kind: ACCOUNT, repo: "web", value: "a1" }, { kind: ACCOUNT, repo: "web", stage: "dev", value: "a9" }], kinds: [ACCOUNT] } }));
    renderApp(<RememberMapping {...props} stage="dev" />);
    expect(await screen.findByText("Gemerkt für web: Diese Ressource wird künftig vorgeschlagen.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the save button when the stored value differs", async () => {
    fakePortal(base({ [`GET ${MAP}`]: { entries: [{ kind: ACCOUNT, repo: "web", value: "a9" }], kinds: [ACCOUNT] } }));
    renderApp(<RememberMapping {...props} />);
    expect(await screen.findByRole("button", { name: "Für web merken" })).toBeInTheDocument();
  });
});
