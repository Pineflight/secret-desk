import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NormalizationChange, NormalizationEntryState } from "@secret-desk/core";
import { NORMALIZE_KINDS, NameHint, NormalizeDialog, countApplicable } from "@/components/NormalizeDialog";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const state = (id: string, name: string, over: Partial<NormalizationEntryState> = {}): NormalizationEntryState => ({ id, entryKind: "secret", name, stage: "dev", ...over });

const change = (over: Partial<NormalizationChange> & Pick<NormalizationChange, "id" | "kind">): NormalizationChange => ({
  entryKind: "secret",
  entryIds: ["e1"],
  before: [state("e1", "OLD_NAME")],
  after: [state("e1", "NEW_NAME")],
  reasons: [{ code: "r", text: "Reason text" }],
  needsWorkflowChange: false,
  conflicts: [],
  autoApplicable: true,
  missingParams: [],
  ...over,
});

const plan = {
  changes: [
    change({ id: "rename:1", kind: "rename", needsWorkflowChange: true, entryIds: ["e1"] }),
    change({ id: "provider:1", kind: "provider", entryIds: ["e2"], before: [state("e2", "CF_TOKEN", { provider: "manual" })], after: [state("e2", "CF_TOKEN", { provider: "cloudflare" })], missingParams: ["accountId", "zoneId"] }),
    change({ id: "stage:1", kind: "stage", entryIds: ["e3"], before: [state("e3", "STAGE_ENTRY", { stage: "dev" })], after: [state("e3", "STAGE_ENTRY", { stage: "production" })] }),
    change({ id: "source:1", kind: "source", entryKind: "variable", entryIds: ["e4"], before: [state("e4", "VAR_ONE", { entryKind: "variable" })], after: [state("e4", "VAR_ONE", { entryKind: "variable", source: { connection: "supabase", kind: "supabase.project", field: "url", resource: null } })], autoApplicable: false }),
    change({ id: "source:2", kind: "source", entryKind: "variable", entryIds: ["e5"], before: [state("e5", "VAR_TWO", { entryKind: "variable" })], after: [state("e5", "VAR_TWO", { entryKind: "variable", source: { connection: "supabase", kind: "supabase.project", field: "url", resource: "ref1" } })] }),
    change({ id: "source:3", kind: "source", entryIds: ["e6"], before: [state("e6", "VAR_THREE")], after: [state("e6", "VAR_THREE")] }),
    change({ id: "merge:1", kind: "merge", entryIds: ["m1", "m2"], before: [state("m1", "DUP"), state("m2", "DUP")], after: [], autoApplicable: false, conflicts: ["m2"] }),
    change({ id: "manual:1", kind: "manual-only", entryIds: ["x1"], before: [state("x1", "HAND")], after: [], autoApplicable: false, reasons: [] }),
    change({ id: "rename:2", kind: "rename", entryIds: ["e7"], before: [state("e7", "OLD2")], after: [] }),
  ],
};

describe("normalize helpers", () => {
  it("counts the changes that can be applied automatically and keeps a stable kind order", () => {
    expect(countApplicable(plan.changes)).toBe(6);
    expect(countApplicable([])).toBe(0);
    expect(NORMALIZE_KINDS[0]).toBe("rename");
  });
});

