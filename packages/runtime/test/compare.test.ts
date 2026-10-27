import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareStages } from "../src/compare.js";
import { createRuntime } from "../src/runtime.js";

const INVENTORY = `version: 1
secrets:
  - { id: k-stg, name: API_KEY, stage: staging, service: x, expiry: none, places: [{ repo: web, scope: environment }] }
  - { id: k-prod, name: API_KEY, stage: production, service: x, expiry: none, places: [{ repo: web, scope: environment }] }
  - { id: only-stg, name: DEBUG_KEY, stage: staging, service: x, expiry: none, places: [{ repo: web, scope: environment }] }
  - { id: cf, name: CF_TOKEN, stage: shared, service: x, expiry: none, places: [{ repo: web, scope: repository }] }
variables:
  - { id: v-stg, name: SITE_URL, stage: staging, value: "https://s.example.com", places: [{ repo: web, scope: environment }] }
  - { id: v-prod, name: SITE_URL, stage: production, value: "https://example.com", places: [{ repo: web, scope: environment }] }
`;

interface Spec {
  /** Pfad -> Antwort; fehlt der Pfad, gibt es 404. Zahl = HTTP-Status, Objekt = JSON-Body. */
  [path: string]: number | object;
}

async function setup(spec: Spec) {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "").split("?")[0]!;
    calls.push(`${init?.method ?? "GET"} ${u}`);
    const r = spec[u];
    if (typeof r === "number") return new Response(JSON.stringify({ message: "denied" }), { status: r });
    if (r === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-cmp-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock, bundledRecipes: null });
  const bare = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: {}, fetch: fetchMock, bundledRecipes: null });
  return { rt, bare, calls };
}
const sec = (...n: string[]) => ({ secrets: n.map((name) => ({ name, created_at: "c", updated_at: "u" })) });
const vr = (o: Record<string, string>) => ({ variables: Object.entries(o).map(([name, value]) => ({ name, value, created_at: "c", updated_at: "u" })) });
const S = "/repos/acme/web/environments";
const full: Spec = {
  [`${S}/staging/secrets`]: sec("API_KEY", "DEBUG_KEY", "STRAY"),
  [`${S}/production/secrets`]: sec("API_KEY"),
  "/repos/acme/web/actions/secrets": sec("CF_TOKEN"),
  [`${S}/staging/variables`]: vr({ SITE_URL: "https://s.example.com" }),
  [`${S}/production/variables`]: vr({ SITE_URL: "https://x.example.com" }),
  "/repos/acme/web/actions/variables": vr({}),
};

describe("compareStages", () => {
  it("ohne live: kein Netz, nur Erwartung", async () => {
    const { rt, calls } = await setup(full);
    const r = await compareStages(rt);
    expect(calls).toEqual([]);
    expect(r.live).toBe(false);
    expect(r.rows.find((x) => x.name === "API_KEY")!.cells.staging!.state).toBe("unknown");
  });

  it("mit live: ok, Luecke, different, Waisen; jedes Ziel einmal gelesen", async () => {
    const { rt, calls } = await setup(full);
    const r = await compareStages(rt, { live: true });
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    const row = (n: string, kind = "secret") => r.rows.find((x) => x.name === n && x.kind === kind)!;
    expect(row("API_KEY").parity).toBe("consistent");
    expect(row("DEBUG_KEY")).toMatchObject({ parity: "gap", missingIn: ["production"] });
    expect(row("SITE_URL", "variable").cells.production!.state).toBe("different");
    expect(row("STRAY").cells.staging!.state).toBe("unexpected");
    expect(r.summary.orphans).toBe(1);
    expect(r.summary.gaps).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it("eine Environment 403: error-Zellen, der Rest bleibt", async () => {
    const { rt } = await setup({ ...full, [`${S}/production/secrets`]: 403 });
    const r = await compareStages(rt, { live: true });
    const api = r.rows.find((x) => x.name === "API_KEY")!;
    expect(api.cells.production).toMatchObject({ state: "error", expected: true });
    expect(api.cells.production!.detail?.error?.status).toBe(403);
    expect(api.cells.staging!.state).toBe("ok");
    expect(r.rows.find((x) => x.name === "SITE_URL")!.cells.production!.state).toBe("different");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.target).toContain("production");
    expect(r.summary.perStage.production!.error).toBeGreaterThan(0);
  });

  it("Environment fehlt in GitHub (404): missing statt Fehler", async () => {
    const { [`${S}/production/secrets`]: _absent, ...spec } = full;
    const { rt } = await setup(spec);
    const r = await compareStages(rt, { live: true, kinds: ["secret"] });
    const c = r.rows.find((x) => x.name === "API_KEY")!.cells.production!;
    expect(c.state).toBe("missing");
    expect(c.detail?.notFound).toEqual(["web/env:production"]);
    expect(r.errors).toEqual([]);
  });

  it("kinds und repo begrenzen die Aufrufe", async () => {
    const a = await setup(full);
    await compareStages(a.rt, { live: true, kinds: ["variable"] });
    expect(a.calls.every((c) => c.endsWith("/variables"))).toBe(true);
    expect(a.calls).toHaveLength(3);
    const b = await setup(full);
    await compareStages(b.rt, { live: true, repo: "gibt-es-nicht" });
    expect(b.calls).toEqual([]);
  });

  it("liefert nie einen Wert eines Secrets, Variablenwerte nur als Vergleich", async () => {
    const { rt } = await setup({ ...full, [`${S}/staging/secrets`]: { secrets: [{ name: "API_KEY", created_at: "c", updated_at: "u", value: "TOPSECRET" }] } });
    const r = await compareStages(rt, { live: true });
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
    expect(JSON.stringify(r)).not.toContain("ghp_x");
  });

  it("nicht verbunden: ganzer Aufruf scheitert mit dem Hinweis", async () => {
    const { bare } = await setup(full);
    await expect(compareStages(bare, { live: true })).rejects.toThrow();
  });
});
