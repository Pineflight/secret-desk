import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter } from "@/components/BrowseControls";
import { Marked } from "@/components/Marked";
import { LazySection } from "@/components/LazySection";
import { FacadeBrowserOnly } from "@/components/FacadeBrowserOnly";
import { RenameRepoDialog } from "@/components/RenameRepoDialog";
import { RenewalBadge, RenewalNotice } from "@/components/RenewalWarnings";
import { PageSearch } from "@/components/PageSearch";
import { AttachmentThumb, EvidenceImage } from "@/components/Evidence";
import { invalidateRepoList } from "@/lib/repo-list";
import type { FacadeState } from "@/lib/facade";
import type { RenewalWarning } from "@/lib/renewal-warning";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

describe("BrowseControls", () => {
  it("changes group and sort and keeps the rest of the state", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<BrowseControls value={BROWSE_DEFAULT} onChange={onChange} />);
    await pickOption(user, "Gruppieren", "Stage");
    expect(onChange).toHaveBeenLastCalledWith({ repo: "", sort: "name", group: "stage" });
    await pickOption(user, "Sortieren", "Ablauf");
    expect(onChange).toHaveBeenLastCalledWith({ repo: "", sort: "expires", group: "none" });
  });

  it("offers only the given sorts", async () => {
    const { user } = renderApp(<BrowseControls value={BROWSE_DEFAULT} onChange={() => {}} sorts={["name", "repo"]} />);
    await user.click(screen.getByRole("combobox", { name: "Sortieren" }));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Name", "Repository"]);
  });

  it("filters by repository and renders group headings", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<><RepoFilter value={BROWSE_DEFAULT} onChange={onChange} repos={["acme-app", "acme-docs"]} /><GroupHeading label="acme-app" count={3} /></>);
    await pickOption(user, "Repository", "acme-docs");
    expect(onChange).toHaveBeenCalledWith({ ...BROWSE_DEFAULT, repo: "acme-docs" });
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("Alle");
    expect(screen.getByText("acme-app")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("Marked", () => {
  it("renders plain text without terms", () => {
    const { container } = renderApp(<Marked text="Hello" terms={[]} />);
    expect(container).toHaveTextContent("Hello");
    expect(container.querySelector("mark")).toBeNull();
  });

  it("marks the hits and leaves the rest", () => {
    const { container } = renderApp(<Marked text="deploy token" terms={["token"]} />);
    expect(container.querySelector("mark")).toHaveTextContent("token");
    expect(container).toHaveTextContent("deploy token");
  });
});

describe("LazySection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the children at once when there is no IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderApp(<LazySection><p>content</p></LazySection>);
    expect(await screen.findByText("content")).toBeInTheDocument();
  });

  it("holds the place with a skeleton until the section scrolls into view", () => {
    let trigger: (e: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    class Fake {
      constructor(cb: typeof trigger) { trigger = cb; }
      observe() {}
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", Fake);
    const { container } = renderApp(<LazySection minHeight={50} fallback={<span>wait</span>}><p>content</p></LazySection>);
    expect(screen.getByText("wait")).toBeInTheDocument();
    expect((container.querySelector('[aria-hidden="true"]') as HTMLElement).style.minHeight).toBe("50px");
    act(() => trigger([{ isIntersecting: false }]));
    expect(screen.queryByText("content")).toBeNull();
    act(() => trigger([{ isIntersecting: true }]));
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });

  it("uses the default skeleton without a fallback", () => {
    class Fake {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Fake);
    const { container } = renderApp(<LazySection><p>content</p></LazySection>);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByText("content")).toBeNull();
  });
});

