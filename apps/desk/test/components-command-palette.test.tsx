import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/CommandPalette";
import { I18nProvider } from "@/lib/i18n";
import { navigation } from "./helpers/navigation";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const secrets = [
  { id: "cf-token", name: "CF_API_TOKEN", stage: "staging", status: "soon", provider: "cloudflare", service: "github-actions", places: [{ repo: "acme-app" }, { repo: "acme-app" }], tags: ["deploy"], owner: "anna" },
  { id: "db-url", name: "DB_URL", stage: "production", status: "ok", places: [] },
  { id: "old", name: "OLD_KEY", stage: "mystery", status: "weird", places: [{ repo: "acme-docs" }] },
  { id: "bare", name: "BARE_KEY", stage: "", status: "ok", places: [] },
];
const variables = [{ id: "proj-id", name: "ACME_PROJECT_ID", stage: "staging", places: [{ repo: "acme-app" }], tags: ["core"] }];
const sources: Record<string, FakeHandler> = {
  "GET secrets": secrets,
  "GET variables": variables,
  "GET stages": [{ id: "staging", label: "Staging", kind: "test" }],
  "GET providers": [{ id: "cloudflare", label: "Cloudflare" }],
  "GET repos": { repos: [{ name: "acme-app", secrets: 2, variables: 1 }] },
  "GET connections": [{ id: "github", label: "GitHub", connected: true }, { id: "resend", label: "Resend", connected: false }],
};

let clock = 1_900_000_000_000;

beforeEach(() => {
  // The palette keeps its sources for 30 seconds per module; every test starts a minute later so none sees another's data.
  clock += 60_000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
});
afterEach(() => vi.useRealTimers());

const open = (props: { onClose?: () => void; shortcut?: string } = {}) => renderApp(<CommandPalette onClose={props.onClose ?? (() => {})} shortcut={props.shortcut ?? "Ctrl K"} />);
const input = () => screen.getByRole("combobox", { name: "Suchen oder Befehl eingeben …" });
const announcement = () => document.querySelector('p[role="status"]') as HTMLElement;
const loaded = async () => { await waitFor(() => expect(screen.queryByText("Lade Einträge …")).toBeNull()); };

describe("CommandPalette loading and empty state", () => {
  it("shows a loading hint, then suggestions with the typical actions and a focused input", async () => {
    fakePortal(sources);
    open();
    expect(screen.getByText("Lade Einträge …")).toBeInTheDocument();
    expect(input()).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    await loaded();
    const group = screen.getByRole("group", { name: "Vorschläge" });
    expect(within(group).getByText("Neues Secret anlegen")).toBeInTheDocument();
    expect(within(group).getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText("Ctrl K")).toBeInTheDocument();
  });

  it("works when sources fail or answer in an odd shape, and without a shortcut hint", async () => {
    fakePortal({ "GET repos": {}, "GET secrets": { status: 500, body: { error: "boom" } } });
    open({ shortcut: "" });
    await loaded();
    expect(screen.getByRole("group", { name: "Vorschläge" })).toBeInTheDocument();
    expect(screen.queryByText("Ctrl K")).toBeNull();
  });

  it("reuses loaded sources within 30 seconds and does not update after unmount", async () => {
    const portal = fakePortal(sources);
    const first = open();
    await loaded();
    first.unmount();
    open();
    await loaded();
    expect(portal.callsTo("GET", "secrets")).toHaveLength(1);
    const early = open();
    early.unmount();
    await act(async () => { await Promise.resolve(); });
  });

  it("restores overflow and focus on close", async () => {
    fakePortal(sources);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = open();
    await loaded();
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe("CommandPalette closing", () => {
  it("closes on Escape, on the Esc button and on a click beside the dialog, but not inside", async () => {
    fakePortal(sources);
    const onClose = vi.fn();
    const { user, container } = open({ onClose });
    await loaded();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(container.querySelector(".fixed") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps Tab inside the dialog", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.keyboard("{Escape}");
    const first = screen.getByRole("combobox");
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    const last = screen.getAllByRole("button").at(-1)!;
    last.focus();
    await user.tab();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "a" });
  });
});

describe("CommandPalette search", () => {
  it("groups results, highlights hits, announces the count and opens an item with Enter, recording history", async () => {
    fakePortal(sources);
    const onClose = vi.fn();
    const { user } = open({ onClose });
    await loaded();
    await user.type(input(), "token");
    expect(await screen.findByRole("group", { name: "Secrets" })).toBeInTheDocument();
    expect(announcement()).toHaveTextContent(/Treffer/);
    expect(document.querySelector("mark")).not.toBeNull();
    expect(screen.getByText("Läuft bald ab")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(navigation.router.push).toHaveBeenCalledWith("/secrets/cf-token");
    expect(onClose).toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("sd:palette:recent-items") ?? "[]")).toContain("secret:cf-token");
    expect(JSON.parse(window.localStorage.getItem("sd:palette:recent-queries") ?? "[]")).toContain("token");
  });

  it("opens an item by click and lets the mouse move the selection", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "acme");
    const options = await screen.findAllByRole("option");
    fireEvent.mouseMove(options[1]!);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.click(options[1]!);
    expect(navigation.router.push).toHaveBeenCalled();
  });

  it("covers every group kind with its page and subtitle", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "e");
    await screen.findAllByRole("group");
    await user.clear(input());
    await user.type(input(), "github");
    expect(await screen.findByText("verbunden")).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "resend");
    expect(await screen.findByText("nicht verbunden", { selector: "span.shrink-0" })).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "cloudflare");
    expect(await screen.findByRole("group", { name: /Anbieter/ })).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "staging");
    expect(await screen.findByRole("group", { name: /Stage/i })).toBeInTheDocument();
  });

  it("moves with the arrow keys, Home and End, and jumps between groups with Tab", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "acme");
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Tab}");
    const selectedIndex = screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selectedIndex).toBeGreaterThan(0);
    await user.keyboard("a");
  });

  it("does not hijack Tab with a single group or Shift+Tab", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "token");
    await screen.findByRole("group", { name: "Secrets" });
    await user.keyboard("{Tab}");
    expect(document.activeElement).not.toBeNull();
  });

  it("suggests filters and applies a suggestion by click and by Enter", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "sta");
    const suggestion = await screen.findByRole("option", { name: "stage:" });
    await user.click(suggestion);
    expect(input()).toHaveValue("stage:");
    expect(input()).toHaveFocus();
    await user.type(input(), "pro");
    await user.keyboard("{Enter}");
    expect(input()).toHaveValue("stage:production ");
  });

  it("offers a did-you-mean correction when nothing matches", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "tokxxn");
    expect(await screen.findByText("Keine Treffer für „tokxxn“.", { selector: "p.text-muted-text" })).toBeInTheDocument();
    expect(screen.getByText("Filter: stage: repo: tag: art: besitzer: status: provider:")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "token" }));
    expect(input()).toHaveValue("token");
    expect(await screen.findByRole("group", { name: "Secrets" })).toBeInTheDocument();
  });

  it("shows only the filter suggestions, no empty-result text, when a filter key is being typed", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "statu");
    expect(await screen.findByRole("option", { name: "status:" })).toBeInTheDocument();
    expect(screen.queryByText(/^Keine Treffer für/, { selector: "p.text-muted-text" })).toBeNull();
  });

  it("lists an item without subtitle", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "bare_key");
    expect(await screen.findByText("BARE_KEY")).toBeInTheDocument();
  });

  it("shows no correction when nothing is close, and announces the empty result", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "zzzzzzzzzz");
    expect(await screen.findByText("Keine Treffer für „zzzzzzzzzz“.", { selector: "p.text-muted-text" })).toBeInTheDocument();
    expect(screen.queryByText("Meintest du")).toBeNull();
    expect(announcement()).toHaveTextContent("Keine Treffer");
  });

  it("does not open anything on Enter without rows", async () => {
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "zzzzzzzzzz{Enter}");
    expect(navigation.router.push).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
  });
});

