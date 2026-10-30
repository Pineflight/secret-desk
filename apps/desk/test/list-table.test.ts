import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(src, p), "utf8");

// Die Komponenten importieren ueber den Alias "@/", den Vitest hier nicht aufloest: geprueft wird der Quelltext, die echte Seite wurde bei 768/1280/1440/1920 px gemessen.
describe("list layout", () => {
  it("ListTable has a small default minimum width and an opt-in sticky last column", () => {
    const code = read("components/ListTable.tsx");
    const m = /minWidth = (\d+)/.exec(code);
    expect(Number(m?.[1])).toBeLessThanOrEqual(720);
    expect(code).toContain("stickyLast");
    expect(code).toContain("sd-sticky-last");
  });
  it("the sticky rule pins the last column to the right edge with a card background", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.sd-sticky-last td:last-child[\s\S]*position:\s*sticky/);
    expect(css).toMatch(/right:\s*0/);
    expect(css).toMatch(/background:\s*var\(--sd-card\)/);
  });
  it("the entries table fits its card instead of scrolling: no forced minimum width, wide columns fold into the name cell", () => {
    const page = read("app/entries/page.tsx");
    expect(page).toContain("<ListTable minWidth={0}");
    expect(page).not.toContain("<ListTable stickyLast");
    // Kind, stage, value and targets fold into the name cell below 1280 px, status and actions below 640 px.
    expect(page).toContain("max-xl:hidden");
    expect(page).toContain("max-sm:hidden");
    expect(read("components/ListTable.tsx")).toContain("minWidth: minWidth || undefined");
  });
  it("secret and variable rows share one actions cell: centered, same width, same group class", () => {
    const page = read("app/entries/page.tsx");
    const list = read("components/ListTable.tsx");
    expect(list).toMatch(/ACTIONS_CELL_CLASS = "[^"]*align-middle/);
    expect(list).toMatch(/ACTIONS_GROUP_CLASS = "[^"]*w-\[10\.5rem\][^"]*justify-end/);
    const secretRow = page.slice(page.indexOf("function SecretRowView"), page.indexOf("function VariableRowView"));
    const variableRow = page.slice(page.indexOf("function VariableRowView"));
    for (const row of [secretRow, variableRow]) {
      expect(row).toContain("ACTIONS_GROUP_CLASS");
      expect(row).toContain("ACTIONS_CELL_CLASS");
      expect(row).toContain("variables.edit");
    }
  });
});

describe("spacing system", () => {
  const css = read("app/globals.css");
  it("defines the 4/8/12/16/24/32 px scale and the role tokens as CSS variables", () => {
    for (const [n, rem] of [[1, "0.25"], [2, "0.5"], [3, "0.75"], [4, "1"], [6, "1.5"], [8, "2"]] as const) {
      expect(css).toContain(`--sd-space-${n}: ${rem}rem`);
    }
    expect(css).toMatch(/--sd-gap-section:\s*var\(--sd-space-8\)/);
    expect(css).toMatch(/--sd-gap-head:\s*var\(--sd-space-3\)/);
    expect(css).toMatch(/--sd-pad-card:\s*var\(--sd-space-4\)/);
  });
  it("narrows the section gap on small screens", () => {
    expect(css).toMatch(/max-width:\s*639px\)[\s\S]*--sd-gap-section:\s*var\(--sd-space-6\)/);
  });
  it("cards and list cells use the tokens and compact cells", () => {
    expect(read("components/ui.tsx")).toContain("p-[var(--sd-pad-card)]");
    expect(read("components/ListTable.tsx")).toContain('LIST_CELL_CLASS = "px-3 py-2"');
  });
  it("the compare page separates repo groups with the section gap and a sticky head", () => {
    const code = read("app/compare/page.tsx");
    expect(code).toContain("sd-section");
    expect(code).toContain("sd-group-head");
    expect(css).toMatch(/\.sd-group-head[\s\S]*position:\s*sticky/);
  });
});
