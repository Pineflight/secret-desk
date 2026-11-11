import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "@/components/Shell";
import { resetSessionForTests } from "@/lib/api";
import { refreshCounts } from "@/lib/refresh";
import { navigation } from "./helpers/navigation";
import { fakePortal, type FakeHandler, type FakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { drainRequestsAfterEach } from "./helpers/drain";

drainRequestsAfterEach();

// The palette and the launch form have their own tests; here they only show that the shell opens and closes them.
vi.mock("@/components/CommandPalette", () => ({
  CommandPalette: ({ shortcut, onClose }: { shortcut: string; onClose: () => void }) => (
    <div role="dialog" aria-label="palette-stub">shortcut:{shortcut}<button onClick={onClose}>close-palette</button></div>
  ),
}));
vi.mock("@/components/LaunchForm", () => ({
  LaunchForm: ({ onSession }: { onSession: (s: unknown) => void }) => <button onClick={() => onSession({})}>launch-stub</button>,
}));

const OVERVIEW = { pendingReviews: 0, pendingApprovals: 0 };
const routes = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  overview: OVERVIEW,
  "GET overview": OVERVIEW,
  "GET about": { version: "1.2.3", displayVersion: "v1.2.3", releaseUrl: "https://example.test/release" },
  "GET team-sync/status": { setupNeeded: false },
  "GET inventory/version": { version: 1, problem: null },
  ...over,
});

