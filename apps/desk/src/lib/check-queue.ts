/**
 * "Check sign-in" runs in the one remote browser, so checks must never overlap: a check on one provider card checks that
 * provider only, and further clicks wait their turn. This queue is the whole rule, kept apart from the page so it can be tested.
 */

export type CheckPhase = "waiting" | "checking";

export interface CheckQueue<R> {
  /** Queues a check for this provider. Asking again while it waits or runs returns the same result promise (no second run). */
  enqueue: (id: string) => Promise<R | undefined>;
  /** Phases of the providers that are waiting or running right now. */
  phases: () => ReadonlyMap<string, CheckPhase>;
}

/**
 * `run` performs one check and may throw; the queue then carries on with the next one and the failed one resolves to `undefined`
 * (the caller keeps the error itself). `onChange` fires whenever a provider starts waiting, starts running or is done.
 */
export function createCheckQueue<R>(run: (id: string) => Promise<R>, onChange: (phases: ReadonlyMap<string, CheckPhase>) => void = () => undefined): CheckQueue<R> {
  const phases = new Map<string, CheckPhase>();
  const pending = new Map<string, Promise<R | undefined>>();
  let tail: Promise<unknown> = Promise.resolve();
  const emit = (): void => onChange(new Map(phases));
  return {
    enqueue(id) {
      const known = pending.get(id);
      if (known) return known;
      phases.set(id, "waiting");
      emit();
      const job = tail.then(async (): Promise<R | undefined> => {
        phases.set(id, "checking");
        emit();
        try {
          return await run(id);
        } catch {
          return undefined;
        } finally {
          phases.delete(id);
          pending.delete(id);
          emit();
        }
      });
      tail = job;
      pending.set(id, job);
      return job;
    },
    phases: () => new Map(phases),
  };
}
