import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { ChromeNotFoundError, findChrome } from "./chrome.js";
import type { BrowserDriver, ResolvedCondition } from "./driver.js";
import { describeSelector, type Selector } from "./selector.js";
import { pollCondition } from "./wait.js";

export interface PlaywrightDriverOptions {
  chromePath?: string;
  /** Dauerhaftes Profil, damit Anmeldungen erhalten bleiben. Standard ~/.secret-desk/browser-profile (Modus 700). */
  profileDir?: string;
  slowMoMs?: number;
  /** Nur fuer Tests; im Betrieb bleibt das Fenster sichtbar. */
  headless?: boolean;
  /** Zeitlimit je Aktion (Standard 15 s). */
  actionTimeoutMs?: number;
}

export const DEFAULT_PROFILE_DIR = join(homedir(), ".secret-desk", "browser-profile");

type Role = Parameters<Page["getByRole"]>[0];

/** Steuert ein sichtbares Chrome mit dauerhaftem Profil ueber playwright-core. */
export class PlaywrightDriver implements BrowserDriver {
  readonly #opts: PlaywrightDriverOptions;
  #context: BrowserContext | undefined;
  #page: Page | undefined;

  constructor(opts: PlaywrightDriverOptions = {}) {
    this.#opts = opts;
  }

  async open(): Promise<void> {
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Error("playwright-core ist nicht installiert (pnpm install, optionale Abhaengigkeit).");
    }
    const path = findChrome(this.#opts.chromePath);
    const profile = this.#opts.profileDir ?? DEFAULT_PROFILE_DIR;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(profile, 0o700);
    try {
      this.#context = await chromium.launchPersistentContext(profile, {
        ...(path ? { executablePath: path } : { channel: "chrome" }),
        headless: this.#opts.headless ?? false,
        slowMo: this.#opts.slowMoMs ?? 0,
        viewport: null,
      });
    } catch (err) {
      if (!path) throw new ChromeNotFoundError("Kein Chrome gefunden.");
      throw new Error(`Chrome liess sich nicht starten: ${(err as Error).message.split("\n")[0]}`);
    }
    this.#context.setDefaultTimeout(this.#opts.actionTimeoutMs ?? 15_000);
    this.#page = this.#context.pages()[0] ?? (await this.#context.newPage());
  }

  get #p(): Page {
    if (!this.#page) throw new Error("Browser nicht geoeffnet");
    return this.#page;
  }

  #loc(s: Selector): Locator {
    const p = this.#p;
    if (s.role !== undefined) return p.getByRole(s.role as Role, s.name !== undefined ? { name: s.name } : {});
    if (s.label !== undefined) return p.getByLabel(s.label);
    if (s.text !== undefined) return p.getByText(s.text);
    if (s.placeholder !== undefined) return p.getByPlaceholder(s.placeholder);
    if (s.testid !== undefined) return p.getByTestId(s.testid);
    if (s.css !== undefined) return p.locator(s.css);
    throw new Error(`Selektor ohne Suchart: ${describeSelector(s)}`);
  }

  async goto(url: string): Promise<void> {
    await this.#p.goto(url, { waitUntil: "domcontentloaded" });
  }

  async fill(sel: Selector, value: string): Promise<void> {
    await this.#loc(sel).fill(value);
  }

  async select(sel: Selector, value: string): Promise<void> {
    const loc = this.#loc(sel);
    const options = loc.locator("option");
    const values = await options.evaluateAll((els) => els.map((e) => (e as unknown as { value: string }).value));
    const labels = (await options.allTextContents()).map((t) => t.trim());
    // Wert oder sichtbare Beschriftung; findet sich keines, Abbruch (kein Raten).
    if (values.includes(value)) await loc.selectOption({ value });
    else if (labels.includes(value)) await loc.selectOption({ label: value });
    else throw new Error(`Option nicht gefunden: ${describeSelector(sel)}`);
  }

  async check(sel: Selector, checked: boolean): Promise<void> {
    await this.#loc(sel).setChecked(checked);
  }

  async click(sel: Selector): Promise<void> {
    await this.#loc(sel).click();
  }

  async press(key: string, sel?: Selector): Promise<void> {
    if (sel) await this.#loc(sel).press(key);
    else await this.#p.keyboard.press(key);
  }

  async currentUrl(): Promise<string> {
    return this.#p.url();
  }

  async isVisible(sel: Selector): Promise<boolean> {
    return this.#loc(sel).first().isVisible();
  }

  async hasText(text: string): Promise<boolean> {
    return this.#p.getByText(text).first().isVisible();
  }

  async readText(sel: Selector): Promise<string> {
    const loc = this.#loc(sel);
    try {
      return await loc.inputValue({ timeout: 2000 });
    } catch {
      return (await loc.textContent()) ?? "";
    }
  }

  async screenshot(masks: Selector[]): Promise<Buffer> {
    return this.#p.screenshot({ type: "png", mask: masks.map((m) => this.#loc(m)), maskColor: "#000000" });
  }

  waitFor(cond: ResolvedCondition, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return pollCondition(this, cond, timeoutMs, signal);
  }

  async close(): Promise<void> {
    await this.#context?.close().catch(() => undefined);
    this.#context = undefined;
    this.#page = undefined;
  }
}

/** Ist die optionale Abhaengigkeit playwright-core installiert? */
export async function playwrightAvailable(): Promise<boolean> {
  try {
    await import("playwright-core");
    return true;
  } catch {
    return false;
  }
}
