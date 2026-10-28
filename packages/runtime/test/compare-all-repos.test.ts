import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareStages } from "../src/compare.js";
import { listRepos, renameInventoryRepo, setLink } from "../src/repos.js";
import { createRuntime } from "../src/runtime.js";

const INVENTORY = `version: 1
secrets:
  - { id: k-stg, name: API_KEY, stage: staging, service: x, expiry: none, places: [{ repo: web, scope: environment }] }
  - { id: lf, name: LEITFADEN_KEY, stage: shared, service: x, expiry: none, places: [{ repo: leitfaden, scope: repository }] }
variables: []
`;

type Reply = number | object | string | Response | ((url: string) => Response);
interface Spec {
  [path: string]: Reply;
}

const DEPLOY = `
on: push
jobs:
  prod:
    environment: production
    runs-on: x
    steps:
      - run: node scripts/secrets.mjs
      - run: echo \${{ secrets.RESEND_API_KEY }} \${{ secrets.TURNSTILE_SECRET_KEY }}
  stg:
    environment: staging
    runs-on: x
    steps:
      - run: echo \${{ vars.NEXT_PUBLIC_APP_URL }}
`;

async function setup(spec: Spec, opts: { projects?: boolean } = {}) {
  const calls: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const path = u.split("?")[0]!;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 2));
    inflight -= 1;
    const r = spec[path];
    if (r instanceof Response) return r.clone();
    if (typeof r === "function") return r(u);
    if (typeof r === "number") return new Response(JSON.stringify({ message: "denied" }), { status: r });
    if (typeof r === "string") return new Response(r, { status: 200 });
    if (r === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-cmp-all-")));
  const projects = join(dir, "projekte");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock, bundledRecipes: null });
  return { rt, calls, projects, dir, max: () => maxInflight };
}
const sec = (...n: string[]) => ({ secrets: n.map((name) => ({ name, created_at: "c", updated_at: "u" })) });
const vr = (o: Record<string, string>) => ({ variables: Object.entries(o).map(([name, value]) => ({ name, value, created_at: "c", updated_at: "u" })) });
const repo = (name: string, over: Record<string, unknown> = {}) => ({ name, private: true, archived: false, default_branch: "main", pushed_at: "2026-10-20T00:00:00Z", ...over });
const dirEntry = (name: string) => ({ name, type: "file", size: 100 });

const base: Spec = {
  "/orgs/acme/repos": [repo("web"), repo("night-before"), repo("costs"), repo("old", { archived: true }), repo(".github"), repo(".github-private"), repo("status")],
  "/repos/acme/web/environments": { environments: [{ name: "staging" }] },
  "/repos/acme/web/environments/staging/secrets": sec("API_KEY"),
  "/repos/acme/web/environments/staging/variables": vr({}),
  "/repos/acme/web/environments/production/secrets": sec(),
  "/repos/acme/web/environments/production/variables": vr({}),
  "/repos/acme/web/actions/secrets": sec(),
  "/repos/acme/web/actions/variables": vr({}),
  "/repos/acme/night-before/environments": { environments: [{ name: "staging" }, { name: "preview" }] },
  "/repos/acme/night-before/environments/staging/secrets": sec("RESEND_API_KEY"),
  "/repos/acme/night-before/environments/staging/variables": vr({}),
  "/repos/acme/night-before/environments/preview/secrets": sec("PREVIEW_ONLY"),
  "/repos/acme/night-before/environments/preview/variables": vr({}),
  "/repos/acme/night-before/actions/secrets": sec("CLOUDFLARE_API_TOKEN"),
  "/repos/acme/night-before/actions/variables": vr({ SITE: "x" }),
  "/repos/acme/costs/environments": { environments: [] },
  "/repos/acme/costs/actions/secrets": sec(),
  "/repos/acme/costs/actions/variables": vr({}),
  "/repos/acme/status/environments": 403,
  "/repos/acme/status/actions/secrets": 403,
  "/repos/acme/status/actions/variables": vr({}),
  "/orgs/acme/actions/secrets": sec(),
  "/orgs/acme/actions/variables": vr({}),
};

