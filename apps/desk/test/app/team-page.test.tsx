import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TeamPage from "@/app/team/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const syncStatus = { status: 404, body: { error: "no team sync here" } };

describe("Team page", () => {
  it("offers the export download", () => {
    fakePortal({ "GET team-sync/status": syncStatus });
    renderApp(<TeamPage />);
    expect(screen.getByRole("link", { name: t("team.download") })).toHaveAttribute("href", "/api/ui/team-export");
  });

  it("keeps the import button disabled and ignores a submit while the text is empty", async () => {
    const portal = fakePortal({ "GET team-sync/status": syncStatus });
    const { user, container } = renderApp(<TeamPage />);
    const button = screen.getByRole("button", { name: t("team.import") });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(t("team.pasteText")), "   ");
    expect(button).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(portal.callsTo("POST", "team-import")).toHaveLength(0);
  });

  it("imports pasted text and shows added and skipped counts (object form)", async () => {
    const portal = fakePortal({
      "GET team-sync/status": syncStatus,
      "POST team-import": { added: { secrets: 2, variables: 1 }, skipped: {} },
      "GET stages": [],
    });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("version: 1");
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    expect(await screen.findByText(t("team.importSummary", { added: "2 secrets, 1 variables", skipped: "0" }))).toBeInTheDocument();
    expect(screen.getByText(t("team.imported"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-import")[0]!.body).toEqual({ text: "version: 1", replace: false });
    await waitFor(() => expect(portal.callsTo("GET", "stages").length).toBeGreaterThan(0));
  });

  it("counts list and number results", async () => {
    fakePortal({ "GET team-sync/status": syncStatus, "POST team-import": { added: ["a", "b", "c"], skipped: 4 }, "GET stages": [] });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("x: 1");
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    expect(await screen.findByText(t("team.importSummary", { added: "3", skipped: "4" }))).toBeInTheDocument();
  });

  it("shows the import failure", async () => {
    fakePortal({ "GET team-sync/status": syncStatus, "POST team-import": { status: 400, body: { error: "not valid yaml" } } });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("oops");
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    expect(await screen.findByText("not valid yaml")).toBeInTheDocument();
    expect(screen.queryByText(t("team.importDone"))).toBeNull();
  });

  it("asks for confirmation before replacing and can cancel", async () => {
    const portal = fakePortal({ "GET team-sync/status": syncStatus });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("x: 1");
    await user.click(screen.getByRole("checkbox", { name: t("team.replace") }));
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-import")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: t("team.confirmReplaceCancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the confirmation with Escape without importing", async () => {
    const portal = fakePortal({ "GET team-sync/status": syncStatus });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("x: 1");
    await user.click(screen.getByRole("checkbox", { name: t("team.replace") }));
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(portal.callsTo("POST", "team-import")).toHaveLength(0);
  });

  it("replaces after the confirmation and sends the confirm flag", async () => {
    const portal = fakePortal({ "GET team-sync/status": syncStatus, "POST team-import": { added: 1, skipped: 0 }, "GET stages": [] });
    const { user } = renderApp(<TeamPage />);
    await user.click(screen.getByLabelText(t("team.pasteText")));
    await user.paste("x: 1");
    await user.click(screen.getByRole("checkbox", { name: t("team.replace") }));
    await user.click(screen.getByRole("button", { name: t("team.import") }));
    await user.click(await screen.findByRole("button", { name: t("team.confirmReplaceYes") }));
    expect(await screen.findByText(t("team.importDone"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "team-import")[0]!.body).toEqual({ text: "x: 1", replace: true, confirmReplace: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads a chosen file into the text box and ignores an empty file choice", async () => {
    fakePortal({ "GET team-sync/status": syncStatus });
    const { user } = renderApp(<TeamPage />);
    const input = screen.getByLabelText(t("team.loadFile"));
    fireEvent.change(input);
    expect(screen.getByLabelText(t("team.pasteText"))).toHaveValue("");
    await user.upload(input, new File(["secrets: []"], "team.yaml", { type: "text/yaml" }));
    await waitFor(() => expect(screen.getByLabelText(t("team.pasteText"))).toHaveValue("secrets: []"));
  });
});
