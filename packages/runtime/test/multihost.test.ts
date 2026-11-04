import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { getSecret } from "../src/agent-api.js";
import { checkRecipeSession, portalFrom } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const human = { kind: "human", name: "alice" } as const;
const LIVE = "www.peecho.com";
const TEST = "test.www.peecho.com";

const INVENTORY = `version: 1
secrets:
  - id: print-api-key-test
    name: PRINT_API_KEY
    stage: dev
    service: peecho
    provider: peecho-api-keys-browser
    expiry: none
    params: { portal: test, value: merchantKey }
    places: [{ repo: acme-app, scope: repository }]
  - id: print-api-key-live
    name: PRINT_API_KEY_LIVE
    stage: dev
    service: peecho
    provider: peecho-api-keys-browser
    expiry: none
    params: { portal: live, value: merchantKey }
    places: [{ repo: acme-app, scope: repository }]
  - id: plain-key
    name: PLAIN_KEY
    stage: dev
    service: other
    provider: manual
    expiry: none
    places: [{ repo: acme-app, scope: repository }]
`;

async function setup(signedInAt: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "sd-multihost-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const opened: string[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    persistSignIn: false,
    automationDriver: () =>
      new FakeDriver({
        pollMs: 2,
        on: (e, d) => {
          if (e.action !== "goto") return;
          const host = new URL(e.key).hostname;
          opened.push(host);
          d.url = signedInAt.includes(host) ? `https://${host}/dashboard/orders` : `https://${host}/login`;
        },
      }),
  });
  return { rt, opened };
}

describe("recipe with several hosts: the human's sign-in check", () => {
  it("checks the portal that was named and remembers the answer for that host only", async () => {
    const { rt, opened } = await setup([TEST]);
    expect(await checkRecipeSession(rt, human, "peecho-api-keys", { host: "test", timeoutSeconds: 0.5 })).toMatchObject({ signedIn: true });
    expect(opened).toEqual([TEST]);
    expect(rt.automation.signInChecks().map((c) => [c.host, c.signedIn])).toEqual([[TEST, true]]);
    expect(await checkRecipeSession(rt, human, "peecho-api-keys", { host: LIVE, timeoutSeconds: 0.05 })).toMatchObject({ signedIn: false });
    expect(Object.fromEntries(rt.automation.signInChecks().map((c) => [c.host, c.signedIn]))).toEqual({ [TEST]: true, [LIVE]: false });
  });

  it("does not guess the portal: no choice or an unknown one is an error and opens nothing", async () => {
    const { rt, opened } = await setup([]);
    await expect(checkRecipeSession(rt, human, "peecho-api-keys")).rejects.toThrow(/Choose the portal/);
    await expect(checkRecipeSession(rt, human, "peecho-api-keys", { host: "evil.example.com" })).rejects.toThrow(/Choose the portal/);
    expect(opened).toEqual([]);
    expect(rt.automation.signInChecks()).toEqual([]);
  });

  it("uses the portal parameter chosen in the sign-in dialog when the body names no host", async () => {
    const { rt } = await setup([]);
    const recipe = rt.automation.recipe("peecho-api-keys")!;
    expect(portalFrom(recipe, {}, { portal: "test" }).host).toBe(TEST);
    expect(portalFrom(recipe, { host: "live" }, { portal: "test" }).host).toBe(LIVE);
    expect(() => portalFrom(recipe, {}, {})).toThrow(/Choose the portal/);
    const plain = rt.automation.recipe("openai-admin-key")!;
    expect(portalFrom(plain, {}, {})).toBe(plain);
  });
});

describe("recipe with several hosts: the entry knows its portal", () => {
  it("names the host an entry's parameters pick, and null for entries without one", async () => {
    const { rt } = await setup([]);
    expect(getSecret(rt, "print-api-key-test").browserHost).toBe(TEST);
    expect(getSecret(rt, "print-api-key-live").browserHost).toBe(LIVE);
    expect(getSecret(rt, "plain-key").browserHost).toBeNull();
  });
});
