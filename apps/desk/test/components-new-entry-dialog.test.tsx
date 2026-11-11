import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewEntryDialog } from "@/components/NewEntryDialog";
import { renderApp } from "./helpers/render";

vi.mock("@/components/SecretForm", () => ({
  SecretForm: ({ onCreated, onClose, footerHost }: { onCreated: () => void; onClose: () => void; footerHost?: HTMLElement | null }) => (
    <div><span>secret-form</span><span data-testid="secret-host">{footerHost ? "host" : "no-host"}</span><button onClick={onCreated}>created-secret</button><button onClick={onClose}>close-secret</button></div>
  ),
}));
vi.mock("@/components/VariableDialogs", () => ({
  VariableForm: ({ onCreated }: { onCreated: () => void }) => <div><span>variable-form</span><button onClick={onCreated}>created-variable</button></div>,
}));

describe("NewEntryDialog", () => {
  it("starts with the preselected kind and switches the form and description", async () => {
    const { user } = renderApp(<NewEntryDialog initialKind="secret" sources={[]} prefill={null} onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Neuer Eintrag" })).toBeInTheDocument();
    expect(screen.getByText("secret-form")).toBeInTheDocument();
    expect(screen.getByText(/Es wird nur beschrieben, wo ein Secret liegt/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Variable" }));
    expect(screen.getByText("variable-form")).toBeInTheDocument();
    expect(screen.getByText(/Variablen sind in GitHub im Klartext lesbar/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Secret" }));
    expect(screen.getByText("secret-form")).toBeInTheDocument();
  });

  it("opens on the variable form and forwards created and close", async () => {
    const onCreated = vi.fn();
    const { user } = renderApp(<NewEntryDialog initialKind="variable" sources={[]} prefill={null} onClose={() => {}} onCreated={onCreated} />);
    await user.click(screen.getByText("created-variable"));
    expect(onCreated).toHaveBeenCalled();
  });

  it("hands the dialog footer element to the form so its buttons can sit there", () => {
    renderApp(<NewEntryDialog initialKind="secret" sources={[]} prefill={null} onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByTestId("secret-host")).toHaveTextContent("host");
  });
});
