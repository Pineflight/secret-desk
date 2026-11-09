import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamSpec } from "@secret-desk/core";
import { ParamsForm } from "@/components/ParamsForm";
import type { Draft, ResourceState } from "@/lib/params-form";
import { fakePortal } from "./helpers/portal";
import { okState, spec } from "./helpers/params";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

type Props = Partial<Parameters<typeof ParamsForm>[0]>;

function Harness({ specs, initial = {}, spy, ...rest }: Props & { specs: ParamSpec[]; initial?: Draft; spy?: (d: Draft) => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  return <ParamsForm specs={specs} draft={draft} onDraft={(d) => { setDraft(d); spy?.(d); }} resources={{}} {...rest} />;
}

const R = (state: object): ResourceState => state as ResourceState;

describe("ParamsForm simple fields", () => {
  it("renders text, url, integer and list fields with required badges and writes the draft", async () => {
    const spy = vi.fn();
    const specs = [
      spec({ key: "name", type: "string", required: true, help: "Helpful text" }),
      spec({ key: "base", type: "url" }),
      spec({ key: "ttl", type: "integer", min: 2, max: 9 }),
      spec({ key: "free", type: "integer" }),
      spec({ key: "names", type: "stringList" }),
    ];
    const { user } = renderApp(<Harness specs={specs} spy={spy} />);
    expect(screen.getByText("Pflicht")).toBeInTheDocument();
    expect(screen.getAllByText("optional")).toHaveLength(4);
    expect(screen.getByText("Helpful text")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/name de/), "x");
    await user.type(screen.getByLabelText(/base de/), "https://a.test");
    const ttl = screen.getByLabelText(/ttl de/);
    expect(ttl).toHaveAttribute("min", "2");
    expect(ttl).toHaveAttribute("max", "9");
    expect(screen.getByLabelText(/free de/)).toHaveAttribute("min", "1");
    expect(screen.getByLabelText(/free de/)).not.toHaveAttribute("max");
    await user.type(ttl, "5");
    await user.type(screen.getByLabelText(/names de/), "a");
    expect(spy).toHaveBeenLastCalledWith({ name: "x", base: "https://a.test", ttl: "5", names: "a" });
    expect(screen.getByText("Mehrere Werte mit Komma oder Zeilenumbruch trennen.")).toBeInTheDocument();
  });

  it("shows the held values: numbers, lists and non-string values", () => {
    const specs = [spec({ key: "ttl", type: "integer" }), spec({ key: "names", type: "stringList" }), spec({ key: "name", type: "string" }), spec({ key: "u", type: "url" }), spec({ key: "ttl2", type: "integer" }), spec({ key: "names2", type: "stringList" })];
    renderApp(<Harness specs={specs} initial={{ ttl: 7, names: ["a", "b"], name: 5, u: 1, ttl2: {}, names2: "x" }} />);
    expect(screen.getByLabelText(/ttl de/)).toHaveValue(7);
    expect(screen.getByLabelText(/names de/)).toHaveValue("a\nb");
    expect(screen.getByLabelText(/^name de/)).toHaveValue("");
    expect(screen.getByLabelText(/u de/)).toHaveValue("");
    expect(screen.getByLabelText(/ttl2 de/)).toHaveValue(null);
    expect(screen.getByLabelText(/names2 de/)).toHaveValue("x");
  });

  it("uses English labels and help when the locale is en and disables fields", () => {
    window.localStorage.setItem("sd-locale", "en");
    const specs = [spec({ key: "name", type: "string", helpEn: "English help", help: "Deutsche Hilfe" })];
    renderApp(<Harness specs={specs} disabled />);
    expect(screen.getByLabelText(/name en/)).toBeDisabled();
    expect(screen.getByText("English help")).toBeInTheDocument();
    expect(screen.getByText("optional")).toBeInTheDocument();
  });

  it("shows the field error as an alert", () => {
    renderApp(<Harness specs={[spec({ key: "name", type: "string" })]} errors={{ name: "Name fehlt." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Name fehlt.");
  });

  it("shows the integration default until the field is filled and marks requiredWhen as required", async () => {
    const specs = [
      spec({ key: "account", type: "string", integrationDefault: true }),
      spec({ key: "zone", type: "string", requiredWhen: { key: "scope", equals: "zone" } }),
      spec({ key: "scope", type: "enum", defaultValue: "account", options: [{ value: "account", label: "Konto", labelEn: "Account" }, { value: "zone", label: "Zone", labelEn: "Zone" }] }),
    ];
    const { user } = renderApp(<Harness specs={specs} defaults={{ account: "acc-1" }} />);
    expect(screen.getByText("Standard der Integration: acc-1")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/account de/), "mine");
    expect(screen.queryByText(/Standard der Integration/)).toBeNull();
    expect(within(screen.getByText("zone de").closest("label")!).getByText("optional")).toBeInTheDocument();
    await pickOption(user, /scope de/, "Zone");
    expect(within(screen.getByText("zone de").closest("label")!).getByText("Pflicht")).toBeInTheDocument();
  });
});

describe("ParamsForm enum fields", () => {
  const enumSpec = (o: Partial<ParamSpec> = {}) => spec({ key: "scope", type: "enum", options: [{ value: "a", label: "Alpha", labelEn: "Alpha en" }, { value: "b", label: "Beta", labelEn: "Beta en" }], ...o });

  it("offers a pick placeholder without default and chooses an option", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[enumSpec()]} spy={spy} />);
    await user.click(screen.getByRole("combobox", { name: /scope de/ }));
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: "Bitte wählen" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(spy).toHaveBeenLastCalledWith({ scope: "b" });
  });

  it("names the default in the empty option when it is optional", async () => {
    const { user } = renderApp(<Harness specs={[enumSpec({ defaultValue: "a" })]} />);
    await user.click(screen.getByRole("combobox", { name: /scope de/ }));
    expect(within(await screen.findByRole("listbox")).getByRole("option", { name: "a (optional)" })).toBeInTheDocument();
  });

  it("drops the empty option for a required enum with default and uses English option labels", async () => {
    window.localStorage.setItem("sd-locale", "en");
    const { user } = renderApp(<Harness specs={[enumSpec({ required: true, defaultValue: "a" })]} initial={{ scope: "a" }} />);
    await user.click(screen.getByRole("combobox", { name: /scope en/ }));
    const names = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Alpha en", "Beta en"]);
  });

  it("shows nothing selected for a non-string value", () => {
    renderApp(<Harness specs={[enumSpec()]} initial={{ scope: 3 }} />);
    expect(screen.getByRole("combobox", { name: /scope de/ })).toHaveTextContent("Bitte wählen");
  });
});

