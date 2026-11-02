import { beforeEach, describe, expect, it, vi } from "vitest";

// The CDP branch of the driver against a mocked playwright-core: no browser is started.
const connectOverCDP = vi.fn();
const launchPersistentContext = vi.fn();
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP, launchPersistentContext } }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => ({ address: "172.18.0.9", family: 4 })) }));

const { PlaywrightDriver } = await import("../src/index.js");

function fakePage() {
  const handlers: Record<string, (p: unknown) => void> = {};
  return {
    close: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    url: () => "https://example.test/",
    on: vi.fn((event: string, h: (p: unknown) => void) => {
      handlers[event] = h;
    }),
    handlers,
  };
}

function fakeRemote(contexts = true) {
  const existing = fakePage();
  const mine = fakePage();
  const context = { newPage: vi.fn(async () => mine), setDefaultTimeout: vi.fn(), pages: () => [existing], close: vi.fn(async () => undefined) };
  const browser = { contexts: () => (contexts ? [context] : []), close: vi.fn(async () => undefined) };
  return { browser, context, existing, mine };
}

beforeEach(() => {
  connectOverCDP.mockReset();
  launchPersistentContext.mockReset();
});

describe("PlaywrightDriver with cdpEndpoint", () => {
  it("connects over CDP to the resolved address and never launches a local Chrome", async () => {
    const r = fakeRemote();
    connectOverCDP.mockResolvedValue(r.browser);
    const driver = new PlaywrightDriver({ cdpEndpoint: "http://browser:9222", chromePath: "/nonexistent/chrome", profileDir: "/nonexistent/profile", slowMoMs: 50 });
    await driver.open();
    expect(connectOverCDP).toHaveBeenCalledWith("http://172.18.0.9:9222/", { timeout: 15_000, slowMo: 50 });
    expect(launchPersistentContext).not.toHaveBeenCalled();
    // The run works in its own tab, not in a tab the human has open.
    expect(r.context.newPage).toHaveBeenCalledOnce();
    expect(r.mine.bringToFront).toHaveBeenCalled();
    await driver.goto("https://example.test/");
    expect(r.mine.goto).toHaveBeenCalled();
    expect(r.existing.goto).not.toHaveBeenCalled();
  });

  it("closes only its own pages and disconnects; it never closes the context or other tabs", async () => {
    const r = fakeRemote();
    connectOverCDP.mockResolvedValue(r.browser);
    const driver = new PlaywrightDriver({ cdpEndpoint: "http://127.0.0.1:9222" });
    await driver.open();
    const popup = fakePage();
    r.mine.handlers["popup"]?.(popup);
    await driver.close();
    expect(r.mine.close).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(r.existing.close).not.toHaveBeenCalled();
    expect(r.context.close).not.toHaveBeenCalled();
    expect(r.browser.close).toHaveBeenCalledOnce(); // disconnect
    await driver.close(); // idempotent
    expect(r.browser.close).toHaveBeenCalledOnce();
  });

  it("fails without echoing credentials when the browser is not reachable", async () => {
    connectOverCDP.mockRejectedValue(new Error("connect ECONNREFUSED http://user:s3cret@127.0.0.1:9222\n at stack"));
    const driver = new PlaywrightDriver({ cdpEndpoint: "http://user:s3cret@127.0.0.1:9222" });
    const err = await driver.open().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("Cannot connect to the remote browser at http://127.0.0.1:9222");
    expect(err?.message).not.toContain("s3cret");
    expect(err?.message).not.toContain("at stack");
  });

  it("disconnects and fails when the browser has no default context", async () => {
    const r = fakeRemote(false);
    connectOverCDP.mockResolvedValue(r.browser);
    const driver = new PlaywrightDriver({ cdpEndpoint: "http://127.0.0.1:9222" });
    await expect(driver.open()).rejects.toThrow(/has no default context/);
    expect(r.browser.close).toHaveBeenCalledOnce();
  });

  it("rejects an invalid endpoint before connecting", async () => {
    const driver = new PlaywrightDriver({ cdpEndpoint: "file:///etc/passwd" });
    await expect(driver.open()).rejects.toThrow(/only http, https, ws and wss/);
    expect(connectOverCDP).not.toHaveBeenCalled();
  });
});
