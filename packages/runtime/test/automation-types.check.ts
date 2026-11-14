// Compile-time check, not a test (see `agent-api-types.check.ts`): `src/automation-types.ts` stands in for a few types of the automation
// package in the declarations of the portable entry. The small ones must stay equal to the originals; the driver must have the same
// members with the same signatures (a screenshot is bytes there, a `Buffer` here: the one named difference); the provider and the
// recipe must stay assignable from the originals, so that the Node modules (which use the originals) satisfy the port.
import type {
  BrowserDriver,
  BrowserProvider,
  LoginCredentials,
  LoginMethodId,
  LoginMethodInfo,
  LoginNeed,
  Recipe,
  ResolvedCondition,
  Selector,
  SudoAnswer,
  SudoMethod,
  SudoProblem,
} from "@secret-desk/automation";
import type {
  PortableBrowserDriver,
  PortableBrowserProvider,
  PortableLoginCredentials,
  PortableLoginMethodId,
  PortableLoginMethodInfo,
  PortableLoginNeed,
  PortableRecipe,
  PortableResolvedCondition,
  PortableSelector,
  PortableSudoAnswer,
  PortableSudoMethod,
  PortableSudoProblem,
} from "../src/automation-types.js";
import type { AutomationPort } from "../src/automation-port.js";

type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
// Not distributive: a union on the left must be assignable as a whole.
type Assignable<From, To> = [From] extends [To] ? true : false;
type Driver = BrowserDriver;
type PDriver = PortableBrowserDriver;
type Members = Exclude<keyof Driver, "screenshot">;

export type AutomationTypeCopies = [
  Expect<Same<PortableLoginNeed, LoginNeed>>,
  Expect<Same<PortableSudoMethod, SudoMethod>>,
  Expect<Same<PortableSudoProblem, SudoProblem>>,
  Expect<Same<PortableSudoAnswer, SudoAnswer>>,
  Expect<Same<PortableLoginMethodId, LoginMethodId>>,
  Expect<Same<PortableLoginMethodInfo, LoginMethodInfo>>,
  Expect<Same<PortableLoginCredentials, LoginCredentials>>,
  Expect<Same<PortableSelector, Selector>>,
  Expect<Same<PortableResolvedCondition, ResolvedCondition>>,
  // The driver: the same members, each with the same signature, except the screenshot, whose bytes may be a `Buffer`.
  Expect<Same<keyof Driver, keyof PDriver>>,
  Expect<Same<Pick<Driver, Members>, Pick<PDriver, Members>>>,
  Expect<Same<Parameters<Driver["screenshot"]>, Parameters<PDriver["screenshot"]>>>,
  Expect<Assignable<Awaited<ReturnType<Driver["screenshot"]>>, Awaited<ReturnType<PDriver["screenshot"]>>>>,
  Expect<Assignable<Driver, PDriver>>,
  Expect<Assignable<BrowserProvider, PortableBrowserProvider>>,
  Expect<Assignable<Recipe, PortableRecipe>>,
];

// The port compares the parameters of these members strictly: an implementation that reads more of a provider than the port hands out
// (here: one more member) is refused. With method syntax in the port it would be accepted.
interface RicherProvider extends PortableBrowserProvider {
  readonly extra: true;
}
// @ts-expect-error `run` that needs a richer provider than the port gives it
export const richerRun: AutomationPort["run"] = async <T>(_secretId: string, _provider: RicherProvider, work: () => Promise<T>) => work();
// @ts-expect-error `attach` that needs a richer provider than the port gives it
export const richerAttach: AutomationPort["attach"] = async (_provider: RicherProvider) => 0;
// A smaller requirement is fine.
export const smallerRun: AutomationPort["run"] = async <T>(_secretId: string, _provider: { id: string }, work: () => Promise<T>) => work();
