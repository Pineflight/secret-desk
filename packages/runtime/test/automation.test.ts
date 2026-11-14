import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { FakeDriver } from "@secret-desk/automation";
import { IssuanceError } from "@secret-desk/core";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationError, viewerUrlFrom } from "../src/automation.js";
import { requestIssuance, resolveApproval, listProviders, listSecrets, getAutomation, getAutomationRun, cancelAutomationRun, PolicyError } from "../src/agent-api.js";
import { createLocalRuntime } from "../src/runtime.js";
import { envHost } from "./helpers/env-host.js";

const TOKEN = "tok_s3cr3tvalue99xyz";

const RECIPE = `# STATUS: nicht gegen die echte Seite geprueft
id: sample-token
label: Beispiel
host: example.test
login:
  expect: { url: "^https://example\\\\.test/tokens" }
  message: Bitte anmelden
steps:
  - goto: "https://example.test/tokens/new?name={{name}}"
  - fill: { label: Name, value: "{{name}}" }
  - screenshot: vorher
  - click: { role: button, name: Create, createsToken: true }
capture:
  token:
    find: { css: "#tok" }
    pattern: "^(tok_[a-z0-9]+)$"
    timeoutSeconds: 0.05
  externalId: { from: name }
  expires: { from: days }
mask: [{ css: "#tok" }]
`;

const INVENTORY = `version: 1
secrets:
  - id: sample-a
    name: SAMPLE_A
    stage: production
    service: example
    provider: sample-token-browser
    expiry: none
    ttlDays: 30
    places: [{ repo: acme-app, scope: repository }]
  - id: sample-b
    name: SAMPLE_B
    stage: dev
    service: example
    provider: sample-token-browser
    expiry: none
    places: [{ repo: acme-app, scope: repository }]
`;

interface Opts {
  /** Treiberverhalten: true = Token erscheint nach dem Klick, "login" = Anmeldung noetig, "fail" = kein Token. */
  mode?: "ok" | "login" | "fail";
  automation?: string;
  env?: Record<string, string>;
  /** Adds a guided sign-in (`login.form`) to the sample recipe. */
  form?: boolean;
}

const FORM_RECIPE = RECIPE.replace("  message: Bitte anmelden\n", "  message: Bitte anmelden\n  form:\n    start: https://example.test/login\n    steps:\n      - fill: { label: Email, value: \"{{login.username}}\" }\n      - fill: { label: Password, value: \"{{login.password}}\" }\n");

