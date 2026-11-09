import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import SecretDetailPage from "@/app/secrets/[id]/page";
import { formatDate } from "@/lib/format";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";

beforeEach(() => navigation.setParams({ id: "s1" }));

const secret = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "STRIPE_KEY",
  title: null,
  description: null,
  owner: null,
  link: null,
  tags: [],
  product: null,
  stage: "dev",
  service: "stripe",
  provider: "manual",
  automatic: false,
  browser: false,
  readOnly: false,
  expiry: "date",
  expires: "2026-06-01",
  daysLeft: 30,
  status: "ok",
  rotatedAt: "2026-01-01",
  verifiedAt: null,
  verifiedBy: null,
  ttlDays: null,
  places: [],
  guide: null,
  connection: null,
  vendor: null,
  browserHost: null,
  notes: null,
  params: { status: "none", missing: [] },
  ...over,
});
const report = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  secretId: "s1",
  secretName: "STRIPE_KEY",
  createdAt,
  kind: "issued",
  provider: "manual",
  stage: "dev",
  label: "label",
  targets: [],
  checks: [],
  checklist: [],
  fingerprint: `fp-${id}`,
  attachments: [],
  ...over,
});
const run = (over: Record<string, unknown> = {}) => ({ secretId: "s1", providerId: "p", status: "idle", text: "", host: null, step: null, startedAt: "", updatedAt: "", ...over });
const plan = (over: Record<string, unknown> = {}) => ({ places: ["acme/app"], automatic: true, revokesOld: true, ttlDays: 30, stage: "dev", provider: "manual", ...over });

const page = (routes: Record<string, FakeHandler> = {}) => fakePortal({ "GET secrets/s1": secret(), "GET evidence/s1": [], "GET normalization": { changes: [] }, ...routes });
const loaded = async () => screen.findByText(t("secretDetail.description"));

describe("Secret detail: loading and header", () => {
  it("shows a skeleton while loading", () => {
    page();
    const { container } = renderApp(<SecretDetailPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
  });

  it("shows the error and retries", async () => {
    let fail = true;
    page({ "GET secrets/s1": () => (fail ? { status: 404, body: { error: "no such entry" } } : secret()) });
    const { user } = renderApp(<SecretDetailPage />);
    expect(await screen.findByText("no such entry")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    await loaded();
  });

  it("shows the title when there is one and offers manual entry only for a manual entry", async () => {
    page({ "GET secrets/s1": secret({ title: "Stripe live key" }) });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByRole("heading", { name: "Stripe live key" })).toBeInTheDocument();
    expect(screen.getByText("STRIPE_KEY")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("secretDetail.back") })).toHaveAttribute("href", "/entries?kind=secret");
    expect(screen.queryByRole("button", { name: t("secretDetail.generate") })).toBeNull();
    expect(screen.getByRole("button", { name: t("secretDetail.pasteValue") })).toBeInTheDocument();
  });

  it("offers generating for automatic entries and reading again for read-only ones", async () => {
    page({ "GET secrets/s1": secret({ automatic: true }) });
    const first = renderApp(<SecretDetailPage />);
    expect(await screen.findByRole("button", { name: t("secretDetail.generate") })).toBeEnabled();
    first.unmount();
    page({ "GET secrets/s1": secret({ automatic: true, readOnly: true }) });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByRole("button", { name: t("secretDetail.readAgain") })).toBeInTheDocument();
  });
});

