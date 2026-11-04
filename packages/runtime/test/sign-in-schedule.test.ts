import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { SignInScheduler, dueSignInChecks } from "../src/sign-in-schedule.js";
import { createRuntime } from "../src/runtime.js";

interface World {
  signedIn: Record<string, boolean>;
  active: number;
  maxActive: number;
  opened: string[];
}

const HOSTS = { openai: "platform.openai.com", anthropic: "platform.claude.com", peechoLive: "www.peecho.com", peechoTest: "test.www.peecho.com" } as const;

function driverFor(w: World): FakeDriver {
  const d = new FakeDriver({
    pollMs: 2,
    on: (e, drv) => {
      if (e.action !== "goto") return;
      const host = new URL(e.key).hostname;
      w.opened.push(host);
      drv.url = w.signedIn[host] ? `https://${host}/${host.endsWith("peecho.com") ? "dashboard/orders" : "home"}` : `https://${host}/login`;
      if (w.signedIn[host]) {
        // Whatever the recipe expects after sign-in: make every plausible condition true.
        drv.pageText.add("signed in");
      }
    },
  });
  w.active += 1;
  w.maxActive = Math.max(w.maxActive, w.active);
  const close = d.close.bind(d);
  d.close = async () => {
    w.active -= 1;
    await close();
  };
  return d;
}

async function setup(automation = "", signedIn: Record<string, boolean> = {}) {
  const w: World = { signedIn, active: 0, maxActive: 0, opened: [] };
  const dir = await mkdtemp(join(tmpdir(), "sd-signin-schedule-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${automation}`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, automationDriver: () => driverFor(w), persistSignIn: false });
  const lines: string[] = [];
  const scheduler = new SignInScheduler(rt, { log: (l) => lines.push(l), timeoutSeconds: 0.05, retryMinutes: 30 });
  return { rt, w, scheduler, lines };
}

const AUTOMATION_6H = "automation:\n  signInCheckHours: 6\n";

describe("scheduled sign-in checks: which hosts are due", () => {
  it("lists one recipe per host, hosts without any answer first, then the oldest answer", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    const now = new Date();
    const hosts = dueSignInChecks(rt, now).map((d) => d.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts).toEqual(expect.arrayContaining([HOSTS.openai, HOSTS.anthropic]));
    rt.automation.noteSignIn(HOSTS.openai, true);
    rt.automation.noteSignIn(HOSTS.anthropic, true);
    expect(dueSignInChecks(rt, now).map((d) => d.host)).not.toContain(HOSTS.openai);
  });

  it("uses the interval: due from signInCheckHours on, not before", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    rt.automation.noteSignIn(HOSTS.openai, true);
    const at = Date.now();
    const has = (offsetHours: number) => dueSignInChecks(rt, new Date(at + offsetHours * 3_600_000)).some((d) => d.host === HOSTS.openai);
    expect(has(5.9)).toBe(false);
    expect(has(6.1)).toBe(true);
  });

  it("is empty when the schedule is off (0) and for a host that was just tried", async () => {
    const off = await setup("automation:\n  signInCheckHours: 0\n");
    expect(dueSignInChecks(off.rt, new Date())).toEqual([]);
    const { rt } = await setup(AUTOMATION_6H);
    const now = new Date();
    const attempts = new Map([[HOSTS.openai, now.getTime() - 5 * 60_000]]);
    expect(dueSignInChecks(rt, now, attempts, 30).map((d) => d.host)).not.toContain(HOSTS.openai);
    expect(dueSignInChecks(rt, new Date(now.getTime() + 40 * 60_000), attempts, 30).map((d) => d.host)).toContain(HOSTS.openai);
  });
});

describe("scheduled sign-in checks: a recipe with several hosts", () => {
  it("lists every host of the recipe on its own, so the second portal is due as well", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    const due = dueSignInChecks(rt, new Date());
    const peecho = due.filter((d) => d.recipe.id === "peecho-api-keys").map((d) => d.host);
    expect(peecho.sort()).toEqual([HOSTS.peechoTest, HOSTS.peechoLive].sort());
    // One answer for the live portal does not satisfy the test portal.
    rt.automation.noteSignIn(HOSTS.peechoLive, true);
    const after = dueSignInChecks(rt, new Date()).filter((d) => d.recipe.id === "peecho-api-keys").map((d) => d.host);
    expect(after).toEqual([HOSTS.peechoTest]);
  });

  it("checks each portal at its own host and remembers a different answer for each", async () => {
    const { rt, w, scheduler } = await setup(AUTOMATION_6H, { [HOSTS.peechoLive]: true });
    const tick = await scheduler.tick();
    const results = Object.fromEntries(tick.checked.map((c) => [c.host, c.result]));
    expect(results[HOSTS.peechoLive]).toBe("signed-in");
    expect(results[HOSTS.peechoTest]).toBe("signed-out");
    expect(w.opened).toEqual(expect.arrayContaining([HOSTS.peechoLive, HOSTS.peechoTest]));
    const memory = Object.fromEntries(rt.automation.signInChecks().map((c) => [c.host, c.signedIn]));
    expect(memory[HOSTS.peechoLive]).toBe(true);
    expect(memory[HOSTS.peechoTest]).toBe(false);
    expect(w.maxActive).toBe(1);
  });

  it("measures the lifetime per host", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    rt.automation.noteSignIn(HOSTS.peechoTest, false);
    rt.automation.noteSignIn(HOSTS.peechoTest, true, "connect");
    rt.automation.noteSignIn(HOSTS.peechoLive, true, "connect");
    rt.automation.noteSignIn(HOSTS.peechoTest, false);
    const lifetimes = rt.automation.signInLifetimes();
    expect(lifetimes.map((l) => l.host)).toEqual([HOSTS.peechoTest]);
  });

  it("tells the portal which host each value of the parameter has", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    const info = rt.automation.info().recipes.find((r) => r.id === "peecho-api-keys");
    expect(info).toMatchObject({ hostBy: "portal", canCheckSignIn: true });
    expect(info?.hosts).toEqual([{ value: "live", host: HOSTS.peechoLive }, { value: "test", host: HOSTS.peechoTest }]);
    const plain = rt.automation.info().recipes.find((r) => r.id !== "peecho-api-keys");
    expect(plain).toMatchObject({ hostBy: null, hosts: [] });
  });
});

