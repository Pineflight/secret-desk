import { beforeAll, describe, expect, it } from "vitest";
import { createDemoFetch } from "../src/server/demo.js";

let demo: typeof fetch;
beforeAll(async () => {
  demo = await createDemoFetch();
});

const gh = (path: string, init?: RequestInit) => demo(`https://api.github.com${path}`, init);
const jsonOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("demo GitHub", () => {
  it("only simulates GitHub", async () => {
    const res = await demo("https://example.org/anything");
    expect(res.status).toBe(501);
    expect((await jsonOf(res))["message"]).toMatch(/only GitHub/);
  });

  it("lists the demo repositories of an organization", async () => {
    const repos = (await jsonOf(await gh("/orgs/acme/repos"))) as unknown as { name: string; private: boolean }[];
    expect(repos.map((r) => r.name)).toEqual(["acme-app", "acme-web", "acme-docs", "acme-lab", "acme-tools"]);
    expect(repos.every((r) => r.private)).toBe(true);
  });

  it("serves a public key and lists, creates and replaces secrets", async () => {
    const key = await jsonOf(await gh("/repos/acme/acme-app/actions/secrets/public-key"));
    expect(key["key_id"]).toBe("demo-key");
    const list = async () => ((await jsonOf(await gh("/repos/acme/acme-app/actions/secrets"))) as unknown as { total_count: number; secrets: { name: string }[] });
    expect((await list()).secrets.map((s) => s.name)).toEqual(["CLOUDFLARE_API_TOKEN", "VAPID_PRIVATE_KEY"]);
    expect((await gh("/repos/acme/acme-app/actions/secrets/NEW_ONE", { method: "PUT" })).status).toBe(201);
    expect((await gh("/repos/acme/acme-app/actions/secrets/NEW_ONE", { method: "PUT" })).status).toBe(204);
    expect((await list()).total_count).toBe(3);
    expect((await gh("/repos/acme/brand-new/actions/secrets/FIRST", { method: "PUT" })).status).toBe(201);
    expect((await jsonOf(await gh("/repos/acme/brand-new/actions/secrets"))) as unknown as { total_count: number }).toMatchObject({ total_count: 1 });
  });

  it("answers 404 for a secret or variable list that does not exist", async () => {
    expect((await gh("/repos/acme/none/actions/secrets")).status).toBe(404);
    expect((await gh("/repos/acme/none/actions/variables")).status).toBe(404);
  });

  it("lists, creates and changes variables", async () => {
    const list = async () => ((await jsonOf(await gh("/repos/acme/acme-app/actions/variables"))) as unknown as { variables: { name: string; value: string }[] }).variables;
    expect(await list()).toMatchObject([{ name: "ACME_PROJECT_ID", value: "proj_demo_123" }]);
    expect((await gh("/repos/acme/acme-app/actions/variables", { method: "POST", body: JSON.stringify({ name: "SECOND", value: "2" }) })).status).toBe(201);
    expect((await gh("/repos/acme/acme-app/actions/variables/SECOND", { method: "PATCH", body: JSON.stringify({ value: "3" }) })).status).toBe(204);
    expect((await list()).find((v) => v.name === "SECOND")?.value).toBe("3");
    expect((await gh("/repos/acme/acme-app/actions/variables/MISSING", { method: "PATCH", body: JSON.stringify({ value: "x" }) })).status).toBe(404);
    expect((await gh("/repos/acme/no-bucket/actions/variables/X", { method: "PATCH", body: JSON.stringify({ value: "x" }) })).status).toBe(404);
    expect((await gh("/repos/acme/fresh/actions/variables", { method: "POST", body: JSON.stringify({ name: "A", value: "1" }) })).status).toBe(201);
  });

  it("does not simulate anything else", async () => {
    const res = await gh("/user");
    expect(res.status).toBe(404);
    expect((await jsonOf(res))["message"]).toMatch(/nicht simuliert/);
    expect((await gh("/orgs/acme/repos", { method: "POST" })).status).toBe(404);
  });
});