describe("Secret detail: description and facts", () => {
  it("shows description, owner, link, tags, notes, targets and dates", async () => {
    page({
      "GET secrets/s1": secret({
        description: "Payment key",
        owner: "Team Pay",
        link: "https://example.test/dashboard",
        tags: ["payments", "eu"],
        notes: "rotate yearly",
        verifiedAt: "2026-02-03",
        verifiedBy: "alice",
        places: [{ repo: "acme/app", scope: "repository" }],
      }),
    });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText("Payment key")).toBeInTheDocument();
    expect(screen.getByText("Team Pay")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /example\.test\/dashboard/ })).toHaveAttribute("href", "https://example.test/dashboard");
    expect(screen.getByText("#payments")).toBeInTheDocument();
    expect(screen.getByText("rotate yearly")).toBeInTheDocument();
    expect(screen.getByText(formatDate("2026-02-03"), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.verifiedBy", { name: "alice" }).trim(), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(t("secretDetail.noTargets"))).toBeNull();
  });

  it("shows a description without an owner", async () => {
    page({ "GET secrets/s1": secret({ description: "Only a description" }) });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText("Only a description")).toBeInTheDocument();
    expect(screen.queryByText(t("secretDetail.owner"))).toBeNull();
  });

  it("says so when there is no description and no target", async () => {
    page();
    renderApp(<SecretDetailPage />);
    await loaded();
    expect(screen.getByText(t("secretDetail.noDescription"))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.noTargets"))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.never"))).toBeInTheDocument();
  });

  it("shows an entry with only an owner and no description", async () => {
    page({ "GET secrets/s1": secret({ owner: "Team Pay" }) });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText("Team Pay")).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.noDescription"))).toBeInTheDocument();
  });

  it("describes a read-only entry that never expires, read or not yet read", async () => {
    page({ "GET secrets/s1": secret({ readOnly: true, expiry: "none", verifiedAt: "2026-02-03" }) });
    const first = renderApp(<SecretDetailPage />);
    expect(await screen.findByText(t("secretDetail.neverExpiresRead", { date: formatDate("2026-02-03") }))).toBeInTheDocument();
    first.unmount();
    page({ "GET secrets/s1": secret({ readOnly: true, expiry: "none" }) });
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText(t("secretDetail.neverExpiresUnread"))).toBeInTheDocument();
  });

  it("edits the description and reloads the entry", async () => {
    const portal = page({ "PATCH secrets/s1": {} });
    const { user } = renderApp(<SecretDetailPage />);
    await loaded();
    await user.click(screen.getByRole("button", { name: t("secretDetail.edit") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: t("meta.save") }));
    await waitFor(() => expect(portal.callsTo("PATCH", "secrets/s1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(portal.callsTo("GET", "secrets/s1").length).toBeGreaterThanOrEqual(2);
  });

  it("closes the edit dialog without saving", async () => {
    page();
    const { user } = renderApp(<SecretDetailPage />);
    await loaded();
    await user.click(screen.getByRole("button", { name: t("secretDetail.edit") }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("meta.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Secret detail: history", () => {
  it("lists reviews, newest first, with the decision and the attachments", async () => {
    page({
      "GET evidence/s1": [
        report("old", "2026-01-01T10:00:00.000Z", { checks: [{ id: "a", label: "A", status: "fail" }], confirmation: { decision: "rejected", by: "bob", at: "2026-01-01T11:00:00.000Z", note: "wrong key" } }),
        report("new", "2026-03-01T10:00:00.000Z", { checks: [{ id: "a", label: "A", status: "warn" }], confirmation: { decision: "confirmed", by: "alice", at: "2026-03-01T11:00:00.000Z" }, attachments: [{ file: "s.png", note: "proof" }] }),
        report("mid", "2026-02-01T10:00:00.000Z", { checks: [{ id: "a", label: "A", status: "pass" }] }),
      ],
    });
    renderApp(<SecretDetailPage />);
    await screen.findByText("fp-new");
    const order = screen.getAllByText(/^fp-/).map((n) => n.textContent);
    expect(order).toEqual(["fp-new", "fp-mid", "fp-old"]);
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText(/wrong key/)).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.notConfirmed"))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.attachments"))).toBeInTheDocument();
    expect(screen.getByText(t("common.overall.fail"))).toBeInTheDocument();
    expect(screen.getByText(t("common.overall.warn"))).toBeInTheDocument();
    expect(screen.getByText(t("common.overall.pass"))).toBeInTheDocument();
  });

  it("shows the empty state and the history error with a retry", async () => {
    let fail = true;
    page({ "GET evidence/s1": () => (fail ? { status: 500, body: { error: "history broke" } } : []) });
    const { user } = renderApp(<SecretDetailPage />);
    expect(await screen.findByText("history broke")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText(t("secretDetail.noReviewTitle"))).toBeInTheDocument();
  });
});

describe("Secret detail: renewal", () => {
  const generate = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.click(await screen.findByRole("button", { name: t("secretDetail.generate") }));
  };

  it("starts a renewal and opens the review", async () => {
    const portal = page({ "GET secrets/s1": secret({ automatic: true }), "POST renewal-requests": { status: "awaiting-review", issuance: { id: "iss/9" }, message: "" } });
    const { user } = renderApp(<SecretDetailPage />);
    await generate(user);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/reviews/iss%2F9"));
    expect(portal.callsTo("POST", "renewal-requests")[0]!.body).toEqual({ secretId: "s1" });
  });

  it("points to the approvals when an approval is needed", async () => {
    page({ "GET secrets/s1": secret({ automatic: true }), "POST renewal-requests": { status: "pending-approval", approvalId: "a1", secretId: "s1", message: "" } });
    const { user } = renderApp(<SecretDetailPage />);
    await generate(user);
    expect(await screen.findByText(t("secretDetail.approvalTitle"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("secretDetail.toApprovals") })).toHaveAttribute("href", "/approvals");
  });

  it("shows the plan of a dry run with all its parts", async () => {
    const portal = page({
      "POST renewal-requests": {
        status: "dry-run",
        plan: plan({ params: { ok: true, missing: [], problems: [] } }),
        preflight: { status: "ok", resource: "project-1", findings: [{ id: "f1", label: "Scope too wide", status: "warn", detail: "has admin" }, { id: "f2", label: "No expiry", status: "warn" }] },
      },
    });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    expect(await screen.findByText(t("secretDetail.dryRunTitle"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "renewal-requests")[0]!.body).toEqual({ secretId: "s1", dryRun: true });
    expect(screen.getByText(t("secretDetail.planAuto"))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.planTargets", { targets: "acme/app" }))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.planRevokes"))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.planTtl", { days: 30 }))).toBeInTheDocument();
    expect(screen.getByText(t("params.plan.paramsOk"))).toBeInTheDocument();
    expect(screen.getByText(t("params.plan.resource", { resource: "project-1" }))).toBeInTheDocument();
    expect(screen.getByText("Scope too wide (has admin); No expiry")).toBeInTheDocument();
  });

  it.each([
    ["a manual plan without targets that keeps the old value", plan({ automatic: false, places: [], revokesOld: false, ttlDays: null }), [t("secretDetail.planManual"), t("secretDetail.planTargets", { targets: t("secretDetail.planNoTargets") }), t("secretDetail.planKeeps")]],
    ["a read-only plan", plan({ readOnly: true }), [t("secretDetail.planRead")]],
    ["missing parameters", plan({ params: { ok: false, missing: ["accountId"], problems: [] } }), [t("params.plan.paramsMissing", { keys: "accountId" })]],
    ["invalid parameters", plan({ params: { ok: false, missing: [], problems: [{ message: "too short" }, { message: "bad chars" }] } }), [t("params.plan.paramsInvalid", { text: "too short; bad chars" })]],
  ])("shows %s", async (_name, p, lines) => {
    page({ "POST renewal-requests": { status: "dry-run", plan: p } });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    for (const line of lines) expect(await screen.findByText(line)).toBeInTheDocument();
  });

  it("shows a preflight without resource and without findings quietly", async () => {
    page({ "POST renewal-requests": { status: "dry-run", plan: plan(), preflight: { status: "skipped", resource: null, findings: [] } } });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    await screen.findByText(t("secretDetail.dryRunTitle"));
    expect(screen.queryByText(t("params.plan.resource", { resource: "" }), { exact: false })).toBeNull();
  });

  it("sends the user to the parameters when they are missing or invalid", async () => {
    const portal = page({ "GET secrets/s1": secret({ automatic: true, params: { status: "missing", missing: ["accountId", "region"] } }), "GET secrets/s1/params": { status: 404, body: { error: "no params" } } });
    const { user } = renderApp(<SecretDetailPage />);
    const generateButton = await screen.findByRole("button", { name: t("secretDetail.generate") });
    expect(generateButton).toBeDisabled();
    const blocked = t("params.card.blocked", { keys: "accountId, region" });
    expect(screen.getAllByText(blocked, { exact: false }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: t("secretDetail.planOnly") }));
    await user.click(screen.getByRole("button", { name: t("params.card.goTo") }));
    expect(portal.callsTo("POST", "renewal-requests")).toHaveLength(0);
  });

  it("explains invalid parameters without naming keys", async () => {
    page({ "GET secrets/s1": secret({ params: { status: "invalid", missing: [] } }), "GET secrets/s1/params": { status: 404, body: { error: "no params" } } });
    renderApp(<SecretDetailPage />);
    expect((await screen.findAllByText(t("params.card.blockedPlain"), { exact: false })).length).toBeGreaterThan(0);
  });

  it("goes to the parameter card with the server's message when the request names parameter problems", async () => {
    page({
      "GET secrets/s1": secret({ automatic: true, params: { status: "ok", missing: [] } }),
      "GET secrets/s1/params": { provider: "manual", providerLabel: "Manual", connection: null, connected: null, effective: { region: "eu" }, unknown: {}, resources: {}, specs: [{ key: "region", label: "Region", labelEn: "Region", type: "string", required: true, help: "", helpEn: "" }], values: { region: "eu" }, defaults: {}, problems: [], complete: true, preflight: null },
      "POST renewal-requests": { status: 400, body: { error: "parameters are wrong", code: "params_invalid", problems: [{ key: "region", code: "invalid" }] } },
    });
    const { user } = renderApp(<SecretDetailPage />);
    await generate(user);
    expect(await screen.findByText("parameters are wrong")).toBeInTheDocument();
  });

  it("shows failed preflight findings", async () => {
    page({ "POST renewal-requests": { status: 400, body: { error: "preflight", code: "preflight_failed", findings: [{ id: "f", label: "Token lacks scope", status: "fail", detail: "needs repo" }] } } });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    expect(await screen.findByText(t("params.preflight.failedTitle"))).toBeInTheDocument();
    expect(screen.getByText(/Token lacks scope/)).toBeInTheDocument();
  });

  it("points to the integrations when the connection is missing, with or without a hint", async () => {
    page({ "POST renewal-requests": { status: 409, body: { error: "GitHub is not connected", code: "not-connected", hint: "add a token", connection: "github" } } });
    const first = renderApp(<SecretDetailPage />);
    await first.user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    expect(await screen.findByText(t("secretDetail.connMissingTitle"))).toBeInTheDocument();
    expect(screen.getByText("GitHub is not connected (add a token)", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("secretDetail.toConnections") })).toHaveAttribute("href", "/connections");
    first.unmount();
    page({ "POST renewal-requests": { status: 409, body: { error: "Cloudflare is not connected", code: "not-connected" } } });
    const second = renderApp(<SecretDetailPage />);
    await second.user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    expect(await screen.findByText("Cloudflare is not connected", { exact: false })).toBeInTheDocument();
  });

  it("falls back to a generic message when something that is no error is thrown", async () => {
    page({ "GET secrets/s1": secret({ automatic: true }), "POST renewal-requests": { status: "awaiting-review", issuance: { id: "iss-1" }, message: "" } });
    navigation.router.push.mockImplementation(() => {
      throw "navigation refused";
    });
    const { user } = renderApp(<SecretDetailPage />);
    await generate(user);
    expect(await screen.findByText(t("secretDetail.unknownError"))).toBeInTheDocument();
  });

  it("falls back to the plain parameter text when a thrown value names problems but has no message", async () => {
    page({
      "GET secrets/s1": secret({ automatic: true, params: { status: "ok", missing: [] } }),
      "GET secrets/s1/params": { provider: "manual", providerLabel: "Manual", connection: null, connected: null, effective: {}, unknown: {}, resources: {}, specs: [{ key: "region", label: "Region", labelEn: "Region", type: "string", required: true, help: "", helpEn: "" }], values: {}, defaults: {}, problems: [], complete: true, preflight: null },
      "POST renewal-requests": { status: "awaiting-review", issuance: { id: "iss-1" }, message: "" },
    });
    navigation.router.push.mockImplementation(() => {
      throw { code: "params_invalid", problems: [{ key: "region", code: "invalid" }] };
    });
    const { user } = renderApp(<SecretDetailPage />);
    await generate(user);
    expect(await screen.findByText(t("params.card.blockedPlain"))).toBeInTheDocument();
  });

  it("reloads the entry after the parameters were saved in their card", async () => {
    const view = { provider: "manual", providerLabel: "Manual", connection: null, connected: null, effective: { region: "eu" }, unknown: {}, resources: {}, specs: [{ key: "region", label: "Region", labelEn: "Region", type: "string", required: true, help: "", helpEn: "" }], values: { region: "eu" }, defaults: {}, problems: [], complete: true, preflight: null };
    const portal = page({ "GET secrets/s1": secret({ params: { status: "ok", missing: [] } }), "GET secrets/s1/params": view, "PUT secrets/s1/params": view, "GET providers/manual/params*": view });
    const { user } = renderApp(<SecretDetailPage />);
    const card = within(await screen.findByText(t("params.card.title"), { selector: "h2" }).then((h) => h.closest("section") as HTMLElement));
    await user.click(await card.findByRole("button", { name: t("params.card.edit") }));
    const field = await screen.findByDisplayValue("eu");
    await user.clear(field);
    await user.type(field, "us");
    // The draft is checked against the provider after a short pause; let that request finish inside the test.
    await waitFor(() => expect(portal.calls.some((c) => c.path.startsWith("providers/manual/params") && c.path.includes("param.region=us"))).toBe(true));
    await user.click(screen.getByRole("button", { name: t("params.card.save") }));
    await waitFor(() => expect(portal.callsTo("PUT", "secrets/s1/params")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "secrets/s1").length).toBeGreaterThanOrEqual(2));
  });

  it("shows any other failure as a toast", async () => {
    page({ "POST renewal-requests": { status: 500, body: { error: "provider exploded" } } });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.planOnly") }));
    expect(await screen.findByText("provider exploded")).toBeInTheDocument();
  });
});