describe("compareStages mit allRepos", () => {
  it("liest Repositories ohne Inventar: Funde sind unexpected, leere Repos stehen in der Liste", async () => {
    const { rt, calls } = await setup(base);
    const r = await compareStages(rt, { live: true, allRepos: true });
    const nb = r.rows.filter((x) => x.repo === "night-before").map((x) => `${x.kind}:${x.name}`).sort();
    expect(nb).toEqual(["secret:CLOUDFLARE_API_TOKEN", "secret:PREVIEW_ONLY", "secret:RESEND_API_KEY", "variable:SITE"]);
    expect(r.rows.find((x) => x.name === "RESEND_API_KEY")!.cells.staging!.state).toBe("unexpected");
    expect(r.rows.find((x) => x.name === "PREVIEW_ONLY")!.other).toEqual({ present: ["preview"], needed: [] });
    expect(r.repos.map((x) => x.name)).toEqual(["costs", "leitfaden", "night-before", "status", "web"]);
    expect(r.repos.find((x) => x.name === "costs")).toMatchObject({ inInventory: false, found: { secrets: 0, variables: 0 }, private: true });
    // 403 je Repo wird zum Hinweis, nicht zum Gesamtfehler
    expect(r.errors).toEqual([]);
    expect(r.repos.find((x) => x.name === "status")!.notes.map((n) => n.code).sort()).toEqual(["environments-unreadable", "read-error"]);
    // archivierte und .github-Repos werden nie angefasst
    expect(calls.some((c) => /\/repos\/acme\/(old|\.github|\.github-private)\b/.test(c))).toBe(false);
    // nur lesen
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("begrenzt Aufrufe: hoechstens vier gleichzeitig, je Repo Repo-Ebene plus Environments", async () => {
    const { rt, calls, max } = await setup(base);
    await compareStages(rt, { live: true, allRepos: true });
    expect(max()).toBeLessThanOrEqual(4);
    const nb = calls.filter((c) => c.includes("/repos/acme/night-before"));
    // 1 Environments-Liste + 2 Arten x (Repo-Ebene + 2 Environments)
    expect(nb).toHaveLength(1 + 2 * 3);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("ohne allRepos oder ohne live: keine Repo-Liste, nur Inventar-Repos", async () => {
    const a = await setup(base);
    const r = await compareStages(a.rt, { live: true });
    expect(a.calls.some((c) => c.includes("/orgs/acme/repos"))).toBe(false);
    expect(r.repos.map((x) => x.name)).toEqual(["leitfaden", "web"]);
    const b = await setup(base);
    await compareStages(b.rt, { allRepos: true });
    expect(b.calls).toEqual([]);
  });

  it("Repo-Liste nicht lesbar: Fehler als Hinweis, Inventar-Vergleich bleibt", async () => {
    const { rt } = await setup({ ...base, "/orgs/acme/repos": 500, "/users/acme/repos": 500 });
    const r = await compareStages(rt, { live: true, allRepos: true });
    expect(r.errors.some((e) => e.target === "repositories")).toBe(true);
    expect(r.rows.find((x) => x.name === "API_KEY")).toBeTruthy();
  });

  it("repo-Filter beschraenkt auch die Zusatz-Repositories", async () => {
    const { rt, calls } = await setup(base);
    const r = await compareStages(rt, { live: true, allRepos: true, repo: "costs" });
    expect(r.repos.map((x) => x.name)).toEqual(["costs"]);
    expect(calls.some((c) => c.includes("/repos/acme/night-before"))).toBe(false);
  });
});

describe("compareStages mit workflows", () => {
  const wfSpec: Spec = {
    ...base,
    "/repos/acme/night-before/contents/.github/workflows": [dirEntry("deploy.yml"), dirEntry("README.md")],
    "/repos/acme/night-before/contents/.github/workflows/deploy.yml": DEPLOY,
    "/repos/acme/web/contents/.github/workflows": 403,
    "/repos/acme/costs/contents/.github/workflows": 404,
    "/repos/acme/status/contents/.github/workflows": 403,
  };

  it("Contents-API: needed-Zeilen, Hinweis bei 403, 404 = keine Workflows", async () => {
    const { rt, calls } = await setup(wfSpec);
    const r = await compareStages(rt, { live: true, allRepos: true, workflows: true });
    const row = (n: string) => r.rows.find((x) => x.repo === "night-before" && x.name === n)!;
    // production existiert in night-before nicht -> RESEND/TURNSTILE fehlen dort, staging hat RESEND
    expect(row("RESEND_API_KEY").cells.production).toMatchObject({ state: "needed", detail: { neededBy: ["deploy.yml"] } });
    expect(row("RESEND_API_KEY").cells.staging!.state).toBe("unexpected");
    expect(row("TURNSTILE_SECRET_KEY").cells.production!.state).toBe("needed");
    expect(row("NEXT_PUBLIC_APP_URL").kind).toBe("variable");
    expect(row("NEXT_PUBLIC_APP_URL").cells.staging!.state).toBe("needed");
    expect(row("RESEND_API_KEY").needs).toEqual([{ file: "deploy.yml", environment: "production" }]);
    expect(r.summary.neededMissing).toBe(3);
    expect(r.repos.find((x) => x.name === "night-before")!.needed).toBe(3);
    // web: 403 auf Contents -> Hinweis, kein Gesamtfehler
    expect(r.repos.find((x) => x.name === "web")!.notes).toEqual([{ code: "contents-forbidden", status: 403 }]);
    expect(r.repos.find((x) => x.name === "costs")!.notes).toEqual([]);
    expect(r.errors).toEqual([]);
    // README.md wird nicht gelesen
    expect(calls.some((c) => c.endsWith("README.md"))).toBe(false);
  });

  it("lokal verknuepfter Ordner hat Vorrang, die Contents-API wird nicht gefragt", async () => {
    const { rt, calls, projects } = await setup(wfSpec);
    const dir = join(projects, "night-before");
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "local.yml"), "on: push\njobs:\n  j:\n    runs-on: x\n    environment: staging\n    steps:\n      - run: echo ${{ secrets.LOCAL_ONLY_KEY }}\n");
    await setLink(rt, "night-before", dir);
    const r = await compareStages(rt, { live: true, allRepos: true, workflows: true });
    const names = r.rows.filter((x) => x.repo === "night-before" && x.needs).map((x) => x.name);
    expect(names).toEqual(["LOCAL_ONLY_KEY"]);
    expect(calls.some((c) => c.includes("/repos/acme/night-before/contents"))).toBe(false);
  });

  it("ohne live: nur lokale Ordner, kein Netz", async () => {
    const { rt, calls, projects } = await setup(wfSpec);
    const dir = join(projects, "web");
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "ci.yml"), "on: push\njobs:\n  j:\n    runs-on: x\n    environment: staging\n    steps:\n      - run: echo ${{ secrets.FRESH_KEY }}\n");
    await setLink(rt, "web", dir);
    const r = await compareStages(rt, { workflows: true });
    expect(calls).toEqual([]);
    expect(r.rows.find((x) => x.name === "FRESH_KEY")!.cells.staging!.state).toBe("needed");
  });

  it("Organisations-Secrets decken Workflow-Bedarf", async () => {
    const { rt } = await setup({ ...wfSpec, "/orgs/acme/actions/secrets": sec("TURNSTILE_SECRET_KEY") });
    const r = await compareStages(rt, { live: true, allRepos: true, workflows: true });
    const t = r.rows.find((x) => x.repo === "night-before" && x.name === "TURNSTILE_SECRET_KEY")!;
    expect(t.cells.production!.state).toBe("not-expected");
    expect(t.neededMissing).toBe(false);
  });
});

