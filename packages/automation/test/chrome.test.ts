import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCandidates, chromeInstallHint } from "../src/chrome.js";

describe("chromeCandidates", () => {
  it("Windows: Program Files, Program Files (x86), LocalAppData; Chrome, Chromium, Edge; without duplicates", () => {
    const env = {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      PROGRAMW6432: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\Ann\\AppData\\Local",
    } as unknown as NodeJS.ProcessEnv;
    const list = chromeCandidates("win32", env);
    expect(list).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(list).toContain("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    expect(list).toContain("C:\\Users\\Ann\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(list).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(new Set(list.map((p) => p.toLowerCase())).size).toBe(list.length);
    for (const p of list) expect(path.win32.isAbsolute(p)).toBe(true);
  });
  it("Windows without environment variables: empty list instead of crash", () => {
    expect(chromeCandidates("win32", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("Linux: google-chrome, chromium, chromium-browser, Edge, Snap and Flatpak", () => {
    const list = chromeCandidates("linux", {} as NodeJS.ProcessEnv);
    for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"]) expect(list).toContain(p);
    expect(list.some((p) => p.includes("flatpak"))).toBe(true);
  });
  it("macOS: Chrome before Chromium", () => {
    const list = chromeCandidates("darwin", {} as NodeJS.ProcessEnv);
    expect(list[0]).toContain("Google Chrome.app");
  });
  it("hints per system", () => {
    expect(chromeInstallHint("win32")).toMatch(/Edge/);
    expect(chromeInstallHint("linux")).toMatch(/Snap|Flatpak/);
  });
});
