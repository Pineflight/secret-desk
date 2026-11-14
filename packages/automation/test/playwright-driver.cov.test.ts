import { beforeEach, describe, expect, it, vi } from "vitest";

// The local-launch branch and every action of the driver against a fake of playwright-core: no browser is started.
const launchPersistentContext = vi.fn();
const connectOverCDP = vi.fn();
vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext, connectOverCDP } }));

const ensurePrivateDir = vi.fn(async (_dir: string) => undefined);
vi.mock("@secret-desk/core", async (importActual) => ({ ...(await importActual<typeof import("@secret-desk/core")>()), ensurePrivateDir: (dir: string) => ensurePrivateDir(dir) }));

const findChrome = vi.fn<(preferred?: string) => string | undefined>();
vi.mock("../src/chrome.js", async (importActual) => ({ ...(await importActual<typeof import("../src/chrome.js")>()), findChrome: (preferred?: string) => findChrome(preferred) }));

const { PlaywrightDriver, defaultProfileDir, ChromeNotFoundError, playwrightAvailable } = await import("../src/index.js");

interface LocatorState {
  optionValues: string[];
  optionLabels: string[];
  inputValue: string | Error;
  textContent: string | null;
  attribute: string | null;
  visible: boolean;
}

function fakeLocator(name: string, state: LocatorState, log: string[]) {
  const loc = {
    name,
    first: vi.fn(() => fakeLocator(`${name}.first`, state, log)),
    locator: vi.fn((css: string) => {
      const options = {
        evaluateAll: vi.fn(async (fn: (els: { value: string }[]) => string[]) => fn(state.optionValues.map((value) => ({ value })))),
        allTextContents: vi.fn(async () => state.optionLabels),
      };
      log.push(`${name}.locator(${css})`);
      return options;
    }),
    fill: vi.fn(async (v: string) => void log.push(`${name}.fill(${v})`)),
    selectOption: vi.fn(async (o: unknown) => void log.push(`${name}.selectOption(${JSON.stringify(o)})`)),
    setChecked: vi.fn(async (c: boolean) => void log.push(`${name}.setChecked(${c})`)),
    click: vi.fn(async () => void log.push(`${name}.click`)),
    press: vi.fn(async (k: string) => void log.push(`${name}.press(${k})`)),
    isVisible: vi.fn(async () => state.visible),
    inputValue: vi.fn(async (o: { timeout: number }) => {
      if (state.inputValue instanceof Error) throw state.inputValue;
      log.push(`${name}.inputValue(${o.timeout})`);
      return state.inputValue;
    }),
    textContent: vi.fn(async () => state.textContent),
    getAttribute: vi.fn(async (a: string) => {
      log.push(`${name}.getAttribute(${a})`);
      return state.attribute;
    }),
  };
  return loc;
}

function fakeBrowser(state: Partial<LocatorState> = {}, existingPage = false) {
  const full: LocatorState = { optionValues: [], optionLabels: [], inputValue: "typed", textContent: "shown", attribute: "attr", visible: true, ...state };
  const log: string[] = [];
  const locatorFor = (name: string) => fakeLocator(name, full, log);
  const page = {
    getByRole: vi.fn((role: string, opts: unknown) => locatorFor(`role(${role},${JSON.stringify(opts)})`)),
    getByLabel: vi.fn((v: unknown, opts: unknown) => locatorFor(`label(${String(v)},${JSON.stringify(opts)})`)),
    getByText: vi.fn((v: unknown) => locatorFor(`text(${String(v)})`)),
    getByPlaceholder: vi.fn((v: unknown) => locatorFor(`placeholder(${String(v)})`)),
    getByTestId: vi.fn((v: string) => locatorFor(`testid(${v})`)),
    locator: vi.fn((css: string) => locatorFor(`css(${css})`)),
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => "https://example.test/page"),
    keyboard: { press: vi.fn(async (k: string) => void log.push(`keyboard.press(${k})`)) },
    screenshot: vi.fn(async (_o: unknown) => Buffer.from("PNG")),
  };
  const context = {
    setDefaultTimeout: vi.fn(),
    pages: vi.fn(() => (existingPage ? [page] : [])),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { page, context, log };
}

