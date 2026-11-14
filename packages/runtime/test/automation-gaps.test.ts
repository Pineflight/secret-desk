import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver, PlaywrightDriver, type BrowserProvider } from "@secret-desk/automation";
import { IssuanceError, InventoryError, ParamsInvalidError, ProviderRegistry } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationError, AutomationManager, viewerUrlFrom } from "../src/automation.js";
import { createLocalRuntime, type RuntimeOptions } from "../src/runtime.js";
import { envHost } from "./helpers/env-host.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const RECIPE_NO_STATUS = `id: plain-recipe
label: Plain
host: plain.example.test
login:
  expect: { url: "^https://plain\\\\.example\\\\.test/tokens" }
  message: Please sign in
steps:
  - goto: "https://plain.example.test/tokens/new"
  - click: { role: button, name: Create, createsToken: true }
capture:
  token:
    find: { css: "#tok" }
    pattern: "^(tok_[a-z0-9]+)$"
    timeoutSeconds: 0.05
mask: [{ css: "#tok" }]
`;

async function setup(opts: { automation?: string; recipes?: Record<string, string>; runtime?: RuntimeOptions; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-auto-gaps-"));
  await mkdir(join(dir, "recipes"));
  for (const [name, text] of Object.entries(opts.recipes ?? {})) await writeFile(join(dir, "recipes", name), text);
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${opts.automation ?? ""}`);
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1", ...(opts.env ?? {}) } as unknown as NodeJS.ProcessEnv, bundledRecipes: null, ...(opts.runtime ?? {}) });
  return { rt, dir };
}

const fakeProvider = (): BrowserProvider => ({ id: "x-browser", takeScreenshots: () => [] }) as unknown as BrowserProvider;

describe("viewerUrlFrom", () => {
  it("rejects a path on the portal host that contains whitespace or backslashes", () => {
    expect(viewerUrlFrom("/browser/a b", {})).toBeNull();
    expect(viewerUrlFrom("/browser\\a", {})).toBeNull();
    expect(viewerUrlFrom("/browser/ok", {})).toBe("/browser/ok");
  });
});

describe("loading recipes", () => {
  it("a recipe without a STATUS comment is shown as not checked", async () => {
    const { rt } = await setup({ recipes: { "plain.yaml": RECIPE_NO_STATUS } });
    expect(rt.automation.recipes).toMatchObject([{ id: "plain-recipe", status: "nicht geprueft" }]);
  });

  it("reports a missing bundled recipe folder", async () => {
    const { rt } = await setup({ runtime: { bundledRecipes: "/does/not/exist/recipes" } });
    expect(rt.automation.problems).toContainEqual({ file: "/does/not/exist/recipes", message: "Der Ordner mit den mitgelieferten Rezepten wurde nicht gefunden." });
  });

  it("reports recipe folders that cannot be read, without failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-auto-file-"));
    const asFile = join(dir, "not-a-folder");
    await writeFile(asFile, "x");
    const { rt } = await setup({ automation: `automation: { recipesDirs: [${JSON.stringify(asFile)}] }\n` });
    expect(rt.automation.recipes).toEqual([]);
    expect(rt.automation.problems[0]?.message).toMatch(/^Rezepte konnten nicht gelesen werden: /);
  });

  it("with bundled recipes, an external recipe folder is skipped unless allowed, and says so", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "sd-auto-bundled-"));
    const { rt, dir } = await setup({ recipes: { "plain.yaml": RECIPE_NO_STATUS }, runtime: { bundledRecipes: bundled } });
    expect(rt.automation.recipes).toEqual([]);
    expect(rt.automation.problems).toContainEqual({ file: join(dir, "recipes"), message: "Externer Rezeptordner uebersprungen: automation.allowExternalRecipes ist aus." });
    const allowed = await setup({ recipes: { "plain.yaml": RECIPE_NO_STATUS }, automation: "automation: { allowExternalRecipes: true }\n", runtime: { bundledRecipes: bundled } });
    expect(allowed.rt.automation.recipes.map((r) => r.id)).toEqual(["plain-recipe"]);
  });
});

