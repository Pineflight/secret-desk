import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVENTORY_POLL_MS, inventoryChanged, useInventorySync } from "../src/lib/inventory-sync";
import { readStored, usePersistedState, writeStored } from "../src/lib/persisted-state";
import { subscribeInventoryChange } from "../src/lib/refresh";
import { entriesOfKinds, sameMapKey, useResourceMap } from "../src/lib/resource-map";
import { useDraftParams } from "../src/lib/use-params";
import { usePageSearch } from "../src/lib/use-page-search";
import { useRenewalWarnings } from "../src/lib/use-renewal-warnings";
import { navigation } from "./helpers/navigation";
import { fakePortal } from "./helpers/portal";

afterEach(() => vi.useRealTimers());

describe("useStages", () => {
  beforeEach(() => vi.resetModules());

  const stage = (id: string) => ({ id, label: id.toUpperCase(), kind: "test", environmentName: id, usage: {} });

  it("falls back to the standard stages until the answer arrives, then shares one request", async () => {
    const portal = fakePortal({ "GET stages": [stage("qa")] });
    const { useStages, useStageDefs } = await import("../src/lib/use-stages");
    const defs = renderHook(() => useStageDefs());
    expect(defs.result.current.map((d) => d.id)).toContain("production");
    const a = renderHook(() => useStages());
    expect(a.result.current.stages).toBeUndefined();
    await waitFor(() => expect(a.result.current.stages?.map((s) => s.id)).toEqual(["qa"]));
    await waitFor(() => expect(defs.result.current.map((d) => d.id)).toEqual(["qa"]));
    const b = renderHook(() => useStages());
    expect(b.result.current.stages?.map((s) => s.id)).toEqual(["qa"]);
    expect(portal.callsTo("GET", "stages")).toHaveLength(1);
  });

  it("joins a request that is already running and reloads on demand", async () => {
    const portal = fakePortal({ "GET stages": [stage("qa")] });
    const { loadStages, useStages } = await import("../src/lib/use-stages");
    const [first, second] = await Promise.all([loadStages(), loadStages()]);
    expect(second).toBe(first);
    expect(portal.callsTo("GET", "stages")).toHaveLength(1);
    expect(await loadStages()).toBe(first);
    expect(portal.callsTo("GET", "stages")).toHaveLength(1);
    const hook = renderHook(() => useStages());
    await act(async () => { hook.result.current.reload(); });
    await waitFor(() => expect(portal.callsTo("GET", "stages")).toHaveLength(2));
  });

  it("asks again after the cache has expired and tells open pages about published stages", async () => {
    const portal = fakePortal({ "GET stages": [stage("qa")] });
    const { loadStages, publishStages, useStages } = await import("../src/lib/use-stages");
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadStages();
    vi.setSystemTime(Date.now() + 31_000);
    const hook = renderHook(() => useStages());
    await waitFor(() => expect(portal.callsTo("GET", "stages")).toHaveLength(2));
    act(() => publishStages([stage("new") as never]));
    expect(hook.result.current.stages?.map((s) => s.id)).toEqual(["new"]);
    hook.unmount();
    expect(() => publishStages([])).not.toThrow();
  });

  it("answers null when the stages cannot be loaded", async () => {
    fakePortal({});
    const { loadStages } = await import("../src/lib/use-stages");
    expect(await loadStages()).toBeNull();
  });
});

