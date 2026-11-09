import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, InventoryError, NotConnectedError } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAbout } from "../src/about.js";
import { createRuntime } from "../src/runtime.js";
import { shortenHome } from "../src/settings.js";
import { SignInStore } from "../src/sign-in-store.js";
import { listStages, setStages } from "../src/stages.js";
import { sudoAnswerFrom } from "../src/sudo-answer.js";
import { readWorkflowFiles } from "../src/workflows.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAbout without an explicit env", () => {
  it("falls back to the process environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-about-env-"));
    vi.stubEnv("SECRET_DESK_COMMIT", "0123456789abcdef0123");
    try {
      const a = readAbout({ rootDir: dir, thirdPartyFile: join(dir, "missing.json") });
      expect(a.commit).toBe("0123456789ab");
      expect(a.version).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("shortenHome with a root home directory", () => {
  it("does not build a home pattern when the home directory is just a slash", () => {
    vi.stubEnv("HOME", "/");
    try {
      expect(shortenHome("/opt/data/file")).toBe("/opt/data/file");
      expect(shortenHome("/home/anna/x")).toBe("~/x");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sign-in store: records read from a file", () => {
  it("a record without a known source counts as a check; invalid lifetime samples are dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-signin-gap-"));
    const file = join(dir, "state.json");
    const t = "2026-11-01T00:00:00.000Z";
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        hosts: {
          "a.example.test": {
            signedIn: false,
            checkedAt: t,
            source: "somewhere-else",
            lifetimes: [null, { minutes: -5, measuredAt: t }, { minutes: "x", measuredAt: t }, { minutes: 10.4, measuredAt: "garbage" }, { minutes: 90.6, measuredAt: t }],
          },
        },
      }),
    );
    const s = new SignInStore(file);
    await s.load();
    expect(s.checks()).toEqual([{ host: "a.example.test", signedIn: false, checkedAt: t, source: "check" }]);
    expect(s.lifetimes()).toEqual([{ host: "a.example.test", averageMinutes: 91, samples: 1, measuredAt: t }]);
  });
});

describe("sudoAnswerFrom", () => {
  it("accepts the three methods and wipes typed values from the body", () => {
    expect(sudoAnswerFrom({ method: "mobile" }, ["mobile"])).toEqual({ method: "mobile" });
    const codeBody: Record<string, unknown> = { method: "code", code: " 12 34 56 " };
    expect(sudoAnswerFrom(codeBody, ["code"])).toEqual({ method: "code", code: "123456" });
    expect(codeBody["code"]).toBe("");
    const pwBody: Record<string, unknown> = { method: "password", password: "made-up pass" };
    expect(sudoAnswerFrom(pwBody, ["password"])).toEqual({ method: "password", password: "made-up pass" });
    expect(pwBody["password"]).toBe("");
  });

  it("rejects a missing or malformed code and password", () => {
    expect(() => sudoAnswerFrom({ method: "code" }, ["code"])).toThrow(/code is not valid/);
    expect(() => sudoAnswerFrom({ method: "code", code: 123456 }, ["code"])).toThrow(/code is not valid/);
    expect(() => sudoAnswerFrom({ method: "code", code: "ab" }, ["code"])).toThrow(InventoryError);
    expect(() => sudoAnswerFrom({ method: "password" }, ["password"])).toThrow(/password is not valid/);
    expect(() => sudoAnswerFrom({ method: "password", password: 5 }, ["password"])).toThrow(/password is not valid/);
    expect(() => sudoAnswerFrom({ method: "password", password: "x".repeat(1025) }, ["password"])).toThrow(/password is not valid/);
    expect(() => sudoAnswerFrom({ method: "password", password: "a\u0000b" }, ["password"])).toThrow(/password is not valid/);
  });

  it("rejects an unknown method and a method the page does not offer", () => {
    expect(() => sudoAnswerFrom({ method: "carrier-pigeon" }, ["mobile"])).toThrow(/mobile, code or password/);
    expect(() => sudoAnswerFrom({}, ["mobile"])).toThrow(/mobile, code or password/);
    expect(() => sudoAnswerFrom({ method: "mobile" }, ["code"])).toThrow(/not offered/);
  });
});

