import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import ReviewDetailPage from "@/app/reviews/[id]/page";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";

// The thumbnail buttons are named "<alt> enlarge" in the interface language.
const ENLARGE = /enlarge|vergrößern/i;

beforeEach(() => navigation.setParams({ id: "iss-1" }));

const report = (over: Record<string, unknown> = {}) => ({
  id: "rep-1",
  secretId: "s1",
  secretName: "STRIPE_KEY",
  createdAt: "2026-01-02T10:00:00.000Z",
  kind: "issued",
  provider: "stripe",
  stage: "dev",
  label: "label",
  targets: [],
  checks: [],
  checklist: [{ id: "c1", text: "Value is in the vault" }, { id: "c2", text: "Old key revoked" }],
  fingerprint: "abc123def456",
  attachments: [],
  ...over,
});
const review = (over: Record<string, unknown> = {}, reportOver: Record<string, unknown> = {}) => ({
  id: "iss-1",
  secretId: "s1",
  secretName: "STRIPE_KEY",
  stage: "dev",
  provider: "stripe",
  kind: "issued",
  createdAt: "2026-01-02T10:00:00.000Z",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  overall: "pass",
  report: report(reportOver),
  ...over,
});
const commit = (over: Record<string, unknown> = {}) => ({ secretId: "s1", reportId: "rep-1", ok: true, partial: false, places: [{ place: "acme/app", outcome: "created" }], revokedOld: true, expires: "2026-06-01", ...over });

const page = (routes: Record<string, FakeHandler> = {}) => fakePortal({ "GET reviews/iss-1": review(), "GET secrets/s1": { name: "STRIPE_KEY", description: null }, ...routes });
const tickAll = async (user: ReturnType<typeof renderApp>["user"]) => {
  await user.click(await screen.findByRole("checkbox", { name: "Value is in the vault" }));
  await user.click(screen.getByRole("checkbox", { name: "Old key revoked" }));
};

describe("Review detail: loading and errors", () => {
  it("shows a skeleton while loading", () => {
    page();
    const { container } = renderApp(<ReviewDetailPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
  });

  it("shows the error with a way back and retries", async () => {
    let fail = true;
    page({ "GET reviews/iss-1": () => (fail ? { status: 404, body: { error: "review gone" } } : review()) });
    const { user } = renderApp(<ReviewDetailPage />);
    expect(await screen.findByText("review gone")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("reviews.detail.backAll") })).toHaveAttribute("href", "/reviews");
    expect(screen.getByText(t("reviews.detail.expiresHint"))).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByRole("heading", { name: "STRIPE_KEY" })).toBeInTheDocument();
  });
});

describe("Review detail: content", () => {
  it("shows the kind, the countdown, the description of the entry and all kinds of checks", async () => {
    page({
      "GET reviews/iss-1": review(
        { kind: "manual", overall: "warn" },
        {
          attachments: [{ file: "shot.png", note: "first shot" }],
          checks: [
            { id: "k1", label: "Both", status: "pass", expected: "10 days", actual: "9 days", detail: "close enough" },
            { id: "k2", label: "Only expected", status: "warn", expected: "10 days" },
            { id: "k3", label: "Only actual", status: "fail", actual: "9 days" },
            { id: "k4", label: "Nothing", status: "info" },
          ],
        },
      ),
      "GET secrets/s1": { name: "STRIPE_KEY", description: "Payment key for the shop" },
    });
    renderApp(<ReviewDetailPage />);
    expect(await screen.findByRole("heading", { name: "STRIPE_KEY" })).toBeInTheDocument();
    expect(screen.getByText(t("reviews.detail.atProvider", { kind: t("reviews.detail.kindManual"), provider: "stripe" }))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t("reviews.detail.timeLeft", { time: "\\d\\d:\\d\\d" })))).toBeInTheDocument();
    expect(await screen.findByText("Payment key for the shop")).toBeInTheDocument();
    expect(screen.getByText("close enough")).toBeInTheDocument();
    expect(screen.getByText("Only expected")).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ENLARGE })).toBeInTheDocument();
  });

  it("labels automatic kinds and survives a missing entry description", async () => {
    page({ "GET secrets/s1": { status: 404, body: { error: "no entry" } } });
    renderApp(<ReviewDetailPage />);
    expect(await screen.findByText(t("reviews.detail.atProvider", { kind: t("reviews.detail.kindAuto"), provider: "stripe" }))).toBeInTheDocument();
  });
});

