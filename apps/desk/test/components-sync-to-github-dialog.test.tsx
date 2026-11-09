import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncLine, SyncOutcome, SyncPlan } from "@secret-desk/core";
import { SyncToGitHubDialog } from "@/components/SyncToGitHubDialog";
import { fakePortal, type FakeHandler } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const line = (over: Partial<SyncLine> = {}): SyncLine => ({
  key: "variable:v1:web",
  kind: "variable",
  entryId: "v1",
  name: "API_URL",
  repo: "acme/web",
  place: { repo: "acme/web", scope: "repository" },
  placeLabel: "Repository",
  stage: "staging",
  production: false,
  action: "set",
  reason: "missing",
  defaultOn: true,
  ...over,
});
const plan = (lines: SyncLine[], over: Partial<SyncPlan> = {}): SyncPlan => ({
  generatedAt: "2026-01-01T00:00:00Z",
  lines,
  counts: { set: 1, write: 0, skip: 0, unchanged: 3 },
  hasProduction: lines.some((l) => l.production),
  ...over,
});
const outcome = (l: SyncLine, o: SyncOutcome["outcome"] = "created", error?: string): SyncOutcome => ({ key: l.key, kind: l.kind, entryId: l.entryId, name: l.name, placeLabel: l.placeLabel, outcome: o, ...(error ? { error } : {}) });
const PLAN = "POST compare/sync-plan";
const SYNC = "POST compare/sync";
const dialog = (props: Partial<Parameters<typeof SyncToGitHubDialog>[0]> = {}) => <SyncToGitHubDialog onClose={() => {}} onDone={() => {}} {...props} />;
const sync = (lines: SyncLine[]): FakeHandler => (call) => {
  const keys = (call.body as { keys: string[] }).keys;
  return { outcomes: lines.filter((l) => keys.includes(l.key)).map((l) => outcome(l)), ok: keys.length, failed: 0 };
};

