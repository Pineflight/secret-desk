import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListTable } from "../src/components/ListTable";

const render = (props: { stickyLast?: boolean; minWidth?: number } = {}) => renderToStaticMarkup(createElement(ListTable, { columns: ["Name", "Actions"], ...props }, createElement("tr", null, createElement("td", null, "a"), createElement("td", null, "b"))));

describe("ListTable layout", () => {
  it("keeps the actions column sticky only when asked for", () => {
    expect(render({ stickyLast: true })).toContain("sd-sticky-last");
    expect(render()).not.toContain("sd-sticky-last");
  });
  it("uses a small default minimum width so lists fit next to the sidebar at 1280px (content width 966px)", () => {
    const m = /min-width:(\d+)px/.exec(render());
    expect(Number(m?.[1])).toBeLessThanOrEqual(720);
  });
  it("an explicit minimum width is kept", () => {
    expect(render({ minWidth: 1000 })).toContain("min-width:1000px");
  });
});
