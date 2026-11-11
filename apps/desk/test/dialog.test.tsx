import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/Dialog";
import { renderApp } from "./helpers/render";

describe("Dialog", () => {
  it("renders an accessible modal with title, description and children", () => {
    renderApp(<Dialog title="Edit" description="Pick wisely" onClose={() => {}}><p>body</p></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "Edit" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Pick wisely")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the description when none is given and picks the size classes", () => {
    const { rerender } = renderApp(<Dialog title="A" onClose={() => {}}>x</Dialog>);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-xl");
    rerender(<Dialog title="A" wide onClose={() => {}}>x</Dialog>);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-3xl");
    rerender(<Dialog title="A" size="xl" onClose={() => {}}>x</Dialog>);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-[960px]");
    expect(document.querySelector("p.text-muted")).toBeNull();
  });

  it("focuses the [data-autofocus] element, else the first focusable one", () => {
    const { unmount } = renderApp(<Dialog title="A" onClose={() => {}}><input aria-label="first" /><input aria-label="second" data-autofocus /></Dialog>);
    expect(screen.getByLabelText("second")).toHaveFocus();
    unmount();
    renderApp(<Dialog title="A" onClose={() => {}}><input aria-label="first" /></Dialog>);
    // The close button comes first in the DOM.
    expect(screen.getByRole("button", { name: "Dialog schließen" })).toHaveFocus();
  });

  it("locks body scroll while open and restores focus and scroll on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = renderApp(<Dialog title="A" onClose={() => {}}>x</Dialog>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("closes with Escape, the close button and a click on the backdrop but not on the panel", async () => {
    const onClose = vi.fn();
    const { user } = renderApp(<Dialog title="A" onClose={onClose}><button type="button">inner</button></Dialog>);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Dialog schließen" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("always calls the latest onClose", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { user, rerender } = renderApp(<Dialog title="A" onClose={first}>x</Dialog>);
    rerender(<Dialog title="A" onClose={second}>x</Dialog>);
    await user.keyboard("{Escape}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog in both directions", async () => {
    const { user } = renderApp(<Dialog title="A" onClose={() => {}}><input aria-label="one" /><input aria-label="two" /></Dialog>);
    const close = screen.getByRole("button", { name: "Dialog schließen" });
    const two = screen.getByLabelText("two");
    expect(close).toBeInTheDocument();
    two.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(two).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByLabelText("one")).toHaveFocus();
  });

  it("ignores Tab when nothing inside is focusable and other keys", async () => {
    const { user } = renderApp(<Dialog title="A" onClose={() => {}}>x</Dialog>);
    const close = screen.getByRole("button", { name: "Dialog schließen" });
    close.setAttribute("tabindex", "-1");
    close.setAttribute("disabled", "");
    await user.keyboard("{Tab}a");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders the footer outside the scrolling body and keeps its buttons in the focus trap", async () => {
    const { user } = renderApp(<Dialog title="A" onClose={() => {}} footer={<button>save</button>}><input aria-label="field" /></Dialog>);
    const footerButton = screen.getByRole("button", { name: "save" });
    const body = screen.getByLabelText("field").parentElement!;
    expect(body).toHaveClass("overflow-y-auto");
    expect(body).not.toContainElement(footerButton);
    expect(screen.getByRole("dialog")).toContainElement(footerButton);
    footerButton.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Dialog schließen" })).toHaveFocus();
  });

  it("renders no footer bar without a footer", () => {
    renderApp(<Dialog title="A" onClose={() => {}}>x</Dialog>);
    expect(document.querySelector(".border-t.border-line")).toBeNull();
  });

  it("renders no empty body for a dialog with only a description and a footer", () => {
    renderApp(<Dialog title="A" description="Sure?" onClose={() => {}} footer={<button>go</button>} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".overflow-y-auto")).toBeNull();
    expect(screen.getByText("Sure?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "go" })).toBeInTheDocument();
  });
});
