import { describe, expect, it } from "vitest";
import { createDemoFetch } from "../src/server/demo.js";
import { blobSha } from "../src/server/demo-github-repos.js";

const FILE_TEXT = "version: 1\nsecrets: []\nvariables: []\n";
const make = async (teamFile: (() => string) | null = () => FILE_TEXT) => {
  const demo = await createDemoFetch(teamFile ? { teamFile } : {});
  const gh = (path: string, init?: RequestInit & { json?: unknown }) => demo(`https://api.github.com${path}`, init?.json === undefined ? init : { ...init, body: JSON.stringify(init.json) });
  return { gh, demo };
};
const bodyOf = async (res: Response) => (await res.json()) as Record<string, any>;
const TEAM = "/repos/acme/team-config";

describe("demo GitHub: repositories of the user", () => {
  it("lists private and public repositories, the team repository most recent", async () => {
    const { gh } = await make();
    const res = await gh("/user/repos?per_page=100&sort=pushed&page=1");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string; private: boolean; owner: { login: string }; default_branch: string }[];
    expect(list[0]).toMatchObject({ name: "team-config", private: true, owner: { login: "acme" }, default_branch: "main" });
    expect(list.find((r) => r.name === "open-samples")?.private).toBe(false);
    expect(list.filter((r) => r.private)).toHaveLength(6);
  });

  it("answers repository metadata with push permission, and 404 for an unknown repository", async () => {
    const { gh } = await make();
    expect(await bodyOf(await gh(TEAM))).toMatchObject({ private: true, default_branch: "main", permissions: { push: true } });
    expect((await bodyOf(await gh("/repos/acme/open-samples"))).private).toBe(false);
    expect((await gh("/repos/acme/unknown")).status).toBe(404);
    expect((await gh("/repos/acme/unknown/branches")).status).toBe(404);
  });
});

describe("demo GitHub: branches, refs and tree", () => {
  it("lists branches and reads a ref", async () => {
    const { gh } = await make();
    expect(await (await gh(`${TEAM}/branches?per_page=100&page=1`)).json()).toEqual([{ name: "main" }]);
    const ref = await bodyOf(await gh(`${TEAM}/git/ref/heads/main`));
    expect(ref["object"].sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await gh(`${TEAM}/git/ref/heads/nope`)).status).toBe(404);
  });

  it("creates a branch from a commit, refuses duplicates and unknown commits, and deletes branches", async () => {
    const { gh } = await make();
    const sha = (await bodyOf(await gh(`${TEAM}/git/ref/heads/main`)))["object"].sha as string;
    expect((await gh(`${TEAM}/git/refs`, { method: "POST", json: { ref: "refs/heads/feature/x", sha } })).status).toBe(201);
    expect((await gh(`${TEAM}/git/refs`, { method: "POST", json: { ref: "refs/heads/feature/x", sha } })).status).toBe(422);
    expect((await gh(`${TEAM}/git/refs`, { method: "POST", json: { ref: "refs/heads/other", sha: "f".repeat(40) } })).status).toBe(422);
    expect((await gh(`${TEAM}/git/refs`, { method: "POST", json: {} })).status).toBe(422);
    expect((await bodyOf(await gh(`${TEAM}/git/ref/heads/feature/x`)))["object"].sha).toBe(sha);
    expect((await gh(`${TEAM}/git/refs/heads/feature/x`, { method: "DELETE" })).status).toBe(204);
    expect((await gh(`${TEAM}/git/refs/heads/feature/x`, { method: "DELETE" })).status).toBe(404);
    expect((await gh(`${TEAM}/git/refs/heads/main`, { method: "DELETE" })).status).toBe(422);
  });

  it("lists the files of a commit as a tree and answers 404 for an unknown commit", async () => {
    const { gh } = await make();
    const sha = (await bodyOf(await gh(`${TEAM}/git/ref/heads/main`)))["object"].sha as string;
    const tree = await bodyOf(await gh(`${TEAM}/git/trees/${sha}?recursive=1`));
    expect(tree["truncated"]).toBe(false);
    expect((tree["tree"] as { path: string; type: string }[]).map((e) => `${e.type} ${e.path}`)).toEqual(["blob README.md", "blob secret-desk.team.yaml"]);
    expect((await gh(`${TEAM}/git/trees/${"a".repeat(40)}?recursive=1`)).status).toBe(404);
  });

  it("has no team file when none is supplied", async () => {
    const { gh } = await make(null);
    const sha = (await bodyOf(await gh(`${TEAM}/git/ref/heads/main`)))["object"].sha as string;
    const tree = await bodyOf(await gh(`${TEAM}/git/trees/${sha}`));
    expect((tree["tree"] as { path: string }[]).map((e) => e.path)).toEqual(["README.md"]);
    expect((await gh(`${TEAM}/contents/secret-desk.team.yaml?ref=main`)).status).toBe(404);
  });

  it("reads the team file only once, from the supplied function", async () => {
    let calls = 0;
    const { gh } = await make(() => { calls += 1; return FILE_TEXT; });
    await gh("/user/repos");
    await gh(`${TEAM}/branches`);
    expect(calls).toBe(1);
  });
});