describe("Secret detail: browser run", () => {
  const browser = (state: Record<string, unknown> | FakeHandler) => page({ "GET secrets/s1": secret({ automatic: true, browser: true }), "GET automation/runs/s1": state as FakeHandler });

  it("shows no run panel when nothing runs", async () => {
    browser(run());
    renderApp(<SecretDetailPage />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(new RegExp(`^${t("secretDetail.browserTitle")}`))).toBeNull();
    expect(screen.queryByRole("button", { name: t("secretDetail.browserCancel") })).toBeNull();
  });

  it("follows a running run and cancels it", async () => {
    const portal = browser(run({ status: "running", text: "Opening the portal", host: "dash.example", step: { index: 2, total: 5 }, createdName: "made-key" }));
    portal.calls.length = 0;
    fakePortal({
      "GET secrets/s1": secret({ automatic: true, browser: true }),
      "GET evidence/s1": [],
      "GET automation/runs/s1": run({ status: "running", text: "Opening the portal", host: "dash.example", step: { index: 2, total: 5 }, createdName: "made-key" }),
      "POST automation/runs/s1/cancel": run({ status: "cancelled" }),
    });
    const { user } = renderApp(<SecretDetailPage />);
    expect(await screen.findByText("Opening the portal")).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.browserHost", { host: "dash.example" }))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.browserStep", { index: 2, total: 5 }))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.browserCreated", { name: "made-key" }))).toBeInTheDocument();
    expect(screen.getByText(t("secretDetail.browserReloadHint"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("secretDetail.generate") })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: t("secretDetail.browserCancel") }));
  });

  it("shows a cancel failure", async () => {
    fakePortal({
      "GET secrets/s1": secret({ automatic: true, browser: true }),
      "GET evidence/s1": [],
      "GET automation/runs/s1": run({ status: "waiting-human", text: "Sign in please" }),
      "POST automation/runs/s1/cancel": { status: 500, body: { error: "cannot cancel" } },
    });
    const { user } = renderApp(<SecretDetailPage />);
    expect(await screen.findByText(t("secretDetail.browserWaiting"), { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("secretDetail.browserCancel") }));
    expect(await screen.findByText("cannot cancel")).toBeInTheDocument();
  });

  it("links a finished run to its review", async () => {
    browser(run({ status: "done", text: "hidden when done", issuanceId: "iss-7" }));
    renderApp(<SecretDetailPage />);
    expect(await screen.findByRole("link", { name: t("secretDetail.browserToReview") })).toHaveAttribute("href", "/reviews/iss-7");
    expect(screen.getByText(t("secretDetail.browserDone"), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("hidden when done")).toBeNull();
  });

  it("shows a finished run without a review link", async () => {
    browser(run({ status: "done" }));
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText(t("secretDetail.browserDone"), { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("secretDetail.browserToReview") })).toBeNull();
  });

  it.each([
    ["failed", t("secretDetail.browserFailed")],
    ["cancelled", t("secretDetail.browserCancelled")],
  ])("shows a %s run", async (status, title) => {
    browser(run({ status, text: "what happened" }));
    renderApp(<SecretDetailPage />);
    expect(await screen.findByText(title, { exact: false })).toBeInTheDocument();
    expect(screen.getByText("what happened")).toBeInTheDocument();
  });

  it("starts a browser run: starting state first, then the review", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    fakePortal({
      "GET secrets/s1": secret({ automatic: true, browser: true }),
      "GET evidence/s1": [],
      "GET automation/runs/s1": run(),
      "POST renewal-requests": () => gate.then(() => ({ status: "awaiting-review", issuance: { id: "iss-3" }, message: "" })),
    });
    const { user } = renderApp(<SecretDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("secretDetail.generate") }));
    expect(await screen.findByText(t("secretDetail.browserStarting"), { exact: false })).toBeInTheDocument();
    await act(async () => {
      release(undefined);
      await gate;
    });
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/reviews/iss-3"));
    await waitFor(() => expect(screen.queryByText(t("secretDetail.browserStarting"), { exact: false })).toBeNull());
  });
});

