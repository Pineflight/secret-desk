import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ComparePage from "@/app/compare/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";
import { pick } from "../helpers/select";
import { NA, STAGES, cell, repoInfo, result, row } from "./compare-fixtures";

const LIVE = "compare?live=1&all=1&workflows=1";
const compare = (payload: Record<string, unknown> | FakeHandler, routes: Record<string, FakeHandler> = {}) =>
  fakePortal({ "GET compare?": payload as FakeHandler, [`GET ${LIVE}`]: payload as FakeHandler, "GET compare?normalize=1": payload as FakeHandler, "GET stages": STAGES.map((s) => ({ id: s.id, kind: s.kind, label: s.label, environmentName: s.environment, usage: {} })), ...routes });

const consistent = row("web", "A_KEY", { staging: cell("ok", true, true), production: cell("ok", true, true) }, { parity: "consistent" });
const gap = row("web", "B_KEY", { staging: cell("ok", true, true), production: cell("missing", true, false, { targets: ["web/env:production"], missingAt: ["web/env:production"] }) }, { parity: "gap", missingIn: ["production"], ids: ["b-1", "b-2", "b-3"], names: ["B_KEY_STAGING", "B_KEY_PROD"] });
const variable = row("api", "C_VAR", { staging: cell("ok", true, true), production: cell("different", true, true, { expectedValues: ["1"], actualValues: ["2"] }) }, { kind: "variable", ids: ["c-var"] });
const orphan = row("api", "D_KEY", { staging: cell("unexpected", false, true, { actualNames: ["D_KEY_OLD"] }) }, { ids: [] });
const errored = row("api", "E_KEY", { staging: cell("error", true, undefined, { error: { target: "api/env:staging", message: "403 forbidden" } }) });

describe("Compare page: states", () => {
  it("shows a skeleton, then an empty state without rows", async () => {
    compare(result());
    const { container } = renderApp(<ComparePage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
    expect(await screen.findByText(t("compare.emptyFirst"))).toBeInTheDocument();
    const status = screen.getByText(t("compare.statusOffline"));
    expect(status).toHaveAttribute("title", t("compare.offlineNotice"));
    expect(screen.queryByText(t("compare.offlineNotice"))).toBeNull();
  });

  it("keeps the write-to-GitHub action in the page header, disabled until the data is there", async () => {
    compare(result({ rows: [consistent] }));
    renderApp(<ComparePage />);
    expect(screen.getByRole("button", { name: t("compare.sync.button") })).toBeDisabled();
    await ready();
    expect(screen.getByRole("button", { name: t("compare.sync.button") })).toBeEnabled();
  });

  it("shows the error and retries", async () => {
    let fail = true;
    compare(() => (fail ? { status: 500, body: { error: "compare broke" } } : result()));
    const { user } = renderApp(<ComparePage />);
    expect(await screen.findByText("compare broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("compare.emptyFirst"))).toBeInTheDocument();
  });

  it("lists rows by repository with cells, parity and a summary", async () => {
    compare(result({ live: true, rows: [consistent, gap, variable, orphan, errored] }));
    renderApp(<ComparePage />);
    expect(await screen.findByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeInTheDocument();
    expect(screen.getAllByText(t("compare.parityConsistent")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("compare.parityGap", { stages: "Production" })).length).toBeGreaterThan(0);
    expect(screen.getByText("B_KEY_STAGING, B_KEY_PROD")).toBeInTheDocument();
    expect(screen.getByText(/b-1, b-2 …/)).toBeInTheDocument();
    expect(screen.getByTitle("403 forbidden")).toBeInTheDocument();
    expect(screen.getAllByText(t("compare.groupGaps", { count: 1 })).length).toBeGreaterThan(0);
  });

  it("lists every repository only once and orders gaps first", async () => {
    compare(result({ live: true, rows: [consistent, gap] }));
    renderApp(<ComparePage />);
    await screen.findByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) });
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf(t("compare.rowAria", { name: "B_KEY" }))).toBeLessThan(labels.indexOf(t("compare.rowAria", { name: "A_KEY" })));
  });
});

