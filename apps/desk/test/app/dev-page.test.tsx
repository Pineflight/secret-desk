import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import DevPage from "@/app/dev/page";
import { translate as t } from "@/lib/i18n";
import { invalidateRepoList } from "@/lib/repo-list";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { pick } from "../helpers/select";
import { renderApp } from "../helpers/render";

beforeEach(() => invalidateRepoList());

const entry = (key: string, source: string, over: Record<string, unknown> = {}) => ({ key, source, description: null, ...over });
const template = (over: Record<string, unknown> = {}) => ({
  id: "acme-dev",
  repo: "acme-app",
  stage: "dev",
  file: ".env.local",
  entries: [entry("A_KEY", "default", { value: "x" })],
  ...over,
});
const repoRow = (name: string, folder: string | null) => ({ name, secrets: 0, variables: 0, templates: 0, inInventory: true, github: null, link: folder ? { path: folder, exists: true, remote: null, remoteMatches: null } : null });
const repos = (...rows: unknown[]) => ({ owner: "acme", github: "off", repos: rows });
const written = (over: Record<string, unknown> = {}) => ({ status: "written", path: "/home/dev/acme-app/.env.local", keys: ["A_KEY"], sources: { A_KEY: "default" }, skipped: [], gitIgnored: true, warnings: [], ...over });

const dev = (routes: Record<string, FakeHandler> = {}) => fakePortal({ "GET dev-templates": [], "GET repos?live=1": repos(), "GET stages": [{ id: "dev", kind: "dev", environmentName: null, usage: {} }, { id: "staging", kind: "test", environmentName: "staging", usage: {} }], ...routes });
const card = (id: string, file = ".env.local") => screen.getByText(t("dev.templateAndFile", { id, file })).closest("section") as HTMLElement;