describe("Secret detail: manual value", () => {
  const open = async (user: ReturnType<typeof renderApp>["user"]) => {
    await user.click(await screen.findByRole("button", { name: t("secretDetail.pasteValue") }));
    return within(await screen.findByRole("dialog"));
  };

  it("sends the value, empties the field and opens the review", async () => {
    const portal = page({ "POST secrets/s1/manual-value": { id: "iss-5" } });
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    expect(dialog.getByRole("button", { name: t("secretDetail.check") })).toBeDisabled();
    await user.type(dialog.getByLabelText(t("secretDetail.newValue")), "value-for-tests");
    await user.click(dialog.getByRole("button", { name: t("secretDetail.check") }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/reviews/iss-5"));
    expect(portal.callsTo("POST", "secrets/s1/manual-value")[0]!.body).toEqual({ value: "value-for-tests" });
    expect(dialog.getByLabelText(t("secretDetail.newValue"))).toHaveValue("");
  });

  it("ignores a submit without a value", async () => {
    const portal = page();
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    fireEvent.submit(dialog.getByLabelText(t("secretDetail.newValue")).closest("form")!);
    expect(portal.callsTo("POST", "secrets/s1/manual-value")).toHaveLength(0);
  });

  it("shows a failure and can be cancelled", async () => {
    page({ "POST secrets/s1/manual-value": { status: 400, body: { error: "value rejected" } } });
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    await user.type(dialog.getByLabelText(t("secretDetail.newValue")), "value-for-tests");
    await user.click(dialog.getByRole("button", { name: t("secretDetail.check") }));
    expect(await dialog.findByText("value rejected")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: t("secretDetail.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("copes with the dialog being closed while the value is on its way", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    const portal = page({ "POST secrets/s1/manual-value": () => gate.then(() => ({ id: "iss-6" })) });
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    await user.type(dialog.getByLabelText(t("secretDetail.newValue")), "value-for-tests");
    await user.click(dialog.getByRole("button", { name: t("secretDetail.check") }));
    await waitFor(() => expect(portal.callsTo("POST", "secrets/s1/manual-value")).toHaveLength(1));
    await user.keyboard("{Escape}");
    await act(async () => {
      release(undefined);
      await gate;
    });
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/reviews/iss-6"));
  });

  it("shows the guide with a prefilled link and steps", async () => {
    page({ "GET secrets/s1": secret({ guide: { url: "https://example.test/keys", openUrl: "https://example.test/keys?name=x", steps: ["Open keys", "Create key"] } }) });
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    expect(dialog.getByRole("link", { name: t("secretDetail.openProviderPrefilled") })).toHaveAttribute("href", "https://example.test/keys?name=x");
    expect(dialog.getByText("Create key")).toBeInTheDocument();
  });

  it("shows the plain guide link without steps", async () => {
    page({ "GET secrets/s1": secret({ guide: { url: "https://example.test/keys", openUrl: "https://example.test/keys", steps: [] } }) });
    const { user } = renderApp(<SecretDetailPage />);
    const dialog = await open(user);
    expect(dialog.getByRole("link", { name: t("secretDetail.openProviderGuide") })).toBeInTheDocument();
    expect(dialog.queryByRole("list")).toBeNull();
  });
});
