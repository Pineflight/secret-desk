import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizationPlan } from "@secret-desk/core";
import type { ParamSuggestion, SecretView } from "@secret-desk/runtime";
import { CompleteParamsDialog } from "@/components/CompleteParamsDialog";
import { NormalizeDialog } from "@/components/NormalizeDialog";
import { api } from "@/lib/api";
import { renderApp } from "./helpers/render";

// The portal client only ever throws Error objects; these tests drive the defensive `String(e)` fallback of the dialogs.
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: vi.fn() }));
const apiMock = vi.mocked(api);

describe("dialogs with a non-Error rejection", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("CompleteParamsDialog shows a rejected string as the row error", async () => {
    const row: ParamSuggestion = { secretId: "s1", provider: "acme", stage: "dev", missing: ["account"], suggestions: { account: { value: "a1", label: "A", reason: "r" } }, status: "suggested" };
    apiMock.mockImplementation((method: string) => (method === "POST" ? Promise.resolve({ suggestions: [row] }) : Promise.reject({ toString: () => "plain-string-failure" })) as Promise<never>);
    const { user } = renderApp(<CompleteParamsDialog secrets={[{ id: "s1", name: "S1", title: null } as SecretView]} onClose={() => {}} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("plain-string-failure");
  });

  it("NormalizeDialog toasts a rejected string", async () => {
    const plan: NormalizationPlan = { changes: [{ id: "c1", kind: "rename", entryKind: "secret", entryIds: ["s1"], before: [{ id: "s1", entryKind: "secret", name: "OLD", stage: "dev" }], after: [{ id: "s1", entryKind: "secret", name: "NEW", stage: "dev" }], reasons: [], needsWorkflowChange: false, conflicts: [], autoApplicable: true, missingParams: [] }] };
    apiMock.mockImplementation((method: string) => (method === "GET" ? Promise.resolve(plan) : Promise.reject({ toString: () => "plain-string-failure" })) as Promise<never>);
    const { user } = renderApp(<NormalizeDialog onClose={() => {}} onChanged={() => {}} onCompleteParams={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Alle eindeutigen übernehmen (1)" }));
    expect(await screen.findByText("plain-string-failure")).toBeInTheDocument();
  });
});