describe("CommandPalette history", () => {
  const stored = () => {
    window.localStorage.setItem("sd:palette:recent-items", JSON.stringify(["secret:cf-token", "gone:missing"]));
    window.localStorage.setItem("sd:palette:recent-queries", JSON.stringify(["token", "acme"]));
  };

  it("lists recent items and queries, re-runs a query and clears the history", async () => {
    stored();
    fakePortal(sources);
    const { user } = open();
    await loaded();
    expect(within(screen.getByRole("group", { name: "Zuletzt geöffnet" })).getByText("CF_API_TOKEN")).toBeInTheDocument();
    const queries = screen.getByRole("group", { name: "Zuletzt gesucht" });
    await user.click(within(queries).getByText("acme"));
    expect(input()).toHaveValue("acme");
    await user.clear(input());
    await user.click(screen.getByRole("button", { name: "Verlauf löschen" }));
    expect(screen.queryByRole("group", { name: "Zuletzt geöffnet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verlauf löschen" })).toBeNull();
  });

  it("boosts recently opened items and turns the history off and on again", async () => {
    stored();
    fakePortal(sources);
    const { user } = open();
    await loaded();
    await user.type(input(), "acme");
    await screen.findAllByRole("option");
    await user.clear(input());
    await user.click(screen.getByRole("button", { name: "Verlauf ausschalten" }));
    expect(screen.queryByRole("group", { name: "Zuletzt geöffnet" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Verlauf speichern (nur Suchbegriffe, lokal)" }));
    expect(screen.getByRole("button", { name: "Verlauf ausschalten" })).toBeInTheDocument();
    expect(window.localStorage.getItem("sd:palette:history-off")).toBeNull();
  });
});

describe("CommandPalette without storage or window", () => {
  it("still works when localStorage is blocked", async () => {
    fakePortal(sources);
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    try {
      const { user } = open();
      await loaded();
      await user.type(screen.getByRole("combobox"), "token");
      await user.keyboard("{Enter}");
      expect(navigation.router.push).toHaveBeenCalledWith("/secrets/cf-token");
    } finally {
      spy.mockRestore();
    }
  });

  it("renders on the server without a window", () => {
    vi.stubGlobal("window", undefined);
    let html = "";
    try {
      html = renderToString(<I18nProvider><CommandPalette onClose={() => {}} shortcut="" /></I18nProvider>);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(html).toContain("Suche und Befehle");
  });
});
