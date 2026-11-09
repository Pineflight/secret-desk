import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetNavigation } from "./helpers/navigation";

// next/navigation needs the App Router; every component test gets the controllable fake instead.
vi.mock("next/navigation", async () => await import("./helpers/navigation"));

// happy-dom reports an English browser; the app defaults to German, so tests start in German unless they store another locale.
beforeEach(() => {
  window.localStorage.setItem("sd-locale", "de");
});

afterEach(() => {
  cleanup();
  resetNavigation();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
