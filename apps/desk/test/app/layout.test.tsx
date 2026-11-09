import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout, { metadata } from "@/app/layout";

describe("root layout", () => {
  it("sets German as document language and renders the page inside the shell", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>page-content-for-tests</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("page-content-for-tests");
  });

  it("keeps the portal out of search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("secret-desk");
  });
});
