/** Data of the integrations page: a vendor catalog, connections, providers, sign-in checks and counts. Shapes follow `src/lib/provider-cards.ts`. */
export const vendor = (id: string, label: string, category: string, rest: Record<string, unknown> = {}) => ({
  id,
  label,
  category,
  icon: null,
  connections: [],
  connectionPrefixes: [],
  legacyConnections: [],
  optionalConnections: [],
  providers: [],
  recipes: [],
  signInPlanned: false,
  ...rest,
});

export const catalog = (...vendors: unknown[]) => ({ categories: ["code", "payments", "messaging", "other"], vendors });

export const connection = (id: string, vendorId: string | null, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  vendor: vendorId,
  role: "primary",
  connected: true,
  source: "session",
  description: null,
  url: null,
  openUrl: null,
  steps: [],
  permissions: [],
  ...over,
});

export const provider = (id: string, vendorId: string | null, over: Record<string, unknown> = {}) => ({ id, label: id, kind: "manual", browser: false, vendor: vendorId, connection: null, guide: { url: "https://example.test", steps: [] }, ...over });

export const recipe = (id: string, providerId: string, host: string, over: Record<string, unknown> = {}) => ({ id, providerId, label: id, host, status: "ok", sha256: "x", allowHosts: [host], bundled: true, canCheckSignIn: true, ...over });

export const automation = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  browser: { mode: "local", endpoint: null, reachable: true, browser: null, detail: null, viewerUrl: null },
  chrome: { found: true, path: null, hint: null },
  profileDir: "",
  loginTimeoutMinutes: 10,
  signInFreshHours: 12,
  signInChecks: [],
  allowExternalRecipes: false,
  recipes: [],
  problems: [],
  ...over,
});

export const facade = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  recipeId: `${id}-recipe`,
  connectionId: id,
  available: true,
  reason: null,
  recipeStatus: "ok",
  host: `${id}.example`,
  connected: false,
  needsProject: false,
  inputs: [],
  timeoutMinutes: 10,
  methods: [{ id: "email", label: null, labelEn: null }],
  promise: null,
  ...over,
});

export const runState = (over: Record<string, unknown> = {}) => ({ secretId: "", providerId: "p", status: "running", text: "Working", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over });

/** Never expires within sight: used where the expiry level must stay quiet. */
export const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
