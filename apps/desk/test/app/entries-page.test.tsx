import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EntriesPage from "@/app/entries/page";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal, type FakeHandler } from "../helpers/portal";
import { renderApp } from "../helpers/render";
import { pick } from "../helpers/select";

const secret = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase().replace(/-/g, "_"),
  title: null,
  description: null,
  owner: null,
  link: null,
  tags: [],
  product: null,
  stage: "dev",
  service: "svc",
  provider: "manual",
  automatic: false,
  browser: false,
  readOnly: false,
  expiry: "date",
  expires: "2026-06-01",
  daysLeft: 30,
  status: "ok",
  rotatedAt: null,
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
const variable = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase().replace(/-/g, "_"),
  description: null,
  owner: null,
  link: null,
  tags: [],
  product: null,
  stage: "dev",
  value: "value-1",
  from: null,
  places: [{ repo: "acme/app", scope: "repository" }],
  ...over,
});
const drift = (state: string, over: Record<string, unknown> = {}) => ({ variableId: "v", place: { repo: "acme/app", scope: "repository" }, placeLabel: "acme/app", state, expected: "value-1", actual: "value-1", updatedAt: null, ...over });

const STAGE_VIEWS = [
  { id: "dev", kind: "dev", label: "Dev", environmentName: null, usage: {} },
  { id: "staging", kind: "test", label: "Staging", environmentName: "staging", usage: {} },
  { id: "production", kind: "live", label: "Production", environmentName: "production", usage: {} },
];

const entries = (secrets: unknown[] | FakeHandler, variables: unknown[] | FakeHandler, routes: Record<string, FakeHandler> = {}) =>
  fakePortal({
    "GET secrets?": secrets as FakeHandler,
    "GET variables?": variables as FakeHandler,
    "GET stages": STAGE_VIEWS,
    "GET normalization": { changes: [] },
    "GET variable-sources": { sources: [] },
    "GET secrets": [],
    "GET variables": [],
    "GET automation": { enabled: false, recipes: [], signInChecks: [] },
    "GET vendors": { categories: [], vendors: [] },
    "GET connections": [],
    "GET providers": [],
    "GET facades": [],
    ...routes,
  });
const counts = (secrets: number, variables: number) => t("entries.counts", { secrets, variables });
const ready = async (text = counts(2, 2)) => screen.findByText(text);
const row = (name: string) => screen.getAllByText(name)[0]!.closest("tr") as HTMLElement;

const SECRETS = [secret("alpha-key", { stage: "staging", description: "Alpha secret", tags: ["pay"], places: [{ repo: "acme/app", scope: "repository" }] }), secret("beta-key", { status: "expired", daysLeft: -2 })];
const VARIABLES = [variable("gamma-var", { description: "Gamma variable" }), variable("delta-var", { value: null, stage: "production", places: [{ repo: "acme/docs", scope: "repository" }] })];

describe("Entries page: list", () => {
  it("shows a skeleton, then secrets and variables in one list with the counts", async () => {
    entries(SECRETS, VARIABLES);
    const { container } = renderApp(<EntriesPage />);
    expect(container.querySelector(".sd-skeleton")).not.toBeNull();
    await ready();
    expect(screen.getAllByText("ALPHA_KEY").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GAMMA_VAR").length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("variables.unknownYet")).length).toBeGreaterThan(0);
  });

  it("shows the first-run empty state and the filtered one", async () => {
    entries([], []);
    const first = renderApp(<EntriesPage />);
    expect(await screen.findByText(t("entries.emptyFirst"))).toBeInTheDocument();
    first.unmount();
    navigation.set("/entries?kind=secret");
    entries([], []);
    renderApp(<EntriesPage />);
    expect(await screen.findByText(t("entries.emptyFiltered"))).toBeInTheDocument();
  });

  it("shows the errors of both lists and retries them", async () => {
    let fail = true;
    entries(() => (fail ? { status: 500, body: { error: "secrets broke" } } : SECRETS), () => (fail ? { status: 500, body: { error: "variables broke" } } : VARIABLES));
    const { user } = renderApp(<EntriesPage />);
    expect(await screen.findByText("secrets broke")).toBeInTheDocument();
    expect(screen.getByText("variables broke")).toBeInTheDocument();
    fail = false;
    while (screen.queryAllByRole("button", { name: t("common.retry") }).length > 0) await user.click(screen.getAllByRole("button", { name: t("common.retry") })[0]!);
    await ready();
  });

  it("lists many rows in pages", async () => {
    const many = Array.from({ length: 60 }, (_, i) => secret(`key-${String(i).padStart(2, "0")}`));
    entries(many, []);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(60, 0));
    expect(screen.queryAllByText("KEY_55")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: t("common.showMore", { count: 10 }) }));
    expect(screen.getAllByText("KEY_55").length).toBeGreaterThan(0);
  });
});

