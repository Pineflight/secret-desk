import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamConfigPicker } from "@/components/TeamConfigPicker";
import { CHOICE_STORAGE_KEY, type SetupChoice } from "@/lib/setup-choice";
import type { ModeAccess, RepoChoice, RepoDiscovery, TeamMode } from "@/lib/team-picker";
import { CREATE_FILE } from "@/lib/team-picker";
import { fakePortal, type FakeHandler, type FakePortal } from "./helpers/portal";
import { drainRequestsAfterEach } from "./helpers/drain";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";
import { runState } from "./helpers/run";
import { activeToken, tokenInfo } from "./helpers/team-token";

drainRequestsAfterEach();

const repoChoice = (name: string, over: Partial<RepoChoice> = {}): RepoChoice => ({ owner: "acme", name, fullName: `acme/${name}`, private: true, archived: false, defaultBranch: "main", pushedAt: "2026-02-03T10:00:00Z", selectable: true, reason: null, ...over });
const repos = (list: RepoChoice[], over: Partial<RepoDiscovery> = {}): RepoDiscovery => ({ source: "github-pat", problem: null, repos: list, preselected: null, truncated: false, ...over });
const access = (mode: TeamMode, over: Partial<ModeAccess> = {}): ModeAccess => ({ source: "github-pat", problem: null, mode, strategy: "pull-request", neededRights: mode === "pull" ? ["Contents: read"] : ["Contents: read and write"], checks: [], ok: true, ...over });
const choice = (over: Partial<SetupChoice> = {}): SetupChoice => ({ repo: "acme/team", branch: "main", file: "team.json", mode: "pull", strategy: "pull-request", confirmed: { repo: true, file: true, mode: true }, ...over });
const seed = (c: SetupChoice) => localStorage.setItem(CHOICE_STORAGE_KEY, JSON.stringify(c));

const BRANCHES = { source: "github-pat", problem: null, branches: ["main", "dev"], defaultBranch: "main", truncated: false };
const FILES = { source: "github-pat", problem: null, files: ["team.json", "other.json"], preselected: "team.json", canCreate: false, createPath: "secret-desk-team.json", truncated: false };

const routes = (over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  "GET team-sync/discovery/repos": repos([repoChoice("team"), repoChoice("other")]),
  "GET team-sync/discovery/branches*": BRANCHES,
  "GET team-sync/discovery/files*": FILES,
  "GET team-sync/discovery/access*": (call) => access(call.path.includes("mode=pull-push") ? "pull-push" : "pull"),
  "GET team-sync/token": tokenInfo(),
  ...over,
});
const picker = (onChange = vi.fn()) => ({ onChange, ui: <TeamConfigPicker onChange={onChange} /> });
const accessCalls = (p: FakePortal) => p.calls.filter((c) => c.path.startsWith("team-sync/discovery/access"));