async function opened(state: Partial<LocatorState> = {}, existingPage = false, opts: ConstructorParameters<typeof PlaywrightDriver>[0] = {}) {
  const b = fakeBrowser(state, existingPage);
  launchPersistentContext.mockResolvedValue(b.context);
  findChrome.mockReturnValue("/opt/chrome");
  const driver = new PlaywrightDriver({ profileDir: "/profiles/p", ...opts });
  await driver.open();
  return { driver, ...b };
}

beforeEach(() => {
  launchPersistentContext.mockReset();
  ensurePrivateDir.mockClear();
  connectOverCDP.mockReset();
  findChrome.mockReset();
});

describe("playwrightAvailable", () => {
  it("is true when playwright-core can be imported", async () => {
    expect(await playwrightAvailable()).toBe(true);
  });
});

describe("PlaywrightDriver local launch", () => {
  it("starts the found Chrome with a private profile, visible, in a sandbox, and reuses the first page", async () => {
    const { driver, context, page } = await opened({}, true, { chromePath: "/opt/chrome", slowMoMs: 20, actionTimeoutMs: 5000 });
    expect(findChrome).toHaveBeenCalledWith("/opt/chrome");
    expect(ensurePrivateDir).toHaveBeenCalledWith("/profiles/p");
    expect(launchPersistentContext).toHaveBeenCalledWith("/profiles/p", { executablePath: "/opt/chrome", headless: false, slowMo: 20, viewport: null, chromiumSandbox: true });
    expect(context.setDefaultTimeout).toHaveBeenCalledWith(5000);
    expect(context.newPage).not.toHaveBeenCalled();
    await driver.goto("https://example.test/");
    expect(page.goto).toHaveBeenCalledWith("https://example.test/", { waitUntil: "domcontentloaded" });
  });
  it("uses the default profile folder, default timeout and headless mode on request, and opens a page when there is none", async () => {
    const b = fakeBrowser();
    launchPersistentContext.mockResolvedValue(b.context);
    findChrome.mockReturnValue("/opt/chrome");
    await new PlaywrightDriver({ headless: true }).open();
    expect(ensurePrivateDir).toHaveBeenCalledWith(defaultProfileDir());
    expect(launchPersistentContext).toHaveBeenCalledWith(defaultProfileDir(), expect.objectContaining({ headless: true, slowMo: 0 }));
    expect(b.context.setDefaultTimeout).toHaveBeenCalledWith(15_000);
    expect(b.context.newPage).toHaveBeenCalledOnce();
  });
  it("falls back to the chrome channel when no executable was found", async () => {
    const b = fakeBrowser();
    launchPersistentContext.mockResolvedValue(b.context);
    findChrome.mockReturnValue(undefined);
    await new PlaywrightDriver({ profileDir: "/profiles/p" }).open();
    expect(launchPersistentContext).toHaveBeenCalledWith("/profiles/p", expect.objectContaining({ channel: "chrome" }));
    expect(launchPersistentContext.mock.calls[0]![1]).not.toHaveProperty("executablePath");
  });
  it("reports a missing Chrome when the channel launch fails", async () => {
    launchPersistentContext.mockRejectedValue(new Error("no such channel"));
    findChrome.mockReturnValue(undefined);
    const err = await new PlaywrightDriver({ profileDir: "/profiles/p" }).open().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ChromeNotFoundError);
    expect(err.message).toContain("Kein Chrome gefunden.");
  });
  it("reports a failed start of a found Chrome with the first line of the reason only", async () => {
    launchPersistentContext.mockRejectedValue(new Error("spawn failed\n  at stack line"));
    findChrome.mockReturnValue("/opt/chrome");
    await expect(new PlaywrightDriver({ profileDir: "/profiles/p" }).open()).rejects.toThrow("Chrome liess sich nicht starten: spawn failed");
  });
  it("refuses every action before open()", async () => {
    const driver = new PlaywrightDriver();
    await expect(driver.currentUrl()).rejects.toThrow("Browser nicht geoeffnet");
    await expect(driver.click({ css: "#x" })).rejects.toThrow("Browser nicht geoeffnet");
  });
});