describe("ParamsForm presets", () => {
  const withPreset = spec({ key: "perm", type: "string", presets: [
    { id: "deploy", label: "Deploy", labelEn: "Deploy en", values: { perm: "p1", other: ["x", "y"] }, needs: ["zone"] },
    { id: "plain", label: "Plain", labelEn: "Plain en", values: { perm: "p2" } },
  ] });
  const zone = spec({ key: "zone", type: "string" });

  it("lists presets, applies one into the draft and marks it active", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[withPreset, zone]} spy={spy} />);
    expect(screen.getByText("Vorlagen")).toBeInTheDocument();
    expect(screen.getByText("Dazu noch wählen: zone de")).toBeInTheDocument();
    expect(screen.queryByText(/Dazu noch wählen: zone de/, { selector: "p.x" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    expect(spy).toHaveBeenLastCalledWith({ perm: "p1", other: ["x", "y"] });
    expect(screen.getByRole("button", { name: "Deploy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Plain" })).toHaveAttribute("aria-pressed", "false");
  });

  it("names an unknown needed key as is and hides the section for an empty preset list", () => {
    const unknownNeed = spec({ key: "perm", type: "string", presets: [{ id: "d", label: "D", labelEn: "D", values: { perm: "p" }, needs: ["ghost"] }] });
    const { unmount } = renderApp(<Harness specs={[unknownNeed]} />);
    expect(screen.getByText("Dazu noch wählen: ghost")).toBeInTheDocument();
    unmount();
    renderApp(<Harness specs={[spec({ key: "perm", type: "string", presets: [] })]} />);
    expect(screen.queryByText("Vorlagen")).toBeNull();
  });

  it("uses the English preset label", () => {
    window.localStorage.setItem("sd-locale", "en");
    renderApp(<Harness specs={[withPreset, zone]} />);
    expect(screen.getByRole("button", { name: "Deploy en" })).toBeInTheDocument();
    expect(screen.getByText("Also choose: zone en")).toBeInTheDocument();
  });
});

