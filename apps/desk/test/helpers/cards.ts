import type { BrowserWay, HostLine, KeyRow, ProviderCard, RecipeRow } from "@/lib/provider-cards";
import type { Readiness } from "@/lib/browser-ready";

/** A provider card with nothing connected; override what the test needs. */
export const card = (over: Partial<ProviderCard> = {}): ProviderCard => ({
  id: "acme",
  label: "Acme",
  category: "hosting",
  icon: null,
  custom: false,
  status: "none",
  signIn: { state: "none", facade: null, recipes: [], available: false },
  keys: [],
  byHand: [],
  prefixes: [],
  browser: null,
  worksWithoutBrowser: false,
  browserSignedIn: false,
  produces: [],
  secrets: 0,
  variables: 0,
  ...over,
});

export const key = (over: Partial<KeyRow> = {}): KeyRow => ({ id: "acme", label: "Acme key", connected: true, role: "primary", daysLeft: 40, expires: "2099-01-01", level: "ok", ...over });

export const readiness = (state: Readiness["state"], ageMinutes: number | null = null, over: Partial<Readiness> = {}): Readiness => ({ state, checkedAt: ageMinutes === null ? null : "2026-01-01T00:00:00Z", ageMinutes, stale: false, ...over });

export const browserWay = (over: Partial<BrowserWay> = {}): BrowserWay => ({ readiness: readiness("unknown"), secrets: 0, expiry: null, neverExpires: false, sessionHours: null, hostLines: [], ...over });

export const hostLine = (over: Partial<HostLine> = {}): HostLine => ({ value: "live", host: "portal.acme.test", readiness: readiness("ready", 120), sessionHours: null, ...over });

export const recipe = (over: Partial<RecipeRow> = {}): RecipeRow => ({ id: "acme-recipe", label: "Acme console", host: "portal.acme.test", canCheckSignIn: true, ...over });