async function setup(opts: Opts = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-auto-"));
  await mkdir(join(dir, "recipes"));
  await writeFile(join(dir, "recipes", "sample.yaml"), opts.form ? FORM_RECIPE : RECIPE);
  await writeFile(join(dir, "recipes", "kaputt.yaml"), "id: kaputt\nlabel: Kaputt\n");
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n${opts.automation ?? ""}`,
  );
  const drivers: FakeDriver[] = [];
  const login = { done: false };
  const mode = opts.mode ?? "ok";
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x", ...(opts.env ?? {}) },
    fetch: fetchMock,
    bundledRecipes: null,
    automationDriver: () => {
      const d = new FakeDriver({
        url: mode === "login" ? "https://example.test/login" : "about:blank",
        visible: ['Feld "Name"', 'button "Create"'],
        pollMs: 5,
        on: (e, drv) => {
          if (e.action === "goto") drv.url = mode === "login" && !login.done ? "https://example.test/login?next=geheim" : "https://example.test/tokens/new";
          if (e.action === "click" && mode !== "fail") {
            drv.visible.add("css #tok");
            drv.texts.set("css #tok", TOKEN);
          }
        },
      });
      drivers.push(d);
      return d;
    },
  });
  return { rt, drivers, login };
}

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;
const until = async (fn: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("Zeitueberschreitung im Test");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("recipes and providers", () => {
  it("registers <id>-browser per recipe and collects invalid recipes", async () => {
    const { rt } = await setup();
    const p = rt.providers.get("sample-token-browser");
    expect(p).toMatchObject({ id: "sample-token-browser", label: "Beispiel (Browser)", kind: "automatic" });
    expect(rt.automation.isBrowserProvider(p)).toBe(true);
    expect(rt.automation.recipes).toMatchObject([{ id: "sample-token", providerId: "sample-token-browser", status: "nicht gegen die echte Seite geprueft" }]);
    expect(rt.automation.problems.map((x) => x.file.split("/").pop())).toEqual(["kaputt.yaml"]);
    expect(listProviders(rt).find((x) => x.id === "sample-token-browser")).toMatchObject({ browser: true });
    expect(listProviders(rt).find((x) => x.id === "random-hex")).toMatchObject({ browser: false, readOnly: false });
    expect(listProviders(rt).find((x) => x.id === "sample-token-browser")).toMatchObject({ readOnly: false });
    expect((await listSecrets(rt))[0]).toMatchObject({ browser: true, automatic: true, readOnly: false });
  });

  it("registers nothing when automation.enabled is false", async () => {
    const { rt } = await setup({ automation: "automation: { enabled: false }\n" });
    expect(rt.providers.get("sample-token-browser")).toBeUndefined();
    expect(rt.automation.info()).toMatchObject({ enabled: false, recipes: [] });
  });

  it("reads recipe folders from the configuration (relative to the config file)", async () => {
    const { rt } = await setup({ automation: "automation: { recipesDirs: [./leer], loginTimeoutMinutes: 3 }\n" });
    expect(rt.automation.loginTimeoutMinutes).toBe(3);
    expect(rt.automation.recipes).toHaveLength(1);
  });

  it("reports a missing Chrome in the state without failing", async () => {
    const { rt } = await setup({ automation: "automation: { chromePath: /gibt/es/nicht }\n" });
    const info = await getAutomation(rt, human);
    expect(info.chrome).toMatchObject({ found: false, path: null });
    expect(info.chrome.hint).toMatch(/Chrome nicht gefunden/);
  });
});

describe("remote browser (SECRET_DESK_BROWSER_CDP)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

  async function devtools(): Promise<string> {
    server = createServer((req, res) => {
      if (req.url === "/json/version") res.end(JSON.stringify({ Browser: "Chrome/140.0.0.0" }));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("is local by default", async () => {
    const { rt } = await setup();
    expect((await getAutomation(rt, human)).browser).toEqual({ mode: "local", endpoint: null, reachable: null, browser: null, detail: null, viewerUrl: null });
  });

  it("reports the mode and that the endpoint answers; no credentials in the output", async () => {
    const url = await devtools();
    const withAuth = url.replace("http://", "http://user:s3cret@");
    const { rt } = await setup({ env: { SECRET_DESK_BROWSER_CDP: withAuth } });
    const info = await getAutomation(rt, human);
    expect(info.browser).toEqual({ mode: "remote", endpoint: url, reachable: true, browser: "Chrome/140.0.0.0", detail: null, viewerUrl: null });
    expect(info.chrome).toMatchObject({ found: false, path: null });
    expect(JSON.stringify(info)).not.toContain("s3cret");
  });

  it("shows the viewer address of the remote browser, never with credentials", async () => {
    const url = await devtools();
    const viewer = "http://desk.local/browser/vnc.html?path=browser/websockify&autoconnect=1";
    const { rt } = await setup({ env: { SECRET_DESK_BROWSER_CDP: url, SECRET_DESK_BROWSER_VIEWER_URL: viewer } });
    expect((await getAutomation(rt, human)).browser.viewerUrl).toBe(viewer);
    expect(viewerUrlFrom("http://user:pw@desk.local/browser/", envHost({}))).toBeNull();
    expect(viewerUrlFrom("javascript:alert(1)", envHost({}))).toBeNull();
    expect(viewerUrlFrom("/browser/vnc.html?path=browser/websockify&autoconnect=1", envHost({}))).toBe("/browser/vnc.html?path=browser/websockify&autoconnect=1");
    expect(viewerUrlFrom("//evil.example/x", envHost({}))).toBeNull();
    expect(viewerUrlFrom("http://desk.local/a", envHost({ SECRET_DESK_BROWSER_VIEWER_URL: "https://other.local/b" }))).toBe("https://other.local/b");
    // Without a host the variable is not read and only the configured address counts.
    expect(viewerUrlFrom("http://desk.local/a")).toBe("http://desk.local/a");
  });

  it("takes the endpoint from the configuration; the environment variable wins", async () => {
    const url = await devtools();
    const fromConfig = await setup({ automation: `automation: { cdpEndpoint: "${url}" }\n` });
    expect((await getAutomation(fromConfig.rt, human)).browser).toMatchObject({ mode: "remote", endpoint: url, reachable: true });
    const overridden = await setup({ automation: `automation: { cdpEndpoint: "${url}" }\n`, env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" } });
    expect((await getAutomation(overridden.rt, human)).browser).toMatchObject({ mode: "remote", endpoint: "http://127.0.0.1:9", reachable: false });
  });

  it("reports an endpoint that does not answer without failing", async () => {
    const { rt } = await setup({ env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" } });
    expect((await getAutomation(rt, human)).browser).toMatchObject({ mode: "remote", reachable: false, detail: "The browser endpoint is not reachable." });
  });

  it("an invalid endpoint is reported, never falls back to a local Chrome, and a run fails", async () => {
    await sodium.ready;
    const { rt } = await setup({ env: { SECRET_DESK_BROWSER_CDP: "ftp://u:hunter2@host" } });
    const info = await getAutomation(rt, human);
    expect(info.browser).toMatchObject({ mode: "remote", endpoint: null, reachable: false });
    expect(JSON.stringify(info)).not.toContain("hunter2");
    const real = await createLocalRuntime(rt.configPath, { vault: null, env: { GH_TEST: "ghp_x", SECRET_DESK_BROWSER_CDP: "ftp://u:hunter2@host" }, bundledRecipes: null });
    const err = await requestIssuance(real, human, "sample-a").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/only http, https, ws and wss/);
    expect(err?.message).not.toContain("hunter2");
  });
});

describe("run", () => {
  it("creates, attaches receipts to the report, state done without value", async () => {
    const { rt, drivers } = await setup();
    const r = await requestIssuance(rt, human, "sample-a");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    expect(drivers[0]?.opened && drivers[0].closed).toBe(true);
    const st = getAutomationRun(rt, human, "sample-a");
    expect(st).toMatchObject({ status: "done", issuanceId: r.issuance.id, providerId: "sample-token-browser" });
    const report = await rt.evidence.get("sample-a", r.issuance.id);
    expect(report.attachments.map((a) => a.note)).toEqual(["Browser: vorher", "Browser: nach-erzeugen"]);
    for (const text of [JSON.stringify(st), JSON.stringify(r), JSON.stringify(await getAutomation(rt, human)), JSON.stringify(report)]) expect(text).not.toContain(TOKEN);
    expect(rt.issuances.get(r.issuance.id)?.value.reveal()).toBe(TOKEN);
  });

  it("waits for the human, shows host and reason, continues afterwards", async () => {
    const { rt, drivers, login } = await setup({ mode: "login" });
    const p = requestIssuance(rt, human, "sample-a");
    await until(() => rt.automation.state("sample-a").status === "waiting-human");
    const waiting = rt.automation.state("sample-a");
    expect(waiting.host).toBe("example.test");
    expect(waiting.text).toMatch(/anmelden/i);
    expect(JSON.stringify(waiting)).not.toContain("geheim"); // keine Query der Seite im Zustand
    // Mensch meldet sich an: Zielseite ist erreicht.
    login.done = true;
    drivers[0]!.url = "https://example.test/tokens/new";
    const r = await p;
    expect(r.status).toBe("awaiting-review");
    expect(rt.automation.state("sample-a").status).toBe("done");
  });

  it("remote browser with a guided sign-in: a signed-out run ends at once as needs-sign-in, no value, no query", async () => {
    const { rt, drivers } = await setup({ mode: "login", form: true, env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" } });
    const err = await requestIssuance(rt, human, "sample-a").then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as AutomationError).kind).toBe("signin");
    const st = getAutomationRun(rt, human, "sample-a");
    expect(st).toMatchObject({ status: "failed", signInRecipeId: "sample-token", failure: { code: "needs-sign-in" } });
    expect(rt.automation.isBusy()).toBe(false);
    expect(drivers[0]?.closed).toBe(true);
    for (const text of [JSON.stringify(st), String(err?.message), JSON.stringify(await getAutomation(rt, human))]) {
      expect(text).not.toContain("geheim");
      expect(text).not.toContain(TOKEN);
    }
  });

  it("local browser, or a recipe without a guided sign-in, keeps waiting for the human in the window", async () => {
    for (const s of [await setup({ mode: "login", form: true }), await setup({ mode: "login", env: { SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9" } })]) {
      const p = requestIssuance(s.rt, human, "sample-a");
      await until(() => s.rt.automation.state("sample-a").status === "waiting-human");
      expect(s.rt.automation.state("sample-a").signInRecipeId).toBeUndefined();
      cancelAutomationRun(s.rt, human, "sample-a");
      await expect(p).rejects.toThrow(AutomationError);
    }
  });

  it("rejects a second concurrent run", async () => {
    const { rt } = await setup({ mode: "login" });
    const first = requestIssuance(rt, human, "sample-a");
    await until(() => rt.automation.state("sample-a").status === "waiting-human");
    await expect(requestIssuance(rt, human, "sample-b")).rejects.toThrow(IssuanceError);
    await expect(requestIssuance(rt, human, "sample-b")).rejects.toThrow(/laeuft schon ein Browser-Lauf/);
    expect(rt.automation.state("sample-b").status).toBe("idle");
    cancelAutomationRun(rt, human, "sample-a");
    await expect(first).rejects.toThrow(AutomationError);
  });

  it("cancels: state cancelled, browser closed, a new run is possible afterwards", async () => {
    const { rt, drivers } = await setup({ mode: "login" });
    const p = requestIssuance(rt, human, "sample-a");
    const assertion = expect(p).rejects.toMatchObject({ name: "AutomationError", kind: "abort" });
    await until(() => rt.automation.state("sample-a").status === "waiting-human");
    expect(cancelAutomationRun(rt, human, "sample-a").text).toBe("Wird abgebrochen.");
    await assertion;
    expect(rt.automation.state("sample-a")).toMatchObject({ status: "cancelled", text: "Abgebrochen." });
    expect(drivers[0]?.closed).toBe(true);
    expect(() => cancelAutomationRun(rt, human, "sample-a")).toThrow(/kein Browser-Lauf/);
    // frei fuer den naechsten Lauf
    const next = requestIssuance(rt, human, "sample-b");
    await until(() => rt.automation.state("sample-b").status === "waiting-human");
    cancelAutomationRun(rt, human, "sample-b");
    await expect(next).rejects.toThrow(AutomationError);
  });

  it("answers params_invalid for a ttlDays the provider does not offer before any run state, browser or approval exists", async () => {
    const { rt, drivers } = await setup();
    const provider = rt.providers.get("sample-token-browser")!;
    provider.ttlDaysOptions = [1, 7, 30];
    rt.inventory.patchSecret("sample-a", { ttlDays: 90 });
    for (const dryRun of [false, true]) {
      const err = (await requestIssuance(rt, human, "sample-a", { dryRun }).catch((e: unknown) => e)) as { code?: string; problems?: { key: string; code: string }[]; message: string };
      expect(err.code).toBe("params_invalid");
      expect(err.problems?.map((p) => [p.key, p.code])).toEqual([["ttlDays", "not_in_options"]]);
      expect(err.message).not.toContain(TOKEN);
    }
    const agentErr = (await requestIssuance(rt, agent, "sample-a").catch((e: unknown) => e)) as { code?: string };
    expect(agentErr.code).toBe("params_invalid");
    expect(rt.automation.state("sample-a").status).toBe("idle");
    expect(rt.approvals.list()).toHaveLength(0);
    expect(drivers).toHaveLength(0);
    for (const days of [30, 7, 1]) {
      rt.inventory.patchSecret("sample-a", { ttlDays: days });
      const plan = await requestIssuance(rt, human, "sample-a", { dryRun: true });
      expect(plan.status).toBe("dry-run");
    }
    rt.inventory.patchSecret("sample-a", { ttlDays: null });
    expect((await requestIssuance(rt, human, "sample-a", { dryRun: true })).status).toBe("dry-run");
  });

  it("fails after creation with the hint to delete the token at the provider", async () => {
    const { rt, drivers } = await setup({ mode: "fail" });
    await expect(requestIssuance(rt, human, "sample-a")).rejects.toThrow(AutomationError);
    const st = rt.automation.state("sample-a");
    expect(st.status).toBe("failed");
    expect(st.createdName).toMatch(/^sample-a-\d{8}-\d{4}$/);
    expect(st.text).toMatch(/dort pruefen und loeschen/);
    expect(drivers[0]?.closed).toBe(true);
    expect(rt.issuances.list()).toHaveLength(0);
  });

  it("returns a clear message without Playwright/Chrome instead of a crash", async () => {
    await sodium.ready;
    const { rt } = await setup({ automation: "automation: { chromePath: /gibt/es/nicht }\n" });
    const real = await createLocalRuntime(rt.configPath, { vault: null, env: { GH_TEST: "ghp_x" }, bundledRecipes: null });
    await expect(requestIssuance(real, human, "sample-a")).rejects.toThrow(/Chrome nicht gefunden|playwright-core/);
    expect(real.automation.state("sample-a").status).toBe("failed");
  });
});

describe("agents", () => {
  it("always need an approval for a browser provider, even in an approved stage", async () => {
    const { rt, drivers } = await setup();
    const r = await requestIssuance(rt, agent, "sample-b"); // dev, agentStages=[dev]
    expect(r).toMatchObject({ status: "pending-approval", secretId: "sample-b" });
    expect((r as { message: string }).message).toMatch(/Browserfenster/);
    expect(drivers).toHaveLength(0);
    expect(rt.automation.state("sample-b").status).toBe("idle");
    // Ein Mensch gibt frei: erst dann laeuft der Browser.
    const approval = await resolveApproval(rt, human, (r as { approvalId: string }).approvalId, "approve");
    expect(approval.state).toBe("approved");
    expect(drivers).toHaveLength(1);
    expect(rt.automation.state("sample-b").status).toBe("done");
  });

  it("may not call state and cancel", async () => {
    const { rt } = await setup();
    await expect(getAutomation(rt, agent)).rejects.toThrow(PolicyError);
    expect(() => getAutomationRun(rt, agent, "sample-a")).toThrow(PolicyError);
    expect(() => cancelAutomationRun(rt, agent, "sample-a")).toThrow(PolicyError);
  });
});