const shell = (children = <p>page content</p>) => <Shell>{children}</Shell>;
/** The session is shown and the first requests of the shell went out (so no request starts after the test ended). */
const settled = async (portal: FakePortal, inventoryAndSetup = true) => {
  await screen.findByText("tester");
  await waitFor(() => {
    for (const path of ["overview", "about"]) expect(portal.callsTo("GET", path).length).toBeGreaterThan(0);
    if (inventoryAndSetup) for (const path of ["inventory/version", "team-sync/status"]) expect(portal.callsTo("GET", path).length).toBeGreaterThan(0);
  });
};

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Shell navigation and account", () => {
  it("lists the pages, marks the current one and shows the user, the footer and the version link", async () => {
    navigation.set("/entries");
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    const nav = screen.getByRole("navigation", { name: "Hauptnavigation" });
    expect(within(nav).getAllByRole("link")).toHaveLength(10);
    expect(within(nav).getByRole("link", { name: "Secrets und Variablen" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Übersicht" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("page content")).toBeInTheDocument();
    expect(screen.getByText("Lokal auf diesem Rechner")).toBeInTheDocument();
    expect(screen.queryByText("Demo, simuliertes GitHub")).toBeNull();
    expect(await screen.findByRole("link", { name: "v1.2.3" })).toHaveAttribute("href", "https://example.test/release");
    expect(screen.getByRole("link", { name: "Über" })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: "Quellcode" })).toHaveAttribute("href", "https://github.com/Pineflight/secret-desk");
  });

  it("marks only the start page for the root path and sub pages of a section as current", async () => {
    navigation.set("/");
    const portal = fakePortal(routes());
    const { rerender } = renderApp(shell());
    await settled(portal);
    const current = () => screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.textContent);
    expect(current()).toEqual(["Übersicht"]);
    navigation.set("/compare/detail");
    rerender(shell());
    expect(current()).toEqual(["Vergleich"]);
    navigation.set("/secrets/abc");
    rerender(shell());
    expect(current()).toEqual(["Secrets und Variablen"]);
    navigation.set("/comparex");
    rerender(shell());
    expect(current()).toEqual([]);
  });

  it("shows the version as plain text without a release link, nothing while it is unknown, and the demo hint", async () => {
    const portal = fakePortal(routes({ "GET about": { version: "1.2.3", displayVersion: "v1.2.3", releaseUrl: null } }));
    const first = renderApp(shell());
    await settled(portal);
    expect(await screen.findByText("v1.2.3")).not.toHaveAttribute("href");
    first.unmount();
    resetSessionForTests();
    const second = fakePortal(routes({ "GET about": { status: 500, body: { error: "x" } } }));
    renderApp(shell());
    await settled(second);
    expect(screen.queryByText("v1.2.3")).toBeNull();
  });

  it("shows the demo hint for a demo session", async () => {
    resetSessionForTests();
    const portal = fakePortal(routes());
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/session" ? { csrf: "csrf-for-tests", user: "demo-user", demo: true } : url.endsWith("about") ? { version: "1", displayVersion: "1", releaseUrl: null } : url.endsWith("overview") ? OVERVIEW : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    renderApp(shell());
    expect(await screen.findByText("Demo, simuliertes GitHub")).toBeInTheDocument();
    expect(screen.getByText("demo-user")).toBeInTheDocument();
  });

  it("shows pending counts in the sidebar and sends the bell to the reviews first, then to the approvals", async () => {
    const answers = { current: { pendingReviews: 2, pendingApprovals: 1 } };
    const portal = fakePortal(routes({ "GET overview": () => answers.current }));
    renderApp(shell());
    expect(await screen.findByRole("link", { name: "3 offene Prüfungen und Freigaben" })).toHaveAttribute("href", "/reviews");
    expect(screen.getByLabelText("2 offen")).toBeInTheDocument();
    expect(screen.getByLabelText("1 offen")).toBeInTheDocument();
    answers.current = { pendingReviews: 0, pendingApprovals: 4 };
    act(() => refreshCounts());
    expect(await screen.findByRole("link", { name: "4 offene Prüfungen und Freigaben" })).toHaveAttribute("href", "/approvals");
    answers.current = { pendingReviews: 0, pendingApprovals: 0 };
    act(() => refreshCounts());
    expect(await screen.findByRole("link", { name: "Keine offenen Prüfungen oder Freigaben" })).toHaveAttribute("href", "/reviews");
  });

  it("toggles the sidebar on small screens and closes it on the backdrop or a page change", async () => {
    const portal = fakePortal(routes());
    const { user, rerender } = renderApp(shell());
    await settled(portal);
    const toggle = screen.getByRole("button", { name: "Menü öffnen oder schließen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const backdrop = document.querySelector<HTMLElement>("div.fixed.inset-0")!;
    await user.click(backdrop);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    navigation.set("/repos");
    rerender(shell());
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
  });

  it("links the new-entry button to the current kind on the entries page", async () => {
    navigation.set("/entries?kind=variable");
    const portal = fakePortal(routes());
    const { rerender } = renderApp(shell());
    await settled(portal);
    expect(screen.getByRole("link", { name: /Neuer Eintrag/ })).toHaveAttribute("href", "/entries?kind=variable&new=1");
    navigation.set("/entries");
    rerender(shell());
    expect(screen.getByRole("link", { name: /Neuer Eintrag/ })).toHaveAttribute("href", "/entries?new=1");
    navigation.set("/repos?kind=x");
    rerender(shell());
    expect(screen.getByRole("link", { name: /Neuer Eintrag/ })).toHaveAttribute("href", "/entries?new=1");
  });

  it("keeps every active filter in the new-entry link on the entries page", async () => {
    navigation.set("/entries?q=alpha&tag=ops&repo=acme%2Fapp&kind=secret&stage=dev&status=soon");
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    const href = screen.getByRole("link", { name: /Neuer Eintrag/ }).getAttribute("href")!;
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/entries");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "alpha", tag: "ops", repo: "acme/app", kind: "secret", stage: "dev", status: "soon", new: "1" });
  });
});

