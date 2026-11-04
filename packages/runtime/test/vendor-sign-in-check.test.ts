import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { checkRecipeSession } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

/**
 * Peecho (two portals) and VesselAPI have a browser recipe but no connection: their cards show the browser sign-in and check it
 * through the recipe's `login.expect`. The check only reads whether the browser is signed in.
 */
const human = { kind: "human", name: "alice" } as const;
const WRITING = ["fill", "click", "select", "type", "press", "screenshot"];

async function setup(site: { vesselSignedIn: boolean; peechoSignedIn: string[] }) {
  const dir = await mkdtemp(join(tmpdir(), "sd-vendor-check-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const actions: string[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    persistSignIn: false,
    automationDriver: () =>
      new FakeDriver({
        pollMs: 2,
        on: (e, d) => {
          actions.push(e.action);
          if (e.action !== "goto") return;
          const host = new URL(e.key).hostname;
          if (host === "dashboard.vesselapi.com") {
            if (site.vesselSignedIn) d.visible.add("css #description");
            else d.visible.delete("css #description");
            d.url = site.vesselSignedIn ? e.key : "https://dashboard.vesselapi.com/login";
          } else d.url = site.peechoSignedIn.includes(host) ? `https://${host}/dashboard/orders` : `https://${host}/login`;
        },
      }),
  });
  return { rt, actions };
}

describe("VesselAPI and Peecho: browser sign-in check without a connection", () => {
  it("checks VesselAPI through the recipe's login.expect and remembers the answer for its host", async () => {
    const { rt, actions } = await setup({ vesselSignedIn: true, peechoSignedIn: [] });
    expect(await checkRecipeSession(rt, human, "vesselapi-api-key", { timeoutSeconds: 0.5 })).toMatchObject({ signedIn: true });
    expect(rt.automation.signInChecks().map((c) => [c.host, c.signedIn])).toEqual([["dashboard.vesselapi.com", true]]);
    expect(actions.filter((a) => WRITING.includes(a))).toEqual([]);
  });

  it("reports VesselAPI as signed out when the dashboard is not shown", async () => {
    const { rt } = await setup({ vesselSignedIn: false, peechoSignedIn: [] });
    expect(await checkRecipeSession(rt, human, "vesselapi-api-key", { timeoutSeconds: 0.05 })).toMatchObject({ signedIn: false });
    expect(rt.automation.signInChecks().map((c) => [c.host, c.signedIn])).toEqual([["dashboard.vesselapi.com", false]]);
  });

  it("checks the two Peecho portals on their own and never writes anything", async () => {
    const { rt, actions } = await setup({ vesselSignedIn: false, peechoSignedIn: ["test.www.peecho.com"] });
    expect(await checkRecipeSession(rt, human, "peecho-api-keys", { host: "live", timeoutSeconds: 0.05 })).toMatchObject({ signedIn: false });
    expect(await checkRecipeSession(rt, human, "peecho-api-keys", { host: "test", timeoutSeconds: 0.5 })).toMatchObject({ signedIn: true });
    expect(Object.fromEntries(rt.automation.signInChecks().map((c) => [c.host, c.signedIn]))).toEqual({ "www.peecho.com": false, "test.www.peecho.com": true });
    expect(actions.filter((a) => WRITING.includes(a))).toEqual([]);
  });

  it("lists both recipes as checkable with the portals of Peecho, so the card gets a sign-in line per portal", async () => {
    const { rt } = await setup({ vesselSignedIn: false, peechoSignedIn: [] });
    const info = (id: string) => rt.automation.recipes.find((r) => r.id === id);
    expect(info("vesselapi-api-key")).toMatchObject({ host: "dashboard.vesselapi.com", canCheckSignIn: true });
    expect(info("peecho-api-keys")).toMatchObject({ canCheckSignIn: true, hostBy: "portal", hosts: [{ value: "live", host: "www.peecho.com" }, { value: "test", host: "test.www.peecho.com" }] });
  });
});