describe("ParamsForm discovered single choice", () => {
  const pick = spec({ key: "account", type: "string", discover: "cloudflare.account" });
  const options = [{ value: "a1", label: "Acme", detail: "first" }, { value: "b2", label: "Beta", suggestedFor: { score: 1, reason: "name match" } }];

  beforeEach(() => {
    fakePortal({ "GET resource-map": { kinds: ["cloudflare.account"], entries: [] }, "PUT resource-map": {} });
  });

  it("chooses from the list and offers the suggestion with adopt", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[pick]} resources={{ account: R(okState(options, "b2")) }} spy={spy} />);
    expect(screen.getByText("Vorschlag: Beta (name match). Wird erst mit Klick übernommen.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Vorschlag übernehmen" }));
    expect(spy).toHaveBeenLastCalledWith({ account: "b2" });
    expect(screen.queryByRole("button", { name: "Vorschlag übernehmen" })).toBeNull();
    expect(screen.getAllByText("Vorschlag").length).toBeGreaterThan(0);
    await pickOption(user, /account de/, /Acme · first/);
    expect(spy).toHaveBeenLastCalledWith({ account: "a1" });
  });

  it("adds a suggestion without reason text and disabled adopt button", () => {
    const noReason = [{ value: "b2", label: "Beta", suggestedFor: { score: 1, reason: "" } }];
    renderApp(<Harness specs={[pick]} resources={{ account: R(okState(noReason, "b2")) }} disabled />);
    expect(screen.getByRole("button", { name: "Vorschlag übernehmen" })).toBeDisabled();
  });

  it("lists an unknown held value, warns it is unlisted and toggles to manual entry and back", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[pick]} initial={{ account: "zz" }} resources={{ account: R(okState(options)) }} spy={spy} />);
    expect(screen.getByText("Der Wert steht nicht in der Liste (anderes Konto?). Bitte prüfen.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /account de/ })).toHaveTextContent("zz");
    await user.click(screen.getByRole("button", { name: "Wert von Hand eintragen" }));
    const input = screen.getByRole("textbox", { name: /account de/ });
    await user.type(input, "1");
    expect(spy).toHaveBeenLastCalledWith({ account: "zz1" });
    await user.click(screen.getByRole("button", { name: "Aus der Liste wählen" }));
    expect(screen.getByRole("combobox", { name: /account de/ })).toBeInTheDocument();
  });

  it("offers to remember a chosen non-suggested resource and saves the mapping", async () => {
    const portal = fakePortal({ "GET resource-map": { kinds: ["cloudflare.account"], entries: [] }, "PUT resource-map": {} });
    const onReload = vi.fn();
    const { user } = renderApp(<Harness specs={[{ ...pick }]} initial={{ account: "a1" }} resources={{ account: R(okState(options)) }} remember={{ repo: "acme-app", stage: "dev" }} onReload={onReload} />);
    await user.click(await screen.findByRole("button", { name: "Für acme-app merken" }));
    expect(portal.callsTo("PUT", "resource-map")[0]?.body).toMatchObject({ kind: "cloudflare.account", repo: "acme-app", value: "a1", label: "Acme" });
    await user.click(screen.getByRole("button", { name: "Liste neu laden" }));
    expect(onReload).toHaveBeenCalled();
  });

  it("does not offer remember for a suggested value, without a repo or without discover kind", async () => {
    renderApp(<Harness specs={[pick]} initial={{ account: "b2" }} resources={{ account: R(okState(options, "b2")) }} remember={{ repo: "acme-app" }} />);
    await screen.findByRole("combobox", { name: /account de/ });
    expect(screen.queryByRole("button", { name: /merken/ })).toBeNull();
  });

  it("shows a mapping mismatch, loading and empty states", () => {
    const { rerender } = renderApp(<Harness specs={[pick]} resources={{ account: R({ ...okState(options), mapMismatch: { value: "old", label: "Old name" } }) }} />);
    expect(screen.getByText(/Die Zuordnung zeigt auf eine Ressource, die der Anbieter nicht kennt \(Old name\)/)).toBeInTheDocument();
    rerender(<Harness specs={[pick]} resources={{ account: R({ ...okState(options), mapMismatch: { value: "old" } }) }} />);
    expect(screen.getByText(/nicht kennt \(old\)/)).toBeInTheDocument();
    rerender(<Harness specs={[pick]} resources={{}} loading />);
    expect(screen.getByText("Liste wird gelesen …")).toBeInTheDocument();
    rerender(<Harness specs={[pick]} resources={{ account: R(okState([])) }} />);
    expect(screen.getByText("Die Integration liefert hier keine Einträge.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Liste neu laden" })).toBeNull();
  });

  it("explains each discovery status when no list is available", () => {
    const base = { options: [], suggested: null };
    const cases: [object, RegExp][] = [
      [{ ...base, status: "not-connected", connection: "cloudflare" }, /Integration cloudflare nicht verbunden/],
      [{ ...base, status: "needs-params" }, /Zuerst den Parameter wählen/],
      [{ ...base, status: "error", error: "HTTP 403." }, /Die Liste ließ sich nicht lesen: HTTP 403\./],
      [{ ...base, status: "error" }, /Die Liste ließ sich nicht lesen\. Hat das Token/],
      [{ ...base, status: "unsupported" }, /Für diesen Parameter gibt es keine Liste/],
    ];
    for (const [state, text] of cases) {
      const { unmount } = renderApp(<Harness specs={[pick]} resources={{ account: R(state) }} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
    const { unmount } = renderApp(<Harness specs={[pick]} resources={{ account: R({ ...base, status: "not-connected" }) }} connection="supabase" />);
    expect(screen.getByText(/Integration supabase nicht verbunden/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Integrationen" })).toHaveAttribute("href", "/connections");
    unmount();
    renderApp(<Harness specs={[pick]} resources={{ account: R({ ...base, status: "not-connected" }) }} />);
    expect(screen.getByText(/Integration \? nicht verbunden/)).toBeInTheDocument();
  });

  it("types a value by hand when there is no list and shows a number value", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[pick]} initial={{ account: 12 }} spy={spy} />);
    const input = screen.getByRole("textbox", { name: /account de/ });
    expect(input).toHaveValue("12");
    await user.type(input, "3");
    expect(spy).toHaveBeenLastCalledWith({ account: "123" });
  });
});