describe("PlaywrightDriver remote browser cleanup", () => {
  const failing = () => vi.fn(async () => Promise.reject(new Error("already gone")));
  it("ignores failures of bringToFront and of closing pages and the connection", async () => {
    const page = { on: vi.fn(), bringToFront: failing(), close: failing() };
    const browser = { contexts: () => [{ setDefaultTimeout: vi.fn(), newPage: vi.fn(async () => page) }], close: failing() };
    connectOverCDP.mockResolvedValue(browser);
    const driver = new PlaywrightDriver({ cdpEndpoint: "http://127.0.0.1:9222" });
    await expect(driver.open()).resolves.toBeUndefined();
    await expect(driver.close()).resolves.toBeUndefined();
    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("ignores a failing disconnect when the remote browser has no context", async () => {
    const browser = { contexts: () => [], close: failing() };
    connectOverCDP.mockResolvedValue(browser);
    await expect(new PlaywrightDriver({ cdpEndpoint: "http://127.0.0.1:9222" }).open()).rejects.toThrow("has no default context");
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("shows only the first line of a connection error", async () => {
    connectOverCDP.mockRejectedValue(new Error("refused\n    at somewhere"));
    await expect(new PlaywrightDriver({ cdpEndpoint: "http://127.0.0.1:9222" }).open()).rejects.toThrow("Cannot connect to the remote browser at http://127.0.0.1:9222: refused");
  });
});

describe("PlaywrightDriver selectors", () => {
  it("maps each selector kind to the matching Playwright locator", async () => {
    const { driver, page } = await opened();
    await driver.click({ role: "button" });
    await driver.click({ role: "button", name: "Create" });
    await driver.click({ role: "button", name: "Create", exact: true });
    await driver.click({ role: "button", name: "/^Create$/i", exact: true });
    await driver.click({ label: "Name" });
    await driver.click({ label: "Name", exact: true });
    await driver.click({ text: "Hello" });
    await driver.click({ placeholder: "Search" });
    await driver.click({ testid: "save" });
    await driver.click({ css: "#x" });
    expect(page.getByRole.mock.calls).toEqual([["button", {}], ["button", { name: "Create" }], ["button", { name: "Create", exact: true }], ["button", { name: /^Create$/i }]]);
    expect(page.getByLabel.mock.calls).toEqual([["Name", {}], ["Name", { exact: true }]]);
    expect(page.getByText).toHaveBeenCalledWith("Hello");
    expect(page.getByPlaceholder).toHaveBeenCalledWith("Search");
    expect(page.getByTestId).toHaveBeenCalledWith("save");
    expect(page.locator).toHaveBeenCalledWith("#x");
  });
  it("narrows to the first match when asked and rejects a selector without a kind", async () => {
    const { driver, log } = await opened();
    await driver.click({ css: "#x", first: true });
    expect(log).toEqual(["css(#x).first.click"]);
    await expect(driver.click({})).rejects.toThrow("Selektor ohne Suchart: css ?");
  });
});

describe("PlaywrightDriver actions", () => {
  it("fills, checks, clicks and presses keys on elements or the page", async () => {
    const { driver, log } = await opened();
    await driver.fill({ label: "Name" }, "demo");
    await driver.check({ label: "Read only" }, true);
    await driver.click({ css: "#go" });
    await driver.press("Enter", { css: "#go" });
    await driver.press("Escape");
    expect(log).toEqual(["label(Name,{}).fill(demo)", "label(Read only,{}).setChecked(true)", "css(#go).click", "css(#go).press(Enter)", "keyboard.press(Escape)"]);
  });
  it("select: takes a value, else a visible label, else fails", async () => {
    const { driver, log } = await opened({ optionValues: ["30", "90"], optionLabels: [" 30 days ", "90 days"] });
    await driver.select({ label: "Expiry" }, "90");
    await driver.select({ label: "Expiry" }, "30 days");
    await expect(driver.select({ label: "Expiry" }, "forever")).rejects.toThrow('Option nicht gefunden: Feld "Expiry"');
    expect(log.filter((l) => l.includes("selectOption"))).toEqual(['label(Expiry,{}).selectOption({"value":"90"})', 'label(Expiry,{}).selectOption({"label":"30 days"})']);
  });
  it("reports the url, visibility and visible text", async () => {
    const { driver, page } = await opened({ visible: true });
    expect(await driver.currentUrl()).toBe("https://example.test/page");
    expect(await driver.isVisible({ css: "#x" })).toBe(true);
    expect(await driver.hasText("Done")).toBe(true);
    expect(await driver.hasText("/^Do/")).toBe(true);
    expect(page.getByText.mock.calls).toEqual([["Done"], [/^Do/]]);
    const hidden = await opened({ visible: false });
    expect(await hidden.driver.isVisible({ css: "#x" })).toBe(false);
  });
  it("readText prefers the input value and falls back to the text content, then to an empty text", async () => {
    const input = await opened({ inputValue: "typed" });
    expect(await input.driver.readText({ css: "#x" })).toBe("typed");
    expect(input.log).toContain("css(#x).inputValue(2000)");
    const text = await opened({ inputValue: new Error("not an input"), textContent: "shown" });
    expect(await text.driver.readText({ css: "#x" })).toBe("shown");
    const empty = await opened({ inputValue: new Error("not an input"), textContent: null });
    expect(await empty.driver.readText({ css: "#x" })).toBe("");
  });
  it("readAttribute returns the value and fails with the selector and attribute name when absent", async () => {
    const present = await opened({ attribute: "https://example.test/x" });
    expect(await present.driver.readAttribute({ css: "a" }, "href")).toBe("https://example.test/x");
    expect(present.log).toContain("css(a).first.getAttribute(href)");
    const absent = await opened({ attribute: null });
    await expect(absent.driver.readAttribute({ css: "a" }, "href")).rejects.toThrow("Attribut nicht gefunden: css a@href");
  });
  it("screenshot masks the given elements in black and returns the PNG", async () => {
    const { driver, page } = await opened();
    const png = await driver.screenshot([{ css: "#secret" }, { testid: "token" }]);
    expect(png.toString()).toBe("PNG");
    const opts = page.screenshot.mock.calls[0]![0] as { type: string; maskColor: string; mask: { name: string }[] };
    expect(opts).toMatchObject({ type: "png", maskColor: "#000000" });
    expect(opts.mask.map((m) => m.name)).toEqual(["css(#secret)", "testid(token)"]);
  });
  it("waitFor polls the condition through the page", async () => {
    const { driver } = await opened({ visible: true });
    await expect(driver.waitFor({ visible: { css: "#x" } }, 1000)).resolves.toBeUndefined();
  });
  it("close shuts down the context once and forgets the page", async () => {
    const { driver, context } = await opened();
    await driver.close();
    await driver.close();
    expect(context.close).toHaveBeenCalledOnce();
    await expect(driver.currentUrl()).rejects.toThrow("Browser nicht geoeffnet");
  });
  it("close ignores an error from the context", async () => {
    const { driver, context } = await opened();
    context.close.mockRejectedValueOnce(new Error("already closed"));
    await expect(driver.close()).resolves.toBeUndefined();
  });
});