describe("TeamConfigPicker repository step", () => {
  it("shows a loading line, then the repositories with the server's preselection that still needs a confirmation", async () => {
    const portal = fakePortal(routes({ "GET team-sync/discovery/repos": repos([repoChoice("team"), repoChoice("other", { pushedAt: null })], { preselected: "acme/team" }) }));
    const { ui, onChange } = picker();
    const { user } = renderApp(ui);
    expect(screen.getByText("Wird geladen")).toBeInTheDocument();
    const group = await screen.findByRole("radiogroup", { name: "Repository" });
    expect(await within(group).findByRole("radio", { name: /acme\/team/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /acme\/other/ })).not.toBeChecked();
    expect(group).toHaveTextContent("letzter Push 2026-02-03");
    expect(screen.queryByText("Wähle ein Repository.")).toBeNull();
    await waitFor(() => expect(portal.callsTo("GET", "team-sync/discovery/branches?repo=acme%2Fteam")).toHaveLength(1));
    expect(onChange).toHaveBeenLastCalledWith(null, undefined);
    expect(screen.queryByLabelText("Zweig")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dieses Repository verwenden" }));
    expect(await screen.findByLabelText("Zweig")).toBeInTheDocument();
  });

  it("asks to choose when nothing is preselected and keeps the confirm button disabled", async () => {
    fakePortal(routes());
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findByText("Wähle ein Repository.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dieses Repository verwenden" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /acme\/other/ }));
    expect(screen.getByRole("button", { name: "Dieses Repository verwenden" })).toBeEnabled();
  });

  it("does not preselect a repository that cannot be used", async () => {
    fakePortal(routes({ "GET team-sync/discovery/repos": repos([repoChoice("team", { selectable: false, reason: "public" })], { preselected: "acme/team" }) }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText(/Kein nutzbares Repository passt/)).toBeInTheDocument();
  });

  it("filters by search, says when nothing matches and lists unusable repositories with their reason", async () => {
    fakePortal(routes({ "GET team-sync/discovery/repos": repos([repoChoice("team"), repoChoice("pub", { selectable: false, reason: "public" }), repoChoice("old", { archived: true })], { truncated: true }) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findByText("Nicht nutzbar (2)")).toBeInTheDocument();
    expect(screen.getByText("Öffentliches Repository: Team-Sync braucht ein privates.")).toBeInTheDocument();
    expect(screen.getByText("Archiviertes Repository: Push nicht möglich.")).toBeInTheDocument();
    expect(screen.getByText(/Die Liste ist abgeschnitten/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Repositories durchsuchen"), "zzz");
    expect(await screen.findByText("Kein Repository passt.")).toBeInTheDocument();
    expect(screen.queryByText(/Nicht nutzbar/)).toBeNull();
  });

  it("shows only the first rows and reveals the rest on request, keeping a chosen repository visible", async () => {
    const many = Array.from({ length: 11 }, (_, i) => repoChoice(`r${String(i).padStart(2, "0")}`));
    fakePortal(routes({ "GET team-sync/discovery/repos": repos(many) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findAllByRole("radio")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "3 weitere zeigen" }));
    expect(screen.getAllByRole("radio")).toHaveLength(11);
    expect(screen.queryByRole("button", { name: /weitere zeigen/ })).toBeNull();
  });

  it("hides the show-more button while searching", async () => {
    const many = Array.from({ length: 11 }, (_, i) => repoChoice(`r${String(i).padStart(2, "0")}`));
    fakePortal(routes({ "GET team-sync/discovery/repos": repos(many) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    await screen.findByRole("button", { name: "3 weitere zeigen" });
    await user.type(screen.getByLabelText("Repositories durchsuchen"), "r0");
    await waitFor(() => expect(screen.queryByRole("button", { name: /weitere zeigen/ })).toBeNull());
    expect(screen.getAllByRole("radio")).toHaveLength(10);
  });

  it("collapses the confirmed repository to one line and reopens the list on change", async () => {
    seed(choice({ confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes());
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findByText("acme/team")).toHaveClass("font-mono");
    expect(screen.queryByRole("radiogroup", { name: "Repository" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ändern" }));
    await user.click(await screen.findByRole("radio", { name: /acme\/other/ }));
    await user.click(screen.getByRole("button", { name: "Dieses Repository verwenden" }));
    expect(await screen.findByText("acme/other")).toBeInTheDocument();
    expect(screen.queryByLabelText("Zweig")).toBeInTheDocument();
  });

  it("starts empty when the stored choice is broken", async () => {
    localStorage.setItem(CHOICE_STORAGE_KEY, "{not json");
    fakePortal(routes());
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText("Wähle ein Repository.")).toBeInTheDocument();
  });

  it("remembers the confirmed repository in the browser", async () => {
    fakePortal(routes({ "GET team-sync/discovery/repos": repos([repoChoice("team")], { preselected: "acme/team" }) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    await user.click(await screen.findByRole("button", { name: "Dieses Repository verwenden" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(CHOICE_STORAGE_KEY)!)).toMatchObject({ repo: "acme/team", confirmed: { repo: true } }));
  });
});

describe("TeamConfigPicker problems", () => {
  it("explains a missing integration with the needed rights and retries on request", async () => {
    const portal = fakePortal(routes({ "GET team-sync/discovery/repos": repos([], { problem: { code: "no-integration", neededRights: ["Contents: read"] } }) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findByText("GitHub ist nicht verbunden")).toBeInTheDocument();
    expect(screen.getByText("Nötige Rechte: Contents: read.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Integrationen öffnen" })).toHaveAttribute("href", "/connections");
    expect(screen.getByLabelText("Repositories durchsuchen")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    await waitFor(() => expect(portal.callsTo("GET", "team-sync/discovery/repos")).toHaveLength(2));
  });

  it("shows a short retry line for a rate limit without the rights", async () => {
    fakePortal(routes({ "GET team-sync/discovery/repos": repos([], { problem: { code: "rate-limit", neededRights: [] } }) }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText("GitHub begrenzt die Anfragen")).toBeInTheDocument();
    expect(screen.queryByText(/Nötige Rechte/)).toBeNull();
    expect(screen.getByRole("button", { name: "Erneut prüfen" })).toBeInTheDocument();
  });

  it("shows a problem reported for the branches or for the files", async () => {
    seed(choice({ confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes({ "GET team-sync/discovery/branches*": { ...BRANCHES, branches: [], defaultBranch: null, problem: { code: "missing-permission", neededRights: ["Metadata: read"] } } }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText("Der GitHub-Integration fehlt ein Recht")).toBeInTheDocument();
    expect(screen.getByLabelText("Zweig")).toBeDisabled();
  });

  it("shows a problem reported for the files", async () => {
    seed(choice({ confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes({ "GET team-sync/discovery/files*": { ...FILES, files: [], preselected: null, problem: { code: "token-rejected", neededRights: [] } } }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText("GitHub hat den Zugriff abgelehnt")).toBeInTheDocument();
  });

  it("shows a short line when GitHub cannot be reached and reloads on retry", async () => {
    let fail = true;
    const portal = fakePortal(routes({ "GET team-sync/discovery/repos": () => (fail ? { status: 502, body: { error: "bad gateway" } } : repos([repoChoice("team")])) }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    expect(await screen.findByText("GitHub ist nicht erreichbar.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    expect(await screen.findByRole("radio", { name: /acme\/team/ })).toBeInTheDocument();
    expect(portal.callsTo("GET", "team-sync/discovery/repos")).toHaveLength(2);
    expect(screen.queryByText("GitHub ist nicht erreichbar.")).toBeNull();
  });
});

describe("TeamConfigPicker branch and file", () => {
  it("offers the branches with the default marked, preselects it and the conventional file, and confirms the file", async () => {
    seed(choice({ branch: "", file: "", confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes());
    const { ui } = picker();
    const { user } = renderApp(ui);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Zweig" })).toHaveTextContent("main (Standard)"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Pfad der Datei" })).toHaveTextContent("team.json"));
    await user.click(screen.getByRole("button", { name: "Diese Datei verwenden" }));
    expect(await screen.findByRole("radiogroup", { name: "Modus" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diese Datei verwenden" })).toBeNull();
  });

  it("resets the file when another branch is chosen and sends it to the file discovery", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    const portal = fakePortal(routes());
    const { ui } = picker();
    const { user } = renderApp(ui);
    await screen.findByRole("radiogroup", { name: "Modus" });
    await pickOption(user, "Zweig", "dev");
    await waitFor(() => expect(portal.callsTo("GET", "team-sync/discovery/files?repo=acme%2Fteam&branch=dev")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Diese Datei verwenden" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Modus" })).toBeNull();
    await pickOption(user, "Pfad der Datei", "other.json");
    expect(screen.getByRole("combobox", { name: "Pfad der Datei" })).toHaveTextContent("other.json");
  });

  it("falls back to creating the file when none exists, explains it and forces the write mode", async () => {
    seed(choice({ file: "", confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes({ "GET team-sync/discovery/files*": { ...FILES, files: [], preselected: null, canCreate: true } }));
    const { ui, onChange } = picker();
    const { user } = renderApp(ui);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Pfad der Datei" })).toHaveTextContent("Neue Datei secret-desk-team.json"));
    expect(screen.getByText("Neue Datei, wird vom ersten Push angelegt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Diese Datei verwenden" }));
    await screen.findByRole("radiogroup", { name: "Modus" });
    expect(screen.getByRole("radio", { name: /nur lesen/ })).toBeDisabled();
    expect(screen.getByText("Eine neue Datei entsteht nur durch einen Push.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /lesen und schieben/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Diesen Modus verwenden" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ createFile: true, path: "secret-desk-team.json", mode: "pull-push" }), expect.anything()));
    expect(CREATE_FILE).toBe("__create__");
  });

  it("shows the create hint with an empty path before the file discovery answers", async () => {
    seed(choice({ file: CREATE_FILE, confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes({ "GET team-sync/discovery/files*": () => new Promise(() => {}) }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByText("Neue Datei, wird vom ersten Push angelegt")).toBeInTheDocument();
    expect(screen.getByLabelText("Pfad der Datei")).toBeDisabled();
  });

  it("keeps the confirm button for the file disabled while there is no path", async () => {
    seed(choice({ branch: "main", file: "", confirmed: { repo: true, file: false, mode: false } }));
    fakePortal(routes({ "GET team-sync/discovery/files*": { ...FILES, files: [], preselected: null, canCreate: false } }));
    const { ui } = picker();
    renderApp(ui);
    expect(await screen.findByRole("button", { name: "Diese Datei verwenden" })).toBeDisabled();
  });
});

describe("TeamConfigPicker mode and token", () => {
  it("checks both modes and reports the selection once all steps are confirmed", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    const portal = fakePortal(routes());
    const { ui, onChange } = picker();
    const { user } = renderApp(ui);
    const group = await screen.findByRole("radiogroup", { name: "Modus" });
    await waitFor(() => expect(within(group).getAllByText(/✓ Bereit/)).toHaveLength(2));
    expect(accessCalls(portal)).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith(null, expect.anything());
    await user.click(screen.getByRole("button", { name: "Diesen Modus verwenden" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ repo: "acme/team", branch: "main", path: "team.json", createFile: false, mode: "pull", strategy: "pull-request" }, expect.objectContaining({ mode: "pull" })));
    expect(await screen.findByTestId("team-token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diesen Modus verwenden" })).toBeNull();
  });

  it("switches to the write mode, offers the push strategy and sends it with the checks", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: true } }));
    const portal = fakePortal(routes());
    const { ui, onChange } = picker();
    const { user } = renderApp(ui);
    await user.click(await screen.findByRole("radio", { name: /lesen und schieben/ }));
    await pickOption(user, "Schieben per", "direkter Commit");
    expect(portal.calls.some((c) => c.path.includes("mode=pull-push") && c.path.includes("strategy=direct"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Diesen Modus verwenden" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "pull-push", strategy: "direct" }), expect.anything()));
  });

  it("shows how long the own team token is valid, and a plain ready line without a date", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    let info = tokenInfo({ active: activeToken({ expires: "2030-05-06" }) });
    fakePortal(routes({ "GET team-sync/token": () => info, "GET team-sync/discovery/access*": (call) => access(call.path.includes("mode=pull-push") ? "pull-push" : "pull", { source: "own" }) }));
    const { ui } = picker();
    const first = renderApp(ui);
    expect(await screen.findAllByText(/Bereit · Team-Token, gültig bis 06\.05\.2030/)).toHaveLength(2);
    first.unmount();
    info = tokenInfo({ active: activeToken({ expires: null }) });
    renderApp(ui);
    expect((await screen.findAllByText(/Bereit · Team-Token/)).length).toBe(2);
  });

  it("shows a calm line while a team token can fix a missing right, and a warning with a link otherwise", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    const needs = (mode: TeamMode) => access(mode, { ok: false, neededRights: ["Contents: write"] });
    let info = tokenInfo({ available: true });
    fakePortal(routes({ "GET team-sync/token": () => info, "GET team-sync/discovery/access*": (call) => needs(call.path.includes("mode=pull-push") ? "pull-push" : "pull") }));
    const { ui } = picker();
    const first = renderApp(ui);
    expect((await screen.findAllByText("Team-Token nötig")).length).toBe(2);
    first.unmount();
    info = tokenInfo({ available: false, reason: "automation-off" });
    renderApp(ui);
    expect((await screen.findAllByText(/⚠ Braucht Contents: write/)).length).toBe(2);
    expect(screen.getAllByRole("link", { name: "GitHub-Token beheben" })).toHaveLength(2);
  });

  it("names a dash when the needed rights are unknown", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    fakePortal(routes({ "GET team-sync/token": tokenInfo({ available: false }), "GET team-sync/discovery/access*": (call) => access(call.path.includes("mode=pull-push") ? "pull-push" : "pull", { ok: false, neededRights: [] }) }));
    const { ui } = picker();
    renderApp(ui);
    expect((await screen.findAllByText(/⚠ Braucht …/)).length).toBe(2);
  });

  it("shows the checking state until the checks answer and lists failed checks under the details", async () => {
    seed(choice({ confirmed: { repo: true, file: true, mode: false } }));
    const failing = [{ id: "c1", label: "Contents", status: "fail" as const, detail: "no write access" }, { id: "c2", label: "Metadata", status: "fail" as const }, { id: "c3", label: "Fine", status: "pass" as const }];
    fakePortal(routes({ "GET team-sync/discovery/access*": (call) => access(call.path.includes("mode=pull-push") ? "pull-push" : "pull", { ok: false, checks: failing, neededRights: [] }) }));
    const { ui } = picker();
    renderApp(ui);
    expect((await screen.findAllByText("Integration wird geprüft…")).length).toBeGreaterThan(0);
    const details = (await screen.findByText("Details")).closest("details")!;
    await waitFor(() => expect(within(details).getAllByText("no write access")).toHaveLength(2));
    expect(within(details).getAllByText("Metadata")).toHaveLength(2);
    expect(within(details).queryByText("Fine")).toBeNull();
    expect(within(details).getAllByText("Nötig bei GitHub: …")).toHaveLength(2);
  });

  it("re-checks the modes and reloads the token when a team token was created in step four", async () => {
    seed(choice());
    let token = tokenInfo({ run: runState({ status: "running" }) });
    const portal = fakePortal(routes({ "GET team-sync/token": () => token, "POST team-sync/token/cancel": () => { token = tokenInfo({ active: activeToken(), run: runState({ status: "done" }) }); return {}; } }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    await screen.findAllByText(/✓ Bereit/);
    const before = accessCalls(portal).length;
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(accessCalls(portal).length).toBeGreaterThan(before));
  });
});

describe("TeamConfigPicker other token", () => {
  it("keeps the button disabled without a token, saves a typed one and starts over", async () => {
    seed(choice());
    const portal = fakePortal(routes({ "POST connections/team-sync/token": {} }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    await screen.findByRole("radiogroup", { name: "Modus" });
    await user.click(screen.getByText("Anderes Token verwenden"));
    const save = screen.getByRole("button", { name: "Dieses Token verwenden" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zugangs-Token"), { target: { value: "token-for-tests" } });
    await user.click(save);
    await waitFor(() => expect(portal.callsTo("POST", "connections/team-sync/token")).toHaveLength(1));
    expect(portal.callsTo("POST", "connections/team-sync/token")[0]?.body).toEqual({ token: "token-for-tests" });
    await waitFor(() => expect(portal.callsTo("GET", "team-sync/discovery/repos")).toHaveLength(2));
    expect(screen.getByLabelText("Zugangs-Token")).toHaveValue("");
    await waitFor(() => expect(localStorage.getItem(CHOICE_STORAGE_KEY)).not.toBe(JSON.stringify(choice())));
  });

  it("shows a failure to save the token", async () => {
    fakePortal(routes({ "POST connections/team-sync/token": { status: 400, body: { error: "token refused" } } }));
    const { ui } = picker();
    const { user } = renderApp(ui);
    await screen.findByText("Wähle ein Repository.");
    await user.click(screen.getByText("Anderes Token verwenden"));
    fireEvent.change(screen.getByLabelText("Zugangs-Token"), { target: { value: "token-for-tests" } });
    await user.click(screen.getByRole("button", { name: "Dieses Token verwenden" }));
    expect(await screen.findByText("token refused")).toBeInTheDocument();
  });
});
