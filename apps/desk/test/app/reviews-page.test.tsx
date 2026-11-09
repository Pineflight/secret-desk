import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReviewsPage from "@/app/reviews/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const issuance = (over: Record<string, unknown> = {}) => ({
  id: "iss-1",
  secretId: "s1",
  secretName: "STRIPE_KEY",
  stage: "dev",
  provider: "manual",
  kind: "manual",
  createdAt: "2026-01-02T10:00:00.000Z",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  overall: "pass",
  report: {},
  ...over,
});

describe("Reviews page", () => {
  it("shows the empty state", async () => {
    fakePortal({ "GET reviews": [] });
    renderApp(<ReviewsPage />);
    expect(await screen.findByText(t("reviews.list.emptyTitle"))).toBeInTheDocument();
  });

  it("shows the error and loads again on retry", async () => {
    let fail = true;
    fakePortal({ "GET reviews": () => (fail ? { status: 500, body: { error: "reviews broke" } } : []) });
    const { user } = renderApp(<ReviewsPage />);
    expect(await screen.findByText("reviews broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("reviews.list.emptyTitle"))).toBeInTheDocument();
  });

  it("lists reviews with a link, a countdown for open ones and an expired mark for old ones", async () => {
    fakePortal({
      "GET reviews": [
        issuance(),
        issuance({ id: "iss/2", secretName: "OLD_KEY", expiresAt: "2020-01-01T00:00:00.000Z", overall: "fail" }),
        issuance({ id: "iss-3", secretName: "WARN_KEY", overall: "warn" }),
      ],
    });
    renderApp(<ReviewsPage />);
    expect(await screen.findByText("STRIPE_KEY")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /STRIPE_KEY/ })).toHaveAttribute("href", "/reviews/iss-1");
    expect(screen.getByRole("link", { name: /OLD_KEY/ })).toHaveAttribute("href", "/reviews/iss%2F2");
    expect(screen.getAllByText(t("reviews.list.expired"))).toHaveLength(1);
    expect(screen.getAllByText(/^0[3-5]:\d\d$/)).toHaveLength(2);
    expect(screen.getByText(t("common.overall.fail"))).toBeInTheDocument();
    expect(screen.getByText(t("common.overall.warn"))).toBeInTheDocument();
  });
});
