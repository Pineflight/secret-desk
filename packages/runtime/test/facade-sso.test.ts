import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { cancelFacade, getFacadeState, listFacades, startFacadeSignIn, submitFacadeConfirm } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const human = { kind: "human", name: "alice" } as const;
const PW = "typed-secret-pw-77";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-sso-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const drivers: FakeDriver[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    automationDriver: () => {
      const d = new FakeDriver({
        pollMs: 2,
        visible: ['button "Continue with Apple"'],
        on: (e, drv) => {
          if (e.action === "goto") drv.url = e.key.includes("/login") ? e.key : "https://platform.openai.com/login";
          if (e.key === 'button "Continue with Apple"') {
            drv.url = "https://appleid.apple.com/auth";
            for (const k of ["css #account_name_text_field", "css #sign-in", "css #password_text_field"]) drv.visible.add(k);
          }
        },
      });
      drivers.push(d);
      return d;
    },
  });
  return { rt, drivers };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("facade: sign-in methods", () => {
  it("lists the methods of each facade and the promise sentence", async () => {
    const { rt } = await setup();
    const all = await listFacades(rt, human);
    expect(all.find((f) => f.id === "openai")).toMatchObject({ promise: "facade.promise.openai", methods: [{ id: "email" }, { id: "google" }, { id: "apple" }, { id: "microsoft" }] });
    expect(all.find((f) => f.id === "revenuecat")).toMatchObject({ promise: "facade.promise.revenuecat" });
    expect(all.find((f) => f.id === "stripe")).toMatchObject({ promise: "facade.promise.stripe" });
    expect(JSON.stringify(all)).not.toContain("viewerUrl");
  });

  it("refuses a method the recipe does not offer, before any browser opens", async () => {
    const { rt, drivers } = await setup();
    expect(() => startFacadeSignIn(rt, human, "openai", { username: "a@b.test", password: PW, method: "github" })).toThrow(/does not offer the sign-in method github/);
    expect(drivers).toHaveLength(0);
  });

  it("signs in through Apple: the credentials go to the identity provider and an approval wait shows in the portal", async () => {
    const { rt, drivers } = await setup();
    startFacadeSignIn(rt, human, "openai", { username: "a@b.test", password: PW, method: "apple" });
    await until(() => drivers[0]?.filled.has("css #password_text_field") === true);
    expect([...drivers[0]!.filled.keys()]).toEqual(["css #account_name_text_field", "css #password_text_field"]);
    drivers[0]!.pageText.add("Check your other devices");
    await until(() => getFacadeState(rt, human, "openai").needs === "approval");
    expect(getFacadeState(rt, human, "openai")).toMatchObject({ status: "waiting-human", needs: "approval", text: expect.stringContaining("Approve the sign-in on your device") });
    expect(JSON.stringify(getFacadeState(rt, human, "openai"))).not.toContain(PW);
    cancelFacade(rt, human, "openai");
  });

  it("refuses a confirmation when the provider asks for none", async () => {
    const { rt } = await setup();
    expect(() => submitFacadeConfirm(rt, human, "openai", { accept: true })).toThrow(/not waiting for an authorization/);
  });
});