describe("Shell session, setup and inventory", () => {
  it("sends a first start without an inventory to the setup assistant, but not when already there or when the check fails", async () => {
    const portal = fakePortal(routes({ "GET team-sync/status": { setupNeeded: true } }));
    const first = renderApp(shell());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/setup"));
    await settled(portal);
    first.unmount();
    navigation.router.replace.mockClear();
    navigation.set("/setup");
    renderApp(shell());
    await settled(portal);
    expect(portal.callsTo("GET", "team-sync/status")).toHaveLength(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("ignores a failing setup check", async () => {
    const portal = fakePortal(routes({ "GET team-sync/status": { status: 500, body: { error: "x" } } }));
    renderApp(shell());
    await settled(portal);
    await waitFor(() => expect(screen.getByText("page content")).toBeInTheDocument());
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("does not redirect when no setup is needed", async () => {
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("asks for the launch address when the server requires it and reloads once the session exists", async () => {
    resetSessionForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "launch", code: "launch-required" }), { status: 401, headers: { "content-type": "application/json" } })));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { user } = renderApp(shell());
    expect(await screen.findByRole("button", { name: "launch-stub" })).toBeInTheDocument();
    expect(screen.queryByText("page content")).toBeNull();
    expect(screen.getByText("…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "launch-stub" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another server error", () => new Response(JSON.stringify({ error: "down" }), { status: 500, headers: { "content-type": "application/json" } })],
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
  ])("keeps the page content for %s while the session is missing", async (_name, answer) => {
    resetSessionForTests();
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    renderApp(shell());
    await waitFor(() => expect(screen.getByText("…")).toBeInTheDocument());
    expect(screen.getByText("page content")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "launch-stub" })).toBeNull();
  });

  it("warns above the page when the inventory file cannot be read", async () => {
    const portal = fakePortal(routes({ "GET inventory/version": { version: 2, problem: { message: "bad json", since: "now", persistent: true } } }));
    renderApp(shell());
    expect(await screen.findByRole("alert")).toHaveTextContent("bad json");
    await settled(portal);
    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});

describe("Shell search", () => {
  it("writes the typed query into the address of a searchable page after a short pause, and removes it when cleared", async () => {
    navigation.set("/entries?kind=secret");
    const portal = fakePortal(routes());
    const { user, rerender } = renderApp(shell());
    await settled(portal);
    const box = screen.getByRole("searchbox", { name: "Suchen" });
    await user.type(box, "stripe");
    await waitFor(() => expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?kind=secret&q=stripe"), { timeout: 3000 });
    // The router would now show the new address; the shell re-reads it.
    navigation.set("/entries?kind=secret&q=stripe");
    rerender(shell());
    await user.clear(box);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?kind=secret"), { timeout: 3000 });
  });

  it("drops the query parameter entirely when it was the only one", async () => {
    navigation.set("/approvals?q=old");
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    expect(screen.getByRole("searchbox")).toHaveValue("old");
    await user.clear(screen.getByRole("searchbox"));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenLastCalledWith("/approvals"), { timeout: 3000 });
  });

  it("does not touch the address of a page without a list", async () => {
    navigation.set("/repos");
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    await user.type(screen.getByRole("searchbox"), "abc");
    await new Promise((r) => setTimeout(r, 400));
    expect(navigation.router.replace).not.toHaveBeenCalledWith(expect.stringContaining("q="));
  });

  it("jumps to the entries search from a page without a list, and to the plain list for an empty query", async () => {
    navigation.set("/repos");
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    await user.type(screen.getByRole("searchbox"), "a b{Enter}");
    expect(navigation.router.push).toHaveBeenLastCalledWith("/entries?q=a%20b");
    await user.clear(screen.getByRole("searchbox"));
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.router.push).toHaveBeenLastCalledWith("/entries");
  });

  it("does not navigate on submit when the page already filters by the query", async () => {
    navigation.set("/entries");
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    await user.type(screen.getByRole("searchbox"), "x{Enter}");
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("follows a query that changes in the address", async () => {
    navigation.set("/entries?q=one");
    const portal = fakePortal(routes());
    const { rerender } = renderApp(shell());
    await settled(portal);
    expect(screen.getByRole("searchbox")).toHaveValue("one");
    navigation.set("/entries?q=two");
    rerender(shell());
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue("two"));
  });
});

describe("Shell remembered filters", () => {
  const saved = "sd:query:/entries";

  it("remembers the filters of a list page and restores them when the page is entered without any", async () => {
    navigation.set("/entries?q=abc&tag=core&foo=ignored");
    const portal = fakePortal(routes());
    const { rerender } = renderApp(shell());
    await settled(portal);
    expect(window.sessionStorage.getItem(saved)).toBe("q=abc&tag=core");
    navigation.set("/repos");
    rerender(shell());
    navigation.set("/entries");
    rerender(shell());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/entries?q=abc&tag=core"));
  });

  it.each([
    ["?new=1", "/entries?q=abc&new=1"],
    ["?neu=1", "/entries?q=abc&new=1"],
    ["?neu=0", "/entries?q=abc"],
  ])("keeps the new-entry flag when restoring (%s)", async (query, expected) => {
    window.sessionStorage.setItem(saved, "q=abc");
    navigation.set(`/entries${query}`);
    const portal = fakePortal(routes());
    renderApp(shell());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expected));
    await settled(portal);
  });

  it("forgets the saved filters when the page is entered without filters and nothing is saved, or when they are cleared", async () => {
    window.sessionStorage.setItem("sd:query:/approvals", "q=old");
    navigation.set("/approvals?q=old");
    const portal = fakePortal(routes());
    const { rerender } = renderApp(shell());
    await settled(portal);
    expect(window.sessionStorage.getItem("sd:query:/approvals")).toBe("q=old");
    navigation.set("/approvals?status=open");
    rerender(shell());
    expect(window.sessionStorage.getItem("sd:query:/approvals")).toBe("status=open");
    navigation.set("/approvals");
    rerender(shell());
    expect(window.sessionStorage.getItem("sd:query:/approvals")).toBeNull();
    navigation.set("/repos");
    rerender(shell());
    window.sessionStorage.setItem(saved, "stale");
    window.sessionStorage.clear();
    navigation.set("/entries");
    rerender(shell());
    await waitFor(() => expect(window.sessionStorage.getItem(saved)).toBeNull());
  });

  it("works when the storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    navigation.set("/entries?q=abc");
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});

describe("Shell command palette", () => {
  const platform = (value: string) => vi.spyOn(window.navigator, "platform", "get").mockReturnValue(value);
  const coarse = (matches: boolean) => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })));

  it("opens from the search field button and closes again", async () => {
    platform("Linux x86_64");
    coarse(false);
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    const open = screen.getByRole("button", { name: "Suche öffnen" });
    expect(open).toHaveAttribute("aria-keyshortcuts", "Control+K");
    expect(open).toHaveTextContent("Strg K");
    await user.click(open);
    expect(await screen.findByRole("dialog", { name: "palette-stub" })).toHaveTextContent("shortcut:Strg K");
    await user.click(screen.getByRole("button", { name: "close-palette" }));
    expect(screen.queryByRole("dialog", { name: "palette-stub" })).toBeNull();
  });

  it("toggles with the platform shortcut and ignores other keys", async () => {
    platform("Linux x86_64");
    coarse(false);
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "palette-stub" })).toBeNull();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "palette-stub" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "palette-stub" })).toBeNull();
  });

  it("uses Cmd+K and the Mac label on a Mac, and an English label in the English interface", async () => {
    platform("MacIntel");
    coarse(false);
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    expect(screen.getByRole("button", { name: "Suche öffnen" })).toHaveAttribute("aria-keyshortcuts", "Meta+K");
    expect(screen.getByRole("button", { name: "Suche öffnen" })).toHaveTextContent("⌘K");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "palette-stub" })).toBeInTheDocument();
  });

  it("shows the English shortcut label", async () => {
    localStorage.setItem("sd-locale", "en");
    platform("Linux x86_64");
    coarse(false);
    const portal = fakePortal(routes());
    renderApp(shell());
    expect(await screen.findByRole("button", { name: "Open search" })).toHaveTextContent("Ctrl K");
    await settled(portal);
  });

  it("offers a plain search button instead of the shortcut on touch devices", async () => {
    platform("Linux armv8l");
    coarse(true);
    const portal = fakePortal(routes());
    const { user } = renderApp(shell());
    await settled(portal);
    expect(screen.getAllByRole("button", { name: "Suche öffnen" })).toHaveLength(1);
    expect(screen.queryByText("Strg K")).toBeNull();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Suchen");
    await user.click(screen.getByRole("button", { name: "Suche öffnen" }));
    expect(await screen.findByRole("dialog", { name: "palette-stub" })).toHaveTextContent(/^shortcut:close-palette$/);
  });

  it("falls back to the touch points of the device when the browser cannot match media", async () => {
    platform("Linux armv8l");
    vi.stubGlobal("matchMedia", undefined);
    vi.spyOn(window.navigator, "maxTouchPoints", "get").mockReturnValue(5);
    const portal = fakePortal(routes());
    renderApp(shell());
    await settled(portal);
    expect(screen.queryByText("Strg K")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Suche öffnen" })).toHaveLength(1);
  });
});