describe("Entries page: rows", () => {
  it("shows what a secret row says: confirmation, parameters, tags and the way to its page", async () => {
    entries(
      [
        secret("alpha-key", { tags: ["pay", "eu"], verifiedAt: "2026-02-03", verifiedBy: "alice", params: { status: "missing", missing: ["region"] }, places: [{ repo: "a", scope: "repository" }, { repo: "b", scope: "repository" }, { repo: "c", scope: "repository" }, { repo: "d", scope: "repository" }] }),
        secret("beta-key", { params: { status: "invalid", missing: [] }, description: "Beta" }),
      ],
      [],
    );
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(2, 0));
    expect(screen.getAllByText(t("params.list.badge")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t("params.list.badgeInvalid")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(`${t("entries.confirmed")}.*alice`)).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "#pay" })[0]!);
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?tag=pay");
    await user.click(screen.getAllByRole("button", { name: t("entries.openSecret", { name: "ALPHA_KEY" }) })[0]!);
    expect(navigation.router.push).toHaveBeenCalledWith("/secrets/alpha-key");
  });

  it("edits a secret's description and reloads the list", async () => {
    const portal = entries(SECRETS, VARIABLES, { "PATCH secrets/alpha-key": {} });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("ALPHA_KEY")).getAllByRole("button", { name: t("variables.edit") })[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("meta.save") }));
    await waitFor(() => expect(portal.callsTo("PATCH", "secrets/alpha-key")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "secrets?").length).toBeGreaterThanOrEqual(2));
  });

  it("shows a renewal badge when a browser sign-in is missing", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    entries([secret("alpha-key", { vendor: "acme", browser: true, expires: soon, daysLeft: 3 })], [], {
      "GET secrets": [secret("alpha-key", { vendor: "acme", browser: true, expires: soon, daysLeft: 3 })],
      "GET automation": { enabled: true, signInFreshHours: 12, signInChecks: [{ host: "h.example", signedIn: false, checkedAt: new Date().toISOString() }], recipes: [{ id: "r1", providerId: "p", label: "R1", host: "h.example", canCheckSignIn: true }] },
      "GET vendors": { categories: ["code"], vendors: [{ id: "acme", label: "Acme", category: "code", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: ["r1"], signInPlanned: false }] },
    });
    renderApp(<EntriesPage />);
    expect((await screen.findAllByText(new RegExp(t("renewal.badge", { days: 3 }).slice(0, 6)))).length).toBeGreaterThan(0);
  });
});

const rowNames = () => screen.getAllByRole("row").map((r) => r.getAttribute("data-kind")).filter(Boolean);

