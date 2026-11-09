import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StageView } from "@secret-desk/runtime";
import { StageDialog } from "@/components/settings/StageDialog";
import { StagesPanel } from "@/components/settings/StagesPanel";
import { emptyUsage, newDraft, type StageDraft } from "@/lib/stage-draft";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { drainRequestsAfterEach } from "./helpers/drain";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

drainRequestsAfterEach();

const usage = (over: Partial<StageView["usage"]> = {}): StageView["usage"] => ({ secrets: 0, variables: 0, templates: 0, policy: false, ...over });
const stage = (over: Partial<StageView> & { id: string; kind: StageView["kind"] }): StageView => ({ environmentName: null, usage: usage(), ...over }) as StageView;
const STAGES: StageView[] = [
  stage({ id: "dev", kind: "dev" }),
  stage({ id: "staging", kind: "test", label: "Vorabtest", tone: "info", environment: "stg-env", environmentName: "stg-env", usage: usage({ secrets: 3, variables: 1, templates: 2 }) }),
  stage({ id: "production", kind: "live", environmentName: "production", usage: usage({ secrets: 1, policy: true }) }),
];
const PUT = "PUT stages";
const panel = (stages = STAGES) => <StagesPanel stages={stages} />;
const putOk = (list: StageView[] = STAGES): FakeHandler => () => list;
const rowOf = (id: string) => screen.getByText(id, { selector: "p" }).closest("[role=row]") as HTMLElement;

describe("StagesPanel list", () => {
  it("lists every stage with kind, environment and usage", () => {
    fakePortal({});
    renderApp(panel());
    const table = screen.getByRole("table", { name: "Stages" });
    expect(table).toBeInTheDocument();
    const staging = rowOf("staging");
    expect(staging).toHaveTextContent("Vorabtest");
    expect(staging).toHaveTextContent("Test (Sandbox)");
    expect(staging).toHaveTextContent("stg-env");
    expect(staging).toHaveTextContent("3 Secrets, 1 Variable, 2 Vorlagen");
    expect(rowOf("dev")).toHaveTextContent("keine");
    expect(rowOf("dev")).toHaveTextContent("Unbenutzt");
    expect(rowOf("production")).toHaveTextContent("1 Secret · In der Agenten-Richtlinie");
  });

  it("disables moving the first stage up and the last one down", () => {
    fakePortal({});
    renderApp(panel());
    expect(screen.getByRole("button", { name: "Stage dev nach oben" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage dev nach unten" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stage production nach unten" })).toBeDisabled();
  });

  it("opens and closes the explanation of the kinds", async () => {
    fakePortal({});
    const { user } = renderApp(panel());
    const toggle = screen.getByRole("button", { name: "So funktionieren Stages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Sandbox oder Testzugang/)).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(/Sandbox oder Testzugang/)).toBeNull();
  });

  it("disables adding at the maximum and explains why", () => {
    fakePortal({});
    const many = Array.from({ length: 12 }, (_, i) => stage({ id: `s${i}`, kind: "test" }));
    renderApp(panel(many));
    const add = screen.getByRole("button", { name: "Stage hinzufügen" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Höchstens 12 Stages sind möglich.");
  });
});

describe("StagesPanel order and saving", () => {
  it("saves the new order immediately and reports it", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage staging nach oben" }));
    expect(await screen.findByText("Stages gespeichert.")).toBeInTheDocument();
    expect((portal.callsTo("PUT", "stages")[0]?.body as { stages: { id: string }[] }).stages.map((s) => s.id)).toEqual(["staging", "dev", "production"]);
  });

  it("moves a stage down", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage dev nach unten" }));
    await screen.findByText("Stages gespeichert.");
    expect((portal.callsTo("PUT", "stages")[0]?.body as { stages: { id: string }[] }).stages.map((s) => s.id)).toEqual(["staging", "dev", "production"]);
  });

  it("sends label, environment and tone of every stage", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel([...STAGES, stage({ id: "shared", kind: "shared", environment: null as never })]));
    await user.click(screen.getByRole("button", { name: "Stage dev nach unten" }));
    await screen.findByText("Stages gespeichert.");
    const sent = (portal.callsTo("PUT", "stages")[0]?.body as { stages: Record<string, unknown>[] }).stages;
    expect(sent.find((s) => s["id"] === "staging")).toEqual({ id: "staging", kind: "test", label: "Vorabtest", environment: "stg-env", tone: "info" });
    expect(sent.find((s) => s["id"] === "shared")).toEqual({ id: "shared", kind: "shared", environment: null });
  });

  it("shows the server error of a failed move below the list", async () => {
    fakePortal({ [PUT]: { status: 400, body: { error: "Stage wird genutzt" } } });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage dev nach unten" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stage wird genutzt");
    expect(screen.queryByText("Stages gespeichert.")).toBeNull();
  });
});

