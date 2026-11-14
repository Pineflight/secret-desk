// Compile-time check, not a test: `tsconfig.typecheck.json` (what `pnpm run typecheck` runs) includes this file, vitest does not run it
// and the build does not emit it.
//
// `agent-api.ts` was split into `agent-api-core.ts` and what stays on the Node side. These are the 15 types the module exported before
// the split (the export list of `packages/runtime/src/agent-api.ts` at commit 44221a7). Each one must still be exported from
// `agent-api.ts` and from the package root (a missing name is a compile error at the import) and must be the same type in both places.
import type {
  Actor as NodeActor,
  Authorize as NodeAuthorize,
  AuthorizationRequest as NodeAuthorizationRequest,
  AuthorizeFault as NodeAuthorizeFault,
  AuthorizedAction as NodeAuthorizedAction,
  DevEnvResult as NodeDevEnvResult,
  IssuanceRequestResult as NodeIssuanceRequestResult,
  IssuanceView as NodeIssuanceView,
  ListFilter as NodeListFilter,
  Overview as NodeOverview,
  SecretView as NodeSecretView,
  SystemActor as NodeSystemActor,
  SystemRoutine as NodeSystemRoutine,
  VariableApplyResult as NodeVariableApplyResult,
  VariableView as NodeVariableView,
} from "../src/agent-api.js";
import type {
  Actor as RootActor,
  Authorize as RootAuthorize,
  AuthorizationRequest as RootAuthorizationRequest,
  AuthorizeFault as RootAuthorizeFault,
  AuthorizedAction as RootAuthorizedAction,
  DevEnvResult as RootDevEnvResult,
  IssuanceRequestResult as RootIssuanceRequestResult,
  IssuanceView as RootIssuanceView,
  ListFilter as RootListFilter,
  Overview as RootOverview,
  SecretView as RootSecretView,
  SystemActor as RootSystemActor,
  SystemRoutine as RootSystemRoutine,
  VariableApplyResult as RootVariableApplyResult,
  VariableView as RootVariableView,
} from "../src/index.js";

type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type AgentApiTypeExports = [
  Expect<Same<NodeActor, RootActor>>,
  Expect<Same<NodeAuthorize, RootAuthorize>>,
  Expect<Same<NodeAuthorizationRequest, RootAuthorizationRequest>>,
  Expect<Same<NodeAuthorizeFault, RootAuthorizeFault>>,
  Expect<Same<NodeAuthorizedAction, RootAuthorizedAction>>,
  Expect<Same<NodeDevEnvResult, RootDevEnvResult>>,
  Expect<Same<NodeIssuanceRequestResult, RootIssuanceRequestResult>>,
  Expect<Same<NodeIssuanceView, RootIssuanceView>>,
  Expect<Same<NodeListFilter, RootListFilter>>,
  Expect<Same<NodeOverview, RootOverview>>,
  Expect<Same<NodeSecretView, RootSecretView>>,
  Expect<Same<NodeSystemActor, RootSystemActor>>,
  Expect<Same<NodeSystemRoutine, RootSystemRoutine>>,
  Expect<Same<NodeVariableApplyResult, RootVariableApplyResult>>,
  Expect<Same<NodeVariableView, RootVariableView>>,
];
