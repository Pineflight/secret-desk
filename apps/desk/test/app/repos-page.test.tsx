import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReposPage from "@/app/repos/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const link = (over: Record<string, unknown> = {}) => ({ path: "/home/dev/acme-app", exists: true, remote: "git@github.com:acme/acme-app.git", remoteMatches: true, ...over });
const repo = (name: string, over: Record<string, unknown> = {}) => ({ name, secrets: 2, variables: 1, templates: 0, inInventory: true, github: null, link: null, ...over });
const list = (repos: unknown[], github = "off") => ({ owner: "acme", github, repos });

const page = (routes: Record<string, FakeHandler> = {}) => fakePortal({ "GET repos": list([repo("acme-app")]), "GET repos?live=1": list([repo("acme-app")], "ok"), ...routes });
const row = (name: string) => screen.getByRole("link", { name: t("repos.showSecretsAria", { name }) }).closest("tr") as HTMLElement;

describe("Repos page: list", () => {
  it("shows a skeleton, then the repositories with counts and links into the entries", async () => {
    page();
    const { container } = renderApp(<ReposPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
    expect(await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) })).toHaveAttribute("href", "/entries?repo=acme-app");
    const tr = row("acme-app");
    expect(within(tr).getByRole("link", { name: "2" })).toHaveAttribute("href", "/entries?kind=secret&repo=acme-app");
    expect(within(tr).getByRole("link", { name: "1" })).toHaveAttribute("href", "/entries?kind=variable&repo=acme-app");
    expect(within(tr).getByText(t("repos.notLinked"))).toBeInTheDocument();
    expect(within(tr).getByText("–")).toBeInTheDocument();
  });

  it("explains every link status and every label of a repository", async () => {
    page({
      "GET repos": list([
        repo("ok-repo", { link: link() }),
        repo("missing-repo", { link: link({ exists: false, remote: null, remoteMatches: null }) }),
        repo("noremote-repo", { link: link({ remote: null, remoteMatches: null }) }),
        repo("mismatch-repo", { link: link({ remoteMatches: false, remote: "git@github.com:other/x.git" }) }),
        repo("agent-repo", { link: link({ path: null }) }),
        repo("github-repo", { inInventory: false, github: { private: true, archived: true, pushedAt: null } }),
        repo("public-repo", { github: { private: false, archived: false, pushedAt: null } }),
        repo("old-name", { renamedTo: "new-name" }),
      ]),
    });
    renderApp(<ReposPage />);
    await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "ok-repo" }) });
    expect(within(row("ok-repo")).getByText(t("repos.statusOk"))).toBeInTheDocument();
    expect(within(row("missing-repo")).getByText(t("repos.statusMissing"))).toBeInTheDocument();
    expect(within(row("noremote-repo")).getByText(t("repos.statusNoRemote"))).toBeInTheDocument();
    expect(within(row("mismatch-repo")).getByText(t("repos.statusMismatch", { remote: "git@github.com:other/x.git" }))).toBeInTheDocument();
    expect(within(row("github-repo")).getByText(t("repos.onlyGithub"))).toBeInTheDocument();
    expect(within(row("github-repo")).getByText(t("repos.private"))).toBeInTheDocument();
    expect(within(row("github-repo")).getByText(t("repos.archived"))).toBeInTheDocument();
    expect(within(row("public-repo")).queryByText(t("repos.private"))).toBeNull();
    expect(within(row("old-name")).getByText(t("repos.renamedTo", { name: "new-name" }))).toBeInTheDocument();
    expect(within(row("ok-repo")).getByText("/home/dev/acme-app")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    page({ "GET repos": list([]) });
    renderApp(<ReposPage />);
    expect(await screen.findByText(t("repos.empty"))).toBeInTheDocument();
  });

  it("shows the error and loads again on retry", async () => {
    let fail = true;
    page({ "GET repos": () => (fail ? { status: 500, body: { error: "repos broke" } } : list([repo("acme-app")])) });
    const { user } = renderApp(<ReposPage />);
    expect(await screen.findByText("repos broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) })).toBeInTheDocument();
  });

  it("filters by name and says so when nothing matches", async () => {
    page({ "GET repos": list([repo("acme-app"), repo("acme-docs")]) });
    const { user } = renderApp(<ReposPage />);
    await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) });
    const box = screen.getByRole("searchbox", { name: t("repos.filter") });
    await user.type(box, "DOCS");
    expect(screen.queryByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) })).toBeNull();
    expect(screen.getByRole("link", { name: t("repos.showSecretsAria", { name: "acme-docs" }) })).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "nothing");
    expect(screen.getByText(t("repos.noMatch"))).toBeInTheDocument();
  });
});

