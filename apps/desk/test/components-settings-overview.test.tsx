import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsOverview } from "@/components/IntegrationsOverview";
import { LanguagePanel, PolicyPanel, StoragePanel } from "@/components/settings/InfoPanels";
import { publishStages } from "@/lib/use-stages";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const settings = (over: Record<string, unknown> = {}) => ({
  configFile: "~/secret-desk.config.yaml",
  policy: { agentStages: ["dev"], agentStagesSource: "policy", envRoots: ["~/projects"] },
  stages: [{ id: "dev", kind: "dev", agentAccess: "direct" }, { id: "production", kind: "live", agentAccess: "approval" }],
  vault: { enabled: true, file: "~/.secret-desk/vault.json", keySourceLabel: "OS keychain" },
  linksFile: "~/links.yaml",
  evidenceDir: "~/evidence",
  automation: { enabled: true, chromeFound: true },
  server: { port: 4747 },
  ...over,
});

describe("PolicyPanel", () => {
  it("shows the loading state and then the load error with retry", async () => {
    let fail = true;
    fakePortal({ "GET settings": () => (fail ? { status: 500, body: { error: "settings unreadable" } } : settings()) });
    const { user } = renderApp(<PolicyPanel />);
    expect(await screen.findByText("settings unreadable")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText(/Die Richtlinie steht in der Konfigurationsdatei \(~\/secret-desk\.config\.yaml\)/)).toBeInTheDocument();
  });

  it("lists direct stages, the source, env roots, access per stage and the rules", async () => {
    publishStages([{ id: "dev", label: "Development", kind: "dev" }, { id: "production", label: "Production", kind: "live" }] as never);
    fakePortal({ "GET settings": settings() });
    renderApp(<PolicyPanel />);
    expect(await screen.findByText(/Ausdrücklich in policy\.agentStages gesetzt/)).toBeInTheDocument();
    expect(screen.getByText("~/projects")).toBeInTheDocument();
    expect(screen.getByText("Direkt, ohne Freigabe")).toBeInTheDocument();
    expect(screen.getByText("Nur mit deiner Freigabe")).toBeInTheDocument();
    expect(screen.getByText("Lokal (dev)")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
  });

  it("explains empty policy lists and the default source", async () => {
    fakePortal({ "GET settings": settings({ policy: { agentStages: [], agentStagesSource: "default", envRoots: [] } }) });
    renderApp(<PolicyPanel />);
    expect(await screen.findByText("Keine Stage: Agenten brauchen immer deine Freigabe.")).toBeInTheDocument();
    expect(screen.getByText(/Standard: alle Stages der Art dev/)).toBeInTheDocument();
    expect(screen.getByText(/Keine gesetzt: Env-Dateien werden nur/)).toBeInTheDocument();
  });
});

describe("StoragePanel", () => {
  it("shows vault, files, automation and port", async () => {
    fakePortal({ "GET settings": settings() });
    renderApp(<StoragePanel />);
    expect(await screen.findByText("~/.secret-desk/vault.json")).toBeInTheDocument();
    expect(screen.getByText("OS keychain")).toBeInTheDocument();
    expect(screen.getByText("~/links.yaml")).toBeInTheDocument();
    expect(screen.getByText("~/evidence")).toBeInTheDocument();
    expect(screen.getByText("Chrome gefunden").nextElementSibling).toHaveTextContent("Ja");
    expect(screen.getByText("4747")).toBeInTheDocument();
    expect(screen.getAllByText("An")).toHaveLength(2);
  });

  it("says the vault is off, hides the file and key source and the Chrome row, and reports a missing Chrome", async () => {
    fakePortal({ "GET settings": settings({ vault: { enabled: false, file: "x", keySourceLabel: null }, automation: { enabled: false, chromeFound: false } }) });
    const { unmount } = renderApp(<StoragePanel />);
    expect(await screen.findByText(/Aus: Tokens liegen nur für diese Sitzung im Speicher/)).toBeInTheDocument();
    expect(screen.queryByText("Tresordatei")).toBeNull();
    expect(screen.queryByText("Chrome gefunden")).toBeNull();
    unmount();
    fakePortal({ "GET settings": settings({ vault: { enabled: true, file: "f", keySourceLabel: null }, automation: { enabled: true, chromeFound: false } }) });
    renderApp(<StoragePanel />);
    expect(await screen.findByText("Tresordatei")).toBeInTheDocument();
    expect(screen.queryByText("Schlüsselquelle")).toBeNull();
    expect(screen.getByText("Chrome gefunden").nextElementSibling).toHaveTextContent("Nein");
  });

  it("shows the load error with retry", async () => {
    fakePortal({ "GET settings": { status: 500, body: { error: "no settings" } } });
    renderApp(<StoragePanel />);
    expect(await screen.findByText("no settings")).toBeInTheDocument();
  });
});

describe("LanguagePanel", () => {
  it("marks the current language and switches it", async () => {
    const { user } = renderApp(<LanguagePanel />);
    expect(screen.getByRole("button", { name: "Deutsch" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Language")).toBeInTheDocument();
  });
});

const conn = (over: Record<string, unknown> = {}) => ({ id: "cloudflare", connected: true, label: "Cloudflare", daysLeft: 40, ...over });
const secretLike = (over: Record<string, unknown> = {}) => ({ connection: "cloudflare", automatic: true, places: [{ scope: "repository", repo: "acme-app" }], params: { status: "ok", missing: [] }, ...over });

describe("IntegrationsOverview", () => {
  it("shows a skeleton and then the load error with retry for all three lists", async () => {
    let fail = true;
    fakePortal({
      "GET connections": () => (fail ? { status: 500, body: { error: "connections failed" } } : []),
      "GET secrets": [],
      "GET variables": [],
    });
    const { user } = renderApp(<IntegrationsOverview />);
    expect(await screen.findByText("connections failed")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Noch nichts angebunden.")).toBeInTheDocument();
  });

  it("summarizes connected integrations with attached entries and the missing-parameter link", async () => {
    fakePortal({
      "GET connections": [conn(), conn({ id: "github", label: "GitHub", daysLeft: 5 }), conn({ id: "supabase", label: "Supabase", daysLeft: null }), conn({ id: "resend", label: "Resend", connected: false })],
      "GET secrets": [secretLike(), secretLike({ automatic: false, params: { status: "missing", missing: ["accountId"] }, places: [] }), secretLike({ connection: "resend" }), secretLike({ connection: "grafana", automatic: false })],
      "GET variables": [{ from: { connection: "cloudflare" }, places: [{ repo: "acme-docs" }] }, { from: null, places: [] }],
    });
    const { user } = renderApp(<IntegrationsOverview />);
    expect(await screen.findByText("3 vollständig, 1 fehlen", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("2 Secrets (1 automatisch erneuerbar), 1 Variablen")).toBeInTheDocument();
    expect(screen.getAllByText("Verbunden")).toHaveLength(2);
    expect(screen.getByText("Bald fällig")).toBeInTheDocument();
    expect(screen.getAllByText("Verbunden, noch nichts zugeordnet.")).toHaveLength(2);
    expect(screen.getByText("Läuft nie ab")).toBeInTheDocument();
    expect(screen.getByText(/Resend verbinden, dann können 1 Tokens automatisch erneuert werden\./)).toBeInTheDocument();
    expect(screen.getByText(/Grafana verbinden, dann lassen sich die zugehörigen Einträge prüfen und erneuern\./)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Verbinden" })).toHaveLength(2);
    await user.click(screen.getByRole("link", { name: "Fehlende zeigen" }));
    expect(window.sessionStorage.getItem("sd:filter:entries.params")).toBe('"missing"');
  });

  it("says nothing is linked and hides the missing-parameter link when nothing is missing", async () => {
    fakePortal({ "GET connections": [conn({ connected: false })], "GET secrets": [], "GET variables": [] });
    renderApp(<IntegrationsOverview />);
    expect(await screen.findByText("Noch nichts angebunden.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Fehlende zeigen" })).toBeNull();
    await waitFor(() => expect(screen.getByText("0 vollständig, 0 fehlen", { exact: false })).toBeInTheDocument());
  });
});