describe("useRepoList", () => {
  beforeEach(() => vi.resetModules());

  it("loads the live list once for all users, reloads on demand and ignores failures", async () => {
    const portal = fakePortal({ "GET repos?live=1": { repos: ["a"] } });
    const { useRepoList, loadRepoList, invalidateRepoList } = await import("../src/lib/repo-list");
    const first = renderHook(() => useRepoList());
    expect(first.result.current.data).toBeNull();
    await waitFor(() => expect(first.result.current.data).toEqual({ repos: ["a"] }));
    const second = renderHook(() => useRepoList());
    expect(second.result.current.data).toEqual({ repos: ["a"] });
    expect(portal.callsTo("GET", "repos?live=1")).toHaveLength(1);
    expect(await loadRepoList()).toEqual({ repos: ["a"] });
    await act(async () => { first.result.current.reload(); });
    await waitFor(() => expect(portal.callsTo("GET", "repos?live=1")).toHaveLength(2));
    invalidateRepoList();
    const [x, y] = await Promise.all([loadRepoList(), loadRepoList()]);
    expect(y).toBe(x);
    expect(portal.callsTo("GET", "repos?live=1")).toHaveLength(3);
  });

  it("keeps the previous list when a reload fails and does not update after unmount", async () => {
    let fail = false;
    fakePortal({ "GET repos?live=1": () => (fail ? { status: 500, body: { error: "x" } } : { repos: ["a"] }) });
    const { useRepoList } = await import("../src/lib/repo-list");
    const hook = renderHook(() => useRepoList());
    await waitFor(() => expect(hook.result.current.data).toEqual({ repos: ["a"] }));
    fail = true;
    await act(async () => { hook.result.current.reload(); });
    expect(hook.result.current.data).toEqual({ repos: ["a"] });
    hook.unmount();
  });

  it("stays empty when the first load fails", async () => {
    fakePortal({});
    const { useRepoList } = await import("../src/lib/repo-list");
    const hook = renderHook(() => useRepoList());
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.data).toBeNull();
    hook.unmount();
  });
});

describe("useResourceMap and helpers", () => {
  it("loads the map and sorts entries of the wanted kinds", async () => {
    fakePortal({ "GET resource-map": { entries: [] } });
    const hook = renderHook(() => useResourceMap());
    await waitFor(() => expect(hook.result.current.data).toEqual({ entries: [] }));
    expect(sameMapKey({ kind: "a", repo: "r" }, { kind: "a", repo: "r", stage: "" })).toBe(true);
    expect(sameMapKey({ kind: "a", repo: "r", stage: "x" }, { kind: "a", repo: "r" })).toBe(false);
    expect(sameMapKey({ kind: "a", repo: "r" }, { kind: "b", repo: "r" })).toBe(false);
    expect(sameMapKey({ kind: "a", repo: "r" }, { kind: "a", repo: "s" })).toBe(false);
    const e = (kind: string, repo: string, stage?: string) => ({ kind, repo, ...(stage ? { stage } : {}) }) as never;
    const out = entriesOfKinds([e("b", "r1"), e("a", "r2", "z"), e("a", "r2"), e("a", "r2", "y"), e("a", "r2"), e("a", "r1"), e("c", "r")], ["a", "b"]);
    expect(out.map((x) => `${x.kind}/${x.repo}/${x.stage ?? ""}`)).toEqual(["a/r1/", "a/r2/", "a/r2/", "a/r2/y", "a/r2/z", "b/r1/"]);
  });
});