describe("browser configuration", () => {
  it("the manager reads the remote browser and viewer only through the host, never from the process environment", async () => {
    const { rt, dir } = await setup();
    vi.stubEnv("SECRET_DESK_BROWSER_CDP", "http://127.0.0.1:9");
    vi.stubEnv("SECRET_DESK_BROWSER_VIEWER_URL", "http://desk.local/vnc.html");
    const base = { config: rt.config, configDir: dir, inventoryDir: dir, providers: new ProviderRegistry(), evidence: rt.evidence };
    const withHost = new AutomationManager({ ...base, host: envHost({ SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9", SECRET_DESK_BROWSER_VIEWER_URL: "http://desk.local/vnc.html" }) });
    expect(withHost.viewerUrl).toBe("http://desk.local/vnc.html");
    expect(withHost.info().browser).toMatchObject({ mode: "remote", viewerUrl: "http://desk.local/vnc.html" });
    const withoutHost = new AutomationManager(base);
    expect(withoutHost.viewerUrl).toBeNull();
    expect(withoutHost.info().browser).toMatchObject({ mode: "local" });
    expect(rt.automation.viewerUrl).toBeNull();
  });

  it("builds a driver without opening it: remote with and without slow motion, local with and without a Chrome path", async () => {
    const remote = await setup({ env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" } });
    expect(await remote.rt.automation.newDriver()).toBeInstanceOf(PlaywrightDriver);
    const slowRemote = await setup({ env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" }, automation: "automation: { slowMoMs: 50 }\n" });
    expect(await slowRemote.rt.automation.newDriver()).toBeInstanceOf(PlaywrightDriver);
    const local = await setup();
    expect(await local.rt.automation.newDriver()).toBeInstanceOf(PlaywrightDriver);
    const slowLocal = await setup({ automation: `automation: { slowMoMs: 50, chromePath: ${JSON.stringify("/opt/made-up/chrome")} }\n` });
    expect(await slowLocal.rt.automation.newDriver()).toBeInstanceOf(PlaywrightDriver);
  });

  it("reports the Chrome that was found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-auto-chrome-"));
    const chrome = join(dir, "chrome");
    await writeFile(chrome, "#!/bin/sh\n", { mode: 0o755 });
    const { rt } = await setup({ automation: `automation: { chromePath: ${JSON.stringify(chrome)} }\n` });
    expect(rt.automation.info().chrome).toMatchObject({ found: true, hint: null });
  });
});

describe("tracked runs", () => {
  it("update and end ignore unknown keys and finished runs; end of a finished run does not free the browser again", async () => {
    const { rt } = await setup();
    const a = rt.automation;
    a.update("nope", { text: "x" });
    a.end("nope", { status: "done", text: "x" });
    expect(a.runs()).toEqual([]);
    a.begin("run-a", "p", { text: "started" });
    expect(a.isActive("run-a")).toBe(true);
    expect(a.isActive("other")).toBe(false);
    a.end("run-a", { status: "done", text: "finished" });
    a.update("run-a", { text: "late" });
    expect(a.state("run-a").text).toBe("finished");
    a.begin("run-b", "p", { text: "second" });
    a.end("run-a", { status: "done", text: "again" });
    expect(a.isBusy()).toBe(true);
    expect(a.isActive("run-b")).toBe(true);
  });

  it("explains a second run: same key or another one", async () => {
    const { rt } = await setup();
    rt.automation.begin("run-a", "p", { text: "x" });
    expect(() => rt.automation.begin("run-a", "p", { text: "x" })).toThrow(/for this provider is already in progress/);
    expect(() => rt.automation.begin("run-b", "p", { text: "x" })).toThrow(/Wait for it or cancel/);
    await expect(rt.automation.run("run-a", fakeProvider(), async () => 1)).rejects.toThrow("Fuer dieses Secret laeuft schon ein Browser-Lauf.");
    await expect(rt.automation.run("run-b", fakeProvider(), async () => 1)).rejects.toThrow("Es laeuft schon ein Browser-Lauf (Secret run-a)");
  });

  it("run: records the issuance id of the result", async () => {
    const { rt } = await setup();
    const result = await rt.automation.run("sec-a", fakeProvider(), async () => ({ id: "issuance-1" }), (r) => r.id);
    expect(result).toEqual({ id: "issuance-1" });
    expect(rt.automation.state("sec-a")).toMatchObject({ status: "done", issuanceId: "issuance-1" });
    await rt.automation.run("sec-b", fakeProvider(), async () => 1);
    expect(rt.automation.state("sec-b").issuanceId).toBeUndefined();
  });

  it("run: an error without a message gets a generic text, known errors pass through, others become AutomationError", async () => {
    const { rt } = await setup();
    await expect(rt.automation.run("sec-a", fakeProvider(), async () => Promise.reject(new Error("")))).rejects.toBeInstanceOf(AutomationError);
    expect(rt.automation.state("sec-a")).toMatchObject({ status: "failed", text: "Der Lauf ist fehlgeschlagen." });
    await expect(rt.automation.run("sec-b", fakeProvider(), async () => Promise.reject(new IssuanceError("provider said no")))).rejects.toBeInstanceOf(IssuanceError);
    await expect(rt.automation.run("sec-c", fakeProvider(), async () => Promise.reject(new InventoryError("bad entry")))).rejects.toBeInstanceOf(InventoryError);
    expect(rt.automation.state("sec-c")).toMatchObject({ status: "failed", text: "bad entry" });
    const invalid = new ParamsInvalidError([{ key: "ttlDays", code: "not_in_options", message: "x", label: "x", labelEn: "x" }]);
    await expect(rt.automation.run("sec-d", fakeProvider(), async () => Promise.reject(invalid))).rejects.toBe(invalid);
  });

  it("attach: a failing receipt upload counts zero", async () => {
    const { rt } = await setup();
    const ok = { attachScreenshots: async () => 2 } as unknown as BrowserProvider;
    const failing = { attachScreenshots: async () => Promise.reject(new Error("disk full")) } as unknown as BrowserProvider;
    expect(await rt.automation.attach(ok, "sec", "report")).toBe(2);
    expect(await rt.automation.attach(failing, "sec", "report")).toBe(0);
  });
});

describe("a recipe provider issuing without an active run", () => {
  it("works without a cancel signal and remembers the signed-in host", async () => {
    const { rt } = await setup({
      recipes: { "plain.yaml": RECIPE_NO_STATUS },
      runtime: {
        automationDriver: () =>
          new FakeDriver({
            url: "about:blank",
            visible: ['button "Create"'],
            pollMs: 5,
            on: (e, drv) => {
              if (e.action === "goto") drv.url = "https://plain.example.test/tokens/new";
              if (e.action === "click") {
                drv.visible.add("css #tok");
                drv.texts.set("css #tok", "tok_madeup123");
              }
            },
          }),
      },
    });
    const provider = rt.providers.get("plain-recipe-browser")!;
    const secret = { id: "plain-secret", name: "PLAIN_SECRET", stage: "dev", service: "x", provider: "plain-recipe-browser", expiry: "none", params: {}, places: [] };
    const issued = await provider.issue!({ secret: secret as never, params: {}, stage: "dev", connections: rt.connections, fetch: rt.fetch, now: new Date("2026-11-09T10:00:00Z"), label: "plain-secret" });
    expect(issued.value.reveal()).toBe("tok_madeup123");
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "plain.example.test", signedIn: true, source: "run" }]);
  });
});

describe("Chrome lookup without a configured path", () => {
  it("says how to install Chrome when no standard location exists (Windows layout, no program folders set)", async () => {
    const { rt } = await setup();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    for (const name of ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "LOCALAPPDATA"]) vi.stubEnv(name, "");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(rt.automation.info().chrome).toMatchObject({ found: false, path: null, hint: expect.stringContaining("Google Chrome oder Microsoft Edge installieren") });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
