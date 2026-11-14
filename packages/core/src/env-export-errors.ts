// The error classes of the env export, in their own module so portable code can throw and catch them without loading the
// Node-bound export itself. `env-export.ts` re-exports both: the class identity is the same on both paths.

export class EnvExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvExportError";
  }
}

export class PromptsRequiredError extends EnvExportError {
  constructor(readonly keys: string[]) {
    super(`Eingabe noetig fuer: ${keys.join(", ")}`);
    this.name = "PromptsRequiredError";
  }
}