describe("useInventorySync", () => {
  const visible = (state: DocumentVisibilityState) => vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);

  it("does nothing while disabled", async () => {
    const portal = fakePortal({ "GET inventory/version": { version: 1, problem: null } });
    const hook = renderHook(() => useInventorySync(false));
    await act(async () => { await Promise.resolve(); });
    expect(portal.calls).toHaveLength(0);
    expect(hook.result.current).toBeNull();
  });

  it("remembers the first version, announces a change and reports a persistent problem", async () => {
    vi.useFakeTimers();
    let version = 1;
    let problem: unknown = null;
    const portal = fakePortal({ "GET inventory/version": () => ({ version, problem }) });
    const changed = vi.fn();
    const off = subscribeInventoryChange(changed);
    const hook = renderHook(() => useInventorySync(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(INVENTORY_POLL_MS); });
    expect(changed).not.toHaveBeenCalled();
    version = 2;
    problem = { message: "unreadable", since: "now", persistent: true };
    await act(async () => { await vi.advanceTimersByTimeAsync(INVENTORY_POLL_MS); });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toMatchObject({ message: "unreadable" });
    off();
    hook.unmount();
    const before = portal.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(INVENTORY_POLL_MS * 3); });
    expect(portal.calls).toHaveLength(before);
  });

  it("probes on focus and when the tab becomes visible, but not while hidden or busy", async () => {
    vi.useFakeTimers();
    const portal = fakePortal({ "GET inventory/version": { version: 1, problem: null } });
    const hidden = visible("hidden");
    const hook = renderHook(() => useInventorySync(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls).toHaveLength(0);
    hidden.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls).toHaveLength(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls).toHaveLength(2);
    // Two probes in the same tick: the second one finds the first still running.
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls).toHaveLength(3);
    hook.unmount();
  });

  it("ignores failed answers and answers that arrive after unmount", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const portal = fakePortal({ "GET inventory/version": async () => { await gate; return { version: 5, problem: { message: "late", since: "x", persistent: true } }; } });
    const hook = renderHook(() => useInventorySync(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    hook.unmount();
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(portal.calls.length).toBeGreaterThan(0);
    expect(hook.result.current).toBeNull();
    fakePortal({});
    const again = renderHook(() => useInventorySync(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(again.result.current).toBeNull();
  });

  it("is a plain function check: changes need an earlier version", async () => {
    expect(inventoryChanged(null, 3)).toBe(false);
    expect(inventoryChanged(3, 3)).toBe(false);
    expect(inventoryChanged(3, 4)).toBe(true);
  });
});

describe("usePersistedState", () => {
  it("reads the stored value after mounting and writes changes, dropping the key at the initial value", async () => {
    window.sessionStorage.setItem("sd:filter:f", JSON.stringify("saved"));
    const hook = renderHook(() => usePersistedState("f", "start"));
    await waitFor(() => expect(hook.result.current[0]).toBe("saved"));
    act(() => hook.result.current[1]("other"));
    expect(window.sessionStorage.getItem("sd:filter:f")).toBe('"other"');
    act(() => hook.result.current[1]("start"));
    expect(window.sessionStorage.getItem("sd:filter:f")).toBeNull();
  });

  it("keeps the initial value without a stored one and survives blocked storage", async () => {
    const fresh = renderHook(() => usePersistedState("none", 3));
    await act(async () => { await Promise.resolve(); });
    expect(fresh.result.current[0]).toBe(3);
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    const blocked = renderHook(() => usePersistedState("x", "a"));
    act(() => blocked.result.current[1]("b"));
    expect(blocked.result.current[0]).toBe("b");
    vi.restoreAllMocks();
  });

  it("falls back for broken JSON and for storage that throws on write", async () => {
    window.sessionStorage.setItem("sd:filter:bad", "{broken");
    expect(readStored("bad", "fallback")).toBe("fallback");
    expect(() => writeStored("k", 1, 0, { setItem: () => { throw new Error("full"); }, removeItem: () => undefined })).not.toThrow();
  });
});

describe("usePageSearch", () => {
  it("starts from the address, follows outside changes and writes typing back after a pause", async () => {
    vi.useFakeTimers();
    navigation.set("/entries?q=abc&kind=secret");
    const hook = renderHook(() => usePageSearch("/entries"));
    expect(hook.result.current.text).toBe("abc");
    act(() => { vi.advanceTimersByTime(500); });
    expect(navigation.router.replace).not.toHaveBeenCalled();
    navigation.set("/entries?q=from-header&kind=secret");
    hook.rerender();
    expect(hook.result.current.text).toBe("from-header");
    act(() => hook.result.current.setText("typed"));
    act(() => { vi.advanceTimersByTime(199); });
    expect(navigation.router.replace).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(navigation.router.replace).toHaveBeenCalledWith("/entries?q=typed&kind=secret");
  });

  it("removes the parameter when the text is cleared and the whole query when nothing else is left", async () => {
    vi.useFakeTimers();
    navigation.set("/entries?q=abc");
    const hook = renderHook(() => usePageSearch("/entries"));
    act(() => hook.result.current.setText(""));
    act(() => { vi.advanceTimersByTime(250); });
    expect(navigation.router.replace).toHaveBeenCalledWith("/entries");
    navigation.router.replace.mockClear();
    navigation.set("/entries");
    const other = renderHook(() => usePageSearch("/entries"));
    expect(other.result.current.text).toBe("");
  });
});

describe("useDraftParams", () => {
  const view = { provider: "acme", providerLabel: "Acme", connection: null, connected: null, values: {}, defaults: {}, specs: [{ key: "accountId", label: "Konto", labelEn: "Account", type: "string", required: true, help: "", helpEn: "" }] };

  it("loads the specification with repo and stage and reloads when a dependency changes", async () => {
    const portal = fakePortal({ "GET providers/acme/params*": (c) => ({ ...view, values: { path: c.path } }) });
    const hook = renderHook(({ draft }) => useDraftParams("acme", "r1", "dev", draft), { initialProps: { draft: {} as Record<string, unknown> } });
    expect(hook.result.current.loading).toBe(true);
    await waitFor(() => expect(hook.result.current.view?.provider).toBe("acme"));
    expect(portal.calls[0]!.path).toBe("providers/acme/params?repo=r1&stage=dev");
    hook.rerender({ draft: { accountId: "a1" } });
    await waitFor(() => expect(portal.calls.map((c) => c.path)).toContain("providers/acme/params?param.accountId=a1&repo=r1&stage=dev"), { timeout: 2000 });
    expect(hook.result.current.view).toBeDefined();
    act(() => hook.result.current.reload());
    await waitFor(() => expect(portal.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("omits empty repo and stage, pauses without a provider and forgets the view when the provider changes", async () => {
    const portal = fakePortal({ "GET providers/acme/params*": view, "GET providers/other/params*": { ...view, provider: "other" } });
    const hook = renderHook(({ id }: { id: string | null }) => useDraftParams(id, "", "", {}), { initialProps: { id: "acme" as string | null } });
    await waitFor(() => expect(hook.result.current.view?.provider).toBe("acme"));
    expect(portal.calls[0]!.path).toBe("providers/acme/params?");
    hook.rerender({ id: null });
    expect(hook.result.current.view).toBeUndefined();
    hook.rerender({ id: "other" });
    await waitFor(() => expect(hook.result.current.view?.provider).toBe("other"));
  });

  it("reports an error and keeps no view", async () => {
    fakePortal({});
    const hook = renderHook(() => useDraftParams("acme", "", "", {}));
    await waitFor(() => expect(hook.result.current.error).not.toBeNull());
    expect(hook.result.current.view).toBeUndefined();
  });
});

describe("useRenewalWarnings", () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const catalog = { categories: ["code"], vendors: [{ id: "acme", label: "Acme", category: "code", icon: null, connections: [], connectionPrefixes: [], legacyConnections: [], optionalConnections: [], providers: [], recipes: ["r1"], signInPlanned: false }] };
  const automation = (over: Record<string, unknown> = {}) => ({
    enabled: true, signInFreshHours: 12, signInChecks: [{ host: "h.example", signedIn: false, checkedAt: new Date().toISOString() }],
    recipes: [{ id: "r1", providerId: "p", label: "R1", host: "h.example", canCheckSignIn: true }], ...over,
  });
  const secrets = [{ id: "s1", name: "ACME_TOKEN", title: "Acme token", vendor: "acme", browser: true, expires: soon, daysLeft: 3 }];

  it("warns about a renewal that needs a signed-in browser, using the default window", async () => {
    fakePortal({ "GET automation": automation(), "GET vendors": catalog, "GET connections": [], "GET secrets": secrets });
    const hook = renderHook(() => useRenewalWarnings());
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(hook.result.current[0]).toMatchObject({ secretId: "s1", vendorId: "acme", state: "signed-out", daysLeft: 3 });
  });

  it("honours a configured window and the optional lists when they load", async () => {
    fakePortal({
      "GET automation": automation({ renewalWarnDays: 1 }), "GET vendors": catalog, "GET connections": [], "GET secrets": secrets,
      "GET providers": [], "GET facades": [], "GET variables": [],
    });
    const hook = renderHook(() => useRenewalWarnings());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(hook.result.current).toEqual([]);
  });

  it("shows nothing while automation is off or a list is missing", async () => {
    fakePortal({ "GET automation": automation({ enabled: false }), "GET vendors": catalog, "GET connections": [], "GET secrets": secrets });
    const off = renderHook(() => useRenewalWarnings());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(off.result.current).toEqual([]);
    fakePortal({ "GET automation": automation(), "GET vendors": catalog, "GET connections": [] });
    const missing = renderHook(() => useRenewalWarnings());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(missing.result.current).toEqual([]);
  });
});
