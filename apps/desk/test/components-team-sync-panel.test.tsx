import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamSyncPanel } from "@/components/TeamSyncPanel";
import { publishStages } from "@/lib/use-stages";
import type { BundleDiff, PushPlan, SyncCheck, SyncStatus } from "@/lib/team-sync";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { runState } from "./helpers/run";
import { activeToken, tokenInfo } from "./helpers/team-token";
import { drainRequestsAfterEach } from "./helpers/drain";

drainRequestsAfterEach();

const STATUS = "GET team-sync/status";
const none = { added: [], changed: [], removed: [] };
const diff = (over: Partial<BundleDiff["sections"]> = {}, empty = false): BundleDiff => ({ empty, sections: { secrets: none, variables: none, stages: none, providers: none, envTemplates: none, ...over } });
const someDiff = () => diff({ secrets: { added: ["s-new"], changed: [], removed: [] } });
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true,
  connected: true,
  tokenSource: "own",
  neededRights: ["Contents: read", "Metadata: read"],
  repo: "acme/team",
  path: "team.json",
  branch: "main",
  mode: "pull",
  pushStrategy: null,
  pushBranch: null,
  pullOnStart: null,
  lastSyncAt: null,
  lastPushAt: null,
  pendingPullUrl: null,
  lastCheck: null,
  lastError: null,
  setupNeeded: false,
  ...over,
});
const routes = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({ [STATUS]: status(), "GET team-sync/token": tokenInfo(), "GET stages": [], ...over });
const check = (over: Partial<SyncCheck> = {}): SyncCheck => ({ state: "remote-changed", remoteSha: "sha-1", diff: someDiff(), ...over });

beforeEach(() => publishStages([]));

