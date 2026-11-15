import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, type Provider } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { nodeRuntimeHost } from "../src/host.js";
import { createRuntime } from "../src/runtime.js";

// An export that fails after an in-place provider replaced the value loses the new value. The gate revokes nothing, the error says so,
// and the evidence carries the warning too. Everything here is made up.
const INVENTORY = `version: 1
secrets:
  - { id: dev-first, name: DEV_FIRST, stage: dev, service: x, provider: made-up-issuer, expiry: none, externalId: same-id, places: [{ repo: acme-issue, scope: repository }] }
  - { id: dev-second, name: DEV_SECOND, stage: dev, service: x, provider: made-up-issuer, expiry: none, places: [{ repo: acme-issue, scope: repository }] }
envTemplates:
  - id: issue-dev
    repo: acme-issue
    stage: dev
    file: .env.local
    entries:
      - { key: FIRST, from: { type: issue, secret: dev-first } }
      - { key: SECOND, from: { type: issue, secret: dev-second } }
`;

describe("exportEnv: a failed export after an in-place issue", () => {
  it("revokes nothing and leaves the warning in the evidence of the secret", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-export-evidence-")));
    const projects = join(dir, "projects");
    await mkdir(projects);
    await writeFile(join(dir, "inventory.yaml"), INVENTORY);
    await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: {} }));
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
    const host = nodeRuntimeHost({ env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv });
    const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, host, bundledRecipes: null, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    const revoke = vi.fn(async () => undefined);
    const issue = vi
      .fn()
      .mockResolvedValueOnce({ value: SecretValue.from("made_up_first_value"), externalId: "same-id", replacedInPlace: true })
      .mockRejectedValueOnce(new Error("provider down"));
    rt.providers.register({ id: "made-up-issuer", label: "Made up issuer", kind: "automatic", issue, revoke } as Provider);

    const err = await exportEnv(rt, { kind: "human", name: "alice" }, { repo: "acme-issue", path: join(projects, ".env.local") }).catch((e: Error) => e);
    expect((err as Error).message).toContain("provider down");
    expect(revoke).not.toHaveBeenCalled();

    const reports = await rt.evidence.list("dev-first");
    expect(reports).toHaveLength(1);
    const report = await rt.evidence.get("dev-first", reports[0]!.id);
    expect(report?.checks.map((c) => c.id)).toEqual(["in-place-value-lost"]);
    expect(report?.externalId).toBe("same-id");
    expect(await rt.evidence.list("dev-second")).toEqual([]);
  });
});
