import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ApprovalsPage from "@/app/approvals/page";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const approval = (over: Record<string, unknown> = {}) => ({
  id: "ap-1",
  action: "issue",
  targetId: "stripe-key",
  requestedBy: "agent-one",
  reason: null,
  createdAt: "2026-01-02T10:00:00.000Z",
  state: "pending",
  snapshotHash: "hash-1",
  snapshot: { secret: "stripe-key", name: "STRIPE_KEY", provider: "manual", stage: "production", ttlDays: null, places: ["acme/app", "acme/docs"], paramsHash: "abc" },
  ...over,
});

describe("Approvals page", () => {
  it("shows the empty state when nothing is waiting", async () => {
    fakePortal({ "GET approvals": [] });
    renderApp(<ApprovalsPage />);
    expect(await screen.findByText(t("approvals.emptyTitle"))).toBeInTheDocument();
  });

  it("shows the error with a retry that loads again", async () => {
    let fail = true;
    const portal = fakePortal({ "GET approvals": () => (fail ? { status: 500, body: { error: "list broke" } } : []) });
    const { user } = renderApp(<ApprovalsPage />);
    expect(await screen.findByText("list broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("approvals.emptyTitle"))).toBeInTheDocument();
    expect(portal.callsTo("GET", "approvals").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a pending issue request with snapshot, target description and reason", async () => {
    fakePortal({
      "GET approvals": [approval({ reason: "rotate before launch" })],
      "GET secrets/stripe-key": { name: "STRIPE_KEY", description: "Payment key for the shop" },
    });
    renderApp(<ApprovalsPage />);
    expect(await screen.findByText(t("approvals.actionIssue"))).toBeInTheDocument();
    expect(screen.getAllByText("stripe-key")).toHaveLength(2);
    expect(screen.getByText(t("approvals.snapshotTitle"))).toBeInTheDocument();
    expect(screen.getByText("acme/app, acme/docs")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(await screen.findByText(/Payment key for the shop/)).toBeInTheDocument();
    expect(screen.getByText(t("approvals.reason", { reason: "rotate before launch" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("approvals.approve") })).toBeEnabled();
  });

  it("approves a request, confirms with a toast and reloads the list", async () => {
    let state = "pending";
    const portal = fakePortal({
      "GET approvals": () => [approval({ state })],
      "GET secrets/stripe-key": { name: "STRIPE_KEY" },
      "POST approvals/ap-1/approve": () => {
        state = "approved";
        return approval({ state });
      },
    });
    const { user } = renderApp(<ApprovalsPage />);
    await user.click(await screen.findByRole("button", { name: t("approvals.approve") }));
    expect(await screen.findByText(t("approvals.approved"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "approvals/ap-1/approve")).toHaveLength(1);
    const link = await screen.findByRole("link", { name: t("approvals.toReview") });
    expect(link).toHaveAttribute("href", "/reviews");
    expect(screen.queryByRole("button", { name: t("approvals.approve") })).toBeNull();
  });

  it("denies a variable request with a toast and loads the variable as target", async () => {
    const portal = fakePortal({
      "GET approvals": [approval({ id: "ap-2", action: "apply-variable", targetId: "proj-id", snapshot: { variable: "proj-id", name: "PROJ_ID", value: "1", stage: "dev", places: [] } })],
      "GET variables/proj-id": { name: "PROJ_ID", description: "x".repeat(200) },
      "POST approvals/ap-2/deny": approval({ state: "denied" }),
    });
    const { user } = renderApp(<ApprovalsPage />);
    expect(await screen.findByText(t("approvals.actionApplyVariable"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("approvals.deny") }));
    expect(await screen.findByText(t("approvals.denied"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "approvals/ap-2/deny")).toHaveLength(1);
    expect(portal.callsTo("GET", "variables/proj-id").length).toBeGreaterThan(0);
  });

  it("shows the failure of a decision and keeps the buttons", async () => {
    fakePortal({
      "GET approvals": [approval()],
      "GET secrets/stripe-key": { name: "STRIPE_KEY" },
      "POST approvals/ap-1/approve": { status: 409, body: { error: "already decided elsewhere" } },
    });
    const { user } = renderApp(<ApprovalsPage />);
    await user.click(await screen.findByRole("button", { name: t("approvals.approve") }));
    expect(await screen.findByText("already decided elsewhere")).toBeInTheDocument();
    expect(screen.queryByText(t("approvals.approved"))).toBeNull();
    expect(screen.getByRole("button", { name: t("approvals.deny") })).toBeEnabled();
  });

  it("explains stale, finished and unknown requests without decision buttons", async () => {
    fakePortal({
      "GET approvals": [
        approval({ id: "a-stale", targetId: "t-stale", state: "stale", result: "Eintrag geaendert" }),
        approval({ id: "a-other", targetId: "t-other", action: "rotate-all", snapshot: null, state: "failed" }),
      ],
      "GET secrets/t-stale": { name: "S" },
      "GET secrets/t-other": { status: 404, body: { error: "gone" } },
    });
    renderApp(<ApprovalsPage />);
    expect(await screen.findByText(t("approvals.stale"))).toBeInTheDocument();
    expect(screen.getByText(t("approvals.result", { result: "Eintrag geaendert" }))).toBeInTheDocument();
    expect(screen.getByText("rotate-all")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("approvals.approve") })).toBeNull();
    expect(screen.getAllByText(t("approvals.snapshotTitle"))).toHaveLength(1);
  });

  it("filters by the search query from the address bar", async () => {
    navigation.set("/approvals?q=agent-two");
    fakePortal({
      "GET approvals": [approval({ id: "a1", targetId: "first-target" }), approval({ id: "a2", targetId: "second-target", requestedBy: "agent-two" })],
      "GET secrets/first-target": { name: "A" },
      "GET secrets/second-target": { name: "B" },
    });
    renderApp(<ApprovalsPage />);
    expect(await screen.findByText("second-target")).toBeInTheDocument();
    expect(screen.queryByText("first-target")).toBeNull();
  });

  it("matches the query against the translated action name", async () => {
    navigation.set("/approvals?q=variable in github");
    fakePortal({
      "GET approvals": [approval({ id: "a1", targetId: "first-target" }), approval({ id: "a2", targetId: "var-target", action: "apply-variable", snapshot: { variable: "v" } })],
      "GET secrets/first-target": { name: "A" },
      "GET variables/var-target": { name: "B" },
    });
    renderApp(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("var-target")).toBeInTheDocument());
    expect(screen.queryByText("first-target")).toBeNull();
    expect(within(document.body).getAllByText(t("approvals.actionApplyVariable"))).toHaveLength(1);
  });
});