describe("Entries page: filters", () => {
  it("writes the chosen filters into the address", async () => {
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(screen.getByRole("button", { name: new RegExp(t("entries.kindVariables")) }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?kind=variable");
    await pick(user, screen.getByLabelText(t("entries.stage")), "Staging");
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?stage=staging");
    await pick(user, screen.getByLabelText(t("entries.status")), t("common.status.expired") + " · " + t("entries.onlySecrets"));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?status=expired");
  });

  it("takes the kind, stage and tag from the address and can clear the tag", async () => {
    navigation.set("/entries?kind=secret&stage=staging&tag=pay");
    const portal = entries(SECRETS, VARIABLES, { "GET secrets?stage=staging&tag=pay": SECRETS, "GET variables?stage=staging&tag=pay": VARIABLES });
    const { user } = renderApp(<EntriesPage />);
    await waitFor(() => expect(portal.callsTo("GET", "secrets?stage=staging&tag=pay").length).toBeGreaterThan(0));
    await user.click(await screen.findByRole("button", { name: t("secrets.removeFilter", { tag: "pay" }) }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?kind=secret&stage=staging");
  });

  it("shows only secrets or only variables with the kind filter", async () => {
    navigation.set("/entries?kind=variable");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 2));
    expect(rowNames().every((k) => k === "variable")).toBe(true);
  });

  it("filters secrets by provider kind and by missing parameters, and variables ignore those filters", async () => {
    entries([secret("auto-key", { automatic: true }), secret("hand-key"), secret("param-key", { params: { status: "missing", missing: ["x"] } })], []);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(3, 0));
    await user.click(screen.getByRole("button", { name: new RegExp(t("entries.moreFilters")) }));
    await pick(user, screen.getByLabelText(new RegExp(t("entries.provider"))), t("secrets.automatic"));
    await screen.findByText(counts(1, 0));
    await pick(user, screen.getByLabelText(new RegExp(t("entries.provider"))), t("entries.all"));
    await pick(user, screen.getByLabelText(new RegExp(t("params.list.filter"))), t("params.list.filterMissing"));
    await screen.findByText(counts(1, 0));
  });

  it("names the filters that rule a kind out instead of applying them silently", async () => {
    navigation.set("/entries?status=expired");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    expect(await screen.findByText(t("entries.narrowed", { filters: t("entries.status"), kind: t("entries.kindVariables") }))).toBeInTheDocument();
  });

  it("offers the combined soon-or-due option only while the URL carries that combination", async () => {
    navigation.set("/entries?status=soon,due");
    entries([secret("alpha-key", { status: "soon", daysLeft: 3 }), secret("beta-key", { status: "due", daysLeft: 0 }), secret("gamma-key", { status: "ok" })], []);
    const { unmount } = renderApp(<EntriesPage />);
    const select = screen.getByLabelText(t("entries.status"));
    await waitFor(() => expect(select).toHaveTextContent(t("entries.statusSoonOrDue")));
    expect(await screen.findByText("alpha-key")).toBeInTheDocument();
    expect(screen.getByText("beta-key")).toBeInTheDocument();
    expect(screen.queryByText("gamma-key")).toBeNull();
    unmount();
    navigation.set("/entries?status=soon");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    expect(screen.getByLabelText(t("entries.status"))).not.toHaveTextContent(t("entries.statusSoonOrDue"));
  });

  it("lists no rows when the status list holds no valid status", async () => {
    navigation.set("/entries?status=foo,bar");
    entries([secret("alpha-key", { status: "ok" })], VARIABLES);
    renderApp(<EntriesPage />);
    await waitFor(() => expect(screen.getByLabelText(t("entries.status"))).toBeInTheDocument());
    expect(screen.queryByText("alpha-key")).toBeNull();
    expect(screen.queryAllByRole("row").filter((r) => r.querySelector("td"))).toHaveLength(0);
  });

  it("clears the combined status with the reset control", async () => {
    navigation.set("/entries?status=soon,due");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await user.click(await screen.findByRole("button", { name: t("entries.reset") }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries");
  });

  it("keeps a status that is not one of the known options selectable", async () => {
    navigation.set("/entries?status=weird");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await waitFor(() => expect(screen.getByLabelText(t("entries.status"))).toHaveTextContent("weird"));
  });

  it.each([
    ["secret", [t("common.status.ok")]],
    ["variable", [t("variables.notCompared")]],
  ])("offers only the %s states when one kind is chosen", async (kindName, labels) => {
    navigation.set(`/entries?kind=${kindName}`);
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(kindName === "secret" ? 2 : 0, kindName === "variable" ? 2 : 0));
    await user.click(screen.getByLabelText(t("entries.status")));
    const list = within(await screen.findByRole("listbox"));
    for (const l of labels) expect(list.getByRole("option", { name: l })).toBeInTheDocument();
    expect(list.queryByRole("option", { name: new RegExp(t("entries.onlySecrets")) })).toBeNull();
  });

  it("filters by repository, also from the address, and groups and sorts", async () => {
    navigation.set("/entries?repo=acme/docs");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 1));
    await pick(user, screen.getByLabelText(t("meta.filterRepo")), t("meta.all"));
    await screen.findByText(counts(2, 2));
    await user.click(screen.getByRole("button", { name: new RegExp(t("entries.moreFilters")) }));
    await pick(user, screen.getByLabelText(t("meta.group")), t("meta.groupRepo"));
    expect(await screen.findAllByText("acme/app")).not.toHaveLength(0);
    await pick(user, screen.getByLabelText(t("meta.group")), t("meta.groupStage"));
    await pick(user, screen.getByLabelText(t("meta.sort")), t("meta.sortStage"));
    expect(screen.getAllByText("Production").length).toBeGreaterThan(0);
  });

  it("searches rows by text from the address and writes typed text back after a pause", async () => {
    navigation.set("/entries?q=alpha");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(1, 0));
    const box = screen.getByLabelText(t("common.pageSearch"));
    await user.clear(box);
    await user.type(box, "gamma");
    await screen.findByText(counts(0, 1));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/entries?q=gamma"));
  });
});

