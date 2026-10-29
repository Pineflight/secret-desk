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
  it("the variables table keeps its actions in view", () => {
    expect(read("app/variables/page.tsx")).toContain("<ListTable stickyLast");
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
