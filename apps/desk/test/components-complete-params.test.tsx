import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamSuggestion, SecretView } from "@secret-desk/runtime";
import { CompleteParamsDialog } from "@/components/CompleteParamsDialog";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const secrets = [
  { id: "titled", name: "TITLED_NAME", title: "A Title" },
  { id: "named", name: "NAMED_ONLY", title: null },
] as SecretView[];

const sg = (value: string, label = value) => ({ value, label, reason: "name match" });

const suggestions: ParamSuggestion[] = [
  { secretId: "titled", provider: "acme", stage: "dev", missing: ["account"], suggestions: { account: sg("a1", "Account One") }, status: "suggested" },
  { secretId: "named", provider: "acme", stage: "staging", missing: ["account", "zone"], suggestions: { account: sg("a2"), zone: null }, status: "partial" },
  { secretId: "ghost-id", provider: "acme", stage: "production", missing: ["account"], suggestions: { account: null }, status: "none" },
  { secretId: "offline", provider: "acme", stage: "dev", missing: ["account"], suggestions: { account: null }, status: "not-connected" },
];

const view = (problems: { key: string; code: string }[] = []) => ({ problems });

function rowOf(id: string): HTMLElement {
  return screen.getByText(id, { selector: "span.font-mono" }).closest("li") as HTMLElement;
}

describe("CompleteParamsDialog", () => {
  it("shows loading, then the empty state, and closes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    fakePortal({ "POST params/suggest-all": async () => { await gate; return { suggestions: [] }; } });
    const onClose = vi.fn();
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={onClose} onChanged={() => {}} />);
    expect(screen.getByText(/Das Portal liest die Konten und Projekte/)).toBeInTheDocument();
    release();
    expect(await screen.findByText("Alle Einträge haben ihre Pflichtparameter.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a load error and retries", async () => {
    let fail = true;
    fakePortal({ "POST params/suggest-all": () => (fail ? { status: 500, body: { error: "scan failed" } } : { suggestions: [] }) });
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("scan failed")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Alle Einträge haben ihre Pflichtparameter.")).toBeInTheDocument();
  });

  it("lists every row with its status, names, suggestions and links", async () => {
    fakePortal({ "POST params/suggest-all": { suggestions } });
    renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByText("A Title");
    expect(screen.getByRole("link", { name: "A Title" })).toHaveAttribute("href", "/secrets/titled");
    expect(screen.getByRole("link", { name: "NAMED_ONLY" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ghost-id" })).toBeInTheDocument();
    expect(screen.getByText("Eindeutiger Vorschlag")).toBeInTheDocument();
    expect(screen.getByText("Nur Teil-Vorschlag")).toBeInTheDocument();
    expect(screen.getByText("Kein eindeutiger Vorschlag")).toBeInTheDocument();
    expect(screen.getByText("Integration nicht verbunden")).toBeInTheDocument();
    expect(within(rowOf("titled")).getByText("Account One")).toBeInTheDocument();
    expect(within(rowOf("titled")).getByText("(name match)")).toBeInTheDocument();
    expect(within(rowOf("named")).getByText("–")).toBeInTheDocument();
    expect(within(rowOf("named")).getByRole("button", { name: "Übernehmen (1/2)" })).toBeEnabled();
    expect(within(rowOf("titled")).getByRole("button", { name: "Übernehmen" })).toBeEnabled();
    expect(within(rowOf("ghost-id")).getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    expect(within(rowOf("offline")).getByRole("link", { name: "Zu den Integrationen" })).toHaveAttribute("href", "/connections");
    expect(within(rowOf("titled")).queryByRole("link", { name: "Von Hand ergänzen" })).toBeNull();
    expect(within(rowOf("named")).getByRole("link", { name: "Von Hand ergänzen" })).toHaveAttribute("href", "/secrets/named");
    expect(screen.getByRole("button", { name: "Alle eindeutigen übernehmen (1)" })).toBeEnabled();
  });

  it("applies one suggestion, reports what is still missing and hides the actions", async () => {
    const portal = fakePortal({
      "POST params/suggest-all": { suggestions },
      "PUT secrets/titled/params": view(),
      "PUT secrets/named/params": view([{ key: "zone", code: "missing" }, { key: "x", code: "wrong_type" }]),
    });
    const onChanged = vi.fn();
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={onChanged} />);
    await screen.findByText("A Title");
    await user.click(within(rowOf("named")).getByRole("button", { name: "Übernehmen (1/2)" }));
    expect(await within(rowOf("named")).findByText("Übernommen · Es fehlen weiter: zone")).toBeInTheDocument();
    expect(portal.callsTo("PUT", "secrets/named/params")[0]?.body).toEqual({ params: { account: "a2" } });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(rowOf("named")).queryByRole("button")).toBeNull();
    await user.click(within(rowOf("titled")).getByRole("button", { name: "Übernehmen" }));
    expect(await within(rowOf("titled")).findByText("Übernommen")).toBeInTheDocument();
    expect(screen.getByText("Kein Eintrag hat einen eindeutigen Vorschlag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle eindeutigen übernehmen (0)" })).toBeDisabled();
  });

  it("shows the error of a failed single apply and keeps the row open", async () => {
    fakePortal({ "POST params/suggest-all": { suggestions }, "PUT secrets/titled/params": { status: 400, body: { error: "not allowed" } } });
    const onChanged = vi.fn();
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={onChanged} />);
    await screen.findByText("A Title");
    await user.click(within(rowOf("titled")).getByRole("button", { name: "Übernehmen" }));
    expect(await within(rowOf("titled")).findByRole("alert")).toHaveTextContent("not allowed");
    expect(onChanged).not.toHaveBeenCalled();
    expect(within(rowOf("titled")).getByRole("button", { name: "Übernehmen" })).toBeEnabled();
  });

  it("applies all unambiguous rows and confirms by toast", async () => {
    const two: ParamSuggestion[] = [suggestions[0]!, { ...suggestions[0]!, secretId: "second" }];
    const portal = fakePortal({ "POST params/suggest-all": { suggestions: two }, "PUT secrets/titled/params": view(), "PUT secrets/second/params": view() });
    const onChanged = vi.fn();
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={onChanged} />);
    await user.click(await screen.findByRole("button", { name: "Alle eindeutigen übernehmen (2)" }));
    expect(await screen.findByText("2 Einträge ergänzt.")).toBeInTheDocument();
    expect(portal.callsTo("PUT", "secrets/second/params")).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports partial failure when applying all", async () => {
    const two: ParamSuggestion[] = [suggestions[0]!, { ...suggestions[0]!, secretId: "second" }];
    fakePortal({ "POST params/suggest-all": { suggestions: two }, "PUT secrets/titled/params": view(), "PUT secrets/second/params": { status: 500, body: { error: "nope" } } });
    const { user } = renderApp(<CompleteParamsDialog secrets={secrets} onClose={() => {}} onChanged={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Alle eindeutigen übernehmen (2)" }));
    expect(await screen.findByText("1 ergänzt, 1 nicht.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Alle eindeutigen übernehmen (1)" })).toBeEnabled());
  });
});