describe("Entries page: variables", () => {
  const withVariables = (routes: Record<string, FakeHandler> = {}) => entries(SECRETS, VARIABLES, routes);
  const compare = async (user: ReturnType<typeof renderApp>["user"], name: string) => user.click(within(row(name)).getAllByRole("button", { name: t("variables.compare") })[0]!);

  it("compares one variable with GitHub and shows the summary", async () => {
    const portal = withVariables({ "GET variables/gamma-var/status": { drift: [drift("in-sync"), drift("different")] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await compare(user, "GAMMA_VAR");
    await waitFor(() => expect(portal.callsTo("GET", "variables/gamma-var/status")).toHaveLength(1));
    expect(await screen.findAllByText(t("common.drift.different"))).not.toHaveLength(0);
  });

  it("shows when the comparison failed", async () => {
    withVariables({ "GET variables/gamma-var/status": { status: 502, body: { error: "GitHub down" } } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await compare(user, "GAMMA_VAR");
    expect((await screen.findAllByText(t("variables.compareError"))).length).toBeGreaterThan(0);
  });

  it("applies a variable to GitHub and compares again", async () => {
    const portal = withVariables({ "POST variables/gamma-var/apply": { status: "applied", outcomes: [{ place: "acme/app", outcome: "updated" }] }, "GET variables/gamma-var/status": { drift: [drift("in-sync")] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.apply") })[0]!);
    expect(await screen.findByText(t("variables.appliedOne", { name: "GAMMA_VAR" }))).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("GET", "variables/gamma-var/status")).toHaveLength(1));
  });

  it("tells when applying needs an approval or failed in some place", async () => {
    withVariables({ "POST variables/gamma-var/apply": { status: "pending-approval", approvalId: "a1" } });
    const first = renderApp(<EntriesPage />);
    await ready();
    await first.user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.apply") })[0]!);
    expect(await screen.findByText(t("variables.approvalNeeded"))).toBeInTheDocument();
    first.unmount();
    withVariables({ "POST variables/gamma-var/apply": { status: "applied", outcomes: [{ place: "acme/app", outcome: "failed", error: "403" }] }, "GET variables/gamma-var/status": { drift: [drift("missing")] } });
    const second = renderApp(<EntriesPage />);
    await ready();
    await second.user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.apply") })[0]!);
    expect(await screen.findByText(t("variables.appliedFailed", { name: "GAMMA_VAR" }))).toBeInTheDocument();
  });

  it("adopts the value from GitHub and reloads", async () => {
    const portal = withVariables({ "POST variables/gamma-var/adopt": variable("gamma-var"), "GET variables/gamma-var/status": { drift: [drift("in-sync")] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.adopt") })[0]!);
    expect(await screen.findByText(t("variables.adoptedOne", { name: "GAMMA_VAR" }))).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("GET", "variables?").length).toBeGreaterThanOrEqual(2));
  });

  it("shows a failed quick action as a message", async () => {
    withVariables({ "POST variables/gamma-var/adopt": { status: 500, body: { error: "adopt broke" } } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.adopt") })[0]!);
    expect(await screen.findByText("adopt broke")).toBeInTheDocument();
  });

  it.each(["secret-blocked", "secret-ack"])("opens the detail with the guard when the server answers %s", async (code) => {
    withVariables({ "POST variables/gamma-var/apply": { status: 409, body: { error: "looks secret", code } }, "GET variables/gamma-var/status": { drift: [] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.apply") })[0]!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens the detail by clicking the row and closes it", async () => {
    withVariables();
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.openDetails", { name: "GAMMA_VAR" }) })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leads from the detail to editing and removing", async () => {
    withVariables({ "PATCH variables/gamma-var": {}, "DELETE variables/gamma-var": { ok: true } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.openDetails", { name: "GAMMA_VAR" }) })[0]!);
    const detail = within(await screen.findByRole("dialog"));
    await user.click(detail.getByRole("button", { name: t("variables.edit") }));
    expect(await screen.findByRole("dialog", { name: t("meta.editTitle") })).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t("meta.cancel") }));
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.openDetails", { name: "GAMMA_VAR" }) })[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("variables.remove") }));
    expect(await screen.findByText(t("variables.removeText", { name: "GAMMA_VAR" }))).toBeInTheDocument();
  });

  it("edits a variable's description from the row and reloads", async () => {
    const portal = withVariables({ "PATCH variables/gamma-var": {} });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.edit") })[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("meta.save") }));
    await waitFor(() => expect(portal.callsTo("PATCH", "variables/gamma-var")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "variables?").length).toBeGreaterThanOrEqual(2));
  });

  it("removes a variable after confirmation and reloads", async () => {
    const portal = withVariables({ "DELETE variables/gamma-var": { ok: true } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.remove") })[0]!);
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: t("variables.remove") }));
    await waitFor(() => expect(portal.callsTo("DELETE", "variables/gamma-var")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "variables?").length).toBeGreaterThanOrEqual(2));
  });

  it("shows where a value comes from and clicking a tag on a variable filters by it", async () => {
    entries([], [variable("gamma-var", { tags: ["pay"], from: { connection: "supabase", kind: "supabase-url", resource: "p1", field: "url" } })], {
      "GET variable-sources": { sources: [{ kind: "supabase-url", connection: "supabase", label: "Supabase", labelEn: "Supabase", fields: [{ field: "url", label: "URL", labelEn: "URL" }], connected: true }] },
    });
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 1));
    expect((await screen.findAllByText(t("variables.src.badge", { source: "Supabase · URL" }))).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "#pay" })[0]!);
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries?tag=pay");
  });
});

const menu = async (user: ReturnType<typeof renderApp>["user"], item: string) => {
  await user.click(screen.getByRole("button", { name: t("entries.moreActions") }));
  await user.click(await screen.findByRole("menuitem", { name: new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
};

describe("Entries page: list actions", () => {
  it("reads GitHub for the secrets on request and again on the second request", async () => {
    const portal = entries(SECRETS, VARIABLES, { "GET secrets?live=1": SECRETS });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("entries.syncGithub"));
    expect(await screen.findByText(t("secrets.liveNotice"))).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("GET", "secrets?live=1")).toHaveLength(1));
    await menu(user, t("entries.syncGithub"));
    await waitFor(() => expect(portal.callsTo("GET", "secrets?live=1").length).toBeGreaterThanOrEqual(2));
  });

  it("offers no secret actions when only variables are shown", async () => {
    navigation.set("/entries?kind=variable");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 2));
    await user.click(screen.getByRole("button", { name: t("entries.moreActions") }));
    expect(screen.queryByRole("menuitem", { name: new RegExp(t("entries.syncGithub")) })).toBeNull();
    expect(screen.getByRole("menuitem", { name: new RegExp(t("variables.compareAll")) })).toBeInTheDocument();
  });

  it("completes missing parameters through its dialog", async () => {
    const needing = secret("needs-key", { params: { status: "missing", missing: ["region"] } });
    entries([needing], [], { "POST params/suggest-all": { suggestions: [] } });
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(1, 0));
    await menu(user, t("params.list.complete"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("compares all variables one after the other and reports the ones that failed", async () => {
    const portal = entries(SECRETS, VARIABLES, { "GET variables/gamma-var/status": { drift: [drift("in-sync")] }, "GET variables/delta-var/status": { status: 502, body: { error: "GitHub down" } } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.compareAll"));
    expect(await screen.findByText(t("variables.compareAllFailed", { count: 1 }))).toBeInTheDocument();
    expect(portal.callsTo("GET", "variables/gamma-var/status")).toHaveLength(1);
    expect(portal.callsTo("GET", "variables/delta-var/status")).toHaveLength(1);
  });

  it("can stop a comparison before the next variable", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    const portal = entries(SECRETS, VARIABLES, { "GET variables/delta-var/status": () => gate.then(() => ({ drift: [drift("in-sync")] })), "GET variables/gamma-var/status": { drift: [] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.compareAll"));
    const stop = await screen.findByRole("button", { name: new RegExp(t("variables.stopCompare")) });
    expect(stop).toHaveTextContent("0/2");
    await user.click(stop);
    await act(async () => {
      release(undefined);
      await gate;
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(t("variables.stopCompare")) })).toBeNull());
    expect(portal.callsTo("GET", "variables/gamma-var/status")).toHaveLength(0);
  });

  it("asks before adopting all variables, then adopts and compares them", async () => {
    const portal = entries(SECRETS, VARIABLES, { "POST variables/gamma-var/adopt": variable("gamma-var"), "POST variables/delta-var/adopt": variable("delta-var"), "GET variables/gamma-var/status": { drift: [drift("in-sync")] }, "GET variables/delta-var/status": { drift: [drift("in-sync")] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.adoptAll"));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: t("variables.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await menu(user, t("variables.adoptAll"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("variables.adoptAllConfirm", { count: 2 }) }));
    expect(await screen.findByText(t("variables.adoptAllDoneOk", { ok: 2 }))).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("GET", "variables/delta-var/status")).toHaveLength(1));
  });

  it("reports the variables that could not be adopted", async () => {
    entries(SECRETS, VARIABLES, { "POST variables/gamma-var/adopt": variable("gamma-var"), "POST variables/delta-var/adopt": { status: 500, body: { error: "no" } }, "GET variables/gamma-var/status": { drift: [] }, "GET variables/delta-var/status": { drift: [] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.adoptAll"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("variables.adoptAllConfirm", { count: 2 }) }));
    expect(await screen.findByText(t("variables.adoptAllDone", { ok: 1, failed: 1 }))).toBeInTheDocument();
  });

  it("can stop adopting all variables", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    const portal = entries(SECRETS, VARIABLES, { "POST variables/delta-var/adopt": () => gate.then(() => variable("delta-var")), "POST variables/gamma-var/adopt": variable("gamma-var") });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.adoptAll"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("variables.adoptAllConfirm", { count: 2 }) }));
    await user.click(await screen.findByRole("button", { name: new RegExp(t("variables.stopCompare")) }));
    await act(async () => {
      release(undefined);
      await gate;
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(t("variables.stopCompare")) })).toBeNull());
    expect(portal.callsTo("POST", "variables/gamma-var/adopt")).toHaveLength(0);
  });

  it("proposes values for variables with a source and closes the dialog", async () => {
    entries([], [variable("gamma-var", { from: { connection: "supabase", kind: "k", resource: "r", field: "f" } })], { "POST variables/suggest-all": { suggestions: [] } });
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 1));
    await menu(user, t("variables.src.suggestAll"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the bulk actions that need rows or sources", async () => {
    entries([], [variable("gamma-var")]);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 1));
    await user.click(screen.getByRole("button", { name: t("entries.moreActions") }));
    expect(screen.getByRole("menuitem", { name: new RegExp(t("variables.src.suggestAll")) })).toBeDisabled();
  });
});

describe("Entries page: heading", () => {
  it("keeps the long subtitle sentence reachable as the description of the heading", async () => {
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await ready();
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleDescription(t("entries.subtitleHint"));
  });
});

describe("Entries page: new entries and normalizing", () => {
  it("hides the page-level new button below sm because the topbar offers the same action", async () => {
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await ready();
    expect(screen.getByRole("button", { name: t("entries.new") })).toHaveClass("hidden", "sm:inline-flex");
  });

  it("opens the dialog from the topbar link target and keeps every active filter in the URL", async () => {
    navigation.set("/entries?q=alpha&tag=ops&repo=acme/app&kind=secret&stage=dev&status=soon&new=1");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const target = navigation.router.replace.mock.calls.at(-1)![0] as string;
    const kept = new URL(target, "http://x").searchParams;
    expect(Object.fromEntries(kept)).toEqual({ q: "alpha", tag: "ops", repo: "acme/app", kind: "secret", stage: "dev", status: "soon" });
  });

  it("opens the new-entry dialog from the button and closes it", async () => {
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(screen.getByRole("button", { name: t("entries.new") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the dialog from the address with the fields filled and cleans the address", async () => {
    navigation.set("/entries?new=variable&pf_name=NEW_VAR&pf_repo=acme/app&pf_stage=dev&pf_id=new-var&kind=variable");
    const portal = entries(SECRETS, VARIABLES, { "POST variables": variable("new-var") });
    const { user } = renderApp(<EntriesPage />);
    const dialog = within(await screen.findByRole("dialog"));
    expect(navigation.router.replace).toHaveBeenCalledWith("/entries?kind=variable");
    expect(dialog.getByDisplayValue("NEW_VAR")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: t("variables.create") }));
    await waitFor(() => expect(portal.callsTo("POST", "variables")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(portal.callsTo("GET", "variables?").length).toBeGreaterThanOrEqual(2));
  });

  it("opens an empty dialog for ?new=1 and the old ?neu=1, taking the kind from the filter", async () => {
    navigation.set("/entries?new=1");
    entries(SECRETS, VARIABLES);
    const first = renderApp(<EntriesPage />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(navigation.router.replace).toHaveBeenCalledWith("/entries");
    first.unmount();
    navigation.set("/entries?neu=1&kind=variable");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows the number of automatic fixes on the normalize button and applies them", async () => {
    const change = {
      id: "rename:secret:alpha-key",
      kind: "rename",
      entryKind: "secret",
      entryIds: ["alpha-key"],
      before: [{ id: "alpha-key", name: "ALPHA_KEY", stage: "dev" }],
      after: [{ id: "alpha-key", name: "ALPHA_KEY_DEV", stage: "dev" }],
      reasons: [{ code: "r", text: "Stage belongs in the stage field" }],
      needsWorkflowChange: true,
      conflicts: [],
      autoApplicable: true,
      missingParams: ["region"],
    };
    const portal = entries(SECRETS, VARIABLES, { "GET normalization": { changes: [change] }, "POST normalization/apply": { applied: ["rename:secret:alpha-key"], needsParams: [{ secretId: "alpha-key", missing: ["region"] }] }, "POST params/suggest-all": { suggestions: [] } });
    const { user } = renderApp(<EntriesPage />);
    await ready();
    const button = await screen.findByTestId("normalize-open");
    await waitFor(() => expect(within(button).getByText("1")).toBeInTheDocument());
    await user.click(button);
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: t("normalize.applyAll", { count: 1 }) }));
    await waitFor(() => expect(portal.callsTo("POST", "normalization/apply")).toHaveLength(1));
    await user.click(await dialog.findByRole("button", { name: t("normalize.nextAction") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(portal.callsTo("POST", "params/suggest-all")).toHaveLength(1));
    await waitFor(() => expect(portal.callsTo("GET", "normalization").length).toBeGreaterThanOrEqual(2));
  });

  it("closes the normalize dialog", async () => {
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(screen.getByTestId("normalize-open"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("normalize.close") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Entries page: comparison state", () => {
  it("asks to compare when the status filter needs comparison results, then filters by them", async () => {
    navigation.set("/entries?status=different");
    const portal = entries(SECRETS, VARIABLES, { "GET variables/gamma-var/status": { drift: [drift("different")] }, "GET variables/delta-var/status": { drift: [drift("in-sync")] } });
    const { user } = renderApp(<EntriesPage />);
    expect(await screen.findByText(t("entries.uncompared", { count: 2 }))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("entries.compareNow") }));
    await waitFor(() => expect(portal.callsTo("GET", "variables/delta-var/status")).toHaveLength(1));
    await screen.findByText(counts(0, 1));
    expect(screen.queryByText(t("entries.uncompared", { count: 2 }), { exact: false })).toBeNull();
  });

  it("restores the repository filter from the session when the address names the same repository", async () => {
    navigation.set("/entries?repo=acme/docs");
    window.sessionStorage.setItem("sd:filter:entries.browse", JSON.stringify({ repo: "acme/docs", sort: "name", group: "none" }));
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 1));
  });

  it("clears the last filter in the address down to the bare path", async () => {
    navigation.set("/entries?tag=pay");
    entries(SECRETS, VARIABLES, { "GET secrets?tag=pay": SECRETS, "GET variables?tag=pay": VARIABLES });
    const { user } = renderApp(<EntriesPage />);
    await user.click(await screen.findByRole("button", { name: t("secrets.removeFilter", { tag: "pay" }) }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/entries");
  });

  it("shows a confirmation without the name when only the date is known", async () => {
    entries([secret("alpha-key", { verifiedAt: "2026-02-03" })], []);
    renderApp(<EntriesPage />);
    await screen.findByText(counts(1, 0));
    expect(screen.getAllByText(t("entries.confirmed"), { exact: false }).length).toBeGreaterThan(0);
  });

  it("stops row clicks inside the action cells from opening the detail", async () => {
    entries([], VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(counts(0, 2));
    const r = row("GAMMA_VAR");
    const cell = r.querySelector("td:last-child") as HTMLElement;
    await user.click(cell);
    await user.click(cell.firstElementChild as HTMLElement);
    const mobile = r.querySelectorAll(".sm\\:hidden");
    await user.click(mobile[mobile.length - 1] as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copes with the variable list changing while a dialog is open", async () => {
    const portal = entries(SECRETS, VARIABLES, { "GET variables/gamma-var/status": { drift: [] } });
    const { user, rerender } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.openDetails", { name: "GAMMA_VAR" }) })[0]!);
    await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: new RegExp(t("variables.compare")) })[0]!);
    await waitFor(() => expect(portal.callsTo("GET", "variables/gamma-var/status")).toHaveLength(1));
    navigation.set("/entries?stage=staging");
    rerender(<EntriesPage />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Entries page: closing dialogs", () => {
  it("closes the adopt-all question with Escape", async () => {
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await menu(user, t("variables.adoptAll"));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the secret edit and the variable removal dialogs without changes", async () => {
    const portal = entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    await user.click(within(row("ALPHA_KEY")).getAllByRole("button", { name: t("variables.edit") })[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("meta.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(within(row("GAMMA_VAR")).getAllByRole("button", { name: t("variables.remove") })[0]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("variables.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(portal.calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toHaveLength(0);
  });

  it("copes with the lists being reloaded while the suggestion or completion dialog is open", async () => {
    const needing = secret("needs-key", { params: { status: "missing", missing: ["region"] } });
    entries([needing], [variable("gamma-var", { from: { connection: "supabase", kind: "k", resource: "r", field: "f" } })], { "POST variables/suggest-all": { suggestions: [] }, "POST params/suggest-all": { suggestions: [] } });
    const { user, rerender } = renderApp(<EntriesPage />);
    await screen.findByText(counts(1, 1));
    await menu(user, t("variables.src.suggestAll"));
    await screen.findByRole("dialog");
    navigation.set("/entries?stage=staging");
    rerender(<EntriesPage />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    navigation.set("/entries");
    rerender(<EntriesPage />);
    await screen.findByText(counts(1, 1));
    await menu(user, t("params.list.complete"));
    await screen.findByRole("dialog");
    navigation.set("/entries?stage=staging");
    rerender(<EntriesPage />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the secondary filters behind one button and opens them by itself when one is active", async () => {
    sessionStorage.setItem("sd:filter:entries.provider", JSON.stringify("auto"));
    entries([secret("auto-key", { automatic: true }), secret("hand-key")], []);
    const { user } = renderApp(<EntriesPage />);
    const more = screen.getByRole("button", { name: new RegExp(t("entries.moreFilters")) });
    await waitFor(() => expect(more).toHaveAttribute("aria-expanded", "true"));
    expect(more).toHaveTextContent("1");
    expect(screen.getByLabelText(new RegExp(t("entries.provider")))).toBeInTheDocument();
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(new RegExp(t("entries.provider")))).toBeNull();
  });

  it("keeps the list search, the filters, the more-filters toggle and reset in one toolbar row", async () => {
    navigation.set("/entries?status=expired");
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    const more = await screen.findByRole("button", { name: new RegExp(t("entries.moreFilters")) });
    const row = more.closest("div.items-end")!;
    expect(row).toContainElement(screen.getByLabelText(t("entries.status")));
    expect(row).toContainElement(screen.getByRole("searchbox", { name: t("common.pageSearch") }));
    expect(row).toContainElement(screen.getByRole("button", { name: t("entries.reset") }));
    expect(screen.getByRole("searchbox", { name: t("common.pageSearch") }).closest("div.min-w-\\[12rem\\]")).not.toBeNull();
  });

  it("starts closed without secondary filters and offers no reset until a filter is set", async () => {
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await screen.findByText(counts(2, 2));
    expect(screen.getByRole("button", { name: new RegExp(t("entries.moreFilters")) })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: t("entries.reset") })).toBeNull();
  });

  it("resets every filter with one control", async () => {
    sessionStorage.setItem("sd:filter:entries.provider", JSON.stringify("auto"));
    sessionStorage.setItem("sd:filter:entries.browse", JSON.stringify({ repo: "", sort: "stage", group: "repo" }));
    navigation.set("/entries?kind=secret&status=expired");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await user.click(await screen.findByRole("button", { name: t("entries.reset") }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/entries");
    await waitFor(() => expect(sessionStorage.getItem("sd:filter:entries.provider")).toBeNull());
    expect(sessionStorage.getItem("sd:filter:entries.browse")).toBeNull();
  });

  it("offers only the filters that exist for variables inside the secondary row", async () => {
    navigation.set("/entries?kind=variable");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await user.click(await screen.findByRole("button", { name: new RegExp(t("entries.moreFilters")) }));
    expect(screen.queryByLabelText(new RegExp(t("entries.provider")))).toBeNull();
    expect(screen.getByLabelText(t("meta.sort"))).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: t("meta.sortExpires") })).toBeNull();
  });
});

describe("Entries page: phone width", () => {
  const phone = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const toggle = () => screen.getByRole("button", { name: new RegExp(`^${t("entries.filters")}`) });

  it("shows only search and a filters toggle until the toggle is used", async () => {
    phone();
    navigation.set("/entries");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await ready();
    expect(screen.getByRole("searchbox", { name: t("common.pageSearch") })).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveAttribute("aria-controls", "entries-filters");
    expect(screen.queryByRole("group", { name: t("entries.kind") })).toBeNull();
    expect(screen.queryByLabelText(t("entries.status"))).toBeNull();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: t("entries.kind") })).toBeInTheDocument();
    expect(screen.getByLabelText(t("entries.status"))).toBeInTheDocument();
    expect(document.getElementById("entries-filters")).toContainElement(screen.getByLabelText(t("entries.stage")));
    await user.click(toggle());
    expect(screen.queryByLabelText(t("entries.status"))).toBeNull();
  });

  it("opens by itself with a count pill while filters are active and hides the secondary row with the area", async () => {
    phone();
    navigation.set("/entries?kind=secret&status=expired");
    entries(SECRETS, VARIABLES);
    const { user } = renderApp(<EntriesPage />);
    await screen.findByText(/ALPHA_KEY|BETA_KEY/);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "true"));
    expect(within(toggle()).getByText("2")).toBeInTheDocument();
    expect(screen.getByLabelText(t("entries.status"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(t("entries.moreFilters")) }));
    expect(screen.getByLabelText(t("meta.sort"))).toBeInTheDocument();
    await user.click(toggle());
    expect(screen.queryByLabelText(t("meta.sort"))).toBeNull();
  });

  it("keeps the full toolbar and no toggle from sm up", async () => {
    entries(SECRETS, VARIABLES);
    renderApp(<EntriesPage />);
    await ready();
    expect(screen.queryByRole("button", { name: new RegExp(`^${t("entries.filters")}`) })).toBeNull();
    expect(screen.getByLabelText(t("entries.status"))).toBeInTheDocument();
  });
});