describe("Repos page: GitHub sync", () => {
  it.each([
    ["off", t("repos.githubOff")],
    ["unavailable", t("repos.githubUnavailable")],
    ["ok", t("repos.syncDone", { count: 1 })],
  ])("reports the GitHub state %s after syncing", async (github, text) => {
    page({ "GET repos?live=1": list([repo("acme-app"), repo("only-gh", { inInventory: false, github: { private: false, archived: false, pushedAt: null } })], github) });
    const { user } = renderApp(<ReposPage />);
    await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) });
    await user.click(screen.getByRole("button", { name: t("repos.sync") }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("loads again when syncing a second time", async () => {
    const portal = page();
    const { user } = renderApp(<ReposPage />);
    await screen.findByRole("link", { name: t("repos.showSecretsAria", { name: "acme-app" }) });
    await user.click(screen.getByRole("button", { name: t("repos.sync") }));
    await screen.findByText(t("repos.syncDone", { count: 0 }));
    await user.click(screen.getByRole("button", { name: t("repos.sync") }));
    await waitFor(() => expect(portal.callsTo("GET", "repos?live=1").length).toBeGreaterThanOrEqual(2));
  });
});

describe("Repos page: local scan", () => {
  const found = [
    { name: "acme-app", path: "/home/dev/acme-app", remote: "git@github.com:acme/acme-app.git", linked: false },
    { name: "acme-docs", path: "/home/dev/acme-docs", remote: "git@github.com:acme/acme-docs.git", linked: false },
    { name: "acme-old", path: "/home/dev/acme-old", remote: "git@github.com:acme/acme-old.git", linked: true },
  ];

  it("says when no folder was found and can be closed", async () => {
    page({ "POST repos/scan": [] });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.scan") }));
    expect(await screen.findByText(t("repos.scanNone"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("repos.close") }));
    expect(screen.queryByText(t("repos.scanNone"))).toBeNull();
  });

  it("shows the scan failure", async () => {
    page({ "POST repos/scan": { status: 500, body: { error: "scan broke" } } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.scan") }));
    expect(await screen.findByText("scan broke")).toBeInTheDocument();
  });

  it("adopts a single folder and marks it linked", async () => {
    const portal = page({ "POST repos/scan": found, "PUT repos/acme-app/link": { name: "acme-app", path: "/home/dev/acme-app", remote: null, remoteMatches: null, warnings: [] } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.scan") }));
    expect(await screen.findByText(t("repos.scanFound", { count: 3 }))).toBeInTheDocument();
    expect(screen.getByText(t("repos.alreadyLinked"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("repos.adoptAria", { name: "acme-app" }) }));
    expect(await screen.findByText(t("repos.adopted", { count: 1 }))).toBeInTheDocument();
    expect(portal.callsTo("PUT", "repos/acme-app/link")[0]!.body).toEqual({ path: "/home/dev/acme-app" });
    await waitFor(() => expect(screen.queryByRole("button", { name: t("repos.adoptAria", { name: "acme-app" }) })).toBeNull());
    expect(screen.getByRole("button", { name: t("repos.adoptAria", { name: "acme-docs" }) })).toBeInTheDocument();
  });

  it("adopts all open folders, reporting the ones that fail", async () => {
    page({
      "POST repos/scan": found,
      "PUT repos/acme-app/link": { name: "acme-app", path: "/p", remote: null, remoteMatches: null, warnings: [] },
      "PUT repos/acme-docs/link": { status: 400, body: { error: "not a git folder" } },
    });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.scan") }));
    await user.click(await screen.findByRole("button", { name: t("repos.adoptAll") }));
    expect(await screen.findByText("not a git folder")).toBeInTheDocument();
    expect(await screen.findByText(t("repos.adopted", { count: 1 }))).toBeInTheDocument();
  });

  it("reports only the failure when nothing could be adopted, and survives closing the scan meanwhile", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    page({ "POST repos/scan": found, "PUT repos/acme-app/link": () => gate.then(() => ({ status: 500, body: { error: "disk full" } })) });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.scan") }));
    await user.click(await screen.findByRole("button", { name: t("repos.adoptAria", { name: "acme-app" }) }));
    await user.click(screen.getByRole("button", { name: t("repos.close") }));
    release(undefined);
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(screen.queryByText(t("repos.adopted", { count: 1 }))).toBeNull();
    expect(screen.queryByText(t("repos.scanFound", { count: 3 }))).toBeNull();
  });
});

describe("Repos page: link dialog", () => {
  const saved = (warnings: string[] = []) => ({ name: "acme-app", path: "/home/dev/acme-app", remote: null, remoteMatches: null, warnings });

  it("links a folder, confirms with a toast and reloads the list", async () => {
    const portal = page({ "PUT repos/acme-app/link": saved() });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.linkAria", { name: "acme-app" }) }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.type(screen.getByLabelText(new RegExp(t("repos.pathLabel"))), "  ~/acme-app  ");
    await user.click(screen.getByRole("button", { name: t("repos.save") }));
    expect(await screen.findByText(t("repos.saved"))).toBeInTheDocument();
    expect(portal.callsTo("PUT", "repos/acme-app/link")[0]!.body).toEqual({ path: "~/acme-app" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(portal.callsTo("GET", "repos").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the dialog open to show warnings of the link", async () => {
    page({ "PUT repos/acme-app/link": saved(["remote differs", "folder is empty"]) });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.linkAria", { name: "acme-app" }) }));
    await user.type(screen.getByLabelText(new RegExp(t("repos.pathLabel"))), "/x");
    await user.click(screen.getByRole("button", { name: t("repos.save") }));
    expect(await screen.findByText("remote differs")).toBeInTheDocument();
    expect(screen.getByText("folder is empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("repos.save") })).toBeNull();
    await user.click(screen.getByRole("button", { name: t("repos.close") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a save failure and can be cancelled", async () => {
    page({ "PUT repos/acme-app/link": { status: 400, body: { error: "outside allowed folders" } } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.linkAria", { name: "acme-app" }) }));
    await user.type(screen.getByLabelText(new RegExp(t("repos.pathLabel"))), "/etc");
    await user.click(screen.getByRole("button", { name: t("repos.save") }));
    expect(await screen.findByText("outside allowed folders")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("repos.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits an existing link with its path prefilled and removes it", async () => {
    const portal = page({ "GET repos": list([repo("acme-app", { link: link() })]), "DELETE repos/acme-app/link": { ok: true } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.editAria", { name: "acme-app" }) }));
    expect(screen.getByLabelText(new RegExp(t("repos.pathLabel")))).toHaveValue("/home/dev/acme-app");
    await user.click(screen.getByRole("button", { name: t("repos.remove") }));
    expect(await screen.findByText(t("repos.removed"))).toBeInTheDocument();
    expect(portal.callsTo("DELETE", "repos/acme-app/link")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("starts empty for a link the agent view hides and shows a removal failure", async () => {
    page({ "GET repos": list([repo("acme-app", { link: link({ path: null }) })]), "DELETE repos/acme-app/link": { status: 500, body: { error: "cannot remove" } } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.editAria", { name: "acme-app" }) }));
    expect(screen.getByLabelText(new RegExp(t("repos.pathLabel")))).toHaveValue("");
    await user.click(screen.getByRole("button", { name: t("repos.remove") }));
    expect(await screen.findByText("cannot remove")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Repos page: export and rename", () => {
  it("opens the .env export for a repository and closes it again", async () => {
    page({ "GET stages": [] });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("dev.exportRepoAria", { name: "acme-app" }) }));
    const dialog = await screen.findByRole("dialog", { name: t("dev.exportDialogTitle", { name: "acme-app" }) });
    expect(within(dialog).getByRole("button", { name: t("dev.exportButton") })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: t("dev.exportClose") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the export dialog with Escape", async () => {
    page({ "GET stages": [] });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("dev.exportRepoAria", { name: "acme-app" }) }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renames a repository in the inventory after confirmation and reloads", async () => {
    const portal = page({ "GET repos": list([repo("old-name", { renamedTo: "new-name" })]), "POST repos/old-name/rename": { from: "old-name", to: "new-name", changed: 3 } });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.renameInventoryAria", { from: "old-name", to: "new-name" }) }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(t("repos.renameConfirm", { from: "old-name", to: "new-name" }))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: t("repos.renameInventory") }));
    expect(await screen.findByText(t("repos.renameDone", { from: "old-name", to: "new-name", count: 3 }))).toBeInTheDocument();
    expect(portal.callsTo("POST", "repos/old-name/rename")[0]!.body).toEqual({ to: "new-name" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("can cancel the rename", async () => {
    const portal = page({ "GET repos": list([repo("old-name", { renamedTo: "new-name" })]) });
    const { user } = renderApp(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: t("repos.renameInventoryAria", { from: "old-name", to: "new-name" }) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("repos.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(portal.callsTo("POST", "repos/old-name/rename")).toHaveLength(0);
  });
});
