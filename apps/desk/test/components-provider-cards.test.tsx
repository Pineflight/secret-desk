import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BusySpinner,
  CardDetails,
  CardStatusBadge,
  CategorySection,
  CollapsedBadge,
  ProviderLogo,
  ProviderGrid,
  ProviderPageCard,
  ProviderTile,
  ResultMark,
  ageText,
  metaVars,
  usePurpose,
} from "@/components/ProviderCards";
import type { BadgeKind, CollapsedMeta } from "@/lib/card-collapsed";
import { renderApp } from "./helpers/render";
import { browserWay, card, hostLine, key, readiness } from "./helpers/cards";

const identity = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${JSON.stringify(v)}` : k);

describe("ProviderLogo", () => {
  it("draws a known single-colour mark, a multi-colour mark and a monogram", () => {
    const { container, rerender } = renderApp(<ProviderLogo icon="github" label="GitHub" size={50} />);
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
    expect((container.querySelector("span[aria-hidden]") as HTMLElement).style.width).toBe("50px");
    rerender(<ProviderLogo icon="peecho" label="Peecho" />);
    expect(container.querySelectorAll("svg path").length).toBeGreaterThan(1);
    expect(container.querySelector("span[aria-hidden]")).toHaveClass("bg-white");
    rerender(<ProviderLogo icon="no-such-icon" label="Acme Corp" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toBe("");
    rerender(<ProviderLogo icon={null} label="Zed" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("badges", () => {
  it("names what is ready for what", () => {
    const cases: [Parameters<typeof CardStatusBadge>[0]["card"], string][] = [
      [card({ keys: [key()], browserSignedIn: true }), "API + Browser"],
      [card({ keys: [key()] }), "API verbunden"],
      [card({ status: "ready" }), "Browser angemeldet"],
      [card({ status: "signout" }), "Anmeldung nötig"],
      [card({ status: "unknown" }), "Anmeldung unbekannt"],
      [card(), "Nicht eingerichtet"],
    ];
    for (const [c, text] of cases) {
      const { unmount } = renderApp(<CardStatusBadge card={c} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders every collapsed badge kind", () => {
    const kinds: [BadgeKind, string][] = [["api-browser", "API + Browser"], ["api", "API verbunden"], ["browser", "Browser angemeldet"], ["signin-needed", "Anmeldung nötig"], ["none", "Nicht eingerichtet"], ["expiring", "Läuft bald ab"], ["expired", "Abgelaufen"]];
    for (const [kind, text] of kinds) {
      const { unmount } = renderApp(<CollapsedBadge kind={kind} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("helpers", () => {
  it("translates the mode and the kind of key in meta variables", () => {
    const meta = (vars: CollapsedMeta["vars"]): CollapsedMeta => ({ kind: "valid", problem: false, key: "k", vars });
    expect(metaVars(meta({ mode: "live", n: 1 }), identity)).toEqual({ mode: "providers.mode.live", n: 1 });
    expect(metaVars(meta({ connection: "github" }), identity)["key"]).toContain("connectionName");
    expect(metaVars(meta({ connection: "unknown-conn" }), identity)).toEqual({ connection: "unknown-conn" });
    expect(metaVars(meta({}), identity)).toEqual({});
  });

  it("words ages in the interface language", () => {
    const t = identity;
    expect(ageText({ unit: "now", count: 0 }, t)).toBe("providers.time.now");
    expect(ageText({ unit: "minutes", count: 5 }, t)).toBe('providers.time.minutes:{"count":5}');
    expect(ageText({ unit: "days", count: 3 }, t)).toBe('providers.time.days:{"count":3}');
  });

  it("states a provider's purpose or that it was added by hand", () => {
    const Probe = () => {
      const purpose = usePurpose();
      return <p>{purpose({ id: "github", custom: false })} | {purpose({ id: "mine", custom: true })}</p>;
    };
    renderApp(<Probe />);
    expect(screen.getByText("Secrets, Variablen und Tokens deiner Repositories | Von Hand hinzugefügt")).toBeInTheDocument();
  });

  it("renders the spinner label and the result mark", () => {
    const { rerender } = renderApp(<BusySpinner label="working" />);
    expect(screen.getByText("working").closest('[role="status"]')).not.toBeNull();
    rerender(<ResultMark result={{ ok: true, at: new Date(2026, 0, 1, 14, 5).getTime(), kind: "test", line: "x" }} label="passed" />);
    expect(screen.getByLabelText("passed")).toHaveTextContent("14:05");
    expect(screen.getByTitle("passed")).toHaveClass("text-success-text");
    rerender(<ResultMark result={{ ok: false, at: new Date(2026, 0, 1, 9, 7).getTime(), kind: "test", line: "x" }} label="failed" />);
    expect(screen.getByTitle("failed")).toHaveClass("text-danger-text");
  });
});

describe("ProviderTile and CategorySection", () => {
  it("opens the provider and describes itself for screen readers", async () => {
    const onOpen = vi.fn();
    const { user } = renderApp(<ProviderTile card={card({ id: "github", label: "GitHub", category: "code" })} onOpen={onOpen} />);
    const tile = screen.getByRole("button", { name: "GitHub, Code und CI, Nicht eingerichtet" });
    await user.click(tile);
    expect(onOpen).toHaveBeenCalled();
    expect(tile).toHaveAccessibleDescription("Secrets, Variablen und Tokens deiner Repositories");
  });

  it("renders a titled section of tiles", () => {
    renderApp(<CategorySection category="code"><li>one</li></CategorySection>);
    expect(screen.getByRole("heading", { level: 3, name: "Code und CI" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveClass("lg:grid-cols-3");
  });

  it("keeps each provider card at its own height", () => {
    renderApp(<ProviderGrid><li>one</li></ProviderGrid>);
    expect(screen.getByRole("list")).toHaveClass("items-start");
  });

  it("starts the first category section flush even after a search field", () => {
    renderApp(<CategorySection category="code"><li>one</li></CategorySection>);
    expect(screen.getByRole("heading", { level: 3 }).closest("section")).toHaveClass("first-of-type:mt-0");
  });

  it("uses singular and plural for the attached counts", () => {
    const { rerender } = renderApp(<CardDetails card={card({ secrets: 1, variables: 0 })} signIn={null} />);
    expect(screen.getByText("1 Secret, 0 Variablen")).toBeInTheDocument();
    rerender(<CardDetails card={card({ secrets: 0, variables: 1 })} signIn={null} />);
    expect(screen.getByText("0 Secrets, 1 Variable")).toBeInTheDocument();
    rerender(<CardDetails card={card({ secrets: 2, variables: 2 })} signIn={null} />);
    expect(screen.getByText("2 Secrets, 2 Variablen")).toBeInTheDocument();
  });

  it("lays the provider cards out in one responsive grid", () => {
    renderApp(<ProviderGrid><li>one</li></ProviderGrid>);
    expect(screen.getByRole("list")).toHaveClass("grid-cols-1", "lg:grid-cols-2", "2xl:grid-cols-3");
  });
});

describe("CardDetails", () => {
  it("counts entries and keys, and gives the earliest expiry with its level", () => {
    const { rerender } = renderApp(<CardDetails card={card({ keys: [key({ daysLeft: 3, level: "critical", expires: "2099-01-01" })], secrets: 2, variables: 1 })} signIn={null} />);
    expect(screen.getByText("2 Secrets, 1 Variable")).toBeInTheDocument();
    expect(screen.getByText(/1 Schlüssel verbunden/)).toBeInTheDocument();
    expect(screen.getByText(/Läuft sehr bald ab/)).toHaveClass("text-danger");
    rerender(<CardDetails card={card({ keys: [key({ daysLeft: 10, level: "soon" })] })} signIn={null} />);
    expect(screen.getByText("Noch nichts verknüpft")).toBeInTheDocument();
    expect(screen.getByText(/Läuft bald ab: /)).toHaveClass("text-warn-text");
    rerender(<CardDetails card={card({ keys: [key({ daysLeft: 90, level: "ok" })] })} signIn={null} />);
    expect(screen.getByText(/Frühester Ablauf/)).not.toHaveClass("text-danger");
    rerender(<CardDetails card={card({ keys: [key({ daysLeft: -2, level: "expired" })] })} signIn={null} />);
    expect(screen.getByText(/Abgelaufen: /)).toHaveClass("text-danger");
    rerender(<CardDetails card={card()} signIn={null} />);
    expect(screen.getByText("Kein Schlüssel verbunden")).toBeInTheDocument();
  });

  it("says no key expires, or that the expiry is unknown", () => {
    const { rerender } = renderApp(<CardDetails card={card({ keys: [key({ expires: null, daysLeft: null, level: null })] })} signIn={null} />);
    expect(screen.getByText("Kein Schlüssel läuft ab")).toBeInTheDocument();
    rerender(<CardDetails card={card({ keys: [key({ expires: undefined, daysLeft: null, level: null })] })} signIn={null} />);
    expect(screen.getByText("Ablauf nicht angegeben")).toBeInTheDocument();
  });

  it("shows browser-managed entries without keys and their never-expiring note", () => {
    const { rerender } = renderApp(<CardDetails card={card({ status: "ready", browser: browserWay({ secrets: 2, readiness: readiness("ready", 30), neverExpires: true }) })} signIn={null} />);
    expect(screen.getByText(/2 .*Browser/)).toBeInTheDocument();
    expect(screen.getByText("Läuft nicht ab")).toBeInTheDocument();
    expect(screen.getByText(/Browser angemeldet, geprüft vor 30 Minuten/)).toBeInTheDocument();
    rerender(<CardDetails card={card({ status: "signout", browser: browserWay({ secrets: 1, readiness: readiness("signed-out", 90) }) })} signIn={null} />);
    expect(screen.getByText(/Browser abgemeldet, geprüft vor 1 Stunde/)).toBeInTheDocument();
    rerender(<CardDetails card={card({ status: "unknown", browser: browserWay({ readiness: readiness("unknown", 3000, { stale: true }) }) })} signIn={null} />);
    expect(screen.getByText(/Zuletzt geprüft vor 2 Tagen/)).toBeInTheDocument();
    rerender(<CardDetails card={card({ status: "unknown", browser: browserWay() })} signIn={null} />);
    expect(screen.getByText(/Anmeldung noch nicht geprüft/)).toBeInTheDocument();
    rerender(<CardDetails card={card({ worksWithoutBrowser: true, keys: [key()] })} signIn={null} />);
    expect(screen.getByText(/Funktioniert ohne Browser-Anmeldung/)).toBeInTheDocument();
    rerender(<CardDetails card={card({ browser: browserWay({ sessionHours: 6 }) })} signIn={null} />);
    expect(screen.getByText("Anmeldungen halten hier etwa 6 Std.")).toBeInTheDocument();
  });

  it("shows one line per portal with ready, signed-out and unknown states, pending checks and results", () => {
    const hostLines = [
      hostLine({ value: "live", host: "live.acme.test", readiness: readiness("ready", 0) }),
      hostLine({ value: "test", host: "test.acme.test", readiness: readiness("signed-out", 10) }),
      hostLine({ value: "beta", host: "beta.acme.test", readiness: readiness("unknown") }),
      hostLine({ value: "gamma", host: "gamma.acme.test", readiness: readiness("unknown", 200) }),
      hostLine({ value: "delta", host: "delta.acme.test", readiness: readiness("ready", 5) }),
      hostLine({ value: "eps", host: "eps.acme.test", readiness: readiness("ready", 5) }),
    ];
    const phases = new Map<string, "waiting" | "checking">([["acme#delta.acme.test", "waiting"], ["acme#eps.acme.test", "checking"]]);
    const results = (host: string) => (host === "live.acme.test" ? { ok: false, at: new Date(2026, 0, 1, 8, 30).getTime(), kind: "test" as const, line: host } : host === "test.acme.test" ? { ok: true, at: new Date(2026, 0, 1, 7, 15).getTime(), kind: "test" as const, line: host } : undefined);
    renderApp(<CardDetails card={card({ status: "ready", browser: browserWay({ hostLines }) })} signIn={null} hostPhases={phases} results={results} />);
    expect(screen.getByText(/Acme live: angemeldet · geprüft gerade eben/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Letzte Prüfung fehlgeschlagen um 08:30/)).toBeInTheDocument();
    expect(screen.getByText("Acme test: Anmeldung nötig")).toBeInTheDocument();
    expect(screen.getByLabelText(/Letzte Prüfung bestanden um 07:15/)).toBeInTheDocument();
    expect(screen.getByText("Acme beta: Anmeldung noch nicht geprüft")).toBeInTheDocument();
    expect(screen.getByText(/Acme gamma: Anmeldung unbekannt · zuletzt geprüft vor 3 Stunden/)).toBeInTheDocument();
    expect(screen.getByText("Delta: wartet auf den Browser …")).toBeInTheDocument();
    expect(screen.getByText("Eps: Anmeldung wird geprüft …")).toBeInTheDocument();
  });

  it("hides the portal lines for a connected card and shows the page-session sign-in state", () => {
    const { rerender } = renderApp(<CardDetails card={card({ status: "connected", keys: [key()], browser: browserWay({ hostLines: [hostLine()] }) })} signIn={null} />);
    expect(screen.queryByText(/Acme live/)).toBeNull();
    for (const [status, text] of [["yes", "Angemeldet"], ["no", "Nicht angemeldet"], ["failed", "Prüfung fehlgeschlagen"]] as const) {
      rerender(<CardDetails card={card()} signIn={status} />);
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    rerender(<CardDetails card={card()} signIn="waiting" />);
    expect(screen.getByText("Prüfung wartet")).toBeInTheDocument();
    rerender(<CardDetails card={card()} signIn="checking" />);
    expect(screen.getByText("Anmeldung wird geprüft …")).toBeInTheDocument();
    rerender(<CardDetails card={card()} signIn="unchecked" />);
    expect(screen.queryByText("Anmeldung wird geprüft …")).toBeNull();
  });
});

describe("ProviderPageCard", () => {
  const view = (over: Partial<{ badge: BadgeKind; meta: CollapsedMeta | null }> = {}) => ({ badge: "api" as BadgeKind, meta: null as CollapsedMeta | null, ...over });
  const c = card({ id: "github", label: "GitHub", category: "code", keys: [key()], secrets: 1 });

  it("toggles its details and renders children and actions only while open", async () => {
    const onToggle = vi.fn();
    const { user, rerender } = renderApp(<ProviderPageCard card={c} view={view()} open={false} onToggle={onToggle} signIn={null} actions={<button>do it</button>}><p>body</p></ProviderPageCard>);
    const toggle = screen.getByRole("button", { name: "Details von GitHub anzeigen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("body")).toBeNull();
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalled();
    rerender(<ProviderPageCard card={c} view={view()} open onToggle={onToggle} signIn={null} actions={<button>do it</button>}><p>body</p></ProviderPageCard>);
    expect(screen.getByRole("button", { name: "Details von GitHub ausblenden" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "do it" })).toBeInTheDocument();
    expect(screen.getByText("1 Schlüssel verbunden", { exact: false })).toBeInTheDocument();
    rerender(<ProviderPageCard card={c} view={view()} open onToggle={onToggle} signIn={null} hostPhases={new Map()} results={() => undefined} />);
    expect(screen.queryByRole("button", { name: "do it" })).toBeNull();
  });

  it("puts the actions before the guides and lists of the body, and names the category", () => {
    renderApp(<ProviderPageCard card={c} view={view()} open onToggle={() => {}} signIn={null} actions={<button>do it</button>}><p>body</p></ProviderPageCard>);
    const action = screen.getByRole("button", { name: "do it" });
    expect(action.compareDocumentPosition(screen.getByText("body")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Code und CI")).toBeInTheDocument();
  });

  it("shows the spinner, the last result and the meta line with its problem colour", () => {
    const meta: CollapsedMeta = { kind: "expiry", problem: true, key: "providers.meta.testFailed", vars: {} };
    const last = { ok: true, at: new Date(2026, 0, 1, 10, 0).getTime(), kind: "test" as const, line: "" };
    const { rerender } = renderApp(<ProviderPageCard card={c} view={view({ meta })} open={false} onToggle={() => {}} signIn={null} busy />);
    expect(screen.getByText("GitHub wird geprüft …")).toBeInTheDocument();
    rerender(<ProviderPageCard card={c} view={view({ meta })} open={false} onToggle={() => {}} signIn={null} last={last} />);
    expect(screen.getByLabelText(/Letzte Prüfung bestanden um 10:00/)).toBeInTheDocument();
    rerender(<ProviderPageCard card={c} view={view({ meta })} open={false} onToggle={() => {}} signIn={null} last={{ ...last, ok: false }} />);
    expect(screen.getByLabelText(/Letzte Prüfung fehlgeschlagen um 10:00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Details von GitHub/ }).querySelector(".text-warn-text")).not.toBeNull();
    rerender(<ProviderPageCard card={c} view={view({ meta: { ...meta, problem: false } })} open={false} onToggle={() => {}} signIn={null} />);
    expect(screen.getByRole("button", { name: /Details von GitHub/ }).querySelector(".text-warn-text")).toBeNull();
  });

  it("below sm a collapsed card is one row: name, badge, then the action on the right; category, purpose and meta show when open", () => {
    const meta: CollapsedMeta = { kind: "expiry", problem: false, key: "providers.meta.testFailed", vars: {} };
    const setUp = vi.fn();
    const { rerender } = renderApp(<ProviderPageCard card={c} view={view({ badge: "none", meta })} open={false} onToggle={() => {}} signIn={null} setUp={setUp} />);
    const toggle = screen.getByRole("button", { name: /Details von GitHub/ });
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const category = screen.getByText("Code und CI");
    expect(category).toHaveClass("max-sm:hidden");
    expect(toggle.parentElement!.parentElement).toHaveClass("max-sm:flex-nowrap");
    const action = toggle.parentElement!.nextElementSibling as HTMLElement;
    expect(action).toHaveClass("max-sm:shrink-0");
    expect(follows(toggle, action)).toBe(true);
    expect(toggle.querySelectorAll(".max-sm\\:hidden")).toHaveLength(3);
    rerender(<ProviderPageCard card={c} view={view({ badge: "none", meta })} open onToggle={() => {}} signIn={null} setUp={setUp} />);
    expect(screen.getByRole("button", { name: /Details von GitHub/ }).querySelectorAll(".max-sm\\:hidden")).toHaveLength(0);
  });

  it("formats the date and days of a meta line", () => {
    const meta: CollapsedMeta = { kind: "expiry", problem: false, key: "providers.meta.expiresSoon", vars: {}, date: "2099-03-04", days: 10 };
    renderApp(<ProviderPageCard card={c} view={view({ meta })} open={false} onToggle={() => {}} signIn={null} />);
    expect(screen.getByText(/04\.03\.2099/)).toBeInTheDocument();
  });

  it("offers setup and per-portal sign-in buttons beside the header", async () => {
    const setUp = vi.fn();
    const onSignIn = vi.fn();
    const { user, rerender } = renderApp(<ProviderPageCard card={c} view={view({ badge: "none" })} open={false} onToggle={() => {}} signIn={null} setUp={setUp} />);
    await user.click(screen.getByRole("button", { name: "GitHub einrichten" }));
    expect(setUp).toHaveBeenCalled();
    rerender(<ProviderPageCard card={c} view={view()} open={false} onToggle={() => {}} signIn={null} setUp={setUp} />);
    expect(screen.queryByRole("button", { name: "GitHub einrichten" })).toBeNull();
    rerender(<ProviderPageCard card={c} view={view()} open={false} onToggle={() => {}} signIn={null} onSignIn={onSignIn} signInPrompts={[{ portal: null }, { portal: "live" }]} />);
    await user.click(screen.getByRole("button", { name: "Bei GitHub anmelden" }));
    expect(onSignIn).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Bei GitHub live anmelden" }));
    expect(onSignIn).toHaveBeenLastCalledWith("live");
    expect(screen.getByText("Bei live anmelden")).toBeInTheDocument();
    // The buttons share the header row with the title button (not an extra row below it).
    expect(screen.getByRole("button", { name: "Bei GitHub anmelden" }).parentElement!.parentElement).toBe(screen.getByRole("button", { name: /Details von GitHub/ }).closest("h4")!.parentElement);
    rerender(<ProviderPageCard card={c} view={view({ badge: "none" })} open={false} onToggle={() => {}} signIn={null} signInPrompts={[{ portal: null }]} />);
    expect(screen.queryByRole("button", { name: "Bei GitHub anmelden" })).toBeNull();
    expect(within(document.body).queryByText("Anmelden")).toBeNull();
  });
});