const needed = row("web", "NEEDED_KEY", { staging: cell("needed", false, undefined, { neededBy: ["deploy.yml"], actualNames: ["NEEDED_KEY"] }), production: cell("not-expected") }, { ids: [], neededMissing: true, needs: [{ file: "deploy.yml" }, { file: "release.yml", environment: "production" }] });
const lowerNeeded = row("web", "lower_key", { staging: cell("needed", false, undefined, { neededBy: ["deploy.yml"] }), production: cell("not-expected") }, { ids: [], neededMissing: true, needs: [{ file: "deploy.yml" }], kind: "variable" });
const mismatch = row("web", "LEVEL_KEY", { staging: cell("level-mismatch", false, undefined, { inventoryStages: ["production"] }), production: cell("ok", true, true) }, { levelMismatch: true, needs: [{ file: "ci.yml" }] });
const others = row("web", "OTHER_KEY", { staging: cell("ok", true, true), production: cell("ok", true, true) }, { other: { present: ["preview"], needed: ["", "qa"] }, needs: [{ file: "x.yml", environment: "qa" }] });
const plain = row("web", "PLAIN_KEY", { staging: cell("ok", true, true), production: cell("ok", true, true) }, { other: { present: [], needed: [] } });
const liveResult = (over: Record<string, unknown> = {}) => result({ live: true, rows: [consistent, gap, variable, orphan, errored], ...over });
const ready = async () => screen.findByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) });

describe("Compare page: live reading", () => {
  it("reads GitHub only after the person asks for it and reloads on request", async () => {
    const portal = compare(liveResult());
    const { user } = renderApp(<ComparePage />);
    await ready();
    expect(portal.callsTo("GET", LIVE)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: t("compare.refresh") })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.live")) }));
    await waitFor(() => expect(portal.callsTo("GET", LIVE)).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: t("compare.refresh") }));
    await waitFor(() => expect(portal.callsTo("GET", LIVE).length).toBeGreaterThanOrEqual(2));
  });

  it("can leave out the repository list and the workflows", async () => {
    const portal = compare(liveResult(), { "GET compare?live=1&workflows=1": liveResult(), "GET compare?live=1": liveResult() });
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.live")) }));
    await user.click(await screen.findByRole("checkbox", { name: new RegExp(t("compare.allRepos")) }));
    await waitFor(() => expect(portal.callsTo("GET", "compare?live=1&workflows=1")).toHaveLength(1));
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.workflows")) }));
    await waitFor(() => expect(portal.callsTo("GET", "compare?live=1")).toHaveLength(1));
  });

  it("shows the loading notice while GitHub is read", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    compare(liveResult(), { [`GET ${LIVE}`]: () => gate.then(() => liveResult()) });
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.live")) }));
    expect(await screen.findByText(t("compare.liveLoading"))).toBeInTheDocument();
    await act(async () => {
      release(undefined);
      await gate;
    });
    const status = await screen.findByText(t("compare.statusLive"));
    expect(status).toHaveAttribute("title", t("compare.liveNotice"));
  });

  it("lists read errors of the targets", async () => {
    compare(liveResult({ errors: [{ target: "web/env:production", message: "429 rate limited" }] }));
    renderApp(<ComparePage />);
    expect(await screen.findByText("429 rate limited", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(t("compare.errorsTitle"))).toBeInTheDocument();
  });

  it("asks for the normalized names", async () => {
    const portal = compare(liveResult());
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.normalize")) }));
    await waitFor(() => expect(portal.callsTo("GET", "compare?normalize=1")).toHaveLength(1));
  });
});

