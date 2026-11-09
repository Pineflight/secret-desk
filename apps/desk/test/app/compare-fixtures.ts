/** Data of the compare page (the answer of `GET compare`). Shapes follow `CompareResult` in `@secret-desk/core`. */
export const STAGES = [
  { id: "dev", label: "dev", kind: "dev", environment: null },
  { id: "staging", label: "Staging", kind: "test", environment: "staging" },
  { id: "production", label: "Production", kind: "live", environment: "production" },
  { id: "shared", label: "shared", kind: "shared", environment: null },
];

export const cell = (state: string, expected = false, present?: boolean, detail?: Record<string, unknown>) => ({
  state,
  expected,
  ...(present !== undefined ? { present } : {}),
  ...(detail ? { detail: { ids: [], targets: [], ...detail } } : {}),
});
export const NA = cell("not-applicable");

export const row = (repo: string, name: string, cells: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  repo,
  name,
  kind: "secret",
  ids: [name.toLowerCase()],
  cells: { dev: NA, shared: NA, staging: cell("not-expected"), production: cell("not-expected"), ...cells },
  parity: "n/a",
  missingIn: [],
  tags: [],
  neededMissing: false,
  levelMismatch: false,
  ...over,
});

export const repoInfo = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  inInventory: true,
  private: true,
  archived: false,
  pushedAt: "2026-02-01T10:00:00Z",
  onGitHub: true,
  found: { secrets: 1, variables: 0 },
  needed: 0,
  notes: [],
  ...over,
});

export const result = (over: Record<string, unknown> = {}) => ({
  stages: STAGES,
  compared: ["staging", "production"],
  rows: [],
  summary: { perStage: {}, gaps: 0, orphans: 0, neededMissing: 0, levelMismatch: 0 },
  ignored: [],
  repos: [],
  live: false,
  errors: [],
  ...over,
});
