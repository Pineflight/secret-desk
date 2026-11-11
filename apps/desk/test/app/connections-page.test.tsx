import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConnectionsPage from "@/app/connections/page";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";
import { automation, catalog, connection, day, facade, provider, recipe, runState, vendor } from "./connections-fixtures";

const CLOUD = vendor("cloudflare", "Cloudflare", "code", { connections: ["cloudflare"], optionalConnections: ["cloudflare-turnstile"] });
const GITHUB = vendor("github", "GitHub", "code", { connections: ["github"], optionalConnections: ["github-app-key"], providers: ["gh-token"], recipes: ["gh-recipe"] });
const STRIPE = vendor("stripe", "Stripe", "payments", { connectionPrefixes: ["stripe:"], legacyConnections: ["stripe"], providers: ["stripe-key"], recipes: ["stripe-recipe"], facade: true });
const TELEGRAM = vendor("telegram", "Telegram", "messaging", { providers: ["telegram-bot"] });

const base = (routes: Record<string, FakeHandler> = {}) =>
  fakePortal({
    "GET vendors": catalog(GITHUB),
    "GET connections": [connection("github", "github", { expires: day(40), savedAt: day(-3), fingerprint: "ab12cd" })],
    "GET providers": [provider("gh-token", "github", { kind: "automatic" })],
    "GET automation": automation({ recipes: [recipe("gh-recipe", "gh-token", "github.com")] }),
    "GET facades": [],
    "GET secrets": [{ vendor: "github", provider: "gh-token" }],
    "GET variables": [],
    "GET live-check": { reports: [], running: false, intervalDays: 7, stale: false },
    ...routes,
  });
const show = (name: string) => t("providers.card.show", { name });
const hide = (name: string) => t("providers.card.hide", { name });
const openCard = async (user: ReturnType<typeof renderApp>["user"], name: string) => {
  await user.click(await screen.findByRole("button", { name: show(name) }));
  return within(screen.getByRole("button", { name: hide(name) }).closest("section") as HTMLElement);
};

describe("Connections page: states of the list", () => {
  it("shows a skeleton while loading and the empty state without any provider in use", async () => {
    base({ "GET connections": [], "GET secrets": [] });
    const { container } = renderApp(<ConnectionsPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
    expect(await screen.findByText(t("connections.emptyTitle"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("providers.expandAll") })).toBeNull();
  });

  it("shows the live check card above the list, and a live check that cannot be loaded does not hide the list", async () => {
    base({ "GET live-check": { status: 500, body: { error: "live check broke" } } });
    renderApp(<ConnectionsPage />);
    expect(await screen.findByRole("heading", { name: t("liveCheck.title") })).toBeInTheDocument();
    expect(await screen.findByText(t("liveCheck.loadFailed"), { exact: false })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: show("GitHub") })).toBeInTheDocument();
  });

  it("shows errors of the lists and retries them", async () => {
    let failing = true;
    base({
      "GET connections": () => (failing ? { status: 500, body: { error: "connections broke" } } : []),
      "GET vendors": () => (failing ? { status: 500, body: { error: "vendors broke" } } : catalog(GITHUB)),
      "GET facades": () => (failing ? { status: 500, body: { error: "facades broke" } } : []),
    });
    const { user } = renderApp(<ConnectionsPage />);
    expect(await screen.findByText("connections broke")).toBeInTheDocument();
    expect(screen.getByText("vendors broke")).toBeInTheDocument();
    expect(screen.getByText(t("providers.page.facadesFailed"), { exact: false })).toBeInTheDocument();
    failing = false;
    // Three retry buttons: connections, vendors and the small one of the facades notice.
    expect(screen.getAllByRole("button", { name: t("common.retry") })).toHaveLength(3);
    while (screen.queryAllByRole("button", { name: t("common.retry") }).length > 0) await user.click(screen.getAllByRole("button", { name: t("common.retry") })[0]!);
    await waitFor(() => expect(screen.queryByText("connections broke")).toBeNull());
  });

  it("puts expand-all next to the add button in the header and lays all providers out in one grid", async () => {
    base({ "GET vendors": catalog(GITHUB, STRIPE, TELEGRAM), "GET secrets": [{ vendor: "github" }, { vendor: "telegram" }] });
    renderApp(<ConnectionsPage />);
    const expand = await screen.findByRole("button", { name: t("providers.expandAll") });
    const add = screen.getByRole("button", { name: t("connections.add") });
    expect(expand.parentElement).toBe(add.parentElement);
    const lists = screen.getAllByRole("list").filter((l) => l.classList.contains("2xl:grid-cols-3"));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveClass("grid-cols-1", "lg:grid-cols-2");
    expect(within(lists[0]!).getAllByRole("heading", { level: 4 }).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the action of an open card before its keys", async () => {
    base();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    const manage = card.getByRole("button", { name: t("providers.page.manage") });
    // The header says "hide" while open, so the "show" buttons are the key rows below.
    const key = card.getAllByRole("button", { name: /anzeigen/ })[0]!;
    expect(manage.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens and closes the cards one by one and all at once", async () => {
    base({ "GET vendors": catalog(GITHUB, TELEGRAM), "GET secrets": [{ vendor: "github" }, { vendor: "telegram" }] });
    const { user } = renderApp(<ConnectionsPage />);
    await user.click(await screen.findByRole("button", { name: show("GitHub") }));
    expect(screen.getByRole("button", { name: hide("GitHub") })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: t("providers.expandAll") }));
    expect(screen.getByRole("button", { name: hide("Telegram") })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("providers.collapseAll") }));
    expect(screen.getByRole("button", { name: show("GitHub") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: show("Telegram") })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: show("GitHub") }));
    await user.click(screen.getByRole("button", { name: hide("GitHub") }));
    expect(screen.getByRole("button", { name: show("GitHub") })).toBeInTheDocument();
  });

  it("remembers which cards are open", async () => {
    base();
    const first = renderApp(<ConnectionsPage />);
    await first.user.click(await screen.findByRole("button", { name: show("GitHub") }));
    first.unmount();
    base();
    renderApp(<ConnectionsPage />);
    expect(await screen.findByRole("button", { name: hide("GitHub") })).toBeInTheDocument();
  });
});

