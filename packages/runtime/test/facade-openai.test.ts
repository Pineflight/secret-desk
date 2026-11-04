import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { checkFacadeSession, checkRecipeSession, getFacadeState, listFacades, startFacadeConnect } from "../src/facade.js";
import { checkConnection } from "../src/connection-check.js";
import { createRuntime } from "../src/runtime.js";

const ADMIN_KEY = "sk-admin-A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const human = { kind: "human", name: "alice" } as const;

interface Site {
  signedIn: boolean;
  keyName: string | null;
  /** Status the fake Admin API answers with. */
  apiStatus: number;
}

function driverFor(site: Site): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        if (e.key.includes("/login") || e.key === "https://platform.openai.com/") drv.url = site.signedIn ? "https://platform.openai.com/home" : "https://platform.openai.com/login";
        else if (e.key.includes("/admin-keys")) {
          if (!site.signedIn) drv.url = "https://platform.openai.com/login";
          else {
            drv.visible.add('button "Create new Admin key" (exact)');
          }
        }
        return;
      }
      if (e.action === "click" && e.key.includes("Create new Admin key")) {
        drv.visible.add('Platzhalter "My Test Key"');
        drv.visible.add('button "Create admin key" (exact)');
        return;
      }
      if (e.action === "click" && e.key.includes("Create admin key")) {
        site.keyName = drv.filled.get('Platzhalter "My Test Key"') ?? "";
        drv.visible.add("css [role=dialog] input[readonly]");
        drv.texts.set("css [role=dialog] input[readonly]", ADMIN_KEY);
      }
    },
  });
}

async function setup(opts: { signedIn?: boolean; apiStatus?: number } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? true, keyName: null, apiStatus: opts.apiStatus ?? 200 };
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-openai-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const urls: string[] = [];
  const bearer: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bearer.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
    if (String(url).startsWith("https://api.openai.com/v1/organization/projects")) {
      return new Response(JSON.stringify({ data: [{ id: "proj_1", name: "One" }, { id: "proj_2", name: "Two" }], has_more: false }), { status: site.apiStatus });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => driverFor(site),
  });
  return { rt, site, urls, bearer };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (rt: Awaited<ReturnType<typeof setup>>["rt"]) => ["done", "failed", "cancelled"].includes(getFacadeState(rt, human, "openai").status);

describe("facade: openai", () => {
  it("is offered with the admin-key recipe, an unverified status and no extra inputs", async () => {
    const { rt } = await setup();
    const f = (await listFacades(rt, human)).find((x) => x.id === "openai")!;
    expect(f).toMatchObject({ id: "openai", recipeId: "openai-admin-key", connectionId: "openai", available: true, connected: false, needsProject: false, host: "platform.openai.com", inputs: [] });
    expect(f.recipeStatus).toMatch(/verified live on 2026-11-03/);
    expect(f.promise).toBe("facade.promise.openai");
    expect(f.methods.map((m) => m.id)).toEqual(["email", "google", "apple", "microsoft"]);
  });

  it("creates the admin key in the signed-in browser, stores it as the openai connection and tests it", async () => {
    const { rt, site, urls, bearer } = await setup();
    startFacadeConnect(rt, human, "openai", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "openai");
    expect(end.failure?.messageEn).toBeUndefined();
    expect(end.status).toBe("done");
    expect(end.result).toMatchObject({ connected: true, connectionId: "openai", storedIn: "session", counts: { projects: 2 } });
    expect(site.keyName).toMatch(/^secret-desk-integration-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect((await rt.connections.token("openai")).reveal()).toBe(ADMIN_KEY);
    expect(urls[0]).toBe("https://api.openai.com/v1/organization/projects?limit=1");
    expect(bearer.every((b) => b === `Bearer ${ADMIN_KEY}`)).toBe(true);
    expect(JSON.stringify(end)).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(rt.automation.info())).not.toContain(ADMIN_KEY);
    // The recipe run proves the sign-in at its host.
    expect(rt.automation.info().signInChecks).toMatchObject([{ host: "platform.openai.com", signedIn: true }]);
    expect((await listFacades(rt, human)).find((x) => x.id === "openai")!.connected).toBe(true);
  });

  it("reports a rejected admin key (401) as a failed connection test", async () => {
    const { rt } = await setup({ apiStatus: 401 });
    startFacadeConnect(rt, human, "openai", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "openai");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "test" });
    const check = await checkConnection(rt, "openai");
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.id === "token")).toMatchObject({ status: "fail" });
  });

  it("tests the stored key: 200 connected, 403 rejected, a regular key is the wrong kind", async () => {
    const ok = await setup();
    ok.rt.connections.session.set("openai", ADMIN_KEY);
    expect(await checkConnection(ok.rt, "openai")).toMatchObject({ ok: true });
    const denied = await setup({ apiStatus: 403 });
    denied.rt.connections.session.set("openai", ADMIN_KEY);
    expect(await checkConnection(denied.rt, "openai")).toMatchObject({ ok: false });
    const wrong = await setup();
    wrong.rt.connections.session.set("openai", "sk-proj-regular-key-0000");
    const r = await checkConnection(wrong.rt, "openai");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "prefix")).toMatchObject({ status: "fail" });
  });
});

describe("browser sign-in memory", () => {
  it("remembers a check per host with its time, for the facade and for a recipe id", async () => {
    const { rt, site } = await setup({ signedIn: false });
    expect(rt.automation.info().signInChecks).toEqual([]);
    expect(await checkFacadeSession(rt, human, "openai", { timeoutSeconds: 0.05 })).toMatchObject({ signedIn: false });
    expect(rt.automation.info().signInChecks).toMatchObject([{ host: "platform.openai.com", signedIn: false }]);
    site.signedIn = true;
    expect(await checkRecipeSession(rt, human, "openai-admin-key", { timeoutSeconds: 0.5 })).toMatchObject({ signedIn: true });
    const [entry] = rt.automation.info().signInChecks;
    expect(entry).toMatchObject({ host: "platform.openai.com", signedIn: true });
    expect(Number.isNaN(Date.parse(entry!.checkedAt))).toBe(false);
    expect(rt.automation.info().signInFreshHours).toBe(12);
  });

  it("does not remember a check that could not be made", async () => {
    const { rt } = await setup();
    rt.automation.begin("other", "x", { text: "busy" });
    expect(await checkRecipeSession(rt, human, "openai-admin-key")).toMatchObject({ failure: { code: "busy" } });
    expect(rt.automation.info().signInChecks).toEqual([]);
  });

  it("refuses recipes without a guided sign-in, unknown recipes and agents", async () => {
    const { rt } = await setup();
    await expect(checkRecipeSession(rt, human, "openai-api-key")).rejects.toThrow(/no guided sign-in/);
    await expect(checkRecipeSession(rt, human, "nope")).rejects.toThrow();
    await expect(checkRecipeSession(rt, { kind: "agent", name: "claude" }, "openai-admin-key")).rejects.toThrow();
  });
});