describe("FacadeBrowserOnly", () => {
  it("explains the result and closes through Fertig", async () => {
    const run: FacadeState = { secretId: "s", providerId: "p", status: "done", text: "", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", phase: "signed-in" };
    const onDone = vi.fn();
    const { user } = renderApp(<FacadeBrowserOnly run={run} onDone={onDone} />);
    expect(screen.getByText("Angemeldet. API-Schlüssel kommen aus dem Browser")).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    expect(onDone).toHaveBeenCalled();
  });
});

describe("RenameRepoDialog", () => {
  it("does not claim a key or a connection that do not exist", () => {
    const run = {
      status: "done",
      kind: "connect",
      timeline: [
        { phase: "signed-in", state: "done", at: "2026-11-09T10:00:00Z" },
        { phase: "key", state: "done", at: "2026-11-09T10:00:01Z" },
        { phase: "connected", state: "done", at: "2026-11-09T10:00:02Z" },
      ],
    } as unknown as FacadeState;
    renderApp(<FacadeBrowserOnly run={run} onDone={() => {}} />);
    expect(screen.getByText("Angemeldet")).toBeInTheDocument();
    expect(screen.queryByText("Zugangsschlüssel angelegt")).not.toBeInTheDocument();
    expect(screen.queryByText("Verbunden")).not.toBeInTheDocument();
  });

  it("renames the repository in the inventory, confirms and reports done", async () => {
    invalidateRepoList();
    const portal = fakePortal({ "POST repos/old-name/rename": { from: "old-name", to: "new-name", changed: 4 } });
    const onDone = vi.fn();
    const { user } = renderApp(<RenameRepoDialog from="old-name" to="new-name" onClose={() => {}} onDone={onDone} />);
    expect(screen.getByText(/old-name im Inventar zu new-name umbenennen/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Im Inventar umbenennen" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(portal.callsTo("POST", "repos/old-name/rename")[0]?.body).toEqual({ to: "new-name" });
    expect(await screen.findByText("Im Inventar umbenannt: old-name zu new-name (4 Einträge).")).toBeInTheDocument();
  });

  it("shows the error, stays open and can be cancelled", async () => {
    fakePortal({ "POST repos/old-name/rename": { status: 409, body: { error: "target exists" } } });
    const onDone = vi.fn();
    const onClose = vi.fn();
    const { user } = renderApp(<RenameRepoDialog from="old-name" to="new-name" onClose={onClose} onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Im Inventar umbenennen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("target exists");
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalled();
  });
});

const warning = (over: Partial<RenewalWarning> = {}): RenewalWarning => ({ secretId: "sec 1", title: "Deploy key", vendorId: "acme", vendorLabel: "Acme", expires: "2026-12-01", daysLeft: 3, state: "signed-out", ...over });

describe("RenewalWarnings", () => {
  it("renders nothing without warnings", () => {
    renderApp(<RenewalNotice warnings={[]} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("lists each warning with a link to the entry and the sign-in action", () => {
    renderApp(<RenewalNotice warnings={[warning(), warning({ secretId: "b", title: "Other", vendorId: "x", vendorLabel: "X" })]} />);
    expect(screen.getByText("Anmeldung nötig vor 2 Erneuerungen")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Deploy key bei Acme: Erneuerung am/ })).toHaveAttribute("href", "/secrets/sec%201");
    expect(screen.getByRole("link", { name: "Bei Acme anmelden" })).toHaveAttribute("href", "/connections?signin=acme");
  });

  it("uses the singular title for one warning", () => {
    renderApp(<RenewalNotice warnings={[warning()]} />);
    expect(screen.getByText("Anmeldung nötig vor 1 Erneuerung")).toBeInTheDocument();
  });

  it("badges a signed-out entry and an unknown one differently", () => {
    const { rerender } = renderApp(<RenewalBadge warning={warning()} />);
    expect(screen.getByText(/^Anmeldung nötig vor Erneuerung am/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bei Acme anmelden" })).toHaveAttribute("href", "/connections?signin=acme");
    rerender(<RenewalBadge warning={warning({ state: "unknown" })} />);
    expect(screen.getByText(/^Anmeldung unbekannt/)).toBeInTheDocument();
  });
});

describe("PageSearch", () => {
  it("reports typing, clears through the button and the Escape key", async () => {
    const onChange = vi.fn();
    const { user, rerender } = renderApp(<PageSearch value="" onChange={onChange} count={null} total={null} />);
    const input = screen.getByRole("searchbox", { name: "In dieser Liste suchen" });
    await user.type(input, "a");
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(screen.queryByRole("button", { name: "Suche leeren" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(<PageSearch value="abc" onChange={onChange} count={2} total={9} />);
    expect(screen.getByText("2 von 9 Treffern")).toBeInTheDocument();
    await user.type(input, "{Escape}");
    expect(onChange).toHaveBeenLastCalledWith("");
    await user.click(screen.getByRole("button", { name: "Suche leeren" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveFocus();
  });

  it("shows no count while counts are unknown", () => {
    const { rerender } = renderApp(<PageSearch value="abc" onChange={() => {}} count={null} total={null} />);
    expect(screen.queryByText(/Treffern/)).toBeNull();
    rerender(<PageSearch value="abc" onChange={() => {}} count={1} total={null} />);
    expect(screen.queryByText(/Treffern/)).toBeNull();
  });

  it("focuses with the slash key unless typing, a dialog is open or a modifier is held", async () => {
    const { user } = renderApp(<><PageSearch value="" onChange={() => {}} count={null} total={null} /><input aria-label="other" /></>);
    const input = screen.getByRole("searchbox");
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "/", ctrlKey: true });
    expect(input).not.toHaveFocus();
    await user.click(screen.getByLabelText("other"));
    await user.keyboard("/");
    expect(input).not.toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.append(dlg);
    fireEvent.keyDown(document, { key: "/" });
    expect(input).not.toHaveFocus();
    dlg.remove();
    fireEvent.keyDown(document, { key: "/" });
    expect(input).toHaveFocus();
  });
});

describe("Evidence", () => {
  it("renders a plain evidence image through the svg url", () => {
    renderApp(<EvidenceImage secretId="s 1" reportId="r1" createdAt="2026-03-01T10:00:00Z" className="extra" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/api/ui/evidence/s%201/r1/svg");
    expect(img).toHaveClass("extra");
  });

  it("enlarges a zoomable evidence image in a dialog and closes it", async () => {
    const { user } = renderApp(<EvidenceImage secretId="s" reportId="r" createdAt="2026-03-01T10:00:00Z" zoomable />);
    await user.click(screen.getByRole("button", { name: /vergrößern/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")).toHaveAttribute("src", "/api/ui/evidence/s/r/svg");
    await user.click(screen.getByRole("button", { name: "Dialog schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows attachment thumbnails with and without a note and enlarges them", async () => {
    const { user } = renderApp(<><AttachmentThumb secretId="s" reportId="r" file="a b.png" note="Console" /><AttachmentThumb secretId="s" reportId="r" file="c.png" /></>);
    const imgs = screen.getAllByRole("img");
    expect(imgs[0]).toHaveAttribute("src", "/api/ui/evidence/s/r/attachments/a%20b.png");
    expect(imgs[0]?.getAttribute("alt")).toContain("Console");
    expect(imgs[1]?.getAttribute("alt")).not.toContain("Console");
    await user.click(screen.getAllByRole("button", { name: /vergrößern/ })[0]!);
    expect(screen.getByRole("dialog").querySelector("img")).toHaveAttribute("src", "/api/ui/evidence/s/r/attachments/a%20b.png");
    await user.click(screen.getByRole("button", { name: "Dialog schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