describe("NameHint", () => {
  it("proposes the new name for an entry that has a rename change", async () => {
    fakePortal({ "GET normalization": plan });
    renderApp(<NameHint entryId="e1" />);
    expect(await screen.findByText("Namensvorschlag: NEW_NAME")).toBeInTheDocument();
  });

  it("renders nothing for an entry without a rename and while loading", async () => {
    const portal = fakePortal({ "GET normalization": plan });
    const { container } = renderApp(<NameHint entryId="e2" />);
    await waitFor(() => expect(portal.callsTo("GET", "normalization")).toHaveLength(1));
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("NormalizeDialog", () => {
  it("shows a skeleton while loading, then the empty state, and closes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ "GET normalization": async () => { await gate; return { changes: [] }; } });
    const onClose = vi.fn();
    const { user } = renderApp(<NormalizeDialog onClose={onClose} onChanged={() => {}} onCompleteParams={() => {}} />);
    expect(screen.queryByText("Alle Namen sind einheitlich, nichts zu tun.")).toBeNull();
    release();
    expect(await screen.findByText("Alle Namen sind einheitlich, nichts zu tun.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle eindeutigen übernehmen (0)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ausgewählte übernehmen (0)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a load error with retry", async () => {
    let fail = true;
    fakePortal({ "GET normalization": () => (fail ? { status: 500, body: { error: "plan failed" } } : { changes: [] }) });
    const { user } = renderApp(<NormalizeDialog onClose={() => {}} onChanged={() => {}} onCompleteParams={() => {}} />);
    expect(await screen.findByText("plan failed")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Alle Namen sind einheitlich, nichts zu tun.")).toBeInTheDocument();
  });

  it("groups the changes by kind and describes each one", async () => {
    fakePortal({ "GET normalization": plan });
    renderApp(<NormalizeDialog onClose={() => {}} onChanged={() => {}} onCompleteParams={() => {}} />);
    for (const heading of ["Umbenennen (2)", "Automatisch erzeugen (1)", "Stage (1)", "Automatisch beziehen (3)", "Zusammenführen (1)", "Bleibt von Hand (1)"]) {
      expect(await screen.findByText(heading)).toBeInTheDocument();
    }
    expect(screen.getByText("Umbenannte Namen brauchen angepasste Workflows")).toBeInTheDocument();
    expect(screen.getByText("OLD_NAME")).toBeInTheDocument();
    expect(screen.getByText("NEW_NAME")).toBeInTheDocument();
    expect(screen.getByText("Workflow anpassen")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("cloudflare")).toBeInTheDocument();
    expect(screen.getByText("Parameter fehlen: accountId, zoneId")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getAllByText("Quelle: Supabase-Projekte · url")).toHaveLength(2);
    expect(screen.getAllByText("Ressource wählen")).toHaveLength(1);
    expect(screen.getByText("Nach dem Umbenennen wären die Einträge gleich benannt. Einen von beiden von Hand löschen oder umbenennen.")).toBeInTheDocument();
    expect(screen.getByText("Der Wert wird von Hand eingefügt.")).toBeInTheDocument();
    expect(screen.getByText("(m2)")).toBeInTheDocument();
    expect(screen.getByText("(e7)")).toBeInTheDocument();
    expect(screen.getAllByText("Reason text").length).toBeGreaterThan(0);
    // Manual-only entries carry no "not automatic" badge; merge and unresolved sources do.
    expect(screen.getAllByText("Nicht automatisch")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(countApplicable(plan.changes));
  });

  it("renders a provider change whose entries carry no provider yet", async () => {
    fakePortal({ "GET normalization": { changes: [change({ id: "provider:x", kind: "provider", before: [state("e9", "NO_PROVIDER")], after: [state("e9", "NO_PROVIDER")] })] } });
    renderApp(<NormalizeDialog onClose={() => {}} onChanged={() => {}} onCompleteParams={() => {}} />);
    expect(await screen.findByText("Automatisch erzeugen (1)")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "NO_PROVIDER" })).toBeInTheDocument();
  });

  it("applies the selected changes, announces them and offers the parameter follow-up", async () => {
    let result: { applied: string[]; needsParams: { secretId: string; missing: string[] }[] } = { applied: ["rename:1", "stage:1"], needsParams: [{ secretId: "e2", missing: ["accountId"] }] };
    const portal = fakePortal({ "GET normalization": plan, "POST normalization/apply": () => result });
    const onChanged = vi.fn();
    const onCompleteParams = vi.fn();
    const { user } = renderApp(<NormalizeDialog onClose={() => {}} onChanged={onChanged} onCompleteParams={onCompleteParams} />);
    await user.click(await screen.findByRole("checkbox", { name: "OLD_NAME" }));
    await user.click(screen.getByRole("checkbox", { name: "STAGE_ENTRY" }));
    await user.click(screen.getByRole("checkbox", { name: "STAGE_ENTRY" }));
    await user.click(screen.getByRole("checkbox", { name: "STAGE_ENTRY" }));
    await user.click(screen.getByRole("button", { name: "Ausgewählte übernehmen (2)" }));
    expect(await screen.findByText("2 Änderungen am Inventar übernommen.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "normalization/apply")[0]?.body).toEqual({ changeIds: ["rename:1", "stage:1"] });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(portal.callsTo("GET", "normalization").length).toBeGreaterThan(1));
    expect(screen.getByRole("button", { name: "Ausgewählte übernehmen (0)" })).toBeDisabled();
    expect(screen.getByText("Für 1 Einträge fehlen nach dem Wechsel noch Parameter, zum Beispiel das Supabase-Projekt.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jetzt Parameter vervollständigen" }));
    expect(onCompleteParams).toHaveBeenCalled();
    result = { applied: [], needsParams: [] };
  });

  it("applies everything that is unambiguous and shows no follow-up without needed parameters", async () => {
    const portal = fakePortal({ "GET normalization": plan, "POST normalization/apply": { applied: ["a"], needsParams: [] } });
    const { user } = renderApp(<NormalizeDialog onClose={() => {}} onChanged={() => {}} onCompleteParams={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Alle eindeutigen übernehmen (6)" }));
    await screen.findByText("1 Änderungen am Inventar übernommen.");
    expect(portal.callsTo("POST", "normalization/apply")[0]?.body).toEqual({ changeIds: ["rename:1", "provider:1", "stage:1", "source:2", "source:3", "rename:2"] });
    expect(screen.queryByText("Als Nächstes")).toBeNull();
  });

  it("toasts the server error of a failed apply and keeps the selection", async () => {
    fakePortal({ "GET normalization": plan, "POST normalization/apply": { status: 409, body: { error: "name collision" } } });
    const onChanged = vi.fn();
    const { user } = renderApp(<NormalizeDialog onClose={() => {}} onChanged={onChanged} onCompleteParams={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: "OLD_NAME" }));
    await user.click(screen.getByRole("button", { name: "Ausgewählte übernehmen (1)" }));
    expect(await screen.findByText("name collision")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ausgewählte übernehmen (1)" })).toBeEnabled();
  });
});