describe("Connections page: a connected key", () => {
  it("shows the card with counts, produced entries and the key with its expiry and save date", async () => {
    base();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    expect(card.getByText(t("providers.produces.title"))).toBeInTheDocument();
    const key = card.getByRole("button", { name: t("providers.key.show", { name: "github" }) });
    await user.click(key);
    expect(card.getByText(t("connections.fingerprint", { fp: "ab12cd" }))).toBeInTheDocument();
    expect(card.getByText(t("connections.savedDaysAgo", { count: 3 }))).toBeInTheDocument();
    expect(card.getByText(t("connections.expOk"))).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: t("providers.key.hide", { name: "github" }) }));
    expect(card.getByRole("button", { name: t("providers.key.show", { name: "github" }) })).toBeInTheDocument();
  });
});

const BROWSER_GITHUB = vendor("github", "GitHub", "code", { recipes: ["gh-recipe"] });
const SHOPX = vendor("shopx", "ShopX", "other", { recipes: ["shopx-recipe"] });
const browserOnly = (routes: Record<string, FakeHandler> = {}) =>
  base({
    "GET vendors": catalog(BROWSER_GITHUB),
    "GET connections": [],
    "GET providers": [],
    "GET automation": automation({ recipes: [recipe("gh-recipe", "gh-token", "github.com")] }),
    "GET secrets": [{ id: "e1", vendor: "github", browser: true, expiry: "date", daysLeft: 20, expires: day(20) }],
    ...routes,
  });
const multiPortal = (routes: Record<string, FakeHandler> = {}) =>
  base({
    "GET vendors": catalog(SHOPX),
    "GET connections": [],
    "GET providers": [],
    "GET automation": automation({
      recipes: [recipe("shopx-recipe", "shopx-token", "live.shopx.test", { hosts: [{ value: "live", host: "live.shopx.test" }, { value: "test", host: "test.shopx.test" }], hostBy: "mode" })],
    }),
    "GET secrets": [{ id: "e1", vendor: "shopx", browser: true, expiry: "date", daysLeft: 20, expires: day(20) }],
    ...routes,
  });

