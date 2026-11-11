import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OverviewPage from "@/app/page";
import { translate as t } from "@/lib/i18n";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const catalog = { categories: ["code"], vendors: [{ id: "acme", label: "Acme", category: "code", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: ["r1"], signInPlanned: false }] };
const automation = { enabled: true, signInFreshHours: 12, signInChecks: [{ host: "h.example", signedIn: false, checkedAt: new Date().toISOString() }], recipes: [{ id: "r1", providerId: "p", label: "R1", host: "h.example", canCheckSignIn: true }] };

const overview = (over: Record<string, unknown> = {}) => ({
  total: 0,
  byStage: { dev: 0, staging: 0, production: 0 },
  byStatus: { ok: 0, unknown: 0, soon: 0, "no-date": 0, due: 0, missing: 0, expired: 0 },
  attention: [],
  variables: 0,
  pendingReviews: 0,
  pendingApprovals: 0,
  ...over,
});
const secret = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `NAME_${id}`, title: null, stage: "dev", status: "soon", places: [], daysLeft: 3, ...over });
const base = { "GET connections": [], "GET secrets": [], "GET variables": [] };

describe("Overview page", () => {
  it("shows skeleton cards, then calm statistics and the all-good state", async () => {
    fakePortal({ ...base, "GET overview": overview() });
    const { container } = renderApp(<OverviewPage />);
    expect(container.querySelectorAll(".sd-skeleton").length).toBeGreaterThan(0);
    expect(await screen.findByText(t("home.allGood"))).toBeInTheDocument();
    expect(screen.getByText(t("home.nothingAll"))).toBeInTheDocument();
    expect(screen.getByText(t("home.statExpired"))).toBeInTheDocument();
    expect(screen.queryByText(t("home.reviewNow"))).toBeNull();
    const all = screen.getByRole("tab", { name: new RegExp(t("home.tabAll")) });
    expect(all).toHaveAttribute("aria-selected", "true");
  });

  it("leads every stat card to the matching list and shows the attention list before the integrations block", async () => {
    fakePortal({ ...base, "GET overview": overview({ attention: [secret("a")], total: 1 }) });
    const { container } = renderApp(<OverviewPage />);
    await screen.findByText(t("home.statExpired"));
    const hrefOf = (label: string) => screen.getByText(label).closest("a")!.getAttribute("href");
    expect(hrefOf(t("home.statExpired"))).toBe("/entries?status=expired");
    expect(hrefOf(t("home.statSoon"))).toBe("/entries?status=soon");
    expect(hrefOf(t("home.statMissing"))).toBe("/entries?kind=secret&status=missing");
    expect(hrefOf(t("home.statReviews"))).toBe("/reviews");
    const attention = screen.getByText(t("home.attention"));
    const placeholder = container.querySelector<HTMLElement>("[style*='min-height: 260px']")!;
    expect(attention.compareDocumentPosition(placeholder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("counts on the soon card only what its link lists: soon secrets, not the due ones", async () => {
    fakePortal({ ...base, "GET overview": overview({ byStatus: { ok: 0, unknown: 0, soon: 3, "no-date": 0, due: 2, missing: 0, expired: 0 } }) });
    renderApp(<OverviewPage />);
    const card = (await screen.findByText(t("home.statSoon"))).closest("a")!;
    expect(card).toHaveAttribute("href", "/entries?status=soon");
    expect(card).toHaveTextContent("3");
    expect(card).not.toHaveTextContent("5");
  });

  it("loads the integrations block only when it scrolls into view", async () => {
    const watchers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          watchers.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    fakePortal({ ...base, "GET overview": overview() });
    renderApp(<OverviewPage />);
    await screen.findByText(t("home.allGood"));
    expect(screen.queryByText(t("home.linked"))).toBeNull();
    watchers.forEach((cb) => cb([{ isIntersecting: true }]));
    expect(await screen.findByText(t("home.linked"))).toBeInTheDocument();
  });

  it("shows the error and retries", async () => {
    let fail = true;
    fakePortal({ ...base, "GET overview": () => (fail ? { status: 500, body: { error: "overview broke" } } : overview()) });
    const { user } = renderApp(<OverviewPage />);
    expect(await screen.findByText("overview broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("home.allGood"))).toBeInTheDocument();
  });

  it("points to pending reviews and approvals", async () => {
    fakePortal({ ...base, "GET overview": overview({ pendingReviews: 2, pendingApprovals: 1, byStatus: { ok: 0, unknown: 0, soon: 1, "no-date": 0, due: 1, missing: 1, expired: 1 } }) });
    renderApp(<OverviewPage />);
    expect(await screen.findByText(t("home.reviewsWaiting", { count: 2 }))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("home.reviewNow") })).toHaveAttribute("href", "/reviews");
    expect(screen.getByText(t("home.approvalsWaiting", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("home.toApprovals") })).toHaveAttribute("href", "/approvals");
  });

  it("shows only the approvals notice when no review waits", async () => {
    fakePortal({ ...base, "GET overview": overview({ pendingApprovals: 3 }) });
    renderApp(<OverviewPage />);
    expect(await screen.findByText(t("home.approvalsWaiting", { count: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(t("home.reviewNow"))).toBeNull();
  });

  it("shows the renewal warning alone when nothing else waits", async () => {
    fakePortal({
      ...base,
      "GET overview": overview(),
      "GET automation": automation,
      "GET vendors": catalog,
      "GET secrets": [{ id: "s1", name: "ACME_TOKEN", title: "Acme token", vendor: "acme", browser: true, expires: day, daysLeft: 3 }],
    });
    renderApp(<OverviewPage />);
    expect(await screen.findByText(t("renewal.title", { count: 1 }))).toBeInTheDocument();
    expect(screen.queryByText(t("home.reviewNow"))).toBeNull();
  });

  it("lists entries that need attention with title or name, places and days", async () => {
    const places = [{ repo: "acme/app", scope: "repository" }, { repo: "acme/docs", scope: "environment", environment: "prod" }];
    fakePortal({
      ...base,
      "GET overview": overview({
        total: 3,
        byStage: { dev: 2, production: 1 },
        attention: [secret("a/1", { title: "Nice title", places }), secret("b", { daysLeft: null, status: "no-date" }), secret("c", { stage: "production", daysLeft: -2, status: "expired" })],
      }),
    });
    renderApp(<OverviewPage />);
    const first = await screen.findByRole("link", { name: /Nice title/ });
    expect(first).toHaveAttribute("href", "/secrets/a%2F1");
    expect(within(first).getByText(/acme\/app/)).toBeInTheDocument();
    const second = screen.getByRole("link", { name: /NAME_b/ });
    expect(within(second).getByText(t("home.noPlaces"))).toBeInTheDocument();
    expect(within(second).getByText(t("common.days.none"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /NAME_c/ })).toBeInTheDocument();
  });

  it("filters by stage and explains an empty stage", async () => {
    fakePortal({ ...base, "GET overview": overview({ total: 2, byStage: { dev: 1, production: 1 }, attention: [secret("a"), secret("c", { stage: "production" })] }) });
    const { user } = renderApp(<OverviewPage />);
    await screen.findByRole("link", { name: /NAME_a/ });
    await user.click(screen.getByRole("tab", { name: /production/i }));
    expect(screen.queryByRole("link", { name: /NAME_a/ })).toBeNull();
    expect(screen.getByRole("link", { name: /NAME_c/ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /staging/i }));
    expect(screen.getByText(t("home.nothingStage", { stage: "staging" }))).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: new RegExp(t("home.tabAll")) }));
    expect(screen.getByRole("link", { name: /NAME_a/ })).toBeInTheDocument();
  });

  it("shows long lists in pages and resets to the first page when the stage changes", async () => {
    const many = Array.from({ length: 60 }, (_, i) => secret(`m${String(i).padStart(2, "0")}`));
    fakePortal({ ...base, "GET overview": overview({ total: 60, byStage: { dev: 60 }, attention: many }) });
    const { user } = renderApp(<OverviewPage />);
    await screen.findByRole("link", { name: /NAME_m00/ });
    expect(screen.queryByRole("link", { name: /NAME_m55/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: t("common.showMore", { count: 10 }) }));
    expect(screen.getByRole("link", { name: /NAME_m55/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /weitere anzeigen/ })).toBeNull();
  });
});
