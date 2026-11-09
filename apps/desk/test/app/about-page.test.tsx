import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AboutPage from "@/app/about/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const about = (over: Record<string, unknown> = {}) => ({
  name: "secret-desk",
  version: "0.1.0",
  buildTag: null,
  commit: null,
  displayVersion: "v0.1.0",
  releaseUrl: null,
  description: "Local portal",
  createdBy: "Pineflight",
  license: "MIT",
  licenseText: "Line one\nline two\n\nSecond paragraph",
  links: { source: "https://example.test/src", issues: "https://example.test/issues", security: "https://example.test/sec", support: "https://example.test/help" },
  thirdParty: [
    { name: "alpha-lib", version: "1.0.0", license: "MIT", source: "npm", status: "allowed" },
    { name: "beta-lib", version: "2.0.0", license: "GPL-3.0", source: "npm", status: "review" },
  ],
  platformFamilies: [],
  privacy: { telemetry: false, pineflightServers: false },
  ...over,
});

describe("About page", () => {
  it("shows a skeleton first, then version, links, license text and the third-party table", async () => {
    fakePortal({ "GET about": about() });
    const { container } = renderApp(<AboutPage />);
    expect(container.querySelector('.sd-skeleton')).not.toBeNull();
    expect(await screen.findByText("secret-desk")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "v0.1.0" })).toBeNull();
    expect(screen.queryByText(t("about.build"))).toBeNull();
    expect(screen.getByRole("link", { name: t("about.source") })).toHaveAttribute("href", "https://example.test/src");
    expect(screen.getByLabelText(t("about.licenseText")).textContent).toBe("Line one line two\n\nSecond paragraph");
    expect(screen.getByText("alpha-lib")).toBeInTheDocument();
    expect(screen.getAllByText(t("about.review"))).toHaveLength(1);
    expect(screen.queryByText(/Plattform|platform/i)).toBeNull();
  });

  it("links the release and shows build tag and commit when known", async () => {
    fakePortal({ "GET about": about({ releaseUrl: "https://example.test/rel", buildTag: "v0.1.0-29", commit: "abc1234", platformFamilies: ["darwin", "linux"] }) });
    renderApp(<AboutPage />);
    expect(await screen.findByRole("link", { name: "v0.1.0" })).toHaveAttribute("href", "https://example.test/rel");
    expect(screen.getByText("v0.1.0-29 · abc1234")).toBeInTheDocument();
    expect(screen.getByText(t("about.platformFamilies", { names: "darwin, linux" }))).toBeInTheDocument();
  });

  it("shows build tag or commit alone", async () => {
    fakePortal({ "GET about": about({ commit: "abc1234" }) });
    renderApp(<AboutPage />);
    expect(await screen.findByText("abc1234")).toBeInTheDocument();
  });

  it("filters the third-party list by name or license", async () => {
    fakePortal({ "GET about": about() });
    const { user } = renderApp(<AboutPage />);
    await screen.findByText("alpha-lib");
    const box = screen.getByLabelText(t("about.thirdFilter"));
    await user.type(box, "gpl");
    const table = screen.getByRole("table");
    expect(within(table).queryByText("alpha-lib")).toBeNull();
    expect(within(table).getByText("beta-lib")).toBeInTheDocument();
    await user.clear(box);
    expect(within(table).getByText("alpha-lib")).toBeInTheDocument();
  });

  it("shows the error and loads again on retry", async () => {
    let fail = true;
    fakePortal({ "GET about": () => (fail ? { status: 500, body: { error: "boom" } } : about()) });
    const { user } = renderApp(<AboutPage />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    await waitFor(() => expect(screen.getByText("secret-desk")).toBeInTheDocument());
  });
});
