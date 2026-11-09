import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserAutomationSection, DeveloperPanel, type AutomationInfo } from "@/components/BrowserAutomationPanel";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const recipe = (over: Partial<AutomationInfo["recipes"][number]> = {}): AutomationInfo["recipes"][number] => ({ id: "r1", providerId: "acme", label: "Acme Console", host: "console.acme.test", status: "ok", sha256: "0123456789abcdef0123456789abcdef", allowHosts: [], bundled: true, canCheckSignIn: true, ...over });

const info = (over: Partial<AutomationInfo> = {}): AutomationInfo => ({
  enabled: true,
  browser: { mode: "local", endpoint: null, reachable: null, browser: null, detail: null, viewerUrl: null },
  chrome: { found: true, path: "/usr/bin/chrome", hint: null },
  profileDir: "~/.secret-desk/profile",
  loginTimeoutMinutes: 10,
  signInFreshHours: 12,
  allowExternalRecipes: false,
  signInChecks: [],
  recipes: [],
  problems: [],
  ...over,
});

const section = (data: AutomationInfo | undefined, extra: { error?: Error; loading?: boolean; reload?: () => void } = {}) => (
  <BrowserAutomationSection q={{ data, error: extra.error ?? null, loading: extra.loading ?? false, reload: extra.reload ?? (() => {}) }} />
);