describe("Compare page: summary and repositories", () => {
  it("shows the stage totals live, with errors, needs and level differences", async () => {
    compare(liveResult({ rows: [consistent, gap, errored, needed, mismatch] }));
    renderApp(<ComparePage />);
    await ready();
    expect(screen.getAllByText(t("compare.sumError")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("compare.sumNeeded")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("compare.sumLevelMismatch")).length).toBeGreaterThan(0);
    expect(screen.getByText(t("compare.sumNeededRows", { count: 1 }), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(t("compare.sumLevelMismatchRows", { count: 1 }), { exact: false })).toBeInTheDocument();
  });

  it("shows dashes instead of live numbers when GitHub was not read", async () => {
    compare(result({ rows: [consistent] }));
    renderApp(<ComparePage />);
    await ready();
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
    expect(screen.getByText(t("compare.sumOffline"), { exact: false })).toBeInTheDocument();
  });

  it("lists ignored repositories", async () => {
    compare(liveResult({ ignored: [".github", ".github-private"] }));
    renderApp(<ComparePage />);
    expect(await screen.findByText(".github, .github-private", { exact: false })).toBeInTheDocument();
  });

  it("explains repositories that GitHub no longer knows and offers renaming where GitHub says the new name", async () => {
    const portal = compare(liveResult({ repos: [repoInfo("old-name", { onGitHub: false, renamedTo: "new-name" }), repoInfo("deleted-repo", { onGitHub: false })] }), {
      "POST repos/old-name/rename": { from: "old-name", to: "new-name", changed: 2 },
    });
    const { user } = renderApp(<ComparePage />);
    expect(await screen.findByText(t("compare.repoRenamed", { name: "new-name" }))).toBeInTheDocument();
    expect(screen.getByText(t("compare.repoGone"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("repos.renameInventoryAria", { from: "old-name", to: "new-name" }) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("repos.renameInventory") }));
    await waitFor(() => expect(portal.callsTo("POST", "repos/old-name/rename")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the rename dialog without renaming", async () => {
    const portal = compare(liveResult({ repos: [repoInfo("old-name", { onGitHub: false, renamedTo: "new-name" })] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: t("repos.renameInventoryAria", { from: "old-name", to: "new-name" }) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("repos.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(portal.callsTo("POST", "repos/old-name/rename")).toHaveLength(0);
  });

  it("lists repositories without any entry and the notes of the repositories", async () => {
    compare(
      liveResult({
        repos: [
          repoInfo("web", { notes: [{ code: "contents-forbidden", message: "needs Contents: Read" }, { code: "parse-error", file: "ci.yml", target: "web" }] }),
          repoInfo("empty-a", { inInventory: false, private: true, pushedAt: "2026-03-04T00:00:00Z", found: { secrets: 0, variables: 0 } }),
          repoInfo("empty-b", { inInventory: false, private: false, pushedAt: null, found: { secrets: 0, variables: 0 } }),
          repoInfo("empty-c", { inInventory: false, private: null, pushedAt: null, found: { secrets: 0, variables: 0 } }),
        ],
      }),
    );
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByText(t("compare.emptyReposTitle"), { exact: false }));
    expect(screen.getByText("empty-a")).toBeInTheDocument();
    expect(screen.getByText(t("compare.repoPrivate"))).toBeInTheDocument();
    expect(screen.getByText(t("compare.repoPublic"))).toBeInTheDocument();
    expect(screen.getByText("2026-03-04")).toBeInTheDocument();
    await user.click(screen.getByText(t("compare.notesTitle"), { exact: false }));
    expect(screen.getByText(t("compare.note.parse-error", { file: "ci.yml", target: "web" }))).toBeInTheDocument();
  });

  it("says when every repository has entries", async () => {
    compare(liveResult({ repos: [repoInfo("web")] }));
    renderApp(<ComparePage />);
    await ready();
    expect(screen.getByText(t("compare.emptyReposNone"))).toBeInTheDocument();
  });
});

describe("Compare page: filters, stages and hiding", () => {
  it("filters by repository, kind and search text", async () => {
    compare(liveResult());
    const { user } = renderApp(<ComparePage />);
    await ready();
    await pick(user, screen.getByLabelText(t("compare.filterRepo")), "api");
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeNull();
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "C_VAR" }) })).toBeInTheDocument();
    await pick(user, screen.getByLabelText(t("compare.kind")), t("compare.kindVariable"));
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "D_KEY" }) })).toBeNull();
    await pick(user, screen.getByLabelText(t("compare.kind")), t("compare.all"));
    await user.type(screen.getByLabelText(t("compare.search")), "e_key");
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "E_KEY" }) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "C_VAR" }) })).toBeNull();
  });

  it("says why nothing is shown: a filter without a match, or no deviation", async () => {
    compare(liveResult({ rows: [consistent] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: t("compare.onlyDeviations") }));
    expect(await screen.findByText(t("compare.noDeviations"))).toBeInTheDocument();
    await user.type(screen.getByLabelText(t("compare.search")), "zzz");
    expect(await screen.findByText(t("compare.emptyFiltered"))).toBeInTheDocument();
  });

  it("can put gaps after the other rows", async () => {
    compare(liveResult({ rows: [consistent, gap] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: t("compare.gapsFirst") }));
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf(t("compare.rowAria", { name: "A_KEY" }))).toBeLessThan(labels.indexOf(t("compare.rowAria", { name: "B_KEY" })));
  });

  it("offers the workflow filter when workflows need names and filters to the missing ones", async () => {
    compare(liveResult({ rows: [consistent, needed] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: t("compare.onlyNeeded") }));
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeNull();
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "NEEDED_KEY" }) })).toBeInTheDocument();
  });

  it("shows level differences only on request", async () => {
    compare(liveResult({ rows: [consistent, mismatch] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("checkbox", { name: t("compare.onlyNeeded") }));
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "LEVEL_KEY" }) })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.showLevelMismatch")) }));
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "LEVEL_KEY" }) })).toBeInTheDocument();
  });

  it("changes the compared stages with the stage buttons", async () => {
    compare(liveResult({ rows: [consistent, gap] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    const group = within(screen.getByRole("group", { name: t("compare.stagesLabel") }));
    expect(group.getByRole("button", { name: "Staging" })).toHaveAttribute("aria-pressed", "true");
    expect(group.getByRole("button", { name: "dev" })).toHaveAttribute("aria-pressed", "false");
    await user.click(group.getByRole("button", { name: "dev" }));
    expect(group.getByRole("button", { name: "dev" })).toHaveAttribute("aria-pressed", "true");
    await user.click(group.getByRole("button", { name: "Production" }));
    expect(group.getByRole("button", { name: "Production" })).toHaveAttribute("aria-pressed", "false");
    await user.click(group.getByRole("button", { name: "Production" }));
    expect(group.getByRole("button", { name: "Production" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hides a repository for this browser and brings it back", async () => {
    compare(liveResult({ rows: [consistent, variable] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("button", { name: t("compare.hideRepoAria", { repo: "web" }) }));
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeNull();
    expect(screen.getByText(t("compare.sumHidden", { count: 1 }), { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(t("compare.showHidden")) }));
    expect(screen.getByText(t("compare.hiddenBadge"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("compare.unhideRepoAria", { repo: "web" }) }));
    expect(screen.queryByText(t("compare.hiddenBadge"))).toBeNull();
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeInTheDocument();
  });

  it("remembers the hidden repositories without hiding one twice", async () => {
    window.sessionStorage.setItem("sd:filter:compare.hiddenRepos", JSON.stringify(["web"]));
    compare(liveResult({ rows: [consistent, variable] }));
    renderApp(<ComparePage />);
    await screen.findByRole("button", { name: t("compare.rowAria", { name: "C_VAR" }) });
    await waitFor(() => expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "A_KEY" }) })).toBeNull());
  });

  it("filters the notes by the chosen repository", async () => {
    compare(liveResult({ rows: [consistent, variable], repos: [repoInfo("web", { notes: [{ code: "inherit" }] }), repoInfo("api", { notes: [{ code: "all-secrets" }] })] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await pick(user, screen.getByLabelText(t("compare.filterRepo")), "api");
    await user.click(screen.getByText(t("compare.notesTitle"), { exact: false }));
    expect(screen.getByText(t("compare.note.all-secrets", { file: "", target: "" }))).toBeInTheDocument();
    expect(screen.queryByText(t("compare.note.inherit", { file: "", target: "" }))).toBeNull();
  });
});

describe("Compare page: copying", () => {
  // `userEvent.setup()` (inside renderApp) installs its own clipboard on `navigator`; the page writes to that one.
  it("copies a Markdown table of the deviations", async () => {
    compare(liveResult({ rows: [gap, variable, errored] }));
    const { user } = renderApp(<ComparePage />);
    await ready2("B_KEY");
    await user.click(screen.getByRole("button", { name: t("compare.copyMd") }));
    expect(await screen.findByText(t("compare.copied"))).toBeInTheDocument();
    const text = await navigator.clipboard.readText();
    expect(text).toContain("B_KEY");
    expect(text).toContain(t("compare.parityGap", { stages: "Production" }));
  });

  it("copes with a refused clipboard", async () => {
    compare(liveResult({ rows: [gap] }));
    const { user } = renderApp(<ComparePage />);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await ready2("B_KEY");
    await user.click(screen.getByRole("button", { name: t("compare.copyMd") }));
    expect(await screen.findByText(t("compare.copyFailed"))).toBeInTheDocument();
  });

  it("says when there is nothing to copy", async () => {
    compare(liveResult({ rows: [consistent] }));
    const { user } = renderApp(<ComparePage />);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await ready();
    await user.click(screen.getByRole("button", { name: t("compare.copyMd") }));
    expect(await screen.findByText(t("compare.nothingToCopy"))).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the copy button disabled until the data is there", () => {
    compare(() => new Promise(() => undefined) as never);
    renderApp(<ComparePage />);
    expect(screen.getByRole("button", { name: t("compare.copyMd") })).toBeDisabled();
  });
});

const ready2 = async (name: string) => screen.findByRole("button", { name: t("compare.rowAria", { name }) });

const without = <R extends { cells: Record<string, unknown> }>(r: R, stage: string): R => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => k !== stage)) });
// The label with any number in place of the count (the text has regex characters, so escape it first).
const ALL = (key: string, count = 99) => new RegExp(t(key, { count }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(String(count), "\\d+"));

describe("Compare page: table details", () => {
  it("marks repositories that only exist on GitHub and rows with other environments", async () => {
    compare(liveResult({ rows: [others, plain], repos: [repoInfo("web", { inInventory: false })] }));
    renderApp(<ComparePage />);
    expect(await screen.findByText(t("compare.repoOnlyGithub"))).toBeInTheDocument();
    expect(screen.getByText(t("compare.otherPresent", { envs: "preview" }))).toBeInTheDocument();
    expect(screen.getByText(t("compare.otherNeeded", { envs: `${t("compare.repoLevelName")}, qa` }))).toBeInTheDocument();
    expect(screen.getByText(t("compare.colOther"))).toBeInTheDocument();
  });

  it("shows a dash where a row has no cell for a stage", async () => {
    compare(liveResult({ rows: [without(row("web", "PARTIAL_KEY", { staging: cell("ok", true, true) }), "production"), others] }));
    renderApp(<ComparePage />);
    await ready2("PARTIAL_KEY");
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("names the files a row needs", async () => {
    compare(liveResult({ rows: [needed, others] }));
    renderApp(<ComparePage />);
    await ready2("NEEDED_KEY");
    expect(screen.getByText(t("compare.needsBadge", { files: "deploy.yml, release.yml" }))).toBeInTheDocument();
    expect(screen.getByText(t("compare.needsBadge", { files: "x.yml" }))).toBeInTheDocument();
  });

  it("shows long lists in pages", async () => {
    const many = Array.from({ length: 60 }, (_, i) => row("big", `KEY_${String(i).padStart(2, "0")}`, { staging: cell("ok", true, true), production: cell("ok", true, true) }, { parity: "consistent" }));
    compare(liveResult({ rows: many }));
    const { user } = renderApp(<ComparePage />);
    await ready2("KEY_00");
    expect(screen.queryByRole("button", { name: t("compare.rowAria", { name: "KEY_55" }) })).toBeNull();
    await user.click(screen.getByRole("button", { name: t("common.showMore", { count: 10 }) }));
    expect(screen.getByRole("button", { name: t("compare.rowAria", { name: "KEY_55" }) })).toBeInTheDocument();
  });
});

describe("Compare page: detail dialog", () => {
  const full = row(
    "web",
    "FULL_KEY",
    {
      staging: cell("error", true, undefined, { targets: ["web/env:staging"], error: { target: "web/env:staging", message: "403 forbidden" } }),
      production: cell("level-mismatch", false, undefined, { notFound: ["qa"], inventoryStages: ["staging", "retired-stage"], neededBy: ["ci.yml"], actualNames: ["FULL_KEY_PROD"] }),
      dev: cell("needed", false, undefined, { neededBy: ["ci.yml"] }),
      shared: cell("unknown", true),
    },
    { ids: ["full-1"], levelMismatch: true },
  );

  it("opens from the name with every stage and its hint, and closes", async () => {
    compare(liveResult({ rows: [gap, variable] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await ready2("B_KEY"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(t("compare.detailTitle", { name: "B_KEY", repo: "web" }))).toBeInTheDocument();
    expect(dialog.getAllByText("web/env:production").length).toBeGreaterThan(0);
    expect(dialog.getByRole("link", { name: t("compare.openSecret", { id: "b-1" }) })).toHaveAttribute("href", "/secrets/b-1");
    await user.click(dialog.getByRole("button", { name: t("compare.close") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from a cell and shows expected and actual values of a variable", async () => {
    compare(liveResult({ rows: [variable] }));
    const { user } = renderApp(<ComparePage />);
    await ready2("C_VAR");
    await user.click(screen.getByRole("button", { name: t("compare.cellAria", { name: "C_VAR", stage: "Production", state: t("compare.stateLong.different") }) }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(t("compare.detailExpectedValue"))).toBeInTheDocument();
    expect(dialog.getByText(t("compare.detailActualValue"))).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: t("compare.openVariable", { id: "c-var" }) })).toHaveAttribute("href", "/entries?kind=variable&q=c-var");
    expect(dialog.getByText(t("compare.kindVariableOne"))).toBeInTheDocument();
  });

  it("shows every kind of detail of a cell, falls back to the id of a removed stage and offers adopting", async () => {
    compare(liveResult({ rows: [full] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await ready2("FULL_KEY"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("403 forbidden")).toBeInTheDocument();
    expect(dialog.getByText(t("compare.detailNotFound", { envs: "qa" }))).toBeInTheDocument();
    expect(dialog.getByText("Staging, retired-stage")).toBeInTheDocument();
    expect(dialog.getByText("FULL_KEY_PROD")).toBeInTheDocument();
    expect(dialog.getAllByText("ci.yml").length).toBeGreaterThan(0);
    expect(dialog.getByRole("link", { name: t("compare.adopt") })).toBeInTheDocument();
    expect(dialog.getAllByText(t("compare.detailFix"), { exact: false }).length).toBeGreaterThan(0);
  });

  it("says when a row has no inventory entry and skips stages it has no cell for", async () => {
    compare(liveResult({ rows: [without(row("api", "LONE_KEY", { staging: cell("unexpected", false, true) }, { ids: [] }), "production")] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await ready2("LONE_KEY"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(t("compare.detailNone"))).toBeInTheDocument();
    expect(dialog.queryByText("Production")).toBeNull();
  });

  it("explains a cell that was not checked while GitHub was not read", async () => {
    compare(result({ rows: [row("web", "OFF_KEY", { staging: cell("unknown", true), production: cell("unknown", true) })] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await ready2("OFF_KEY"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getAllByText(t("compare.detailFix"), { exact: false }).length).toBeGreaterThan(0);
  });

  it("closes the dialog with Escape", async () => {
    compare(liveResult({ rows: [consistent] }));
    const { user } = renderApp(<ComparePage />);
    await user.click(await ready());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Compare page: adopting names from workflows", () => {
  const workflowRows = [needed, lowerNeeded, row("api", "NO_FILE_KEY", { staging: cell("needed"), production: cell("needed") }, { ids: [], neededMissing: true })];

  it("links to the new-entry dialog from the table, one link per stage when several are needed", async () => {
    compare(liveResult({ rows: workflowRows }));
    renderApp(<ComparePage />);
    await ready2("NEEDED_KEY");
    expect(screen.getAllByRole("link", { name: t("compare.adopt") }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: t("compare.adoptStage", { stage: "Staging" }) })[0]).toHaveAttribute("href", expect.stringContaining("/entries?new="));
  });

  it("adopts the chosen names in one go", async () => {
    const portal = compare(liveResult({ rows: workflowRows }), { "POST secrets": {}, "POST variables": {} });
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: ALL("compare.adoptAll") }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(t("compare.adoptInvalid"))).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: ALL("compare.adoptConfirm") }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(portal.callsTo("POST", "secrets")[0]!.body).toMatchObject({ provider: "manual", expiry: "unknown", stage: "staging" });
  });

  it("lets names be skipped and stages be changed, and tells when nothing is chosen", async () => {
    const portal = compare(liveResult({ rows: [needed] }), { "POST secrets": {} });
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: ALL("compare.adoptAll") }));
    const dialog = within(await screen.findByRole("dialog"));
    await pick(user, dialog.getByLabelText(t("compare.adoptStageLabel")), "Production");
    await user.click(dialog.getByRole("checkbox"));
    await user.click(dialog.getByRole("button", { name: t("compare.adoptConfirm", { count: 0 }) }));
    expect(await screen.findByText(t("compare.adoptNone"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "secrets")).toHaveLength(0);
    await user.click(dialog.getByRole("checkbox"));
    await user.click(dialog.getByRole("button", { name: t("compare.adoptConfirm", { count: 1 }) }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]!.body).toMatchObject({ stage: "production", places: [{ repo: "web", scope: "environment" }] });
  });

  it("keeps the failed names in the dialog with the reason and drops the ones that worked", async () => {
    compare(liveResult({ rows: [needed, lowerNeeded] }), { "POST secrets": {}, "POST variables": { status: 409, body: { error: "id already used" } } });
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: ALL("compare.adoptAll") }));
    const dialog = within(await screen.findByRole("dialog"));
    const boxes = dialog.getAllByRole("checkbox");
    await user.click(boxes[boxes.length - 1]!);
    await user.click(dialog.getByRole("button", { name: ALL("compare.adoptConfirm") }));
    expect(await dialog.findByText("id already used", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows only failures when nothing could be adopted, and cancels", async () => {
    compare(liveResult({ rows: [needed] }), { "POST secrets": { status: 500, body: { error: "disk full" } } });
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: ALL("compare.adoptAll") }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: ALL("compare.adoptConfirm") }));
    expect(await dialog.findByText("disk full", { exact: false })).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: t("compare.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Compare page: syncing to GitHub", () => {
  it("opens the sync dialog, for the filtered repository when one is chosen", async () => {
    compare(liveResult({ rows: [consistent, variable] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await pick(user, screen.getByLabelText(t("compare.filterRepo")), "api");
    await user.click(screen.getByRole("button", { name: t("compare.sync.button") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the sync dialog for all repositories", async () => {
    compare(liveResult({ rows: [consistent] }));
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("button", { name: t("compare.sync.button") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("Compare page: adopting corner cases", () => {
  it("adopts names needed on a stage without a GitHub environment at the repository level", async () => {
    const portal = compare(liveResult({ rows: [row("web", "DEV_ONLY_KEY", { dev: cell("needed", false, undefined, { neededBy: ["ci.yml"] }) }, { ids: [], neededMissing: true })] }), { "POST secrets": {} });
    const { user } = renderApp(<ComparePage />);
    await user.click(await screen.findByRole("button", { name: ALL("compare.adoptAll") }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: ALL("compare.adoptConfirm") }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets")).toHaveLength(1));
    expect(portal.callsTo("POST", "secrets")[0]!.body).toMatchObject({ stage: "dev", places: [{ repo: "web", scope: "repository" }] });
  });

  it("shows no adopt link for a row that is flagged but has no needed cell", async () => {
    compare(liveResult({ rows: [row("web", "FLAGGED_KEY", { staging: cell("ok", true, true) }, { neededMissing: true })] }));
    renderApp(<ComparePage />);
    await ready2("FLAGGED_KEY");
    expect(screen.queryByRole("link", { name: t("compare.adopt") })).toBeNull();
  });

  it("offers a plain adopt link when only one of the needed stages is known to the list", async () => {
    compare(liveResult({ rows: [row("web", "GHOST_KEY", { staging: cell("needed"), ghost: cell("needed") }, { ids: [], neededMissing: true })] }));
    renderApp(<ComparePage />);
    await ready2("GHOST_KEY");
    expect(screen.getAllByRole("link", { name: t("compare.adopt") })).toHaveLength(1);
  });
});

describe("Compare page: syncing to GitHub, to the end", () => {
  const line = (key: string, name: string, over: Record<string, unknown> = {}) => ({ key, kind: "variable", entryId: name.toLowerCase(), name, repo: "web", place: { repo: "web", scope: "repository" }, placeLabel: "web/repo", stage: "dev", production: false, action: "write", reason: "missing", defaultOn: true, ...over });
  const plan = (lines: unknown[]) => ({ generatedAt: "2026-01-01T00:00:00Z", lines, counts: { set: 0, write: lines.length, skip: 0, unchanged: 0 }, hasProduction: false });

  it("writes the plan and reloads the comparison", async () => {
    const portal = compare(liveResult({ rows: [consistent] }), {
      "POST compare/sync-plan": plan([line("variable:a", "A_VAR")]),
      "POST compare/sync": { outcomes: [{ key: "variable:a", kind: "variable", entryId: "a", name: "A_VAR", placeLabel: "web/repo", outcome: "created" }], ok: 1, failed: 0 },
    });
    const { user } = renderApp(<ComparePage />);
    await ready();
    await user.click(screen.getByRole("button", { name: t("compare.sync.button") }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(await dialog.findByRole("button", { name: t("compare.sync.confirm", { count: 1 }) }));
    expect(await dialog.findByText(t("compare.sync.summary", { ok: 1, failed: 0, skipped: 0 }))).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("GET", "compare?").length).toBeGreaterThanOrEqual(2));
  });
});
