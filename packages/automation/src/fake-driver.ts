import type { BrowserDriver, ResolvedCondition } from "./driver.js";
import { describeSelector, type Selector } from "./selector.js";
import { pollCondition } from "./wait.js";

export interface FakeEvent {
  action: "goto" | "fill" | "select" | "check" | "click" | "press";
  /** Selektorbeschreibung (describeSelector) bzw. Adresse bei goto, Taste bei press. */
  key: string;
}

export interface FakeDriverOptions {
  url?: string;
  /** Sichtbare Elemente, als describeSelector-Text. */
  visible?: string[];
  /** Text von Elementen fuer readText. */
  texts?: Record<string, string>;
  pageText?: string[];
  /** Pro Aktion aufgerufen, darf den Zustand aendern oder werfen. */
  on?: (event: FakeEvent, driver: FakeDriver) => void | Promise<void>;
  pollMs?: number;
}

/** Skriptbarer Treiber ohne Browser fuer Tests. */
export class FakeDriver implements BrowserDriver {
  url: string;
  readonly visible: Set<string>;
  readonly texts: Map<string, string>;
  readonly pageText: Set<string>;
  readonly calls: string[] = [];
  readonly filled = new Map<string, string>();
  readonly shots: { masks: string[] }[] = [];
  opened = false;
  closed = false;
  readonly #on: FakeDriverOptions["on"];
  readonly #pollMs: number;

  constructor(opts: FakeDriverOptions = {}) {
    this.url = opts.url ?? "about:blank";
    this.visible = new Set(opts.visible);
    this.texts = new Map(Object.entries(opts.texts ?? {}));
    this.pageText = new Set(opts.pageText);
    this.#on = opts.on;
    this.#pollMs = opts.pollMs ?? 5;
  }

  async open(): Promise<void> {
    this.opened = true;
    this.calls.push("open");
  }

  async goto(url: string): Promise<void> {
    this.calls.push(`goto ${url}`);
    this.url = url;
    await this.#on?.({ action: "goto", key: url }, this);
  }

  async fill(sel: Selector, value: string): Promise<void> {
    await this.#act("fill", sel);
    this.filled.set(describeSelector(sel), value);
  }

  async select(sel: Selector, _value: string): Promise<void> {
    await this.#act("select", sel);
  }

  async check(sel: Selector, _checked: boolean): Promise<void> {
    await this.#act("check", sel);
  }

  async click(sel: Selector): Promise<void> {
    await this.#act("click", sel);
  }

  async press(key: string, sel?: Selector): Promise<void> {
    this.calls.push(`press ${key}${sel ? ` ${describeSelector(sel)}` : ""}`);
    await this.#on?.({ action: "press", key }, this);
  }

  async currentUrl(): Promise<string> {
    return this.url;
  }

  async isVisible(sel: Selector): Promise<boolean> {
    return this.visible.has(describeSelector(sel));
  }

  async hasText(text: string): Promise<boolean> {
    return this.pageText.has(text);
  }

  async readText(sel: Selector): Promise<string> {
    const key = describeSelector(sel);
    const text = this.texts.get(key);
    if (text === undefined) throw new Error(`Element nicht gefunden: ${key}`);
    return text;
  }

  async screenshot(masks: Selector[]): Promise<Buffer> {
    const keys = masks.map(describeSelector);
    this.calls.push(`screenshot masks=${keys.length}`);
    this.shots.push({ masks: keys });
    return Buffer.from(`fake-png masks=${keys.join("|")}`);
  }

  waitFor(cond: ResolvedCondition, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return pollCondition(this, cond, timeoutMs, signal, this.#pollMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.calls.push("close");
  }

  async #act(action: "fill" | "select" | "check" | "click", sel: Selector): Promise<void> {
    const key = describeSelector(sel);
    this.calls.push(`${action} ${key}`);
    if (!this.visible.has(key)) throw new Error(`Element nicht sichtbar: ${key}`);
    await this.#on?.({ action, key }, this);
  }
}