describe("StagesPanel add and edit", () => {
  it("adds a stage with a suggested id and appends it to the list", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage hinzufügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Stage hinzufügen" });
    await user.type(within(dialog).getByLabelText("Anzeigename"), "Pre Prod");
    expect(within(dialog).getByLabelText(/^Id/)).toHaveValue("pre-prod");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = (portal.callsTo("PUT", "stages")[0]?.body as { stages: Record<string, unknown>[] }).stages;
    expect(sent.at(-1)).toEqual({ id: "pre-prod", kind: "test", label: "Pre Prod" });
  });

  it("edits an existing stage and keeps its id fixed", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage staging bearbeiten" }));
    const dialog = await screen.findByRole("dialog", { name: "Stage staging bearbeiten" });
    expect(within(dialog).getByLabelText(/^Id/)).toHaveAttribute("readonly");
    await user.clear(within(dialog).getByLabelText("Anzeigename"));
    await user.type(within(dialog).getByLabelText("Anzeigename"), "Abnahme");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = (portal.callsTo("PUT", "stages")[0]?.body as { stages: Record<string, unknown>[] }).stages;
    expect(sent.find((s) => s["id"] === "staging")).toMatchObject({ label: "Abnahme" });
  });

  it("keeps the dialog open and shows the server error of a failed save, and clears it on the next open", async () => {
    fakePortal({ [PUT]: { status: 500, body: { error: "disk full" } } });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage staging bearbeiten" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    await user.click(screen.getByRole("button", { name: "Stage dev bearbeiten" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("StagesPanel list validation", () => {
  it("does not send an over-long list and explains the maximum", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const many = Array.from({ length: 13 }, (_, i) => stage({ id: `s${i}`, kind: "test" }));
    const { user } = renderApp(panel(many));
    await user.click(screen.getByRole("button", { name: "Stage s0 nach unten" }));
    expect(await screen.findByText("Höchstens 12 Stages.")).toBeInTheDocument();
    expect(portal.callsTo("PUT", "stages")).toHaveLength(0);
  });

  it("does not send a list with an invalid id", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel([stage({ id: "Bad Id", kind: "test" }), stage({ id: "ok", kind: "dev" })]));
    await user.click(screen.getByRole("button", { name: "Stage Bad Id nach unten" }));
    expect(await screen.findByText(/Die Id braucht Kleinbuchstaben/)).toBeInTheDocument();
    expect(portal.callsTo("PUT", "stages")).toHaveLength(0);
  });

  it("does not send an empty list", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel([stage({ id: "only", kind: "test" })]));
    await user.click(screen.getByRole("button", { name: "Stage only entfernen" }));
    await user.click(await screen.findByRole("button", { name: "Entfernen" }));
    expect(await screen.findByText("Mindestens eine Stage ist nötig.")).toBeInTheDocument();
    expect(portal.callsTo("PUT", "stages")).toHaveLength(0);
  });

  it("clears an earlier list problem after a successful save", async () => {
    fakePortal({ [PUT]: putOk() });
    const { user, rerender } = renderApp(panel([stage({ id: "only", kind: "test" })]));
    await user.click(screen.getByRole("button", { name: "Stage only entfernen" }));
    await user.click(await screen.findByRole("button", { name: "Entfernen" }));
    await screen.findByText("Mindestens eine Stage ist nötig.");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    rerender(panel([stage({ id: "a", kind: "test" }), stage({ id: "b", kind: "dev" })]));
    await user.click(screen.getByRole("button", { name: "Stage a nach unten" }));
    await waitFor(() => expect(screen.queryByText("Mindestens eine Stage ist nötig.")).toBeNull());
  });
});

