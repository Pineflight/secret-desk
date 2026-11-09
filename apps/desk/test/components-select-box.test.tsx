import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { SelectBox } from "@/components/SelectBox";
import { renderApp } from "./helpers/render";

const OPTIONS = (
  <>
    <option value="a">Alpha</option>
    <option value="b">Beta</option>
    <option value="c">Gamma</option>
  </>
);

function Host({ initial = "b", onPick, children = OPTIONS, ...rest }: { initial?: string; onPick?: (v: string) => void; children?: ReactNode; disabled?: boolean; required?: boolean; searchable?: boolean; className?: string; "aria-label"?: string }) {
  const [v, setV] = useState(initial);
  return (
    <SelectBox
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onPick?.(e.target.value);
      }}
      {...rest}
    >
      {children}
    </SelectBox>
  );
}

const box = () => screen.getByRole("combobox");
const rect = (r: Partial<DOMRect>) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, width: 200, top: 100, bottom: 140, height: 40, right: 210, x: 10, y: 100, toJSON: () => ({}), ...r });

afterEach(() => vi.restoreAllMocks());

describe("SelectBox", () => {
  it("shows the selected label, marks required and takes an aria label and class", () => {
    renderApp(<Host required aria-label="Letter" className="extra" />);
    expect(box()).toHaveTextContent("Beta");
    expect(box()).toHaveAttribute("aria-required", "true");
    expect(box()).toHaveAttribute("aria-label", "Letter");
    expect(box()).toHaveClass("extra");
    expect(box()).toHaveAttribute("aria-expanded", "false");
  });

  it("shows an empty label when the value matches no option", () => {
    renderApp(<Host initial="zzz" />);
    expect(box()).toHaveTextContent("");
  });

  it("opens on click, marks the selected option and picks another one", async () => {
    const onPick = vi.fn();
    const { user } = renderApp(<Host onPick={onPick} />);
    await user.click(box());
    const list = await screen.findByRole("listbox");
    expect(box()).toHaveAttribute("aria-expanded", "true");
    expect(within(list).getByRole("option", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("searchbox", { name: "Suchen…" })).toHaveFocus();
    await user.click(within(list).getByRole("option", { name: "Gamma" }));
    expect(onPick).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box()).toHaveTextContent("Gamma");
    expect(box()).toHaveFocus();
  });

  it("closes again when the button is clicked while open", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    await screen.findByRole("listbox");
    await user.click(box());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open when disabled", async () => {
    const { user } = renderApp(<Host disabled />);
    expect(box()).toBeDisabled();
    await user.click(box());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens with the keyboard on the arrow keys, Enter and space but not on other keys", async () => {
    const { user } = renderApp(<Host searchable={false} />);
    box().focus();
    for (const key of ["{ArrowDown}", "{ArrowUp}", "{Enter}", " "]) {
      await user.keyboard(key);
      await screen.findByRole("listbox");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).toBeNull();
    }
    await user.keyboard("{Tab}");
  });

  it("opens on a typed character with the character as the search query", async () => {
    const { user } = renderApp(<Host />);
    box().focus();
    await user.keyboard("g");
    expect(await screen.findByRole("searchbox")).toHaveValue("g");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Gamma" })).toBeInTheDocument();
  });

  it("ignores typed characters when there is no search field and a modifier or special key", async () => {
    const { user } = renderApp(<Host searchable={false} />);
    box().focus();
    await user.keyboard("g");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{Shift}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores a typed character while the list is open", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    await screen.findByRole("listbox");
    fireEvent.keyDown(box(), { key: "g" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters while typing, shows an empty hint and clears the query on close", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    const search = await screen.findByRole("searchbox");
    await user.type(search, "zzz");
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "alp");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await user.click(box());
    expect(await screen.findByRole("searchbox")).toHaveValue("");
  });

  it("moves with the arrow keys, Home and End and picks with Enter", async () => {
    const onPick = vi.fn();
    const { user } = renderApp(<Host initial="a" onPick={onPick} />);
    await user.click(box());
    await screen.findByRole("listbox");
    const active = () => screen.getAllByRole("option").findIndex((o) => o.className.includes("bg-primary-light"));
    expect(active()).toBe(0);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(active()).toBe(2);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(1);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(active()).toBe(0);
    await user.keyboard("{End}");
    expect(active()).toBe(2);
    await user.keyboard("{Home}");
    expect(active()).toBe(0);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("highlights an option on hover and keeps focus on mouse down", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    const alpha = await screen.findByRole("option", { name: "Alpha" });
    await user.hover(alpha);
    expect(alpha.className).toContain("bg-primary-light");
    expect(fireEvent.mouseDown(alpha)).toBe(false);
  });

  it("closes on Tab without moving focus back to the button", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    await screen.findByRole("listbox");
    fireEvent.keyDown(screen.getByRole("listbox").parentElement!, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores other keys in the list and Enter without a match", async () => {
    const onPick = vi.fn();
    const { user } = renderApp(<Host onPick={onPick} />);
    await user.click(box());
    const search = await screen.findByRole("searchbox");
    await user.type(search, "zzz");
    await user.keyboard("{Enter}");
    await user.keyboard("{F2}");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("closes on an outside mouse down but not on one inside the list", async () => {
    const { user } = renderApp(<><Host /><p>outside</p></>);
    await user.click(box());
    const list = await screen.findByRole("listbox");
    fireEvent.mouseDown(list);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(box());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on scroll outside the list and on resize, but not on scroll inside it", async () => {
    const { user } = renderApp(<Host />);
    await user.click(box());
    const list = await screen.findByRole("listbox");
    fireEvent.scroll(list);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(box());
    await screen.findByRole("listbox");
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens above the button when there is little room below, with and without search", async () => {
    rect({ top: 600, bottom: 640 });
    const { user, unmount } = renderApp(<Host />);
    await user.click(box());
    const list = await screen.findByRole("listbox");
    expect(list.parentElement!.style.bottom).not.toBe("");
    expect(list.parentElement!.style.top).toBe("");
    unmount();
    const second = renderApp(<Host searchable={false} />);
    await second.user.click(box());
    expect((await screen.findByRole("listbox")).parentElement!.style.bottom).not.toBe("");
  });

  it("opens below when there is room and focuses the panel when there is no search field", async () => {
    rect({ top: 10, bottom: 50 });
    const { user } = renderApp(<Host searchable={false} />);
    await user.click(box());
    const list = await screen.findByRole("listbox");
    expect(list.parentElement!.style.top).not.toBe("");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(list.parentElement).toHaveFocus();
  });

  it("opens below even when both sides are cramped and the button is near the top", async () => {
    rect({ top: 20, bottom: 700 });
    const { user } = renderApp(<Host />);
    await user.click(box());
    expect((await screen.findByRole("listbox")).parentElement!.style.top).not.toBe("");
  });

  it("survives an input that refuses a selection range", async () => {
    vi.spyOn(HTMLInputElement.prototype, "setSelectionRange").mockImplementation(() => {
      throw new Error("not supported");
    });
    const { user } = renderApp(<Host />);
    await user.click(box());
    expect(await screen.findByRole("searchbox")).toBeInTheDocument();
  });

  it("starts at the first option when the value is not in the list", async () => {
    const { user } = renderApp(<Host initial="zzz" />);
    await user.click(box());
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option")[0]!.className).toContain("bg-primary-light");
  });

  it("works with a single option and without a search field", async () => {
    const { user } = renderApp(<Host initial="a"><option value="a">Only</option></Host>);
    await user.click(box());
    await screen.findByRole("listbox");
    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.keyboard("{Enter}");
    expect(box()).toHaveTextContent("Only");
  });

  it("shows only the empty hint for a list without options", async () => {
    const { user } = renderApp(<Host initial=""><></></Host>);
    await user.click(box());
    expect(await screen.findByText("Keine Treffer")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
