import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import { translateDeep } from "../src/i18n-en.js";
import { applyNormalizationChanges, getNormalizationPlan } from "../src/normalize.js";
import { createRuntime } from "../src/runtime.js";

const NOTES = "made-up-notes-value-77";
const INVENTORY = `version: 1
secrets:
  - id: cf-access
    name: CF_ACCESS_CLIENT_ID
    stage: production
    service: cloudflare
    expiry: none
    notes: ${NOTES}
    places: [{ repo: web, scope: environment, environment: production }]
  - id: mail
    name: MAIL_API_KEY
    stage: production
    service: resend
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
`;

async function setup(naming = "") {
  const dir = await mkdtemp(join(tmpdir(), "sd-rt-normalize-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${naming}`);
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_made_up_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  return { rt, dir, calls };
}

const human = { kind: "human", name: "tester" } as const;
const agent = { kind: "agent", name: "bot" } as const;

describe("normalization in the runtime", () => {
  it("plans from the inventory and the naming section of the configuration", async () => {
    const { rt } = await setup("naming:\n  renames: { MAIL_API_KEY: RESEND_API_KEY }\n");
    const ids = getNormalizationPlan(rt).changes.map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("rename:"))).toEqual(["rename:secret:cf-access", "rename:secret:mail"]);
    expect(ids.filter((id) => id.startsWith("manual-only:"))).toEqual(["manual-only:secret:cf-access", "manual-only:secret:mail"]);
    expect(getNormalizationPlan(rt).changes.find((c) => c.id === "rename:secret:mail")!.after[0]!.name).toBe("RESEND_API_KEY");
  });

  it("an agent may read the plan but never apply it", async () => {
    const { rt, dir } = await setup();
    expect(getNormalizationPlan(rt).changes.length).toBeGreaterThan(0);
    await expect(applyNormalizationChanges(rt, agent, { changeIds: ["rename:secret:cf-access"] })).rejects.toThrow(PolicyError);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });

  it("applies for a human, saves, never touches GitHub, and the response shows no value", async () => {
    const { rt, dir, calls } = await setup();
    const result = await applyNormalizationChanges(rt, human, { changeIds: ["rename:secret:cf-access"] });
    expect(result.applied).toEqual(["rename:secret:cf-access"]);
    expect(result.plan.changes.filter((c) => c.autoApplicable)).toEqual([]);
    expect(rt.inventory.getSecret("cf-access")!.name).toBe("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(calls).toEqual([]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(NOTES);
    expect(text).not.toContain("ghp_made_up_token_1");
  });

  it("rejects a malformed selection", async () => {
    const { rt } = await setup();
    for (const body of [{}, { changeIds: [] }, { changeIds: "x" }, { changeIds: [1] }, { changeIds: [""] }]) await expect(applyNormalizationChanges(rt, human, body)).rejects.toThrow(/changeIds/);
  });

  it("the plan and the errors translate into English", async () => {
    const { rt } = await setup();
    const plan = translateDeep(getNormalizationPlan(rt), "en");
    expect(plan.changes[0]!.reasons[0]!.text).toBe("The provider is abbreviated; it is spelled out");
    const err = await applyNormalizationChanges(rt, human, { changeIds: ["rename:secret:nope"] }).catch((e: Error) => e);
    expect(translateDeep((err as Error).message, "en")).toBe("Unknown change: rename:secret:nope");
  });
});