async function runtimeIn(dir: string, extra = "") {
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${extra}`);
  return createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
}

describe("setStages validation", () => {
  it("reports schema problems with their path, and (root) for a non-list", async () => {
    const rt = await runtimeIn(await mkdtemp(join(tmpdir(), "sd-stages-gap-")));
    await expect(setStages(rt, [{ id: "Bad Id!", kind: "dev" }])).rejects.toThrow(/0\.id/);
    await expect(setStages(rt, "nope" as never)).rejects.toThrow(/\(Wurzel\)/);
  });

  it("reports duplicate ids and an empty list", async () => {
    const rt = await runtimeIn(await mkdtemp(join(tmpdir(), "sd-stages-gap-")));
    await expect(setStages(rt, [{ id: "dup", kind: "dev" }, { id: "dup", kind: "test" }])).rejects.toThrow(/doppelt: dup/);
    await expect(setStages(rt, [])).rejects.toThrow(/Mindestens eine Stage/);
  });

  it("counts variables and env templates as stage usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-stages-gap-"));
    await writeFile(join(dir, "inventory.yaml"), `version: 1
secrets: []
variables:
  - { id: v1, name: V_ONE, stage: shared, value: x, places: [{ repo: r, scope: repository }] }
envTemplates:
  - { id: t1, repo: r, stage: shared, entries: [{ key: V_ONE, from: { type: variable, variable: v1 } }] }
`);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
    const usage = listStages(rt).find((s) => s.id === "shared")?.usage;
    expect(usage).toMatchObject({ variables: 1, templates: 1 });
    await expect(setStages(rt, [{ id: "dev", kind: "dev" }])).rejects.toThrow(/1 Variablen, 1 Vorlagen/);
  });
});

describe("readWorkflowFiles", () => {
  async function linked(files: Record<string, string>, makeExtra?: (workflows: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "sd-wf-"));
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(dir);
    const projects = join(root, "projects");
    const repoDir = join(projects, "acme-app");
    const workflows = join(repoDir, ".github", "workflows");
    await mkdir(workflows, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(workflows, name), content);
    if (makeExtra) await makeExtra(workflows);
    await writeFile(join(root, "links.json"), JSON.stringify({ version: 1, links: { "acme-app": repoDir } }));
    const rt = await runtimeIn(root, `linksFile: ${JSON.stringify(join(root, "links.json"))}\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
    return { rt, root, workflows };
  }

  it("local: reads regular workflow files only, skips oversized files, links and directories", async () => {
    const { rt } = await linked({ "ci.yml": "name: ci\n", "big.yml": "x".repeat(512 * 1024 + 1), "notes.txt": "ignored" }, async (workflows) => {
      await mkdir(join(workflows, "dir.yml"));
      await symlink(join(workflows, "ci.yml"), join(workflows, "link.yml"));
    });
    const r = await readWorkflowFiles(rt, "acme-app", { github: false });
    expect(r.source).toBe("local");
    expect(r.files).toEqual([{ name: "ci.yml", content: "name: ci\n" }]);
  });

  it("local: a linked folder without a workflows directory yields no files", async () => {
    const { rt, workflows } = await linked({});
    const { rm } = await import("node:fs/promises");
    await rm(workflows, { recursive: true });
    expect(await readWorkflowFiles(rt, "acme-app", { github: false })).toEqual({ files: [], source: "local" });
  });

  it.skipIf(process.getuid?.() === 0)("local: a file that cannot be read is left out", async () => {
    const { rt, workflows } = await linked({ "a.yml": "a: 1\n", "b.yml": "b: 1\n" });
    const { chmod } = await import("node:fs/promises");
    await chmod(join(workflows, "a.yml"), 0o000);
    const r = await readWorkflowFiles(rt, "acme-app", { github: false });
    expect(r.files.map((f) => f.name)).toEqual(["b.yml"]);
  });

  it("without a link and without github: nothing", async () => {
    const rt = await runtimeIn(await mkdtemp(join(tmpdir(), "sd-wf-none-")));
    expect(await readWorkflowFiles(rt, "acme-app", { github: false })).toEqual({ files: [], source: "none" });
  });

  it("github: lists, filters by name and size, reads the content", async () => {
    const rt = await runtimeIn(await mkdtemp(join(tmpdir(), "sd-wf-gh-")));
    vi.spyOn(rt.github, "listWorkflowFiles").mockResolvedValue([{ name: "ci.yml", size: 10 }, { name: "README.md", size: 5 }, { name: "huge.yml", size: 600 * 1024 }]);
    const read = vi.spyOn(rt.github, "readTextFile").mockResolvedValue("name: ci\n");
    const r = await readWorkflowFiles(rt, "acme-app", { github: true });
    expect(r).toEqual({ files: [{ name: "ci.yml", content: "name: ci\n" }], source: "github" });
    expect(read).toHaveBeenCalledWith("acme", "acme-app", ".github/workflows/ci.yml");
  });

  it("github: not connected is rethrown; 401 and 403 become a forbidden note; other errors a generic note", async () => {
    const rt = await runtimeIn(await mkdtemp(join(tmpdir(), "sd-wf-gh-")));
    const list = vi.spyOn(rt.github, "listWorkflowFiles");
    list.mockRejectedValueOnce(new NotConnectedError("github", "Connect"));
    await expect(readWorkflowFiles(rt, "acme-app", { github: true })).rejects.toBeInstanceOf(NotConnectedError);
    list.mockRejectedValueOnce(new GitHubError(403, "forbidden"));
    expect((await readWorkflowFiles(rt, "acme-app", { github: true })).note).toEqual({ code: "contents-forbidden", status: 403 });
    list.mockRejectedValueOnce(new GitHubError(401, "bad credentials"));
    expect((await readWorkflowFiles(rt, "acme-app", { github: true })).note).toEqual({ code: "contents-forbidden", status: 401 });
    list.mockRejectedValueOnce(new GitHubError(500, "server broke"));
    expect((await readWorkflowFiles(rt, "acme-app", { github: true })).note).toEqual({ code: "contents-error", message: "server broke", status: 500 });
    list.mockRejectedValueOnce(new Error("socket closed"));
    expect((await readWorkflowFiles(rt, "acme-app", { github: true })).note).toEqual({ code: "contents-error", message: "socket closed" });
    list.mockRejectedValueOnce("just text");
    expect((await readWorkflowFiles(rt, "acme-app", { github: true })).note).toEqual({ code: "contents-error", message: "just text" });
  });
});
