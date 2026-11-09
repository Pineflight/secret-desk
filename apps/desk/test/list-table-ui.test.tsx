import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu, FilterRow, ListTable, MenuItem, RowIconButton, SegmentSwitch, TagFilterChip } from "@/components/ListTable";
import { renderApp } from "./helpers/render";

describe("ListTable", () => {
  it("renders header cells with their column classes and the rows", () => {
    renderApp(<ListTable columns={["Name", "Kind", "Extra"]} columnClasses={["w-1"]}><tr><td>row</td></tr></ListTable>);
    const heads = screen.getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual(["Name", "Kind", "Extra"]);
    expect(heads[0]).toHaveClass("w-1");
    expect(screen.getByRole("cell", { name: "row" })).toBeInTheDocument();
  });

  it("sets the minimum width and the sticky class only on request, and drops a zero width", () => {
    const { rerender } = renderApp(<ListTable columns={["A"]}><tr><td>x</td></tr></ListTable>);
    expect(screen.getByRole("table")).toHaveStyle({ minWidth: "720px" });
    expect(screen.getByRole("table")).not.toHaveClass("sd-sticky-last");
    rerender(<ListTable columns={["A"]} minWidth={0} stickyLast><tr><td>x</td></tr></ListTable>);
    expect(screen.getByRole("table").style.minWidth).toBe("");
    expect(screen.getByRole("table")).toHaveClass("sd-sticky-last");
  });
});

describe("list helpers", () => {
  it("FilterRow wraps its children", () => {
    renderApp(<FilterRow><span>child</span></FilterRow>);
    expect(screen.getByText("child")).toBeInTheDocument();
  });

  it("TagFilterChip renders nothing without a tag and clears through the chip", async () => {
    const onClear = vi.fn();
    const { rerender, user } = renderApp(<TagFilterChip tag="" label="Tag" removeLabel="Remove" onClear={onClear} />);
    expect(screen.queryByText("Tag")).toBeNull();
    rerender(<TagFilterChip tag="prod" label="Tag" removeLabel="Remove" onClear={onClear} />);
    expect(screen.getByText("Tag")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("button", { name: "Remove" })).toHaveTextContent("#prod");
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("RowIconButton clicks without bubbling and is inert while disabled or loading", async () => {
    const onClick = vi.fn();
    const onRow = vi.fn();
    const { user, rerender } = renderApp(<div onClick={onRow}><RowIconButton label="Edit" icon="key" onClick={onClick} /></div>);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("title", "Edit");
    expect(screen.getByRole("button", { name: "Edit" })).not.toHaveClass("text-danger-text");
    rerender(<RowIconButton label="Edit" icon="key" onClick={onClick} danger disabled />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass("text-danger-text");
    rerender(<RowIconButton label="Edit" icon="key" onClick={onClick} loading />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" }).querySelector(".animate-spin")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("SegmentSwitch marks the active option, shows counts and reports a choice", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<SegmentSwitch label="Kind" value="all" onChange={onChange} options={[{ id: "all", label: "All", count: 3 }, { id: "secret", label: "Secrets" }]} />);
    const group = screen.getByRole("group", { name: "Kind" });
    expect(within(group).getByRole("button", { name: "All 3" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Secrets" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(group).getByRole("button", { name: "Secrets" }));
    expect(onChange).toHaveBeenCalledWith("secret");
  });

  it("ActionMenu opens, closes on a choice, Escape and an outside click", async () => {
    const onPick = vi.fn();
    const { user } = renderApp(
      <div>
        <button type="button">outside</button>
        <ActionMenu label="More">
          <MenuItem icon="key" onClick={onPick}>Pick</MenuItem>
          <MenuItem icon="key" onClick={onPick} disabled>Off</MenuItem>
        </ActionMenu>
      </div>,
    );
    const toggle = screen.getByRole("button", { name: "More" });
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Off" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "Pick" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(toggle);
    await user.keyboard("a");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(toggle);
    await user.click(screen.getByRole("menu"));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
