import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDate, daysLabel } from "../src/lib/format";
import { I18nProvider, getLocale, isLocale, systemLocale, translate, useI18n, useT } from "../src/lib/i18n";
import { useToast } from "../src/lib/toast";
import { CardActivityProvider, useCardActivity, useCardActivityState } from "../src/lib/use-card-activity";
import { Providers, renderApp } from "./helpers/render";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("translate", () => {
  it("picks plural forms, leaves unknown placeholders and falls back to the key", () => {
    expect(translate("common.days.future", { count: 1 }, "en")).toBe("in 1 day");
    expect(translate("common.days.future", { count: 5 }, "en")).toBe("in 5 days");
    expect(translate("common.worker", { count: 2 }, "de")).toBe("Cloudflare Worker");
    expect(translate("common.err.request", { other: 1 }, "de")).toBe("Anfrage fehlgeschlagen ({status}).");
    expect(translate("no.such.key")).toBe("no.such.key");
  });
  it("recognizes locales and the system language", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(systemLocale(["de-AT"])).toBe("de");
    expect(systemLocale(["en-GB"])).toBe("en");
    expect(systemLocale([])).toBe("en");
  });
});

describe("outside a provider", () => {
  it("translates German and ignores language changes", () => {
    const { result } = renderHook(() => ({ i18n: useI18n(), t: useT() }));
    expect(result.current.i18n.locale).toBe("de");
    expect(result.current.t("common.worker")).toBe("Cloudflare Worker");
    expect(result.current.i18n.t("common.days.today")).toBe("heute");
    expect(result.current.i18n.setLocale("en")).toBeUndefined();
  });
});

describe("I18nProvider", () => {
  it("uses the stored language, sets the document language and remembers a change", async () => {
    window.localStorage.setItem("sd-locale", "en");
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(result.current.locale).toBe("en"));
    expect(document.documentElement.lang).toBe("en");
    expect(getLocale()).toBe("en");
    expect(result.current.t("common.days.future", { count: 2 })).toBe("in 2 days");
    act(() => result.current.setLocale("de"));
    expect(result.current.locale).toBe("de");
    expect(window.localStorage.getItem("sd-locale")).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(getLocale()).toBe("de");
  });

  it("formats dates in the chosen language", async () => {
    window.localStorage.setItem("sd-locale", "en");
    renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(getLocale()).toBe("en"));
    expect(formatDate("2026-11-04")).toBe("04/11/2026");
    expect(daysLabel(3)).toBe("in 3 days");
  });

  it("detects the system language once and stores it", async () => {
    window.localStorage.clear();
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "en"]);
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(result.current.locale).toBe("de"));
    expect(window.localStorage.getItem("sd-locale")).toBe("de");
  });

  it("falls back to navigator.language and then to English", async () => {
    window.localStorage.clear();
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue([]);
    const language = vi.spyOn(window.navigator, "language", "get").mockReturnValue("de-CH");
    const first = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(first.result.current.locale).toBe("de"));
    first.unmount();
    window.localStorage.clear();
    language.mockReturnValue(undefined as unknown as string);
    const second = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(second.result.current.locale).toBe("en"));
  });

  it("copes with blocked storage when reading, detecting and saving", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(result.current.locale).toBe("en"));
    act(() => result.current.setLocale("de"));
    expect(result.current.locale).toBe("de");
  });

  it("ignores a stored value that is not a language", async () => {
    window.localStorage.setItem("sd-locale", "klingon");
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de"]);
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    await waitFor(() => expect(result.current.locale).toBe("de"));
    expect(window.localStorage.getItem("sd-locale")).toBe("de");
  });
});

function ToastButtons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("saved")}>ok</button>
      <button type="button" onClick={() => toast.error("failed")}>bad</button>
      <button type="button" onClick={() => toast.info("note")}>info</button>
    </>
  );
}