describe("compareStages mit ignoreRepos", () => {
  const spec: Spec = {
    ...base,
    "/repos/acme/status/contents/.github/workflows": [dirEntry("up.yml")],
    "/repos/acme/status/contents/.github/workflows/up.yml": "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.UPTIME_TOKEN }}\n",
    "/repos/acme/leitfaden/environments": { environments: [] },
    "/repos/acme/leitfaden/actions/secrets": sec(),
    "/repos/acme/leitfaden/actions/variables": vr({}),
    "/repos/acme/leitfaden/contents/.github/workflows": 404,
    "/repos/acme/web/contents/.github/workflows": 404,
    "/repos/acme/night-before/contents/.github/workflows": 404,
    "/repos/acme/costs/contents/.github/workflows": 404,
  };

  it("Standard aus der Konfiguration: .github und .github-private, status bleibt sichtbar", async () => {
    const { rt, calls } = await setup(spec);
    expect(rt.config.compare.ignoreRepos).toEqual([".github", ".github-private"]);
    const r = await compareStages(rt, { live: true, allRepos: true, workflows: true });
    expect(r.ignored).toEqual([".github", ".github-private"]);
    expect(r.rows.some((x) => x.name === "UPTIME_TOKEN")).toBe(true);
    expect(calls.some((c) => /\/repos\/acme\/\.github/.test(c))).toBe(false);
  });

  it("ignorierte Repositories (auch aus dem Inventar) lesen weder GitHub noch Workflows und erscheinen nur in der Liste", async () => {
    const { rt, calls } = await setup(spec);
    const r = await compareStages(rt, { live: true, allRepos: true, workflows: true, ignoreRepos: ["status", "leitfaden", ".github", ".github-private"] });
    expect(r.ignored).toEqual([".github", ".github-private", "leitfaden", "status"]);
    expect(r.rows.some((x) => x.repo === "status" || x.repo === "leitfaden")).toBe(false);
    expect(r.repos.map((x) => x.name)).toEqual(["costs", "night-before", "web"]);
    expect(calls.filter((c) => c.includes("/repos/acme/status") || c.includes("/repos/acme/leitfaden"))).toEqual([]);
    // nicht ignorierte Repos werden weiter gelesen
    expect(calls.some((c) => c.includes("/repos/acme/night-before/environments"))).toBe(true);
  });
});

