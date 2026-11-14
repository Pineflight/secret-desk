import type { Provider } from "@secret-desk/core/portable";

// The few shapes of the browser automation package that the portable part of the runtime names in its declarations (the automation port,
// the waits for a person, the host capability). They are written out here so that the declarations of `@secret-desk/runtime/portable`
// import nothing from `@secret-desk/automation`: a project that uses the portable entry needs no automation package installed.
//
// The small ones are copies of the original types and must stay equal to them; `test/automation-types.check.ts` fails the typecheck
// when they differ. The large ones (the driver, the provider, the recipe) are the part of the original that the portable code relies
// on: the original types are assignable to them, so the Node modules, which use the originals, still satisfy the port.

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

/** A browser the port can hand out. The portable code only opens and closes it; the steps of a recipe are the automation package's business. */
export interface PortableBrowserDriver {
  open(): Promise<void>;
  close(): Promise<void>;
}

/** A provider that is backed by a browser recipe: what the portable code reads of it. */
export interface PortableBrowserProvider extends Provider {
  automation: { recipeId: string };
}

/** A loaded recipe: what the portable code reads of it. */
export interface PortableRecipe {
  id: string;
  host: string;
}