describe("toasts", () => {
  it("falls back to a silent api outside the provider", async () => {
    const { result } = renderHook(() => useToast());
    expect(() => { result.current.success("a"); result.current.error("b"); result.current.info("c"); }).not.toThrow();
  });

  it("shows messages of every kind in a live region and dismisses one by hand", async () => {
    const { user } = renderApp(<ToastButtons />);
    await user.click(screen.getByRole("button", { name: "ok" }));
    await user.click(screen.getByRole("button", { name: "bad" }));
    await user.click(screen.getByRole("button", { name: "info" }));
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("saved");
    expect(region).toHaveTextContent("failed");
    expect(region).toHaveTextContent("note");
    const failed = screen.getByText("failed").closest("div")!;
    expect(failed).toHaveClass("border-danger");
    expect(screen.getByText("saved").closest("div")).toHaveClass("border-success");
    expect(screen.getByText("note").closest("div")).toHaveClass("border-info");
    await user.click(failed.querySelector("button")!);
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.getByText("saved")).toBeInTheDocument();
  });

  it("hides a message after five seconds unless the pointer or focus holds it", async () => {
    vi.useFakeTimers();
    render(<ToastButtons />, { wrapper: Providers });
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    const toast = screen.getByText("saved").closest("div")!;
    fireEvent.mouseEnter(toast);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("saved")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_250); });
    expect(screen.queryByText("saved")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "info" }));
    const info = screen.getByText("note").closest("div")!;
    fireEvent.focus(info);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("note")).toBeInTheDocument();
    fireEvent.blur(info);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_250); });
    expect(screen.queryByText("note")).toBeNull();
  });

  it("shows an identical message once", async () => {
    const { user } = renderApp(<ToastButtons />);
    await user.click(screen.getByRole("button", { name: "ok" }));
    await user.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getAllByText("saved")).toHaveLength(1);
  });
});

describe("card activity", () => {
  it("has a no-op fallback outside a provider that still runs the work", async () => {
    const { result } = renderHook(() => useCardActivity());
    expect(await result.current.track({ card: "a", kind: "test", name: "A", work: async () => 5, judge: () => ({ ok: true }) })).toBe(5);
    expect(result.current.note({ card: "a", kind: "test" }, "A", true)).toBeUndefined();
    expect(result.current.state.running.size).toBe(0);
  });

  const setup = () => renderHook(() => useCardActivityState(), { wrapper: Providers });

  it("tracks work, judges the result and tells the user", async () => {
    const { result } = setup();
    const started = deferredWork();
    let outcome: Promise<number | undefined>;
    act(() => { outcome = result.current.track({ card: "a", kind: "test", line: "k1", name: "Acme", work: () => started.promise, judge: (r) => ({ ok: r > 0 }) }); });
    expect(result.current.state.running.size).toBe(1);
    await act(async () => { started.resolve(3); await outcome; });
    expect(await outcome!).toBe(3);
    expect(result.current.state.running.size).toBe(0);
    expect(result.current.state.last.get("a|k1")).toMatchObject({ ok: true, kind: "test", line: "k1" });
  });

  it("reports a failed verdict with its detail and a thrown error without losing the card", async () => {
    const { result } = setup();
    await act(async () => {
      expect(await result.current.track({ card: "a", kind: "test", name: "Acme", work: async () => 0, judge: () => ({ ok: false, detail: "HTTP 401" }) })).toBe(0);
    });
    expect(result.current.state.last.get("a|")).toMatchObject({ ok: false });
    await act(async () => {
      expect(await result.current.track({ card: "a", kind: "signin", name: "Acme", work: async () => { throw new Error("offline"); }, judge: () => ({ ok: true }) })).toBeUndefined();
    });
    expect(result.current.state.last.get("a|")).toMatchObject({ ok: false, kind: "signin" });
    await act(async () => {
      expect(await result.current.track({ card: "b", kind: "test", name: "Beta", work: () => Promise.reject("text"), judge: () => ({ ok: true }) })).toBeUndefined();
    });
    expect(result.current.state.last.get("b|")).toMatchObject({ ok: false });
  });

  it("notes an activity that ran elsewhere", () => {
    const { result } = setup();
    act(() => result.current.note({ card: "a", kind: "remove", line: "k" }, "Acme", false, "detail text"));
    expect(result.current.state.last.get("a|k")).toMatchObject({ ok: false, kind: "remove" });
    act(() => result.current.note({ card: "a", kind: "remove", line: "k" }, "Acme", true));
    expect(result.current.state.last.get("a|k")).toMatchObject({ ok: true });
  });

  it("shares the state through the provider and puts the toast text on screen", async () => {
    function Probe() {
      const value = useCardActivityState();
      return (
        <CardActivityProvider value={value}>
          <Inner />
        </CardActivityProvider>
      );
    }
    function Inner() {
      const activity = useCardActivity();
      return <button type="button" onClick={() => activity.note({ card: "a", kind: "test" }, "Acme", false, "boom")}>go</button>;
    }
    const { user } = renderApp(<Probe />);
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("status")).toHaveTextContent("Acme: Verbindungstest meldet ein Problem. Details: boom");
  });
});

function deferredWork() {
  let resolve!: (v: number) => void;
  const promise = new Promise<number>((res) => { resolve = res; });
  return { promise, resolve };
}