describe("StagesPanel remove", () => {
  it("removes an unused stage after confirmation", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage dev entfernen" }));
    const dialog = await screen.findByRole("dialog", { name: "Stage dev entfernen?" });
    expect(within(dialog).getByText("Die Definition wird aus dem Inventar entfernt. In GitHub wird nichts gelöscht.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    expect(await screen.findByText("Stage dev entfernt.")).toBeInTheDocument();
    expect((portal.callsTo("PUT", "stages")[0]?.body as { stages: { id: string }[] }).stages.map((s) => s.id)).toEqual(["staging", "production"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("blocks removing a stage that is still used", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage staging entfernen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Stage staging wird noch genutzt (3 Secrets, 1 Variable, 2 Vorlagen) und kann nicht entfernt werden.");
    expect(within(dialog).getByRole("button", { name: "Entfernen" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(portal.callsTo("PUT", "stages")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the removal dialog with Escape without saving", async () => {
    const portal = fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage dev entfernen" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(portal.callsTo("PUT", "stages")).toHaveLength(0);
  });

  it("drops the removal dialog when the list shrinks underneath it", async () => {
    fakePortal({ [PUT]: putOk() });
    const { user, rerender } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage production entfernen" }));
    await screen.findByRole("dialog");
    rerender(panel(STAGES.slice(0, 2)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks removing a stage of the agent policy", async () => {
    fakePortal({ [PUT]: putOk() });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage production entfernen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("steht in der Agenten-Richtlinie (policy.agentStages)");
    expect(within(dialog).getByRole("button", { name: "Entfernen" })).toBeDisabled();
  });

  it("explains a used stage without the policy note even when the policy also names it", async () => {
    fakePortal({ [PUT]: putOk() });
    renderApp(panel());
    expect(rowOf("production")).toHaveTextContent("In der Agenten-Richtlinie");
  });

  it("shows the server error of a failed removal inside the dialog and keeps it open", async () => {
    fakePortal({ [PUT]: { status: 409, body: { error: "still referenced" } } });
    const { user } = renderApp(panel());
    await user.click(screen.getByRole("button", { name: "Stage dev entfernen" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("still referenced");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("StageDialog", () => {
  const draft = (over: Partial<StageDraft> = {}): StageDraft => ({ ...newDraft(), ...over });
  const dialog = (props: Partial<Parameters<typeof StageDialog>[0]> = {}) => <StageDialog initial={draft()} others={[]} pending={false} error={null} onSave={() => {}} onClose={() => {}} {...props} />;

  it("shows a preview badge with the typed name and falls back to an ellipsis", async () => {
    fakePortal({});
    const { user } = renderApp(dialog());
    expect(screen.getByText("Vorschau").parentElement).toHaveTextContent("…");
    await user.type(screen.getByLabelText("Anzeigename"), "Abnahme");
    expect(screen.getByText("Vorschau").parentElement).toHaveTextContent("Abnahme");
  });

  it("does not overwrite an id the person typed themselves while the label changes", async () => {
    fakePortal({});
    const { user } = renderApp(dialog());
    await user.type(screen.getByLabelText(/^Id/), "mine");
    await user.type(screen.getByLabelText("Anzeigename"), "Other Name");
    expect(screen.getByLabelText(/^Id/)).toHaveValue("mine");
  });

  it("lowercases the typed id", async () => {
    fakePortal({});
    const { user } = renderApp(dialog());
    await user.type(screen.getByLabelText(/^Id/), "ABC");
    expect(screen.getByLabelText(/^Id/)).toHaveValue("abc");
  });

  it("does not suggest an id for an existing stage", async () => {
    fakePortal({});
    const { user } = renderApp(dialog({ initial: draft({ id: "fixed", isNew: false, label: "Old" }) }));
    await user.type(screen.getByLabelText("Anzeigename"), "x");
    expect(screen.getByLabelText(/^Id/)).toHaveValue("fixed");
    expect(screen.getByRole("dialog", { name: "Stage fixed bearbeiten" })).toBeInTheDocument();
  });

  it("changes kind and tone and shows the default environment name for the kind", async () => {
    fakePortal({});
    const onSave = vi.fn();
    const { user } = renderApp(dialog({ onSave, initial: draft({ id: "qa" }) }));
    expect(screen.getByLabelText("GitHub-Environment")).toHaveAttribute("placeholder", "qa");
    expect(screen.getByText("Leer: qa. Dieser Name wird bei Bereich „Umgebung“ eingesetzt.")).toBeInTheDocument();
    await pickOption(user, "Art", "Lokal (dev)");
    expect(screen.getByLabelText("GitHub-Environment")).toHaveAttribute("placeholder", "");
    expect(screen.getByText("Leer: keine. Dieser Name wird bei Bereich „Umgebung“ eingesetzt.")).toBeInTheDocument();
    await pickOption(user, "Farbe", "Violett");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "qa", kind: "dev", tone: "ki" }));
  });

  it("turns the environment off and clears the typed name, then on again", async () => {
    fakePortal({});
    const { user } = renderApp(dialog({ initial: draft({ id: "qa", environment: "typed" }) }));
    const env = screen.getByLabelText("GitHub-Environment");
    expect(env).toHaveValue("typed");
    await user.click(screen.getByLabelText("Keine Environment"));
    expect(env).toBeDisabled();
    expect(env).toHaveValue("");
    await user.click(screen.getByLabelText("Keine Environment"));
    expect(env).toBeEnabled();
    await user.type(env, "again");
    expect(env).toHaveValue("again");
  });

  it("rejects an invalid id and a duplicate and removes the message on the next edit", async () => {
    fakePortal({});
    const onSave = vi.fn();
    const { user } = renderApp(dialog({ onSave, others: [{ ...emptyDraft("taken") }] }));
    await user.type(screen.getByLabelText(/^Id/), "-bad");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(screen.getByText(/Die Id braucht Kleinbuchstaben/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Id/));
    expect(screen.queryByText(/Die Id braucht Kleinbuchstaben/)).toBeNull();
    await user.type(screen.getByLabelText(/^Id/), "taken");
    expect(screen.queryByText(/Die Id braucht Kleinbuchstaben/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(screen.getByText("Die Id taken gehört schon zu einer anderen Stage.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the server error and the busy state", () => {
    fakePortal({});
    renderApp(dialog({ error: new Error("rejected by server"), pending: true }));
    expect(screen.getByRole("alert")).toHaveTextContent("rejected by server");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("closes through the cancel button", async () => {
    fakePortal({});
    const onClose = vi.fn();
    const { user } = renderApp(dialog({ onClose }));
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function emptyDraft(id: string): StageDraft {
  return { ...newDraft(), id, isNew: false, usage: emptyUsage() };
}