describe("umbenannte Repositories", () => {
  const renamed = (u: string) => (u.endsWith("/repos/acme/leitfaden") ? new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/9" } }) : new Response(JSON.stringify({ name: "night-before", full_name: "acme/night-before" }), { status: 200 }));
  const spec: Spec = { ...base, "/repos/acme/leitfaden": renamed, "/repositories/9": renamed };

  it("compareStages: Inventar-Repo fehlt in der Liste, 301 liefert den neuen Namen", async () => {
    const { rt } = await setup(spec);
    const r = await compareStages(rt, { live: true, allRepos: true });
    expect(r.repos.find((x) => x.name === "leitfaden")).toMatchObject({ inInventory: true, onGitHub: false, renamedTo: "night-before" });
  });

  it("Repositories-Liste: renamedTo, nicht aufloesbare bleiben ohne", async () => {
    const { rt } = await setup({ ...spec, "/repos/acme/leitfaden": 404 });
    const none = await listRepos(rt, { live: true });
    expect(none.repos.find((x) => x.name === "leitfaden")!.renamedTo).toBeUndefined();
    const { rt: rt2 } = await setup(spec);
    const list = await listRepos(rt2, { live: true });
    expect(list.repos.find((x) => x.name === "leitfaden")).toMatchObject({ inInventory: true, renamedTo: "night-before" });
    expect(list.repos.find((x) => x.name === "web")!.renamedTo).toBeUndefined();
  });

  it("renameInventoryRepo: Inventar wird angepasst und gespeichert, Verknuepfung zieht mit", async () => {
    const { rt, projects, dir } = await setup(spec);
    const folder = join(projects, "lf");
    await mkdir(join(folder, ".git"), { recursive: true });
    await setLink(rt, "leitfaden", folder);
    const res = await renameInventoryRepo(rt, "leitfaden", "night-before");
    expect(res).toMatchObject({ from: "leitfaden", to: "night-before", changed: 1, linkMoved: true });
    expect(rt.inventory.data.secrets.find((s) => s.id === "lf")!.places[0]!.repo).toBe("night-before");
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("night-before");
    expect(JSON.parse(await readFile(join(dir, "links.json"), "utf8")).links).toHaveProperty("night-before");
    await expect(renameInventoryRepo(rt, "leitfaden", "x")).rejects.toThrow(/nicht vor/);
    await expect(renameInventoryRepo(rt, "web", "WEB")).rejects.toThrow(/gleich/);
    await expect(renameInventoryRepo(rt, "web", "a/b")).rejects.toThrow(/ungueltig/);
  });
});