describe("Connections page: browser sign-in checks", () => {
  it("checks the sign-in of a provider and shows the answer on the card", async () => {
    const portal = browserOnly({ "POST recipes/gh-recipe/check": { signedIn: true, checkedAt: new Date().toISOString() } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("facade.checkSignin") }));
    expect(await card.findByText(t("providers.signIn.signedInYes"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "recipes/gh-recipe/check")).toHaveLength(1);
    expect(card.getByText(t("providers.card.signedIn"))).toBeInTheDocument();
  });

  it("reports that the browser is signed out", async () => {
    browserOnly({ "POST recipes/gh-recipe/check": { signedIn: false, checkedAt: new Date().toISOString() } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("facade.checkSignin") }));
    expect(await card.findByText(t("providers.signIn.signedInNo"))).toBeInTheDocument();
  });

  it("explains a check that could not be made", async () => {
    browserOnly({ "POST recipes/gh-recipe/check": { signedIn: false, checkedAt: new Date().toISOString(), failure: { code: "browser-unreachable", message: "no browser here", messageEn: "no browser here" } } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("facade.checkSignin") }));
    expect(await card.findByRole("alert")).toBeInTheDocument();
    expect(card.getByText(t("providers.card.signInFailed"))).toBeInTheDocument();
  });

  it("shows the server's text when the check request itself fails", async () => {
    browserOnly({ "POST recipes/gh-recipe/check": { status: 502, body: { error: "browser refused" } } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("facade.checkSignin") }));
    expect((await card.findAllByText("browser refused")).length).toBeGreaterThan(0);
  });

  it("falls back to a generic text when the failure has no message", async () => {
    browserOnly({ "POST recipes/gh-recipe/check": { status: 502, body: {} } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("facade.checkSignin") }));
    await waitFor(() => expect(card.getByRole("alert")).toBeInTheDocument());
  });

  it("offers a sign-in button on the collapsed card when the browser needs one", async () => {
    browserOnly();
    const { user } = renderApp(<ConnectionsPage />);
    await user.click(await screen.findByRole("button", { name: t("providers.signIn.buttonLabel", { name: "GitHub" }) }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("checks each portal of a provider with several portals on its own", async () => {
    const portal = multiPortal({
      "POST recipes/shopx-recipe/check": (call) => ((call.body as { host: string }).host === "live.shopx.test" ? { signedIn: true, checkedAt: new Date().toISOString() } : { signedIn: false, checkedAt: new Date().toISOString(), failure: { code: "browser-unreachable", message: "portal down", messageEn: "portal down" } }),
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "ShopX");
    await user.click(card.getByRole("button", { name: t("providers.signIn.hostCheck", { portal: "live" }) }));
    await user.click(card.getByRole("button", { name: t("providers.signIn.hostCheck", { portal: "test" }) }));
    expect(await card.findByText(t("providers.signIn.hostYes", { name: "ShopX", portal: "live" }))).toBeInTheDocument();
    expect(await card.findByText(t("providers.signIn.hostFailed", { name: "ShopX", portal: "test" }), { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("POST", "recipes/shopx-recipe/check").map((c) => c.body)).toEqual([{ host: "live.shopx.test" }, { host: "test.shopx.test" }]);
  });

  it("says a portal is signed out", async () => {
    multiPortal({ "POST recipes/shopx-recipe/check": { signedIn: false, checkedAt: new Date().toISOString() } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "ShopX");
    await user.click(card.getByRole("button", { name: t("providers.signIn.hostCheck", { portal: "live" }) }));
    expect(await card.findByText(t("providers.signIn.hostNo", { name: "ShopX", portal: "live" }))).toBeInTheDocument();
  });

  it("offers one sign-in button per portal", async () => {
    multiPortal();
    const { user } = renderApp(<ConnectionsPage />);
    await user.click(await screen.findByRole("button", { name: t("providers.signIn.buttonLabelAt", { name: "ShopX", portal: "live" }) }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

const cloud = (routes: Record<string, FakeHandler> = {}) =>
  base({
    "GET vendors": catalog(CLOUD),
    "GET connections": [
      connection("cloudflare", "cloudflare", { source: "vault", expires: day(5), savedAt: day(0), description: "Main token" }),
      connection("cloudflare-turnstile", "cloudflare", { role: "optional", source: "env", expires: null, savedAt: day(-120) }),
      connection("cf-legacy", "cloudflare", { role: "legacy", source: "weird", description: null }),
      connection("cf-soon", "cloudflare", { source: "op", expires: day(10) }),
      connection("cf-expired", "cloudflare", { source: "session", expires: day(-3), savedAt: "not a date" }),
      connection("cf-off", "cloudflare", { connected: false }),
    ],
    "GET providers": [],
    "GET automation": automation(),
    "GET secrets": [],
    ...routes,
  });
const keyRow = (card: ReturnType<typeof within>, name: string) => card.getByRole("button", { name: t("providers.key.show", { name }) });

describe("Connections page: the keys of a provider", () => {
  it("shows every kind of key with its expiry level, purpose and age", async () => {
    cloud();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    expect(card.queryByRole("button", { name: t("providers.key.show", { name: "cf-off" }) })).toBeNull();
    await user.click(keyRow(card, "cloudflare"));
    expect(card.getByText(t("connections.expCritical"))).toBeInTheDocument();
    expect(card.getByText("Main token")).toBeInTheDocument();
    expect(card.getByText(t("connections.savedToday"))).toBeInTheDocument();
    expect(card.getByText(t("connectionPurpose.cloudflare"))).toBeInTheDocument();
    await user.click(keyRow(card, "cloudflare-turnstile"));
    expect(card.getByText(t("providers.keys.optional"))).toBeInTheDocument();
    expect(card.getByText(t("connections.staleNoExpiry", { days: 120 }))).toBeInTheDocument();
    expect(card.getByText(t("connections.neverExpires"))).toBeInTheDocument();
    await user.click(keyRow(card, "cf-legacy"));
    expect(card.getByText(t("providers.keys.legacy"))).toBeInTheDocument();
    expect(card.getByText(t("connections.expiryUnknown"))).toBeInTheDocument();
    expect(card.getByText(t("connections.connectedBadge", { source: "weird" }))).toBeInTheDocument();
    await user.click(keyRow(card, "cf-soon"));
    expect(card.getByText(t("connections.expSoon"))).toBeInTheDocument();
    await user.click(keyRow(card, "cf-expired"));
    expect(card.getByText(t("connections.expExpired"))).toBeInTheDocument();
    expect(card.getByText(t("connections.expExpiredHint"))).toBeInTheDocument();
    expect(card.queryByText(t("connections.savedToday"), { selector: "p.mt-1" })).toBeInTheDocument();
  });

  it("tests a key and shows the expiry the provider reports instead of the stored one", async () => {
    const portal = cloud({
      "POST connections/cloudflare/check": { ok: true, expires: day(60), checks: [{ id: "c1", label: "Token is active", status: "pass" }, { id: "c2", label: "Scope", status: "fail", detail: "too wide" }] },
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cloudflare"));
    expect(card.getByText(t("connections.expCritical"))).toBeInTheDocument();
    await user.click(card.getAllByRole("button", { name: t("connections.test") })[0]!);
    expect(await card.findByText("Token is active")).toBeInTheDocument();
    expect(card.getByText("too wide")).toBeInTheDocument();
    expect(portal.callsTo("POST", "connections/cloudflare/check")).toHaveLength(1);
    expect(card.getByText(t("connections.expOk"))).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: t("connections.testClose") }));
    expect(card.queryByText("Token is active")).toBeNull();
    expect(card.getByText(t("connections.expCritical"))).toBeInTheDocument();
  });

  it("opens the guide of a key", async () => {
    cloud();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cloudflare"));
    await user.click(card.getByRole("button", { name: t("connections.guide") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("disconnects a stored key and reloads", async () => {
    const portal = cloud({ "DELETE connections/cloudflare/token": connection("cloudflare", "cloudflare", { connected: false }) });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cloudflare"));
    await user.click(card.getByRole("button", { name: t("connections.disconnect") }));
    await waitFor(() => expect(portal.callsTo("DELETE", "connections/cloudflare/token")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "connections").length).toBeGreaterThanOrEqual(2));
  });

  it("keeps the list as it is when disconnecting fails", async () => {
    const portal = cloud({ "DELETE connections/cloudflare/token": { status: 500, body: { error: "vault locked" } } });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cloudflare"));
    await user.click(card.getByRole("button", { name: t("connections.disconnect") }));
    expect(await screen.findByText("vault locked", { exact: false })).toBeInTheDocument();
    expect(portal.callsTo("GET", "connections")).toHaveLength(1);
  });

  it("offers no disconnect for a key that comes from the environment", async () => {
    cloud();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cloudflare-turnstile"));
    expect(card.queryByRole("button", { name: t("connections.disconnect") })).toBeNull();
  });
});

const STRIPE_PREFIXED = vendor("stripe", "Stripe", "payments", { connectionPrefixes: ["stripe:"], legacyConnections: ["stripe"], recipes: ["stripe-recipe"], connections: [] });
const stripe = (routes: Record<string, FakeHandler> = {}, facadeOver: Record<string, unknown> = {}) =>
  base({
    "GET vendors": catalog(STRIPE_PREFIXED),
    "GET connections": [
      connection("stripe:acct_1AbC:sandbox", "stripe", { label: "Stripe Shop (Sandbox)", expires: day(30) }),
      connection("stripe", "stripe", { role: "legacy", label: "Stripe" }),
    ],
    "GET providers": [],
    "GET automation": automation({ recipes: [recipe("stripe-recipe", "stripe-key", "stripe.example")] }),
    "GET facades": [facade("stripe", { connected: true, ...facadeOver })],
    "GET secrets": [],
    "GET state": runState({ status: "idle" }),
    ...routes,
  });

describe("Connections page: a provider with keys per account", () => {
  it("shows the accounts, the missing mode and the older connection", async () => {
    stripe();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    expect(card.getByText(t("providers.account.title", { account: "Shop" }))).toBeInTheDocument();
    expect(card.getByText(t("providers.account.missing", { mode: t("providers.mode.live") }))).toBeInTheDocument();
    expect(card.getByText(t("providers.account.legacyTitle", { count: 1 }))).toBeInTheDocument();
  });

  it("tests an account key and removes it", async () => {
    const portal = stripe({
      "POST connections/stripe%3Aacct_1AbC%3Asandbox/check": { ok: true, checks: [{ id: "c", label: "Key works", status: "pass" }] },
      "DELETE connections/stripe%3Aacct_1AbC%3Asandbox/token": connection("stripe:acct_1AbC:sandbox", "stripe", { connected: false }),
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    await user.click(card.getByRole("button", { name: t("providers.line.testLabel", { name: "Shop Sandbox" }) }));
    expect(await card.findByText("Key works")).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: t("providers.line.removeLabel", { name: "Shop Sandbox" }) }));
    await waitFor(() => expect(portal.callsTo("DELETE", "connections/stripe%3Aacct_1AbC%3Asandbox/token")).toHaveLength(1));
  });

  it("opens the details of the older connection", async () => {
    stripe();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    await user.click(card.getByText(t("providers.account.legacyTitle", { count: 1 })));
    await user.click(card.getByRole("button", { name: t("providers.line.details") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it.each([
    ["reconnects an account", (card: ReturnType<typeof within>) => card.getByRole("button", { name: t("providers.line.reconnectLabel", { name: "Shop Sandbox" }) })],
    ["connects the missing mode", (card: ReturnType<typeof within>) => card.getByRole("button", { name: t("providers.account.connectModeLabel", { account: "Shop", mode: t("providers.mode.live") }) })],
    ["connects another account", (card: ReturnType<typeof within>) => card.getByRole("button", { name: t("providers.line.connectAnother") })],
  ])("%s through the guided sign-in dialog", async (_name, find) => {
    stripe({ "POST facades/stripe/check": { signedIn: true, checkedAt: new Date().toISOString() }, "GET facades/stripe/state": runState({ status: "idle" }) });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    await user.click(find(card));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).queryByText(t("common.loading"))).toBeNull());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("connects through the guided sign-in and records the result on the card", async () => {
    let polls = 0;
    const portal = stripe({
      "GET facades/stripe/state": () => {
        polls += 1;
        return polls === 1 ? runState({ status: "running" }) : runState({ status: "done", result: { connected: true, storedIn: "session", keyName: "restricted key", projectId: null, check: null, counts: {} } });
      },
      "POST facades/stripe/check": { signedIn: true, checkedAt: new Date().toISOString() },
      "GET connections": [connection("stripe:acct_1AbC:sandbox", "stripe", { label: "Stripe Shop (Sandbox)", expires: day(30) })],
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    await user.click(card.getByRole("button", { name: t("providers.line.connectAnother") }));
    await screen.findByRole("dialog");
    await waitFor(() => expect(portal.callsTo("GET", "connections").length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole("button", { name: t("facade.done") })).toBeInTheDocument(), { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: t("facade.done") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Connections page: dialogs and entry points", () => {
  it("opens the provider list from the header and from the empty state, and closes it", async () => {
    base({ "GET connections": [], "GET secrets": [] });
    const { user } = renderApp(<ConnectionsPage />);
    const adds = await screen.findAllByRole("button", { name: t("connections.add") });
    await waitFor(() => expect(screen.getAllByRole("button", { name: t("connections.add") })).toHaveLength(2));
    await user.click(adds[0]!);
    expect(await screen.findByRole("dialog", { name: t("providers.pickTitle") })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getAllByRole("button", { name: t("connections.add") })[1]!);
    expect(await screen.findByRole("dialog", { name: t("providers.pickTitle") })).toBeInTheDocument();
  });

  it("offers setting up a provider that has entries but no way in yet", async () => {
    base({ "GET vendors": catalog(TELEGRAM), "GET connections": [], "GET providers": [], "GET automation": automation(), "GET secrets": [{ vendor: "telegram" }] });
    const { user } = renderApp(<ConnectionsPage />);
    await user.click(await screen.findByRole("button", { name: t("providers.setUpLabel", { name: "Telegram" }) }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens a provider's own dialog through Manage", async () => {
    base();
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    await user.click(card.getByRole("button", { name: t("providers.page.manage") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("names the guided sign-in button after the connection state and disables it when it cannot run", async () => {
    stripe({}, { connected: true });
    const first = renderApp(<ConnectionsPage />);
    const card = await openCard(first.user, "Stripe");
    await first.user.click(card.getByRole("button", { name: t("facade.reconnect") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    first.unmount();
    stripe({}, { connected: false, available: false, reason: "browser off" });
    const second = renderApp(<ConnectionsPage />);
    // The first render left the card open (the page remembers it).
    const again = within((await screen.findByRole("button", { name: hide("Stripe") })).closest("section") as HTMLElement);
    expect(again.getByRole("button", { name: t("facade.connectWith") })).toBeDisabled();
    expect(again.getByRole("button", { name: t("facade.checkSignin") })).toBeDisabled();
  });

  it("reconnects accounts whose id carries the test mode or no mode", async () => {
    stripe({
      "GET connections": [
        connection("stripe:acct_old:test", "stripe", { label: "Stripe Old (Test)", expires: day(30) }),
        connection("stripe:acct_bare", "stripe", { label: "Stripe Bare", expires: day(30) }),
      ],
      "GET facades/stripe/state": runState({ status: "idle" }),
      "POST facades/stripe/check": { signedIn: true, checkedAt: new Date().toISOString() },
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    await user.click(card.getByRole("button", { name: t("providers.line.reconnectLabel", { name: "Old Sandbox" }) }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await user.click(card.getByRole("button", { name: t("providers.line.reconnectLabel", { name: "Bare" }) }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
  });

  it("shows a per-account provider without a guided sign-in without reconnect buttons", async () => {
    stripe({ "GET facades": [], "GET vendors": catalog(vendor("stripe", "Stripe", "payments", { connectionPrefixes: ["stripe:"], legacyConnections: ["stripe"] })) });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Stripe");
    expect(card.getByText(t("providers.account.title", { account: "Shop" }))).toBeInTheDocument();
    expect(card.queryByRole("button", { name: /Reconnect|Erneut/ })).toBeNull();
  });

  it("hints at replacing an older key when a guided sign-in exists", async () => {
    base({
      "GET vendors": catalog(vendor("acme", "Acme", "other", { legacyConnections: ["acme-old"], connections: ["acme"] })),
      "GET connections": [connection("acme-old", "acme", { role: "legacy" })],
      "GET facades": [facade("acme", { connected: false })],
      "GET secrets": [],
      "GET providers": [],
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Acme");
    expect(card.getByText(t("providers.keys.legacyHint"))).toBeInTheDocument();
  });

  it("stores a key from the dialog and refreshes the page", async () => {
    const portal = cloud({ "POST connections/cf-soon/token": connection("cf-soon", "cloudflare", { expires: day(90) }) });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    await user.click(keyRow(card, "cf-soon"));
    await user.click(card.getByRole("button", { name: t("connections.guide") }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByLabelText(t("connections.step3")), "value-for-tests");
    await user.click(dialog.getByRole("button", { name: t("connections.connect") }));
    await waitFor(() => expect(portal.callsTo("POST", "connections/cf-soon/token")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "connections").length).toBeGreaterThanOrEqual(2));
  });

  it("adds a provider by hand and returns to the provider list", async () => {
    const portal = base({ "GET connections": [], "GET secrets": [], "POST providers": { id: "acme-tool", label: "Acme Tool" } });
    const { user } = renderApp(<ConnectionsPage />);
    await user.click((await screen.findAllByRole("button", { name: t("connections.add") }))[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("connections.addCustom") }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByLabelText(new RegExp(t("connections.fieldName"))), "Acme Tool");
    await user.type(dialog.getByLabelText(new RegExp(t("connections.fieldId"))), "acme-tool");
    await user.type(dialog.getByLabelText(new RegExp(t("connections.fieldUrl"))), "https://acme.example/keys");
    await user.click(dialog.getByRole("button", { name: t("connections.addProvider") }));
    await waitFor(() => expect(portal.callsTo("POST", "providers")).toHaveLength(1));
    expect(await screen.findByRole("dialog", { name: t("providers.pickTitle") })).toBeInTheDocument();
    expect(portal.callsTo("GET", "providers").length).toBeGreaterThanOrEqual(2);
  });

  it("closes the add-provider dialog without adding", async () => {
    base({ "GET connections": [], "GET secrets": [] });
    const { user } = renderApp(<ConnectionsPage />);
    await user.click((await screen.findAllByRole("button", { name: t("connections.add") }))[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("connections.addCustom") }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("connections.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the sign-in dialog named in the address once and cleans the address", async () => {
    navigation.set("/connections?signin=github");
    browserOnly();
    renderApp(<ConnectionsPage />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(navigation.router.replace).toHaveBeenCalledWith("/connections");
  });

  it("only cleans the address when the sign-in names an unknown provider", async () => {
    navigation.set("/connections?signin=nobody");
    browserOnly();
    renderApp(<ConnectionsPage />);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/connections"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a malformed sign-in parameter", async () => {
    navigation.set("/connections?signin=../x");
    browserOnly();
    renderApp(<ConnectionsPage />);
    await screen.findByRole("button", { name: show("GitHub") });
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });
});

describe("Connections page: lists that fail to load", () => {
  it("still shows the providers from the connections when the other lists fail", async () => {
    const down = { status: 500, body: { error: "down" } };
    base({
      "GET vendors": catalog(CLOUD),
      "GET connections": [connection("cloudflare", "cloudflare", { expires: day(40) })],
      "GET providers": down,
      "GET automation": down,
      "GET facades": down,
      "GET secrets": down,
      "GET variables": down,
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "Cloudflare");
    expect(card.getByText(t("providers.countsNone"))).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: t("providers.page.manage") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("uses the server's sign-in memory and lifetimes when the automation info has them", async () => {
    browserOnly({
      "GET automation": automation({
        recipes: [recipe("gh-recipe", "gh-token", "github.com")],
        signInChecks: [{ host: "github.com", signedIn: true, checkedAt: new Date().toISOString() }],
        signInLifetimes: [{ host: "github.com", averageMinutes: 600, samples: 3, measuredAt: new Date().toISOString() }],
      }),
    });
    const { user } = renderApp(<ConnectionsPage />);
    const card = await openCard(user, "GitHub");
    expect(card.getByText(t("providers.card.sessionLasts", { hours: 10 }))).toBeInTheDocument();
  });
});
