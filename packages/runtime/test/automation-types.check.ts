// Compile-time check, not a test (see `agent-api-types.check.ts`): `src/automation-types.ts` stands in for a few types of the automation
// package in the declarations of the portable entry. The small ones must stay equal to the originals; the large ones must stay
// assignable from the originals, so that the Node modules (which use the originals) satisfy the port.
import type { BrowserDriver, BrowserProvider, LoginCredentials, LoginMethodId, LoginMethodInfo, LoginNeed, Recipe, SudoAnswer, SudoMethod, SudoProblem } from "@secret-desk/automation";
import type {
  PortableBrowserDriver,
  PortableBrowserProvider,
  PortableLoginCredentials,
  PortableLoginMethodId,
  PortableLoginMethodInfo,
  PortableLoginNeed,
  PortableRecipe,
  PortableSudoAnswer,
  PortableSudoMethod,
  PortableSudoProblem,
} from "../src/automation-types.js";

type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Assignable<From, To> = From extends To ? true : false;

export type AutomationTypeCopies = [
  Expect<Same<PortableLoginNeed, LoginNeed>>,
  Expect<Same<PortableSudoMethod, SudoMethod>>,
  Expect<Same<PortableSudoProblem, SudoProblem>>,
  Expect<Same<PortableSudoAnswer, SudoAnswer>>,
  Expect<Same<PortableLoginMethodId, LoginMethodId>>,
  Expect<Same<PortableLoginMethodInfo, LoginMethodInfo>>,
  Expect<Same<PortableLoginCredentials, LoginCredentials>>,
  Expect<Assignable<BrowserDriver, PortableBrowserDriver>>,
  Expect<Assignable<BrowserProvider, PortableBrowserProvider>>,
  Expect<Assignable<Recipe, PortableRecipe>>,
];
