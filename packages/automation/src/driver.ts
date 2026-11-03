import type { Selector } from "./selector.js";

/** Bedingung mit schon kompiliertem Adressmuster. */
export interface ResolvedCondition {
  url?: RegExp;
  visible?: Selector;
  text?: string;
  /** Holds once no element matching the selector is visible any more. */
  hidden?: Selector;
}

/**
 * Was der Ablauf vom Browser braucht. Alle Fehler nennen hoechstens die Selektorbeschreibung,
 * nie Seiteninhalt (dort koennte der Token stehen).
 */
export interface BrowserDriver {
  /** Fenster oeffnen. Wird von runRecipe aufgerufen. */
  open(): Promise<void>;
  goto(url: string): Promise<void>;
  fill(sel: Selector, value: string): Promise<void>;
  select(sel: Selector, value: string): Promise<void>;
  check(sel: Selector, checked: boolean): Promise<void>;
  click(sel: Selector): Promise<void>;
  /** Taste druecken, optional zuerst ein Element fokussieren. */
  press(key: string, sel?: Selector): Promise<void>;
  currentUrl(): Promise<string>;
  isVisible(sel: Selector): Promise<boolean>;
  hasText(text: string): Promise<boolean>;
  /** Wert eines Eingabefelds oder Text eines Elements. Nur fuer capture. */
  readText(sel: Selector): Promise<string>;
  /** Value of an attribute of the element (for example `aria-label`). Only for capture. Throws when the element or attribute is missing. */
  readAttribute(sel: Selector, name: string): Promise<string>;
  /** PNG der Seite; die Bereiche in `masks` sind verdeckt. */
  screenshot(masks: Selector[]): Promise<Buffer>;
  /** Wartet, bis die Bedingung gilt. Wirft WaitTimeoutError oder WaitAbortedError. */
  waitFor(cond: ResolvedCondition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