describe("Dev page: list", () => {
  it("shows a skeleton while loading and the empty state without templates", async () => {
    dev();
    const { container } = renderApp(<DevPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
    expect(await screen.findByText(t("dev.noTemplates"))).toBeInTheDocument();
    expect(screen.getByText(t("dev.freeExport"))).toBeInTheDocument();
  });

  it("shows the error and retries", async () => {
    let fail = true;
    dev({ "GET dev-templates": () => (fail ? { status: 500, body: { error: "templates broke" } } : [template()]) });
    const { user } = renderApp(<DevPage />);
    expect(await screen.findByText("templates broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" }))).toBeInTheDocument();
  });

  it("describes where each value of a template comes from", async () => {
    dev({
      "GET dev-templates": [
        template({
          entries: [
            entry("K_DEFAULT", "default", { value: "abc", description: "plain default" }),
            entry("K_DEFAULT_EMPTY", "default"),
            entry("K_VAR", "variable", { variable: "proj-id" }),
            entry("K_VAR_MISSING", "variable"),
            entry("K_ISSUE", "issue", { secret: "stripe" }),
            entry("K_ISSUE_MISSING", "issue"),
            entry("K_PROMPT", "prompt"),
            entry("K_PROMPT_OPT", "prompt", { optional: true }),
            entry("K_REF", "ref", { refKey: "OTHER", refTemplate: "acme-other" }),
            entry("K_REF_MISSING", "ref"),
            entry("K_CMD", "command", { commandKey: "API_URL", command: "supabase-status" }),
            entry("K_CMD_MISSING", "command"),
            entry("K_GEN", "generate"),
            entry("K_ODD", "mystery"),
          ],
        }),
      ],
    });
    renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    expect(c.getByText("plain default")).toBeInTheDocument();
    expect(c.getByText(t("dev.detailValue", { value: "abc" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailValue", { value: "" }).trim())).toBeInTheDocument();
    expect(c.getByText(t("dev.detailVariable", { name: "proj-id" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailVariable", { name: "?" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailSecret", { name: "stripe" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailSecret", { name: "?" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailPrompt"))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailPromptOptional"))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailRef", { key: "OTHER", template: "acme-other" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailRef", { key: "?", template: "?" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailCommand", { key: "API_URL", command: "supabase-status" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.detailCommand", { key: "?", command: "?" }))).toBeInTheDocument();
    expect(c.getAllByText(t("dev.detailGenerated"))).toHaveLength(2);
    expect(c.getByText("mystery")).toBeInTheDocument();
  });
});

describe("Dev page: template card", () => {
  it("orders a card: path, required inputs, optional inputs, then overwrite and button in one row, then the closed key list", async () => {
    dev({ "GET dev-templates": [template({ entries: [entry("A_KEY", "default", { value: "x" }), entry("OPT_IN", "prompt", { optional: true }), entry("SECRET_IN", "prompt")] })] });
    renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const path = c.getByLabelText(new RegExp(t("dev.filePath")));
    const required = c.getByLabelText(t("dev.promptRequired", { key: "SECRET_IN" }));
    const optional = c.getByLabelText(t("dev.promptOptional", { key: "OPT_IN" }));
    const overwrite = c.getByRole("checkbox", { name: t("dev.overwrite") });
    const button = c.getByRole("button", { name: t("dev.createFile") });
    const summary = c.getByText(t("dev.keysSummary", { count: 3, input: 1 }));
    const details = summary.closest("details")!;
    expect(follows(path, required) && follows(required, optional) && follows(optional, overwrite) && follows(overwrite, button) && follows(button, summary)).toBe(true);
    expect(button.parentElement!.contains(overwrite)).toBe(true);
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("A_KEY")).toBeInTheDocument();
    expect(within(details).getByRole("list")).toHaveClass("max-h-[50vh]");
  });

  it("says in the key list summary that no input is needed when every key is filled automatically", async () => {
    dev({ "GET dev-templates": [template({ entries: [entry("A_KEY", "default", { value: "x" }), entry("OPT_IN", "prompt", { optional: true })] })] });
    renderApp(<DevPage />);
    expect(await screen.findByText(t("dev.keysSummaryNone", { count: 2 }))).toBeInTheDocument();
  });

  it("shows the result of a written file above the form", async () => {
    dev({ "GET dev-templates": [template()], "POST env-export": written() });
    const { user } = renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    await user.type(c.getByLabelText(new RegExp(t("dev.filePath"))), "/tmp/x.env");
    await user.click(c.getByRole("button", { name: t("dev.createFile") }));
    const done = await c.findByText(t("dev.written"));
    expect(Boolean(done.compareDocumentPosition(c.getByRole("button", { name: t("dev.createFile") })) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("writes the file to the linked folder, asking only for prompts and reporting the result", async () => {
    const portal = dev({
      "GET dev-templates": [template({ entries: [entry("A_KEY", "default", { value: "x" }), entry("SECRET_IN", "prompt"), entry("OPT_IN", "prompt", { optional: true })] })],
      "GET repos?live=1": repos(repoRow("acme-app", "/home/dev/acme-app/")),
      "POST env-export": written({ keys: ["A_KEY", "SECRET_IN"], skipped: ["OPT_IN"], warnings: ["file is not ignored by git"] }),
    });
    const { user } = renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    await waitFor(() => expect(c.getByLabelText(new RegExp(t("dev.filePath")))).toHaveValue("/home/dev/acme-app/.env.local"));
    expect(c.getByText(t("dev.filePathFromLink"))).toBeInTheDocument();
    await user.type(c.getByLabelText(t("dev.promptRequired", { key: "SECRET_IN" })), "value-for-tests");
    await user.click(c.getByRole("checkbox", { name: t("dev.overwrite") }));
    await user.click(c.getByRole("button", { name: t("dev.createFile") }));
    expect(await c.findByText(t("dev.written"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "env-export")[0]!.body).toEqual({ repo: "acme-app", stage: "dev", template: "acme-dev", path: "/home/dev/acme-app/.env.local", overwrite: true, prompts: { SECRET_IN: "value-for-tests" } });
    expect(c.getByText(t("dev.keysList", { keys: "A_KEY, SECRET_IN" }))).toBeInTheDocument();
    expect(c.getByText(t("dev.skippedList", { keys: "OPT_IN" }))).toBeInTheDocument();
    expect(c.getByText("file is not ignored by git")).toBeInTheDocument();
    expect(screen.getByText(t("dev.fileWritten"))).toBeInTheDocument();
    expect(c.getByLabelText(t("dev.promptRequired", { key: "SECRET_IN" }))).toHaveValue("");
  });

  it("uses the typed path over the linked folder and sends no prompts when none was filled", async () => {
    const portal = dev({
      "GET dev-templates": [template({ entries: [entry("SECRET_IN", "prompt")] })],
      "GET repos?live=1": repos(repoRow("acme-app", "C:\\work\\acme")),
      "POST env-export": written({ skipped: undefined }),
    });
    const { user } = renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    const path = c.getByLabelText(new RegExp(t("dev.filePath")));
    await waitFor(() => expect(path).toHaveValue("C:\\work\\acme\\.env.local"));
    await user.clear(path);
    await user.type(path, " /tmp/custom.env ");
    expect(c.getByPlaceholderText(t("dev.filePathHintTpl"))).toBeInTheDocument();
    await user.click(c.getByRole("button", { name: t("dev.createFile") }));
    expect(await c.findByText(t("dev.written"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "env-export")[0]!.body).toEqual({ repo: "acme-app", stage: "dev", template: "acme-dev", path: "/tmp/custom.env", overwrite: false });
    expect(c.queryByText(/Übersprungen|skipped/i)).toBeNull();
  });

  it("starts with an empty path for an unlinked repository and lists missing input", async () => {
    dev({
      "GET dev-templates": [template({ entries: [entry("SECRET_IN", "prompt")] })],
      "POST env-export": { status: "needs-input", keys: ["SECRET_IN"], message: "values missing" },
    });
    const { user } = renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    const path = c.getByLabelText(new RegExp(t("dev.filePath")));
    expect(path).toHaveValue("");
    await user.type(path, "/tmp/x.env");
    await user.click(c.getByRole("button", { name: t("dev.createFile") }));
    expect(await c.findByText(t("dev.missingList", { message: "values missing", keys: "SECRET_IN" }))).toBeInTheDocument();
    expect(screen.queryByText(t("dev.fileWritten"))).toBeNull();
  });

  it("shows the failure of the export", async () => {
    dev({ "GET dev-templates": [template()], "POST env-export": { status: 400, body: { error: "folder not allowed" } } });
    const { user } = renderApp(<DevPage />);
    const c = within(await screen.findByText(t("dev.templateAndFile", { id: "acme-dev", file: ".env.local" })).then((el) => el.closest("section") as HTMLElement));
    await user.type(c.getByLabelText(new RegExp(t("dev.filePath"))), "/etc/x");
    await user.click(c.getByRole("button", { name: t("dev.createFile") }));
    expect(await c.findByText("folder not allowed")).toBeInTheDocument();
  });
});

describe("Dev page: free export", () => {
  const open = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.click(screen.getByText(t("dev.freeExport")));
    return within(screen.getByText(t("dev.freeExport")).closest("details") as HTMLElement);
  };

  it("shows a hint until a result exists and writes a file with all options", async () => {
    const portal = dev({
      "GET repos?live=1": repos(repoRow("acme-app", "/home/dev/acme-app")),
      "POST env-export": written({ keys: ["A_KEY", "B_KEY", "C_KEY"], sources: { A_KEY: "default", B_KEY: "custom-source" }, warnings: ["careful"] }),
    });
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const f = await open(user);
    expect(f.getByText(t("dev.hint"))).toBeInTheDocument();
    await user.type(f.getByLabelText(t("dev.repository")), "acme-app");
    await screen.findByText(t("dev.filePathHintLinked", { folder: "/home/dev/acme-app" }));
    await user.type(f.getByLabelText(new RegExp(t("dev.filePath"))), "/home/dev/acme-app/.env");
    await user.type(f.getByLabelText(t("dev.template")), "acme-dev");
    await pick(user, f.getByLabelText(t("dev.stage")), /staging/i);
    await user.click(f.getByRole("checkbox", { name: t("dev.overwrite") }));
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    await user.type(f.getByLabelText(t("dev.keyAria", { n: 1 })), "MY_INPUT");
    await user.type(f.getByLabelText(t("dev.inputFor", { key: "MY_INPUT" })), "value-for-tests");
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    await user.click(f.getByRole("button", { name: t("dev.createFile") }));
    expect(await f.findByText(t("dev.writtenTo"), { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("POST", "env-export")[0]!.body).toEqual({ repo: "acme-app", path: "/home/dev/acme-app/.env", stage: "staging", overwrite: true, template: "acme-dev", prompts: { MY_INPUT: "value-for-tests" } });
    expect(f.getByText(t("dev.srcDefault"))).toBeInTheDocument();
    expect(f.getByText("custom-source")).toBeInTheDocument();
    expect(f.getByText(t("dev.srcUnknown"))).toBeInTheDocument();
    expect(f.getByText("careful")).toBeInTheDocument();
    expect(f.queryByText(t("dev.hint"))).toBeNull();
    expect(screen.getByText(t("dev.fileWritten"))).toBeInTheDocument();
    expect(f.getByLabelText(t("dev.inputFor", { key: "MY_INPUT" }))).toHaveValue("");
  });

  it("writes without a typed path for a linked repository and without warnings", async () => {
    const portal = dev({
      "GET repos?live=1": repos(repoRow("acme-app", "/home/dev/acme-app")),
      "POST env-export": written(),
    });
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const f = await open(user);
    await user.type(f.getByLabelText(t("dev.repository")), "acme-app");
    await screen.findByText(t("dev.filePathHintLinked", { folder: "/home/dev/acme-app" }));
    await user.click(f.getByRole("button", { name: t("dev.createFile") }));
    expect(await f.findByText(t("dev.writtenTo"), { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("POST", "env-export")[0]!.body).toEqual({ repo: "acme-app", stage: "dev", overwrite: false });
    expect(f.queryByText("careful")).toBeNull();
  });

  it("edits one of several input rows without touching the others", async () => {
    dev();
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const f = await open(user);
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    await user.type(f.getByLabelText(t("dev.keyAria", { n: 2 })), "SECOND");
    await user.type(f.getByLabelText(t("dev.inputFor", { key: "SECOND" })), "value-for-tests");
    await user.type(f.getByLabelText(t("dev.keyAria", { n: 1 })), "FIRST");
    expect(f.getByLabelText(t("dev.keyAria", { n: 2 }))).toHaveValue("SECOND");
    expect(f.getByLabelText(t("dev.inputFor", { key: "FIRST" }))).toHaveValue("");
    expect(f.getByLabelText(t("dev.inputFor", { key: "SECOND" }))).toHaveValue("value-for-tests");
  });

  it("asks for missing inputs, adds fields for new keys only, and lets inputs be removed", async () => {
    dev({ "POST env-export": { status: "needs-input", keys: ["API_TOKEN", "OTHER"], message: "please fill" } });
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const f = await open(user);
    await user.type(f.getByLabelText(t("dev.repository")), "acme-app");
    await user.type(f.getByLabelText(new RegExp(t("dev.filePath"))), "/tmp/x.env");
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    await user.type(f.getByLabelText(t("dev.keyAria", { n: 1 })), "OTHER");
    await user.click(f.getByRole("button", { name: t("dev.createFile") }));
    expect(await f.findByText("please fill", { exact: false })).toBeInTheDocument();
    expect(f.getByText(t("dev.fieldsShown"))).toBeInTheDocument();
    expect(f.getByLabelText(t("dev.keyAria", { n: 2 }))).toHaveValue("API_TOKEN");
    expect(f.queryByLabelText(t("dev.keyAria", { n: 3 }))).toBeNull();
    await user.click(f.getByRole("button", { name: t("dev.inputRemove", { n: 1 }) }));
    expect(f.getByLabelText(t("dev.keyAria", { n: 1 }))).toHaveValue("API_TOKEN");
    expect(screen.queryByText(t("dev.fileWritten"))).toBeNull();
  });

  it("names an unnamed input row by its position and shows a failure", async () => {
    dev({ "POST env-export": { status: 400, body: { error: "export refused" } } });
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const f = await open(user);
    await user.click(f.getByRole("button", { name: t("dev.inputAdd") }));
    expect(f.getByLabelText(t("dev.inputFor", { key: t("dev.keyAria", { n: 1 }) }))).toBeInTheDocument();
    await user.type(f.getByLabelText(t("dev.repository")), "acme-app");
    await user.type(f.getByLabelText(new RegExp(t("dev.filePath"))), "/tmp/x.env");
    await user.click(f.getByRole("button", { name: t("dev.createFile") }));
    expect(await f.findByText("export refused")).toBeInTheDocument();
  });
});

describe("Dev page: .env export card", () => {
  it("offers the download form only once a repository is named", async () => {
    dev();
    const { user } = renderApp(<DevPage />);
    await screen.findByText(t("dev.noTemplates"));
    const exportCard = screen.getByText(t("dev.exportTitle"), { selector: "p" }).closest("section") as HTMLElement;
    expect(within(exportCard).queryByRole("button", { name: t("dev.exportButton") })).toBeNull();
    expect(within(exportCard).getByPlaceholderText(t("dev.exportRepoPlaceholder"))).toBeInTheDocument();
    await user.type(within(exportCard).getByLabelText(t("dev.repository")), " acme-app ");
    expect(within(exportCard).getByRole("button", { name: t("dev.exportButton") })).toBeInTheDocument();
    await user.clear(within(exportCard).getByLabelText(t("dev.repository")));
    await user.type(within(exportCard).getByLabelText(t("dev.repository")), "  ");
    expect(within(exportCard).queryByRole("button", { name: t("dev.exportButton") })).toBeNull();
  });
});