describe("BrowserAutomationSection states", () => {
  it("shows a skeleton while loading and the error with retry", async () => {
    const reload = vi.fn();
    const { user, container, rerender } = renderApp(section(undefined, { loading: true }));
    expect(screen.getByText("Browser-Automatisierung")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
    rerender(section(undefined, { error: new Error("automation failed"), reload }));
    expect(screen.getByText("automation failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(reload).toHaveBeenCalled();
  });

  it("says the automation is off", () => {
    renderApp(section(info({ enabled: false })));
    expect(screen.getByText(/Die Browser-Automatisierung ist ausgeschaltet/)).toBeInTheDocument();
    expect(screen.queryByText("Rezepte")).toBeNull();
  });
});

describe("BrowserAutomationSection local mode", () => {
  it("shows the found Chrome with its path, the profile folder and the login timeout", () => {
    renderApp(section(info()));
    expect(screen.getByText(/öffnet secret-desk ein sichtbares Chrome/)).toBeInTheDocument();
    expect(screen.getByText("Gefunden")).toBeInTheDocument();
    expect(screen.getByTitle("/usr/bin/chrome")).toHaveTextContent("/usr/bin/chrome");
    expect(screen.getByText("~/.secret-desk/profile")).toBeInTheDocument();
    expect(screen.getByText("10 Minuten")).toBeInTheDocument();
  });

  it("shows a found Chrome without a path and a missing Chrome with its hint", () => {
    const { rerender } = renderApp(section(info({ chrome: { found: true, path: null, hint: null } })));
    expect(screen.getByText("Gefunden")).toBeInTheDocument();
    rerender(section(info({ chrome: { found: false, path: null, hint: "Install Chrome first" } })));
    expect(screen.getByText("Nicht gefunden")).toBeInTheDocument();
    expect(screen.getByText("Install Chrome first")).toBeInTheDocument();
    rerender(section(info({ chrome: { found: false, path: null, hint: null } })));
    expect(screen.queryByText("Install Chrome first")).toBeNull();
  });
});

describe("BrowserAutomationSection remote mode", () => {
  const remote = (over: Partial<AutomationInfo["browser"]> = {}) => info({ browser: { mode: "remote", endpoint: "http://pi.local:9222", reachable: true, browser: "Chrome", detail: null, viewerUrl: "https://viewer.test/", ...over } });

  it("shows the reachable remote browser, its viewer link and no profile folder", () => {
    renderApp(section(remote()));
    expect(screen.getByText(/steuert secret-desk den Browser auf dem Server/)).toBeInTheDocument();
    expect(screen.getByText("Antwortet")).toBeInTheDocument();
    expect(screen.getByText("http://pi.local:9222")).toBeInTheDocument();
    expect(screen.getByText("Läuft auf dem Pi: Anmeldungen bleiben im Profil des entfernten Browsers.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Browser öffnen" });
    expect(link).toHaveAttribute("href", "https://viewer.test/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByText("Profilordner")).toBeNull();
  });

  it("shows an unreachable browser with the server's detail and no viewer address", () => {
    renderApp(section(remote({ reachable: false, endpoint: null, detail: "connection refused", viewerUrl: null })));
    expect(screen.getByText("Nicht erreichbar")).toBeInTheDocument();
    expect(screen.getByText("connection refused")).toBeInTheDocument();
    expect(screen.getByText(/Keine Adresse zum Ansehen hinterlegt/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Browser öffnen" })).toBeNull();
  });
});

describe("BrowserAutomationSection recipes, sessions and problems", () => {
  it("lists recipes with bundled or external badges, hosts and shortened hashes", () => {
    renderApp(section(info({ allowExternalRecipes: true, recipes: [recipe(), recipe({ providerId: "ext", label: "External", bundled: false, allowHosts: ["a.test", "b.test"], sha256: "short" })] })));
    expect(screen.getByText(/Externe Rezepte sind eingeschaltet/)).toBeInTheDocument();
    expect(screen.getByText("mitgeliefert")).toBeInTheDocument();
    expect(screen.getByText("extern")).toBeInTheDocument();
    expect(screen.getByText("Erlaubte Hosts: keine weiteren")).toBeInTheDocument();
    expect(screen.getByText("Erlaubte Hosts: a.test, b.test")).toBeInTheDocument();
    expect(screen.getByText("SHA-256 0123456789ab…")).toBeInTheDocument();
    expect(screen.getByText("SHA-256 short")).toBeInTheDocument();
    expect(screen.getAllByText("console.acme.test: ok")).toHaveLength(2);
  });

  it("says when external recipes are off and no recipes exist", () => {
    renderApp(section(info()));
    expect(screen.getByText(/Externe Rezepte sind ausgeschaltet/)).toBeInTheDocument();
    expect(screen.getByText("Keine Rezepte gefunden.")).toBeInTheDocument();
    expect(screen.getByText("Noch keine Antwort zur Anmeldung.")).toBeInTheDocument();
    expect(screen.getByText("Keine.")).toBeInTheDocument();
    expect(screen.getByText(/Die Prüfung im Hintergrund ist aus/)).toBeInTheDocument();
  });

  it("shows sign-in checks with age and lifetime, with the hourly hint", () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    renderApp(section(info({
      signInCheckHours: 6,
      signInChecks: [
        { host: "a.test", signedIn: true, checkedAt: ago(30) },
        { host: "b.test", signedIn: false, checkedAt: ago(5000) },
        { host: "c.test", signedIn: true, checkedAt: "not-a-date" },
      ],
      signInLifetimes: [{ host: "a.test", averageMinutes: 20, samples: 3 }],
    })));
    expect(screen.getByText(/Wird alle 6 Std\. im Hintergrund geprüft/)).toBeInTheDocument();
    const a = screen.getByText("a.test").closest("li")!;
    expect(within(a).getByText(/angemeldet, geprüft vor 30 Min/)).toBeInTheDocument();
    expect(within(a).getByText(/Anmeldungen halten etwa 1 Std\. \(3 gemessen\)/)).toBeInTheDocument();
    const b = screen.getByText("b.test").closest("li")!;
    expect(within(b).getByText(/abgemeldet, geprüft vor 3 Tagen/)).toBeInTheDocument();
    expect(within(b).getByText(/noch keine Haltbarkeit gemessen/)).toBeInTheDocument();
    const c = screen.getByText("c.test").closest("li")!;
    expect(within(c).getByText(/geprüft –/)).toBeInTheDocument();
  });

  it("works when the server sends no lifetimes at all", () => {
    renderApp(section(info({ signInChecks: [{ host: "a.test", signedIn: true, checkedAt: new Date().toISOString() }] })));
    expect(screen.getByText(/noch keine Haltbarkeit gemessen/)).toBeInTheDocument();
  });

  it("lists config problems with their file", () => {
    renderApp(section(info({ problems: [{ file: "recipes/bad.yaml", message: "unknown step" }] })));
    expect(screen.getByText("recipes/bad.yaml")).toBeInTheDocument();
    expect(screen.getByText("unknown step")).toBeInTheDocument();
    expect(screen.queryByText("Keine.")).toBeNull();
  });
});

describe("DeveloperPanel", () => {
  it("shows the documentation links and loads the automation state", async () => {
    fakePortal({ "GET automation": info({ recipes: [recipe()] }) });
    renderApp(<DeveloperPanel />);
    expect(screen.getByRole("link", { name: "Integrationen entwickeln (Anleitung)" })).toHaveAttribute("href", "https://github.com/Pineflight/secret-desk/blob/main/docs/DEVELOPING-INTEGRATIONS.md");
    expect(screen.getByRole("link", { name: "Rezepte schreiben" }).getAttribute("href")).toMatch(/docs\/RECIPES\.md$/);
    expect(screen.getAllByRole("link", { name: "Browser-Automatisierung" })[0]!.getAttribute("href")).toMatch(/docs\/BROWSER-AUTOMATION\.md$/);
    expect(await screen.findByText("Acme Console")).toBeInTheDocument();
  });
});
