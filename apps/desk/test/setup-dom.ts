import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetNavigation } from "./helpers/navigation";

// next/navigation needs the App Router; every component test gets the controllable fake instead.
vi.mock("next/navigation", async () => await import("./helpers/navigation"));

// A test never reaches the network: without a fake of its own (`fakePortal`, `vi.stubGlobal("fetch", ...)`) every `fetch` fails at once.
// Restored after each test as well, so a timer that fires after a test ended cannot open a real connection to localhost.
const noNetwork = async (input: RequestInfo | URL): Promise<Response> => {
  throw new TypeError(`no network in tests: ${String(input)}`);
};
beforeEach(() => {
  vi.stubGlobal("fetch", noNetwork);
});

// happy-dom reports an English browser; the app defaults to German, so tests start in German unless they store another locale.
beforeEach(() => {
  window.localStorage.setItem("sd-locale", "de");
});

afterEach(() => {
  cleanup();
  resetNavigation();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", noNetwork);
  window.localStorage.clear();
  window.sessionStorage.clear();
});
