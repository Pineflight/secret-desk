import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SetupPage from "@/app/setup/page";
import { CHOICE_STORAGE_KEY } from "@/lib/setup-choice";
import { translate as t } from "@/lib/i18n";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const emptyDiff = { added: [], changed: [], removed: [] };
const diff = (over: Record<string, unknown> = {}) => ({
  empty: false,
  sections: { secrets: { added: ["new-secret"], changed: ["old-secret"], removed: [] }, variables: emptyDiff, stages: emptyDiff, providers: emptyDiff, envTemplates: emptyDiff, ...over },
});
const access = { source: "github-pat", problem: null, mode: "pull", strategy: "pull-request", neededRights: ["contents:read"], checks: [], ok: true };

/** Routes of a fully confirmed team setup choice (repo, file and mode), so the page's GitHub button is enabled. */
function readyGitHub(file: string, extra: Record<string, FakeHandler> = {}) {
  window.localStorage.setItem(
    CHOICE_STORAGE_KEY,
    JSON.stringify({ repo: "acme/team", branch: "main", file, mode: file === "__create__" ? "pull-push" : "pull", strategy: "pull-request", confirmed: { repo: true, file: true, mode: true } }),
  );
  return fakePortal({
    "GET team-sync/token": { available: false, reason: "automation-off", viewerUrl: null, timeoutMinutes: 10, active: null, pendingRevocation: null, tokensUrl: "", days: 30, rights: { pull: [], "pull-push": [] }, run: { secretId: "", providerId: "", status: "idle", text: "", startedAt: "", updatedAt: "" } },
    "GET team-sync/discovery/repos": { source: "github-pat", problem: null, truncated: false, preselected: "acme/team", repos: [{ owner: "acme", name: "team", fullName: "acme/team", private: true, archived: false, defaultBranch: "main", pushedAt: "2026-01-01T00:00:00Z", selectable: true, reason: null }] },
    "GET team-sync/discovery/branches*": { source: "github-pat", problem: null, branches: ["main"], defaultBranch: "main", truncated: false },
    "GET team-sync/discovery/files*": { source: "github-pat", problem: null, files: ["team.yaml"], preselected: "team.yaml", canCreate: true, createPath: "team.yaml", truncated: false },
    "GET team-sync/discovery/access*": access,
    "PUT team-sync/config": {},
    "GET stages": [],
    ...extra,
  });
}

describe("Setup page: choice", () => {
  it("starts on GitHub and shows only the chosen panel", async () => {
    fakePortal({});
    const { user } = renderApp(<SetupPage />);
    const group = screen.getByRole("radiogroup", { name: t("setup.choice.label") });
    expect(screen.getByRole("radio", { name: t("setup.choice.github") })).toHaveAttribute("aria-checked", "true");
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("setup.github.preview") })).toBeInTheDocument();
    expect(screen.queryByLabelText(t("setup.upload.title"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("setup.empty.start") })).toBeNull();
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    expect(screen.getByLabelText(t("setup.upload.title"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("setup.github.preview") })).toBeNull();
    expect(screen.getByRole("radio", { name: t("setup.choice.github") })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: t("setup.choice.empty") }));
    expect(screen.getByRole("button", { name: t("setup.empty.start") })).toBeInTheDocument();
    expect(screen.queryByLabelText(t("setup.upload.title"))).toBeNull();
  });
});