describe("TeamSyncPanel status", () => {
  it("renders nothing until the status is known", () => {
    fakePortal({ [STATUS]: () => new Promise(() => {}) });
    const { container } = renderApp(<TeamSyncPanel />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("points to the setup when team sync is not configured", async () => {
    fakePortal(routes({ [STATUS]: status({ configured: false, repo: null, mode: null }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("Team-Sync ist nicht eingerichtet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Einrichten" })).toHaveAttribute("href", "/setup");
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Jetzt synchronisieren" })).toBeNull();
  });

  it("shows repository, file, mode and the last sync in the header and the rest in the details", async () => {
    fakePortal(routes({ [STATUS]: status({ lastSyncAt: "2026-01-02 10:00" }) }));
    renderApp(<TeamSyncPanel />);
    const header = (await screen.findByText("acme/team")).closest("p")!;
    expect(header).toHaveTextContent("team.json @ main");
    expect(header).toHaveTextContent("nur lesen");
    expect(header).toHaveTextContent("Letzter Abgleich: 2026-01-02 10:00");
    const details = screen.getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent("eigenes Team-Sync-Token");
    expect(details).toHaveTextContent("Contents: read, Metadata: read");
    expect(details).toHaveTextContent("Die Team-Datei");
    expect(await screen.findByTestId("team-token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zum Repo schieben" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pull Request anlegen" })).toBeNull();
  });

  it("says never synced, hides the token control without repository or mode and passes no branch", async () => {
    fakePortal(routes({ [STATUS]: status({ repo: null, mode: null, branch: null }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("noch nie")).toBeInTheDocument();
    expect(screen.queryByTestId("team-token")).toBeNull();
  });

  it("starts the token control without a branch when none is set", async () => {
    fakePortal(routes({ [STATUS]: status({ branch: null, pushStrategy: "direct", mode: "pull-push" }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByTestId("team-token")).toBeInTheDocument();
  });

  it("reloads the status when the embedded team token finishes", async () => {
    let token = tokenInfo({ run: runState({ status: "running" }) });
    const portal = fakePortal(routes({ "GET team-sync/token": () => token, "POST team-sync/token/cancel": () => { token = tokenInfo({ run: runState({ status: "done" }) }); return {}; } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(portal.callsTo("GET", "team-sync/status").length).toBeGreaterThanOrEqual(2));
  });

  it("shows the last error and the open pull request", async () => {
    fakePortal(routes({ [STATUS]: status({ lastError: "401 from GitHub", pendingPullUrl: "https://github.test/pr/1" }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("401 from GitHub")).toBeInTheDocument();
    expect(screen.getByText("Letzter Fehler")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "https://github.test/pr/1" });
    expect(link).toHaveAttribute("href", "https://github.test/pr/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Offener Pull Request:/)).toBeInTheDocument();
  });

  it("disables the sync buttons while GitHub is not connected", async () => {
    fakePortal(routes({ [STATUS]: status({ connected: false, mode: "pull-push" }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByRole("button", { name: "Jetzt synchronisieren" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull Request anlegen" })).toBeDisabled();
  });
});

describe("TeamSyncPanel pull", () => {
  it("checks and shows the state with the preview, then merges", async () => {
    const portal = fakePortal(routes({ "POST team-sync/check": check(), "POST team-sync/apply": {} }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    expect(await screen.findByText("Das Repository hat neue Änderungen.")).toBeInTheDocument();
    expect(screen.getByText("Vorschau: was sich ändert")).toBeInTheDocument();
    expect(screen.getByText(/\+ s-new/)).toBeInTheDocument();
    expect(screen.queryByText(/Beide Seiten haben sich geändert/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Neues hinzufügen (Vorhandenes bleibt)" }));
    expect(await screen.findByText("Team-Sync übernommen.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-sync/apply")[0]?.body).toEqual({ expectSha: "sha-1", resolution: "merge" });
    await waitFor(() => expect(screen.queryByText("Das Repository hat neue Änderungen.")).toBeNull());
    expect(portal.callsTo("GET", "team-sync/status").length).toBeGreaterThanOrEqual(3);
  });

  it("explains a conflict, asks twice before replacing and sends the confirmation", async () => {
    const portal = fakePortal(routes({ "POST team-sync/check": check({ state: "conflict" }), "POST team-sync/apply": {} }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    expect(await screen.findByText(/Beide Seiten haben sich geändert/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Repository übernehmen (ersetzt lokal)" }));
    expect(portal.callsTo("POST", "team-sync/apply")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Wirklich ersetzen/ }));
    await screen.findByText("Team-Sync übernommen.");
    expect(portal.callsTo("POST", "team-sync/apply")[0]?.body).toEqual({ expectSha: "sha-1", resolution: "replace", confirmReplace: true });
  });

  it("keeps the local state on request and cancels the decision", async () => {
    const portal = fakePortal(routes({ "POST team-sync/check": check(), "POST team-sync/apply": {} }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    await user.click(await screen.findByRole("button", { name: "Repository übernehmen (ersetzt lokal)" }));
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText("Das Repository hat neue Änderungen.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Jetzt synchronisieren" }));
    expect(screen.queryByRole("button", { name: /Wirklich ersetzen/ })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Lokal behalten" }));
    await screen.findByText("Team-Sync übernommen.");
    expect(portal.callsTo("POST", "team-sync/apply")[0]?.body).toEqual({ expectSha: "sha-1", resolution: "keep-local" });
  });

  it("offers no decision when there is nothing to take over", async () => {
    fakePortal(routes({ "POST team-sync/check": check({ state: "in-sync", remoteSha: "sha-1", diff: diff({}, true) }) }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    expect(await screen.findByText("Alles gleich: lokal und Repository stimmen überein.")).toBeInTheDocument();
    expect(screen.getByText("Keine Unterschiede.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lokal behalten" })).toBeNull();
  });

  it("shows a check without a preview and without a remote file", async () => {
    fakePortal(routes({ "POST team-sync/check": check({ state: "missing-remote", remoteSha: null, diff: null }) }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    expect(await screen.findByText("Im Repository gibt es die Team-Datei noch nicht.")).toBeInTheDocument();
    expect(screen.queryByText("Vorschau: was sich ändert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Lokal behalten" })).toBeNull();
  });

  it("shows an error when the check fails", async () => {
    fakePortal(routes({ "POST team-sync/check": { status: 502, body: { error: "GitHub unreachable" } } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    expect(await screen.findByText("GitHub unreachable")).toBeInTheDocument();
  });

  it("shows an error when applying fails and keeps the decision open", async () => {
    fakePortal(routes({ "POST team-sync/check": check(), "POST team-sync/apply": { status: 409, body: { error: "remote moved on" } } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    await user.click(await screen.findByRole("button", { name: "Neues hinzufügen (Vorhandenes bleibt)" }));
    expect(await screen.findByText("remote moved on")).toBeInTheDocument();
    expect(screen.getByText("Das Repository hat neue Änderungen.")).toBeInTheDocument();
    expect(screen.queryByText("Team-Sync übernommen.")).toBeNull();
  });
});

describe("TeamSyncPanel push", () => {
  const plan = (over: Partial<PushPlan> = {}): PushPlan => ({ diff: someDiff(), remoteSha: "sha-2", localHash: "hash-1", strategy: "pull-request", targetBranch: "secret-desk/team", ...over });
  const pushRoutes = (over: Record<string, FakeHandler> = {}) => routes({ [STATUS]: status({ mode: "pull-push", pushStrategy: "pull-request" }), ...over });

  it("shows the plan as a pull request, then pushes and links the pull request", async () => {
    const portal = fakePortal(pushRoutes({ "POST team-sync/push-plan": plan(), "POST team-sync/push": { pushed: true, pullRequest: { url: "https://github.test/pr/9" } } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    expect(await screen.findByText("Es wird ein Pull Request gegen main angelegt oder aktualisiert (Zweig secret-desk/team).")).toBeInTheDocument();
    expect(screen.getByText(/\+ s-new/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bestätigen und schieben" }));
    const link = await screen.findByRole("link", { name: "https://github.test/pr/9" });
    expect(link).toHaveAttribute("href", "https://github.test/pr/9");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Pull Request bereit:/)).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-sync/push")[0]?.body).toEqual({ confirm: true, expectLocalHash: "hash-1", expectRemoteSha: "sha-2" });
    expect(screen.queryByRole("button", { name: "Bestätigen und schieben" })).toBeNull();
  });

  it("describes a direct push and a push without a pull request", async () => {
    fakePortal(pushRoutes({ [STATUS]: status({ mode: "pull-push", pushStrategy: "direct" }), "POST team-sync/push-plan": plan({ strategy: "direct", targetBranch: "main" }), "POST team-sync/push": { pushed: true } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Zum Repo schieben" }));
    expect(await screen.findByText("Es wird direkt auf main committet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bestätigen und schieben" }));
    expect(await screen.findByText("Ins Repository geschoben.")).toBeInTheDocument();
    expect(screen.queryByText(/Pull Request bereit/)).toBeNull();
  });

  it("uses an empty branch name in the text when the status has none", async () => {
    fakePortal(pushRoutes({ [STATUS]: status({ mode: "pull-push", branch: null }), "POST team-sync/push-plan": plan() }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    expect(await screen.findByText(/^Es wird ein Pull Request gegen\s+angelegt oder aktualisiert \(Zweig secret-desk\/team\)\.$/)).toBeInTheDocument();
  });

  it("says there is nothing to push and offers no confirmation", async () => {
    fakePortal(pushRoutes({ "POST team-sync/push-plan": plan({ diff: diff({}, true) }) }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    expect(await screen.findByText("Es gibt nichts zu schieben.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bestätigen und schieben" })).toBeNull();
  });

  it("cancels the plan", async () => {
    fakePortal(pushRoutes({ "POST team-sync/push-plan": plan() }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    const confirm = await screen.findByRole("button", { name: "Bestätigen und schieben" });
    await user.click(within(confirm.parentElement!).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("button", { name: "Bestätigen und schieben" })).toBeNull();
  });

  it("shows errors of the plan and of the push", async () => {
    let planFails = true;
    fakePortal(pushRoutes({ "POST team-sync/push-plan": () => (planFails ? { status: 500, body: { error: "plan failed" } } : plan()), "POST team-sync/push": { status: 409, body: { error: "hash changed" } } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    expect(await screen.findByText("plan failed")).toBeInTheDocument();
    planFails = false;
    await user.click(screen.getByRole("button", { name: "Pull Request anlegen" }));
    await user.click(await screen.findByRole("button", { name: "Bestätigen und schieben" }));
    expect(await screen.findByText("hash changed")).toBeInTheDocument();
  });

  it("forgets the link of an earlier pull request when a new plan is loaded", async () => {
    fakePortal(pushRoutes({ "POST team-sync/push-plan": plan(), "POST team-sync/push": { pushed: true, pullRequest: { url: "https://github.test/pr/9" } } }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    await user.click(await screen.findByRole("button", { name: "Bestätigen und schieben" }));
    await screen.findByRole("link", { name: "https://github.test/pr/9" });
    await user.click(screen.getByRole("button", { name: "Pull Request anlegen" }));
    await waitFor(() => expect(screen.queryByText(/Pull Request bereit/)).toBeNull());
  });
});

describe("TeamSyncPanel layout", () => {
  const before = (a: Element, b: Element) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const plan = (): PushPlan => ({ diff: someDiff(), remoteSha: "sha-2", localHash: "hash-1", strategy: "pull-request", targetBranch: "secret-desk/team" });

  it("puts the sync button before the token control and the details", async () => {
    fakePortal(routes({ [STATUS]: status({ mode: "pull-push", pushStrategy: "pull-request" }) }));
    renderApp(<TeamSyncPanel />);
    const sync = await screen.findByRole("button", { name: "Jetzt synchronisieren" });
    before(sync, screen.getByRole("button", { name: "Pull Request anlegen" }));
    before(sync, await screen.findByTestId("team-token"));
    before(sync, screen.getByText("Details"));
  });

  it("puts the apply buttons before the preview diff", async () => {
    fakePortal(routes({ "POST team-sync/check": check() }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Jetzt synchronisieren" }));
    const merge = await screen.findByRole("button", { name: "Neues hinzufügen (Vorhandenes bleibt)" });
    const diffText = screen.getByText(/\+ s-new/);
    before(merge, diffText);
    before(screen.getByRole("button", { name: "Lokal behalten" }), diffText);
    expect(diffText.closest("div.overflow-y-auto")).not.toBeNull();
  });

  it("puts the confirm button before the push plan diff", async () => {
    fakePortal(routes({ [STATUS]: status({ mode: "pull-push", pushStrategy: "pull-request" }), "POST team-sync/push-plan": plan() }));
    const { user } = renderApp(<TeamSyncPanel />);
    await user.click(await screen.findByRole("button", { name: "Pull Request anlegen" }));
    const confirm = await screen.findByRole("button", { name: "Bestätigen und schieben" });
    before(confirm, screen.getByText(/\+ s-new/));
  });

  it("shows errors and the pull request link above the token section", async () => {
    fakePortal(routes({ [STATUS]: status({ lastError: "401 from GitHub" }) }));
    renderApp(<TeamSyncPanel />);
    const error = await screen.findByText("401 from GitHub");
    before(error, await screen.findByTestId("team-token"));
  });
});

describe("TeamSyncPanel token status", () => {
  const manage = async () => (await screen.findByText("Token verwalten")).closest("details")!;

  it("says there is no token yet and opens the token details", async () => {
    fakePortal(routes());
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("Noch kein Team-Token")).toBeInTheDocument();
    await waitFor(async () => expect((await manage()).open).toBe(true));
  });

  it("shows a valid covering token and keeps the details closed", async () => {
    fakePortal(routes({ "GET team-sync/token": tokenInfo({ active: activeToken() }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText(/Team-Token gültig bis/)).toBeInTheDocument();
    expect((await manage()).open).toBe(false);
  });

  it("flags an expired token and opens the details", async () => {
    fakePortal(routes({ "GET team-sync/token": tokenInfo({ active: activeToken({ valid: false }) }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("Team-Token abgelaufen")).toBeInTheDocument();
    await waitFor(async () => expect((await manage()).open).toBe(true));
  });

  it("flags a token that does not cover the mode and opens the details", async () => {
    fakePortal(routes({ [STATUS]: status({ mode: "pull-push", pushStrategy: "pull-request" }), "GET team-sync/token": tokenInfo({ active: activeToken({ mode: "pull" }) }) }));
    renderApp(<TeamSyncPanel />);
    expect(await screen.findByText("Das Team-Token deckt diesen Modus nicht ab")).toBeInTheDocument();
    await waitFor(async () => expect((await manage()).open).toBe(true));
  });

  it("opens the details while a run is active", async () => {
    fakePortal(routes({ "GET team-sync/token": tokenInfo({ active: activeToken(), run: runState({ status: "running" }) }) }));
    renderApp(<TeamSyncPanel />);
    await waitFor(async () => expect((await manage()).open).toBe(true));
  });

  it("opens the details when a revocation is pending", async () => {
    fakePortal(routes({ "GET team-sync/token": tokenInfo({ active: activeToken(), pendingRevocation: { tokenName: "old", repo: "acme/team", since: "2026-01-01", url: "https://github.test/x" } }) }));
    renderApp(<TeamSyncPanel />);
    await waitFor(async () => expect((await manage()).open).toBe(true));
  });

  it("shows no status line and keeps the details closed while the token state is unknown", async () => {
    fakePortal(routes({ "GET team-sync/token": () => new Promise(() => {}) }));
    renderApp(<TeamSyncPanel />);
    expect((await manage()).open).toBe(false);
    expect(screen.queryByText(/Team-Token/)).toBeNull();
  });

  it("shows no token section without repository or mode", async () => {
    fakePortal(routes({ [STATUS]: status({ repo: null, mode: null }) }));
    renderApp(<TeamSyncPanel />);
    await screen.findByText("noch nie");
    expect(screen.queryByText("Token verwalten")).toBeNull();
  });
});
