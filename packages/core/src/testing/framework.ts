/**
 * Test-framework seam of the contract suites. The suites do not import a test framework: the caller passes the
 * functions in, so the published package has no dependency on one and the suites run under any runner that has
 * `describe`, `it` and a Jest-style `expect` (Vitest under Node, Vitest inside a Workers test pool, ...).
 * This module is portable: no Node built-ins, no `Buffer`, no file system.
 */

/** The matchers the suites use. Vitest's and Jest's `expect(...)` results satisfy this shape. */
export interface ContractExpectation {
  readonly not: ContractExpectation;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeInstanceOf(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toHaveLength(expected: number): void;
  toHaveProperty(property: string): void;
}

/** The framework functions a suite needs. Pass `{ describe, it, expect }` from your runner. */
export interface ContractFramework {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => unknown): void;
  expect(actual: unknown): ContractExpectation;
}

/**
 * Wraps the body of every test. Use it when the store can only be used inside a special context (for example inside an
 * isolated object of a Workers runtime): the runner enters that context and calls `body` there. The factory is called
 * inside `body`, so every test gets a fresh store inside the context and nothing is shared between tests.
 */
export type ContractRunner = <T>(body: () => Promise<T>) => Promise<T>;

export interface ContractOptions {
  /** Default: the body runs directly. */
  run?: ContractRunner;
}

/** What a factory may hand back besides the store: a cleanup that runs after the test, also when it fails. */
export interface Cleanup {
  cleanup?(): Promise<void> | void;
}

/** Registers one test: `body` runs through the optional runner (directly without one). */
export function contractTest(framework: ContractFramework, options: ContractOptions, name: string, body: () => Promise<void>): void {
  framework.it(name, () => (options.run ? options.run(body) : body()));
}

/** Calls `make`, runs `use` with the result and then the cleanup (also when `use` throws). */
export async function withMade<M extends Cleanup>(make: () => Promise<M> | M, use: (made: M) => Promise<void>): Promise<void> {
  const made = await make();
  try {
    await use(made);
  } finally {
    await made.cleanup?.();
  }
}