describe("demo GitHub: contents", () => {
  it("serves a file with its blob sha and 404 for a missing file or branch", async () => {
    const { gh } = await make();
    const file = await bodyOf(await gh(`${TEAM}/contents/secret-desk.team.yaml?ref=main`));
    expect(file).toMatchObject({ type: "file", sha: blobSha(FILE_TEXT) });
    expect(Buffer.from(file["content"], "base64").toString("utf8")).toBe(FILE_TEXT);
    expect((await bodyOf(await gh(`${TEAM}/contents/secret-desk.team.yaml`)))["sha"]).toBe(blobSha(FILE_TEXT));
    expect((await gh(`${TEAM}/contents/missing.yaml?ref=main`)).status).toBe(404);
    expect((await gh(`${TEAM}/contents/secret-desk.team.yaml?ref=gone`)).status).toBe(404);
  });

  it("creates and replaces a file, with the checks GitHub makes", async () => {
    const { gh } = await make();
    const put = (json: unknown) => gh(`${TEAM}/contents/secret-desk.team.yaml`, { method: "PUT", json });
    const content = Buffer.from("version: 1\n").toString("base64");
    expect((await put({ message: "m", content, branch: "gone" })).status).toBe(404);
    expect((await put({ message: "m", content, branch: "main" })).status).toBe(422);
    expect((await put({ message: "m", content, branch: "main", sha: "0".repeat(40) })).status).toBe(409);
    const ok = await put({ message: "m", content, branch: "main", sha: blobSha(FILE_TEXT) });
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok))["content"].sha).toBe(blobSha("version: 1\n"));
    const created = await gh(`${TEAM}/contents/docs/new.yaml`, { method: "PUT", json: { message: "m", content } });
    expect(created.status).toBe(201);
    expect((await bodyOf(await gh(`${TEAM}/contents/docs/new.yaml?ref=main`)))["sha"]).toBe(blobSha("version: 1\n"));
    expect((await gh(`${TEAM}/contents/docs/new.yaml`, { method: "DELETE" })).status).toBe(404);
    expect((await gh(`${TEAM}/contents/docs/empty.yaml`, { method: "PUT", json: { branch: "main" } })).status).toBe(201);
    expect((await bodyOf(await gh(`${TEAM}/contents/docs/empty.yaml`)))["content"]).toBe("");
  });
});

describe("demo GitHub: pull requests", () => {
  it("opens, finds and updates a pull request with a made-up URL under acme/team-config", async () => {
    const { gh } = await make();
    const sha = (await bodyOf(await gh(`${TEAM}/git/ref/heads/main`)))["object"].sha as string;
    await gh(`${TEAM}/git/refs`, { method: "POST", json: { ref: "refs/heads/secret-desk/team-sync", sha } });
    const find = async (head = "acme:secret-desk/team-sync", base = "main") => (await (await gh(`${TEAM}/pulls?state=open&head=${encodeURIComponent(head)}&base=${base}`)).json()) as { number: number; html_url: string }[];
    expect(await find()).toEqual([]);
    const created = await gh(`${TEAM}/pulls`, { method: "POST", json: { title: "Update", head: "secret-desk/team-sync", base: "main", body: "x" } });
    expect(created.status).toBe(201);
    const pull = await bodyOf(created);
    expect(pull["html_url"]).toBe(`https://github.com/acme/team-config/pull/${pull["number"]}`);
    expect(await find()).toHaveLength(1);
    expect(await find("acme:other")).toEqual([]);
    expect(await find("acme:secret-desk/team-sync", "develop")).toEqual([]);
    expect((await (await gh(`${TEAM}/pulls?state=open&head=${encodeURIComponent("acme:secret-desk/team-sync")}`)).json()) as unknown[]).toHaveLength(1);
    expect((await gh(`${TEAM}/pulls`, { method: "POST", json: { title: "t", head: "none", base: "main" } })).status).toBe(422);
    expect((await gh(`${TEAM}/pulls`, { method: "POST", json: {} })).status).toBe(422);
    expect((await gh(`${TEAM}/pulls`, { method: "POST", json: { head: "main", base: "main" } })).status).toBe(201);
    expect(await (await gh(`${TEAM}/pulls?state=open`)).json()).toEqual([]);
    expect((await bodyOf(await gh(`${TEAM}/pulls/${pull["number"]}`, { method: "PATCH", json: { title: "Renamed", body: "y" } })))["title"]).toBe("Renamed");
    expect((await bodyOf(await gh(`${TEAM}/pulls/${pull["number"]}`, { method: "PATCH", json: {} })))["title"]).toBe("Renamed");
    expect((await gh(`${TEAM}/pulls/999`, { method: "PATCH", json: {} })).status).toBe(404);
  });

  it("does not simulate other methods and paths of a repository", async () => {
    const { gh } = await make();
    expect((await gh(`${TEAM}/issues`)).status).toBe(404);
    expect((await gh(`${TEAM}/contents/x.yaml`, { method: "POST" })).status).toBe(404);
  });
});