describe("SyncToGitHubDialog plan", () => {
  it("shows a skeleton first, then the grouped plan with counts and reasons", async () => {
    const lines = [
      line(),
      line({ key: "secret:s1:web", kind: "secret", entryId: "s1", name: "TOKEN", action: "write", reason: "github-newer", defaultOn: false, warning: "github-newer", production: true, renewable: true, detail: "403 from GitHub", placeLabel: "Environment production" }),
      line({ key: "variable:v2:web", name: "SKIPPED", action: "skip", reason: "no-value", defaultOn: false }),
      line({ key: "variable:v3:api", name: "OTHER", repo: "acme/api" }),
    ];
    fakePortal({ [PLAN]: plan(lines, { counts: { set: 2, write: 1, skip: 1, unchanged: 5 } }) });
    renderApp(dialog());
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeInTheDocument();
    expect(await screen.findByText("2 Variablen setzen, 1 Secrets schreiben, 1 übersprungen, 5 Variablen schon gleich.")).toBeInTheDocument();
    const web = screen.getByRole("region", { name: "acme/web" });
    const names = within(web).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent ?? "");
    expect(names[0]).toContain("API_URL");
    expect(names[1]).toContain("TOKEN");
    expect(names[2]).toContain("SKIPPED");
    expect(web).toHaveTextContent("Wird überschrieben, GitHub ist neuer als das Inventar · Produktion · Wert mit „Erneuern“ erzeugen · 403 from GitHub");
    expect(web).toHaveTextContent("GitHub wurde nach dem Inventar geändert.");
    expect(within(web).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByLabelText("API_URL einschließen")).toBeChecked();
    expect(screen.getByLabelText("TOKEN einschließen")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "2 Änderungen nach GitHub schreiben" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "acme/api" })).toBeInTheDocument();
  });

  it("sends the repository filter and says there is nothing to write", async () => {
    const portal = fakePortal({ [PLAN]: plan([line({ action: "skip", defaultOn: false })], { counts: { set: 0, write: 0, skip: 1, unchanged: 0 } }) });
    renderApp(dialog({ repo: "acme/web" }));
    expect(await screen.findByText("Nichts zu schreiben: GitHub entspricht dem Inventar.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "compare/sync-plan")[0]?.body).toEqual({ repo: "acme/web" });
    expect(screen.getByRole("button", { name: "0 Änderungen nach GitHub schreiben" })).toBeDisabled();
  });

  it("sends an empty body without a repository filter", async () => {
    const portal = fakePortal({ [PLAN]: plan([line()]) });
    renderApp(dialog());
    await screen.findByRole("region", { name: "acme/web" });
    expect(portal.callsTo("POST", "compare/sync-plan")[0]?.body).toEqual({});
  });

  it("shows a failed plan with a retry", async () => {
    let fail = true;
    const portal = fakePortal({ [PLAN]: () => (fail ? { status: 500, body: { error: "GitHub offline" } } : plan([line()])) });
    const { user } = renderApp(dialog());
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub offline");
    fail = false;
    await user.click(screen.getByRole("button", { name: /Erneut versuchen/ }));
    expect(await screen.findByRole("region", { name: "acme/web" })).toBeInTheDocument();
    expect(portal.callsTo("POST", "compare/sync-plan")).toHaveLength(2);
  });

  it("changes the selection and the button count", async () => {
    fakePortal({ [PLAN]: plan([line(), line({ key: "variable:v2:web", name: "B_VAR" })]) });
    const { user } = renderApp(dialog());
    const box = await screen.findByLabelText("API_URL einschließen");
    await user.click(box);
    expect(screen.getByRole("button", { name: "1 Änderungen nach GitHub schreiben" })).toBeEnabled();
    await user.click(screen.getByLabelText("B_VAR einschließen"));
    expect(screen.getByRole("button", { name: "0 Änderungen nach GitHub schreiben" })).toBeDisabled();
    await user.click(box);
    expect(screen.getByRole("button", { name: "1 Änderungen nach GitHub schreiben" })).toBeEnabled();
  });

  it("closes through cancel", async () => {
    fakePortal({ [PLAN]: plan([line()]) });
    const onClose = vi.fn();
    const { user } = renderApp(dialog({ onClose }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SyncToGitHubDialog run", () => {
  it("writes the selection, reports the result, calls onDone and closes through the summary", async () => {
    const lines = [line(), line({ key: "variable:v2:web", name: "B_VAR" })];
    const onDone = vi.fn();
    const onClose = vi.fn();
    const portal = fakePortal({ [PLAN]: plan(lines), [SYNC]: sync(lines) });
    const { user } = renderApp(dialog({ onDone, onClose, repo: "acme/web" }));
    await user.click(await screen.findByRole("button", { name: "2 Änderungen nach GitHub schreiben" }));
    expect(await screen.findByText("2 geschrieben, 0 fehlgeschlagen, 0 übersprungen.")).toBeInTheDocument();
    expect(await screen.findByText("2 Änderungen nach GitHub geschrieben.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "compare/sync")[0]?.body).toEqual({ keys: ["variable:v1:web", "variable:v2:web"], confirmProduction: false, repo: "acme/web" });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("splits a long selection into batches and shows the progress while it runs", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => line({ key: `variable:v${i}:web`, entryId: `v${i}`, name: `VAR_${String(i).padStart(2, "0")}` }));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const portal = fakePortal({
      [PLAN]: plan(lines),
      [SYNC]: async (call) => {
        if (n++ === 1) await gate;
        return sync(lines)(call);
      },
    });
    const { user } = renderApp(dialog());
    await user.click(await screen.findByRole("button", { name: "25 Änderungen nach GitHub schreiben" }));
    expect(await screen.findByText("Schreibe … 20 von 25")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeDisabled();
    expect(screen.getByLabelText("VAR_00 einschließen")).toBeDisabled();
    release();
    expect(await screen.findByText("25 geschrieben, 0 fehlgeschlagen, 0 übersprungen.")).toBeInTheDocument();
    expect(portal.callsTo("POST", "compare/sync").map((c) => (c.body as { keys: string[] }).keys.length)).toEqual([20, 5]);
  });

  it("does not close while running", async () => {
    const lines = [line()];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    fakePortal({ [PLAN]: plan(lines), [SYNC]: async (call) => { await gate; return sync(lines)(call); } });
    const onClose = vi.fn();
    const { user } = renderApp(dialog({ onClose }));
    await user.click(await screen.findByRole("button", { name: "1 Änderungen nach GitHub schreiben" }));
    await screen.findByText(/Schreibe …/);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Dialog schließen" }));
    expect(onClose).not.toHaveBeenCalled();
    release();
    await screen.findByText(/1 geschrieben/);
  });

  it("requires the production confirmation before a selected live line can be written", async () => {
    const lines = [line({ production: true }), line({ key: "variable:v2:web", name: "B_VAR" })];
    const portal = fakePortal({ [PLAN]: plan(lines), [SYNC]: sync(lines) });
    const { user } = renderApp(dialog());
    const confirm = await screen.findByRole("button", { name: "2 Änderungen nach GitHub schreiben" });
    expect(screen.getByText("Produktion betroffen")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.click(screen.getByLabelText("Ich weiß, dass dieser Wert die Produktion betrifft."));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await screen.findByText(/2 geschrieben/);
    expect(portal.callsTo("POST", "compare/sync")[0]?.body).toMatchObject({ confirmProduction: true });
  });

  it("needs no confirmation when the live line is deselected", async () => {
    const lines = [line({ production: true }), line({ key: "variable:v2:web", name: "B_VAR" })];
    fakePortal({ [PLAN]: plan(lines) });
    const { user } = renderApp(dialog());
    await user.click(await screen.findByLabelText("API_URL einschließen"));
    expect(screen.queryByText("Produktion betroffen")).toBeNull();
    expect(screen.getByRole("button", { name: "1 Änderungen nach GitHub schreiben" })).toBeEnabled();
  });

  it("lists failed lines and does not call onDone when nothing was written", async () => {
    const lines = [line(), line({ key: "variable:v2:web", name: "B_VAR" })];
    const onDone = vi.fn();
    fakePortal({
      [PLAN]: plan(lines),
      [SYNC]: { outcomes: [outcome(lines[0]!, "failed", "403 forbidden"), outcome(lines[1]!, "skipped", "ignored")], ok: 0, failed: 1 },
    });
    const { user } = renderApp(dialog({ onDone }));
    await user.click(await screen.findByRole("button", { name: "2 Änderungen nach GitHub schreiben" }));
    expect(await screen.findByText("0 geschrieben, 1 fehlgeschlagen, 1 übersprungen.")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("API_URL · Repository: 403 forbidden");
    expect(await screen.findByText("0 geschrieben, 1 fehlgeschlagen.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keeps the batches done so far when a later request fails and counts the unsent ones as failed", async () => {
    const lines = Array.from({ length: 22 }, (_, i) => line({ key: `variable:v${i}:web`, entryId: `v${i}`, name: `VAR_${String(i).padStart(2, "0")}` }));
    let n = 0;
    const onDone = vi.fn();
    fakePortal({ [PLAN]: plan(lines), [SYNC]: (call) => (n++ === 0 ? sync(lines)(call) : { status: 502, body: { error: "gateway down" } }) });
    const { user } = renderApp(dialog({ onDone }));
    await user.click(await screen.findByRole("button", { name: "22 Änderungen nach GitHub schreiben" }));
    expect(await screen.findByText("gateway down")).toBeInTheDocument();
    expect(screen.getByText("20 geschrieben, 0 fehlgeschlagen, 0 übersprungen.")).toBeInTheDocument();
    expect(await screen.findByText("20 geschrieben, 2 fehlgeschlagen.")).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