describe("Setup page: choice keyboard", () => {
  const radio = (key: string) => screen.getByRole("radio", { name: t(`setup.choice.${key}`) });

  it("keeps only the checked radio in the Tab order", async () => {
    fakePortal({});
    const { user } = renderApp(<SetupPage />);
    expect(radio("github")).toHaveAttribute("tabindex", "0");
    expect(radio("upload")).toHaveAttribute("tabindex", "-1");
    expect(radio("empty")).toHaveAttribute("tabindex", "-1");
    await user.click(radio("upload"));
    expect(radio("github")).toHaveAttribute("tabindex", "-1");
    expect(radio("upload")).toHaveAttribute("tabindex", "0");
  });

  it("moves and selects with the arrow keys, wrapping at both ends", async () => {
    fakePortal({});
    const { user } = renderApp(<SetupPage />);
    radio("github").focus();
    await user.keyboard("{ArrowRight}");
    expect(radio("upload")).toHaveFocus();
    expect(radio("upload")).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowDown}");
    expect(radio("empty")).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowRight}");
    expect(radio("github")).toHaveFocus();
    expect(radio("github")).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowLeft}");
    expect(radio("empty")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(radio("upload")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(radio("github")).toHaveFocus();
    await user.keyboard("{End}");
    expect(radio("empty")).toHaveFocus();
    expect(radio("empty")).toHaveAttribute("aria-checked", "true");
  });

  it("ignores other keys", async () => {
    fakePortal({});
    const { user } = renderApp(<SetupPage />);
    radio("github").focus();
    await user.keyboard("a");
    expect(radio("github")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Setup page: start empty", () => {
  it("dismisses the setup and offers to continue", async () => {
    const portal = fakePortal({ "POST team-sync/dismiss-setup": {}, "GET stages": [] });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.empty") }));
    await user.click(screen.getByRole("button", { name: t("setup.empty.start") }));
    expect(await screen.findByText(t("setup.done"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("setup.continue") })).toHaveAttribute("href", "/");
    expect(portal.callsTo("POST", "team-sync/dismiss-setup")).toHaveLength(1);
    await waitFor(() => expect(portal.callsTo("GET", "stages").length).toBeGreaterThan(0));
  });

  it("shows the failure and stays on the setup", async () => {
    fakePortal({ "POST team-sync/dismiss-setup": { status: 500, body: { error: "cannot dismiss" } } });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.empty") }));
    await user.click(screen.getByRole("button", { name: t("setup.empty.start") }));
    expect(await screen.findByText("cannot dismiss")).toBeInTheDocument();
    expect(screen.queryByText(t("setup.done"))).toBeNull();
  });
});

describe("Setup page: upload", () => {
  const file = () => new File(["secrets: []"], "team.yaml", { type: "text/yaml" });

  it("previews an uploaded file, applies it and finishes", async () => {
    const portal = fakePortal({ "POST team-sync/preview-text": diff(), "POST team-import": { added: 1, skipped: 0 }, "POST team-sync/dismiss-setup": {}, "GET stages": [] });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await user.upload(screen.getByLabelText(t("setup.upload.title")), file());
    expect(await screen.findByText("+ new-secret", { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-sync/preview-text")[0]!.body).toEqual({ text: "secrets: []" });
    await user.click(screen.getByRole("button", { name: t("setup.upload.apply") }));
    expect(await screen.findByText(t("setup.done"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-import")[0]!.body).toEqual({ text: "secrets: []" });
  });

  it("ignores a change event without a file", async () => {
    const portal = fakePortal({});
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await act(async () => {
      screen.getByLabelText(t("setup.upload.title")).dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(portal.callsTo("POST", "team-sync/preview-text")).toHaveLength(0);
  });

  it("shows a preview failure and offers no apply button", async () => {
    fakePortal({ "POST team-sync/preview-text": { status: 400, body: { error: "not a team file" } } });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await user.upload(screen.getByLabelText(t("setup.upload.title")), file());
    expect(await screen.findByText("not a team file")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("setup.upload.apply") })).toBeNull();
  });

  it("keeps the preview and shows the failure when the import fails", async () => {
    fakePortal({ "POST team-sync/preview-text": diff(), "POST team-import": { status: 409, body: { error: "import refused" } } });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await user.upload(screen.getByLabelText(t("setup.upload.title")), file());
    await user.click(await screen.findByRole("button", { name: t("setup.upload.apply") }));
    expect(await screen.findByText("import refused")).toBeInTheDocument();
    expect(screen.queryByText(t("setup.done"))).toBeNull();
  });

  it("says so when the uploaded file changes nothing", async () => {
    fakePortal({ "POST team-sync/preview-text": { empty: true, sections: {} } });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await user.upload(screen.getByLabelText(t("setup.upload.title")), file());
    expect(await screen.findByText(t("teamSync.diff.none"))).toBeInTheDocument();
  });
});

describe("Setup page: GitHub", () => {
  it("keeps the preview button disabled until repository, file and mode are confirmed", () => {
    fakePortal({ "GET team-sync/token": { available: false, reason: "automation-off", viewerUrl: null, timeoutMinutes: 10, active: null, pendingRevocation: null, tokensUrl: "", days: 30, rights: { pull: [], "pull-push": [] }, run: { secretId: "", providerId: "", status: "idle", text: "", startedAt: "", updatedAt: "" } } });
    renderApp(<SetupPage />);
    expect(screen.getByRole("button", { name: t("setup.github.preview") })).toBeDisabled();
  });

  it("previews the remote file and applies it", async () => {
    const portal = readyGitHub("team.yaml", { "POST team-sync/check": { state: "different", remoteSha: "sha-1", diff: diff() }, "POST team-sync/apply": {} });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    expect(await screen.findByText("~ old-secret", { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("PUT", "team-sync/config")[0]!.body).toEqual({ teamSync: { repo: "acme/team", path: "team.yaml", branch: "main", mode: "pull", push: { strategy: "pull-request" } } });
    await user.click(screen.getByRole("button", { name: t("setup.github.apply") }));
    expect(await screen.findByText(t("setup.done"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-sync/apply")[0]!.body).toEqual({ expectSha: "sha-1", resolution: "merge" });
  });

  it("shows the apply failure and no success", async () => {
    readyGitHub("team.yaml", { "POST team-sync/check": { state: "different", remoteSha: "sha-1", diff: diff() }, "POST team-sync/apply": { status: 409, body: { error: "remote moved" } } });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    await user.click(await screen.findByRole("button", { name: t("setup.github.apply") }));
    expect(await screen.findByText("remote moved")).toBeInTheDocument();
    expect(screen.queryByText(t("setup.done"))).toBeNull();
  });

  it.each([
    ["the remote file is missing", { state: "missing-remote", remoteSha: null, diff: null }],
    ["the check returns no diff", { state: "unknown", remoteSha: "sha-2", diff: null }],
  ])("warns and offers no apply when %s", async (_name, check) => {
    readyGitHub("team.yaml", { "POST team-sync/check": check });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    expect(await screen.findByText(t("setup.github.empty"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("setup.github.apply") })).toBeNull();
  });

  it("offers no apply for a diff without a remote revision", async () => {
    readyGitHub("team.yaml", { "POST team-sync/check": { state: "different", remoteSha: null, diff: diff() } });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    expect(await screen.findByText("+ new-secret", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("setup.github.apply") })).toBeNull();
  });

  it("shows a failure to save the configuration", async () => {
    readyGitHub("team.yaml", { "PUT team-sync/config": { status: 400, body: { error: "bad config" } } });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    expect(await screen.findByText("bad config")).toBeInTheDocument();
  });

  it("creates the file with the first push when it does not exist yet", async () => {
    const portal = readyGitHub("__create__");
    const { user } = renderApp(<SetupPage />);
    const create = await screen.findByRole("button", { name: t("setup.github.create") });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    expect(await screen.findByText(t("setup.github.created"))).toBeInTheDocument();
    expect(portal.callsTo("PUT", "team-sync/config")[0]!.body).toMatchObject({ teamSync: { mode: "pull-push", path: "team.yaml" } });
    expect(portal.callsTo("POST", "team-sync/check")).toHaveLength(0);
  });

  it("drops the preview when the selection changes", async () => {
    readyGitHub("team.yaml", { "POST team-sync/check": { state: "different", remoteSha: "sha-1", diff: diff() } });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    await screen.findByRole("button", { name: t("setup.github.apply") });
    await user.click(screen.getByRole("radio", { name: new RegExp(t("teamSync.mode.pull-push")) }));
    await waitFor(() => expect(screen.queryByRole("button", { name: t("setup.github.apply") })).toBeNull());
  });
});

describe("Setup page: confirm before preview", () => {
  const before = (a: Element, b: Element) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  it("puts the apply button before the GitHub preview diff", async () => {
    readyGitHub("team.yaml", { "POST team-sync/check": { state: "different", remoteSha: "sha-1", diff: diff() } });
    const { user } = renderApp(<SetupPage />);
    const preview = await screen.findByRole("button", { name: t("setup.github.preview") });
    await waitFor(() => expect(preview).toBeEnabled());
    await user.click(preview);
    const apply = await screen.findByRole("button", { name: t("setup.github.apply") });
    before(apply, await screen.findByText("+ new-secret", { exact: false }));
  });

  it("puts the apply button before the upload preview diff", async () => {
    fakePortal({ "POST team-sync/preview-text": diff() });
    const { user } = renderApp(<SetupPage />);
    await user.click(screen.getByRole("radio", { name: t("setup.choice.upload") }));
    await user.upload(screen.getByLabelText(t("setup.upload.title")), new File(["secrets: []"], "team.yaml", { type: "text/yaml" }));
    const apply = await screen.findByRole("button", { name: t("setup.upload.apply") });
    before(apply, screen.getByText("+ new-secret", { exact: false }));
  });
});
