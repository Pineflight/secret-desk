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