describe("scheduled sign-in checks: running", () => {
  it("checks the due hosts one at a time, remembers the answers and logs each result without values", async () => {
    const { rt, w, scheduler, lines } = await setup(AUTOMATION_6H, {});
    const tick = await scheduler.tick();
    expect(tick.skipped).toBeNull();
    expect(tick.checked.map((c) => c.host)).toEqual(expect.arrayContaining([HOSTS.openai, HOSTS.anthropic]));
    expect(tick.checked.every((c) => c.result === "signed-out")).toBe(true);
    expect(w.maxActive).toBe(1);
    expect(rt.automation.signInChecks().map((c) => c.host)).toEqual(expect.arrayContaining([HOSTS.openai, HOSTS.anthropic]));
    expect(rt.automation.signInChecks().every((c) => c.source === "check")).toBe(true);
    expect(lines).toHaveLength(tick.checked.length);
    expect(lines[0]).toMatch(/^secret-desk: scheduled sign-in check [a-z.]+: signed out$/);
    expect(lines.join("\n")).not.toMatch(/https?:|\?|token|password/i);
    // Fresh answers: the next pass has nothing to do.
    expect((await scheduler.tick()).checked).toEqual([]);
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("skips while another browser run is active, and does not touch the browser", async () => {
    const { rt, w, scheduler } = await setup(AUTOMATION_6H);
    rt.automation.begin("human-run", "x", { text: "busy" });
    expect(await scheduler.tick()).toEqual({ skipped: "busy", checked: [] });
    expect(w.opened).toEqual([]);
    rt.automation.end("human-run", { status: "done", text: "ok" });
    expect((await scheduler.tick()).checked.length).toBeGreaterThan(0);
  });

  it("does nothing when the schedule is off or browser automation is off", async () => {
    const off = await setup("automation:\n  signInCheckHours: 0\n");
    expect(await off.scheduler.tick()).toEqual({ skipped: "off", checked: [] });
    const disabled = await setup("automation:\n  enabled: false\n");
    expect(await disabled.scheduler.tick()).toEqual({ skipped: "off", checked: [] });
    expect(off.w.opened).toEqual([]);
    expect(disabled.w.opened).toEqual([]);
  });

  it("never overlaps with itself: a second tick during a pass is skipped", async () => {
    const { scheduler, w } = await setup(AUTOMATION_6H);
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    const skipped = [a, b].filter((t) => t.skipped !== null);
    expect(skipped).toHaveLength(1);
    expect(["running", "busy"]).toContain(skipped[0]!.skipped);
    expect(w.maxActive).toBe(1);
  });

  it("records the first signed-out answer after a signed-in one as a lifetime measurement", async () => {
    const { rt } = await setup(AUTOMATION_6H);
    rt.automation.noteSignIn(HOSTS.openai, false);
    rt.automation.noteSignIn(HOSTS.openai, true, "connect");
    rt.automation.noteSignIn(HOSTS.openai, false);
    expect(rt.automation.info().signInLifetimes).toMatchObject([{ host: HOSTS.openai, samples: 1 }]);
    expect(rt.automation.info()).toMatchObject({ signInCheckHours: 6, renewalWarnDays: 7 });
  });
});

describe("sign-in memory across restarts", () => {
  it("keeps the answers in sign-in-state.json next to the links file and loads them in the next runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-signin-restart-"));
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
    await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${join(dir, "data", "repo-links.json")}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    const open = () => createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, persistSignIn: true });
    const first = await open();
    first.automation.noteSignIn(HOSTS.openai, true, "run");
    await first.automation.flushSignIn();
    const second = await open();
    expect(second.automation.signInChecks()).toMatchObject([{ host: HOSTS.openai, signedIn: true, source: "run" }]);
    expect(await readFile(join(dir, "data", "sign-in-state.json"), "utf8")).not.toMatch(/cookie|token|password/i);
  });
});
