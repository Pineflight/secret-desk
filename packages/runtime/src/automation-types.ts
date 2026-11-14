import type { Provider } from "@secret-desk/core/portable";

// The few shapes of the browser automation package that the portable part of the runtime names in its declarations (the automation port,
// the waits for a person, the host capability). They are written out here so that the declarations of `@secret-desk/runtime/portable`
// import nothing from `@secret-desk/automation`: a project that uses the portable entry needs no automation package installed.
//
// The small ones are copies of the original types and must stay equal to them; `test/automation-types.check.ts` fails the typecheck
// when they differ. The driver has every member the automation package calls on it (a host that hands out a driver is held to the
// whole contract), with one difference the check names: a screenshot is a `Uint8Array` here, a `Buffer` there (`Buffer` is a Node type).
// The provider and the recipe are the part of the original that the portable code and the port read: the original types are assignable
// to them, so the Node modules, which use the originals, satisfy the port.

/** What a sign-in waits for from the human (`LoginNeed` of the automation package). */
export type PortableLoginNeed = "mfa-code" | "approval" | "consent";

/** The ways to confirm access (`SudoMethod` of the automation package). */
export type PortableSudoMethod = "mobile" | "code" | "password";

/** Why a confirmation of access was not accepted (`SudoProblem` of the automation package). */
export type PortableSudoProblem = "timeout" | "rejected" | "unavailable";

/** A human's answer to the question of a confirmation of access (`SudoAnswer` of the automation package). */
export type PortableSudoAnswer = { method: "mobile" } | { method: "code"; code: string } | { method: "password"; password: string };

/** The ways a human can sign in at a provider (`LoginMethodId` of the automation package). */
export type PortableLoginMethodId = "email" | "google" | "apple" | "microsoft" | "github";

/** One sign-in method of a recipe, as shown to the human (`LoginMethodInfo` of the automation package). */
export interface PortableLoginMethodInfo {
  id: PortableLoginMethodId;
  label: string | null;
  labelEn: string | null;
}

/** Credentials of one run (`LoginCredentials` of the automation package). */
export interface PortableLoginCredentials {
  username: string;
  password: string;
}

/** How an element is found on a page (`Selector` of the automation package). */
export interface PortableSelector {
  role?: string | undefined;
  name?: string | undefined;
  exact?: boolean | undefined;
  label?: string | undefined;
  text?: string | undefined;
  placeholder?: string | undefined;
  testid?: string | undefined;
  css?: string | undefined;
  first?: boolean | undefined;
}

/** A condition with an already compiled address pattern (`ResolvedCondition` of the automation package). */
export interface PortableResolvedCondition {
  url?: RegExp;
  visible?: PortableSelector;
  text?: string;
  hidden?: PortableSelector;
  all?: PortableResolvedCondition[];
  any?: PortableResolvedCondition[];
}

/** What a recipe run needs from a browser (`BrowserDriver` of the automation package; `screenshot` answers bytes, not a `Buffer`). */
export interface PortableBrowserDriver {
  open(): Promise<void>;
  goto(url: string): Promise<void>;
  fill(sel: PortableSelector, value: string): Promise<void>;
  select(sel: PortableSelector, value: string): Promise<void>;
  check(sel: PortableSelector, checked: boolean): Promise<void>;
  click(sel: PortableSelector): Promise<void>;
  press(key: string, sel?: PortableSelector): Promise<void>;
  currentUrl(): Promise<string>;
  isVisible(sel: PortableSelector): Promise<boolean>;
  hasText(text: string): Promise<boolean>;
  readText(sel: PortableSelector): Promise<string>;
  readAttribute(sel: PortableSelector, name: string): Promise<string>;
  screenshot(masks: PortableSelector[]): Promise<Uint8Array>;
  waitFor(cond: PortableResolvedCondition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** A provider that is backed by a browser recipe: what the port reads of it (`BrowserProvider` of the automation package, less its screenshot types). */
export interface PortableBrowserProvider extends Provider {
  automation: { recipeId: string };
  takeScreenshots(secretId: string): unknown[];
  attachScreenshots(secretId: string, reportId: string): Promise<number>;
}

/** A loaded recipe: what the portable code reads of it. */
export interface PortableRecipe {
  id: string;
  host: string;
}
