import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncLine, SyncPlan } from "@secret-desk/core";
import { SuggestSourcesDialog } from "@/components/VariableSource";
import { SyncToGitHubDialog } from "@/components/SyncToGitHubDialog";
import { api } from "@/lib/api";
import type { SuggestionRow } from "@/lib/variable-source";
import { renderApp } from "./helpers/render";

// The portal client only ever throws Error objects; these tests drive the defensive `String(e)` fallbacks of the dialogs.
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
const plainFailure = () => Promise.reject({ toString: () => "plain-string-failure" }) as Promise<never>;

const line: SyncLine = { key: "variable:v1:web", kind: "variable", entryId: "v1", name: "API_URL", repo: "acme/web", place: { repo: "acme/web", scope: "repository" }, placeLabel: "Repository", stage: "staging", production: false, action: "set", reason: "missing", defaultOn: true };
const plan: SyncPlan = { generatedAt: "2026-01-01T00:00:00Z", lines: [line], counts: { set: 1, write: 0, skip: 0, unchanged: 0 }, hasProduction: false };

describe("dialogs with a non-Error rejection (part 2)", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("SyncToGitHubDialog shows a rejected plan request as text", async () => {
    apiMock.mockImplementation(plainFailure);
    renderApp(<SyncToGitHubDialog onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText("plain-string-failure")).toBeInTheDocument();
  });

  it("SyncToGitHubDialog shows a rejected write request as text", async () => {
    apiMock.mockImplementation(((_method: string, path: string) => (path === "compare/sync-plan" ? Promise.resolve(plan) : plainFailure())) as typeof api);
    const { user } = renderApp(<SyncToGitHubDialog onClose={() => {}} onDone={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "1 Änderungen nach GitHub schreiben" }));
    expect(await screen.findByText("plain-string-failure")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("0 geschrieben, 1 fehlgeschlagen.")).toBeInTheDocument());
  });

  it("SuggestSourcesDialog shows a rejected apply as the row error", async () => {
    const row: SuggestionRow = { variableId: "v1", from: { connection: "c", kind: "k", resource: "r", field: "f" }, current: "old", proposed: "new", resourceLabel: "P", changed: true, status: "ok" };
    apiMock.mockImplementation(((method: string, path: string) => (path === "variables/suggest-all" ? Promise.resolve({ suggestions: [row] }) : plainFailure())) as typeof api);
    const { user } = renderApp(<SuggestSourcesDialog names={{}} onClose={() => {}} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("plain-string-failure")).toBeInTheDocument();
  });
});