describe("Review detail: confirm", () => {
  it("needs every checklist item ticked, can untick, and confirms with the note", async () => {
    const portal = page({ "POST reviews/iss-1/confirm": commit() });
    const { user } = renderApp(<ReviewDetailPage />);
    const confirm = await screen.findByRole("button", { name: t("reviews.detail.confirm") });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(t("reviews.detail.tickAll"))).toBeInTheDocument();
    const first = screen.getByRole("checkbox", { name: "Value is in the vault" });
    await user.click(first);
    await user.click(first);
    expect(first).not.toBeChecked();
    await tickAll(user);
    await waitFor(() => expect(first).toBeChecked());
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(t("reviews.detail.tickAll"))).toBeNull();
    await user.type(screen.getByLabelText(t("reviews.detail.note")), "  checked by me  ");
    await user.click(confirm);
    expect(await screen.findByText(t("reviews.done.okTitle"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "reviews/iss-1/confirm")[0]!.body).toEqual({ ticks: ["c1", "c2"], note: "checked by me" });
    expect(screen.getByText(t("reviews.detail.confirmed"))).toBeInTheDocument();
  });

  it("allows confirming a review without a checklist", async () => {
    const portal = page({ "GET reviews/iss-1": review({}, { checklist: [] }), "POST reviews/iss-1/confirm": commit() });
    const { user } = renderApp(<ReviewDetailPage />);
    expect(await screen.findByText(t("reviews.detail.noChecklist"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("reviews.detail.confirm") }));
    await screen.findByText(t("reviews.done.okTitle"));
    expect(portal.callsTo("POST", "reviews/iss-1/confirm")[0]!.body).toEqual({ ticks: [] });
  });

  it("requires the force box for a failed review and sends it", async () => {
    const portal = page({ "GET reviews/iss-1": review({ overall: "fail" }), "POST reviews/iss-1/confirm": commit() });
    const { user } = renderApp(<ReviewDetailPage />);
    await tickAll(user);
    const confirm = screen.getByRole("button", { name: t("reviews.detail.confirm") });
    expect(screen.getByText(t("reviews.detail.failedTitle"))).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: t("reviews.detail.force") }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await screen.findByText(t("reviews.done.okTitle"));
    expect(portal.callsTo("POST", "reviews/iss-1/confirm")[0]!.body).toEqual({ ticks: ["c1", "c2"], force: true });
  });

  it("shows the failure of a confirmation and stays on the review", async () => {
    page({ "POST reviews/iss-1/confirm": { status: 409, body: { error: "already committed" } } });
    const { user } = renderApp(<ReviewDetailPage />);
    await tickAll(user);
    await user.click(screen.getByRole("button", { name: t("reviews.detail.confirm") }));
    expect(await screen.findByText("already committed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("reviews.detail.confirm") })).toBeInTheDocument();
  });

  it("reports a partly failed commit place by place", async () => {
    page({
      "POST reviews/iss-1/confirm": commit({
        ok: false,
        partial: true,
        revokedOld: false,
        expires: null,
        places: [{ place: "acme/app", outcome: "updated" }, { place: "acme/docs", outcome: "failed", error: "403 forbidden" }, { place: "acme/web", outcome: "created" }],
      }),
    });
    const { user } = renderApp(<ReviewDetailPage />);
    await tickAll(user);
    await user.click(screen.getByRole("button", { name: t("reviews.detail.confirm") }));
    expect(await screen.findByText(t("reviews.done.partialTitle"))).toBeInTheDocument();
    expect(screen.getByText("403 forbidden")).toBeInTheDocument();
    expect(screen.getByText(t("reviews.done.failedPlaces", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("reviews.done.no"))).toBeInTheDocument();
    expect(screen.getByText(t("reviews.done.noExpiry"))).toBeInTheDocument();
    expect(screen.getByText(t("reviews.done.updated"))).toBeInTheDocument();
    expect(screen.getByText(t("reviews.done.created"))).toBeInTheDocument();
    expect(screen.queryByText(t("reviews.detail.confirmed"))).toBeNull();
    expect(screen.getByRole("link", { name: t("reviews.done.toSecret") })).toHaveAttribute("href", "/secrets/s1");
    expect(screen.getByRole("link", { name: t("reviews.done.moreReviews") })).toHaveAttribute("href", "/reviews");
  });

  it("reports a commit that wrote nothing", async () => {
    page({ "POST reviews/iss-1/confirm": commit({ ok: false, partial: false, places: [{ place: "acme/app", outcome: "failed" }] }) });
    const { user } = renderApp(<ReviewDetailPage />);
    await tickAll(user);
    await user.click(screen.getByRole("button", { name: t("reviews.detail.confirm") }));
    expect(await screen.findByText(t("reviews.done.noneTitle"))).toBeInTheDocument();
  });
});

describe("Review detail: expired", () => {
  it("blocks confirming and points to the entry", async () => {
    page({ "GET reviews/iss-1": review({ expiresAt: "2020-01-01T00:00:00.000Z", overall: "fail" }) });
    renderApp(<ReviewDetailPage />);
    expect(await screen.findByText(t("reviews.detail.expiredTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("reviews.detail.expiredRegenerate"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("reviews.detail.toSecret") })).toHaveAttribute("href", "/secrets/s1");
    expect(screen.getByRole("button", { name: t("reviews.detail.confirm") })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Old key revoked" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: t("reviews.detail.force") })).toBeDisabled();
    expect(screen.queryByText(t("reviews.detail.tickAll"))).toBeNull();
  });
});

describe("Review detail: reject", () => {
  it("rejects with a note and returns to the list", async () => {
    const portal = page({ "POST reviews/iss-1/reject": { revokedNew: true } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.type(await screen.findByLabelText(t("reviews.detail.note")), " wrong scope ");
    await user.click(screen.getByRole("button", { name: t("reviews.detail.reject") }));
    expect(await screen.findByText(t("reviews.detail.rejectedDeleted"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "reviews/iss-1/reject")[0]!.body).toEqual({ note: "wrong scope" });
    expect(navigation.router.push).toHaveBeenCalledWith("/reviews");
  });

  it("rejects without a note", async () => {
    const portal = page({ "POST reviews/iss-1/reject": { revokedNew: false } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("reviews.detail.reject") }));
    expect(await screen.findByText(t("reviews.detail.rejected"))).toBeInTheDocument();
    expect(portal.callsTo("POST", "reviews/iss-1/reject")[0]!.body).toEqual({});
  });

  it("shows a rejection failure and stays", async () => {
    page({ "POST reviews/iss-1/reject": { status: 500, body: { error: "reject broke" } } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("reviews.detail.reject") }));
    expect(await screen.findByText("reject broke")).toBeInTheDocument();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });
});

describe("Review detail: screenshots", () => {
  const png = () => new File(["png-bytes"], "shot.png", { type: "image/png" });
  const strict = () => userEvent.setup({ applyAccept: false });

  it("uploads an image with a note and shows it as a thumbnail", async () => {
    const portal = page({ "POST evidence/s1/rep-1/attachments": { file: "shot-1.png", note: "console view" } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.upload(await screen.findByLabelText(t("reviews.detail.imageFile")), png());
    await user.type(screen.getByLabelText(t("reviews.detail.attachmentNote")), " console view ");
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    expect(await screen.findByText(t("reviews.detail.attachmentAdded"))).toBeInTheDocument();
    const body = portal.callsTo("POST", "evidence/s1/rep-1/attachments")[0]!.body as FormData;
    expect((body.get("file") as File).name).toBe("shot.png");
    expect(body.get("note")).toBe("console view");
    expect(screen.getByRole("button", { name: ENLARGE })).toBeInTheDocument();
    expect(screen.getByLabelText(t("reviews.detail.attachmentNote"))).toHaveValue("");
  });

  it("finishes an upload quietly when the page was left meanwhile", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    const portal = page({ "POST evidence/s1/rep-1/attachments": () => gate.then(() => ({ file: "late.png" })) });
    const { user, unmount } = renderApp(<ReviewDetailPage />);
    await user.upload(await screen.findByLabelText(t("reviews.detail.imageFile")), png());
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    await waitFor(() => expect(portal.callsTo("POST", "evidence/s1/rep-1/attachments")).toHaveLength(1));
    unmount();
    await act(async () => {
      release(undefined);
      await gate;
    });
    expect(portal.callsTo("POST", "evidence/s1/rep-1/attachments")).toHaveLength(1);
  });

  it("uploads without a note", async () => {
    const portal = page({ "POST evidence/s1/rep-1/attachments": { file: "shot-1.png" } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.upload(await screen.findByLabelText(t("reviews.detail.imageFile")), png());
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    await screen.findByText(t("reviews.detail.attachmentAdded"));
    expect((portal.callsTo("POST", "evidence/s1/rep-1/attachments")[0]!.body as FormData).has("note")).toBe(false);
  });

  it("does nothing when no file is chosen", async () => {
    const portal = page();
    const { user } = renderApp(<ReviewDetailPage />);
    await user.click(await screen.findByRole("button", { name: t("reviews.detail.addAttachment") }));
    expect(portal.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.queryByText(t("reviews.detail.fileType"))).toBeNull();
  });

  it("refuses other file types and files over five megabytes, and clears the message on a new choice", async () => {
    const portal = page();
    renderApp(<ReviewDetailPage />);
    const user = strict();
    const input = await screen.findByLabelText(t("reviews.detail.imageFile"));
    await user.upload(input, new File(["x"], "doc.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    expect(await screen.findByText(t("reviews.detail.fileType"))).toBeInTheDocument();
    const big = png();
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    await user.upload(input, big);
    expect(screen.queryByText(t("reviews.detail.fileType"))).toBeNull();
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    expect(await screen.findByText(t("reviews.detail.fileSize"))).toBeInTheDocument();
    expect(portal.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows an upload failure", async () => {
    page({ "POST evidence/s1/rep-1/attachments": { status: 500, body: { error: "disk full" } } });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.upload(await screen.findByLabelText(t("reviews.detail.imageFile")), png());
    await user.click(screen.getByRole("button", { name: t("reviews.detail.addAttachment") }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(screen.queryByText(t("reviews.detail.attachmentAdded"))).toBeNull();
  });

  it("opens an attachment in a larger view", async () => {
    page({ "GET reviews/iss-1": review({}, { attachments: [{ file: "shot.png", note: "first shot" }] }) });
    const { user } = renderApp(<ReviewDetailPage />);
    await user.click(await screen.findByRole("button", { name: ENLARGE }));
    expect(within(await screen.findByRole("dialog")).getByRole("img")).toHaveAttribute("src", "/api/ui/evidence/s1/rep-1/attachments/shot.png");
  });
});