describe("ParamsForm discovered multi choice", () => {
  const multi = spec({ key: "perms", type: "stringList", discover: "cloudflare.permissionGroups" });
  const options = [{ value: "p1", label: "Read", detail: "reads" }, { value: "p2", label: "Write" }, { value: 3, label: "Three" }];

  it("selects, removes and clears values and filters the list", async () => {
    const spy = vi.fn();
    const { user } = renderApp(<Harness specs={[multi]} initial={{ perms: ["p1", "ghost", 9] }} resources={{ perms: R(okState(options)) }} spy={spy} />);
    expect(screen.getAllByText("2 ausgewählt").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "ghost entfernen" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Write/ }));
    expect(spy).toHaveBeenLastCalledWith({ perms: ["p1", "ghost", "p2"] });
    await user.click(screen.getByRole("button", { name: "Read entfernen" }));
    expect(spy).toHaveBeenLastCalledWith({ perms: ["ghost", "p2"] });
    await user.type(screen.getByRole("searchbox", { name: "Suchen …" }), "nomatch");
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Alle abwählen" }));
    expect(spy).toHaveBeenLastCalledWith({ perms: [] });
  });

  it("starts empty without selection chips and disables controls", () => {
    renderApp(<Harness specs={[multi]} resources={{ perms: R(okState(options)) }} disabled />);
    expect(screen.getByText("0 ausgewählt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alle abwählen" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Read/ })).toBeDisabled();
  });

  it("disables the remove button of a chosen value while disabled", () => {
    renderApp(<Harness specs={[multi]} initial={{ perms: ["p1"] }} resources={{ perms: R(okState(options)) }} disabled />);
    expect(screen.getByRole("button", { name: "Read entfernen" })).toBeDisabled();
  });

  it("falls back to a text area without a list and shows loading and the discovery note", async () => {
    const spy = vi.fn();
    const { user, unmount } = renderApp(<Harness specs={[multi]} initial={{ perms: ["a", "b"] }} resources={{}} loading spy={spy} />);
    const area = screen.getByRole("textbox", { name: /perms de/ });
    expect(area).toHaveValue("a\nb");
    expect(screen.getByText("Liste wird gelesen …")).toBeInTheDocument();
    await user.type(area, "c");
    expect(spy).toHaveBeenCalled();
    unmount();
    renderApp(<Harness specs={[multi]} initial={{ perms: "typed" }} resources={{ perms: R({ status: "needs-params", options: [], suggested: null }) }} />);
    expect(screen.getByText(/Zuerst den Parameter wählen/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /perms de/ })).toHaveValue("typed");
  });

  it("treats an ok state without options like no list", () => {
    renderApp(<Harness specs={[multi]} resources={{ perms: R(okState([])) }} />);
    expect(screen.getByRole("textbox", { name: /perms de/ })).toBeInTheDocument();
  });
});
