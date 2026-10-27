import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { FakeDriver } from "@secret-desk/automation";
import { IssuanceError } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { AutomationError } from "../src/automation.js";
import { requestIssuance, resolveApproval, listProviders, listSecrets, getAutomation, getAutomationRun, cancelAutomationRun, PolicyError } from "../src/agent-api.js";
import { createRuntime } from "../src/runtime.js";

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
}

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
  await writeFile(join(dir, "recipes", "sample.yaml"), RECIPE);
  await writeFile(join(dir, "recipes", "kaputt.yaml"), "id: kaputt\nlabel: Kaputt\n");
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n${opts.automation ?? ""}`,
  );
  const drivers: FakeDriver[] = [];
  const login = { done: false };
  const mode = opts.mode ?? "ok";
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" },
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

describe("Rezepte und Anbieter", () => {
  it("registriert je Rezept <id>-browser und sammelt ungueltige Rezepte", async () => {
    const { rt } = await setup();
    const p = rt.providers.get("sample-token-browser");
    expect(p).toMatchObject({ id: "sample-token-browser", label: "Beispiel (Browser)", kind: "automatic" });
    expect(rt.automation.isBrowserProvider(p)).toBe(true);
    expect(rt.automation.recipes).toMatchObject([{ id: "sample-token", providerId: "sample-token-browser", status: "nicht gegen die echte Seite geprueft" }]);
    expect(rt.automation.problems.map((x) => x.file.split("/").pop())).toEqual(["kaputt.yaml"]);
    expect(listProviders(rt).find((x) => x.id === "sample-token-browser")).toMatchObject({ browser: true });
    expect(listProviders(rt).find((x) => x.id === "random-hex")).toMatchObject({ browser: false });
    expect((await listSecrets(rt))[0]).toMatchObject({ browser: true, automatic: true });
  });

  it("registriert nichts, wenn automation.enabled false ist", async () => {
    const { rt } = await setup({ automation: "automation: { enabled: false }\n" });
    expect(rt.providers.get("sample-token-browser")).toBeUndefined();
    expect(rt.automation.info()).toMatchObject({ enabled: false, recipes: [] });
  });

  it("liest Rezeptordner aus der Konfiguration (relativ zur Konfigurationsdatei)", async () => {
    const { rt } = await setup({ automation: "automation: { recipesDirs: [./leer], loginTimeoutMinutes: 3 }\n" });
    expect(rt.automation.loginTimeoutMinutes).toBe(3);
    expect(rt.automation.recipes).toHaveLength(1);
  });

  it("meldet einen fehlenden Chrome im Stand, ohne zu scheitern", async () => {
    const { rt } = await setup({ automation: "automation: { chromePath: /gibt/es/nicht }\n" });
    const info = getAutomation(rt, human);
    expect(info.chrome).toMatchObject({ found: false, path: null });
    expect(info.chrome.hint).toMatch(/Chrome nicht gefunden/);
  });
});

describe("Lauf", () => {
  it("erzeugt, haengt Belege an den Bericht, Zustand done ohne Wert", async () => {
    const { rt, drivers } = await setup();
    const r = await requestIssuance(rt, human, "sample-a");
    if (r.status !== "awaiting-review") throw new Error("erwartet");
    expect(drivers[0]?.opened && drivers[0].closed).toBe(true);
    const st = getAutomationRun(rt, human, "sample-a");
    expect(st).toMatchObject({ status: "done", issuanceId: r.issuance.id, providerId: "sample-token-browser" });
    const report = await rt.evidence.get("sample-a", r.issuance.id);
    expect(report.attachments.map((a) => a.note)).toEqual(["Browser: vorher", "Browser: nach-erzeugen"]);
    for (const text of [JSON.stringify(st), JSON.stringify(r), JSON.stringify(getAutomation(rt, human)), JSON.stringify(report)]) expect(text).not.toContain(TOKEN);
    expect(rt.issuances.get(r.issuance.id)?.value.reveal()).toBe(TOKEN);
  });

  it("wartet auf den Menschen, zeigt Host und Grund, macht danach weiter", async () => {
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

  it("lehnt einen zweiten gleichzeitigen Lauf ab", async () => {
    const { rt } = await setup({ mode: "login" });
    const first = requestIssuance(rt, human, "sample-a");
    await until(() => rt.automation.state("sample-a").status === "waiting-human");
    await expect(requestIssuance(rt, human, "sample-b")).rejects.toThrow(IssuanceError);
    await expect(requestIssuance(rt, human, "sample-b")).rejects.toThrow(/laeuft schon ein Browser-Lauf/);
    expect(rt.automation.state("sample-b").status).toBe("idle");
    cancelAutomationRun(rt, human, "sample-a");
    await expect(first).rejects.toThrow(AutomationError);
  });

  it("bricht ab: Zustand cancelled, Browser geschlossen, danach ist ein neuer Lauf moeglich", async () => {
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

  it("scheitert nach dem Erzeugen mit dem Hinweis, den Token beim Anbieter zu loeschen", async () => {
    const { rt, drivers } = await setup({ mode: "fail" });
    await expect(requestIssuance(rt, human, "sample-a")).rejects.toThrow(AutomationError);
    const st = rt.automation.state("sample-a");
    expect(st.status).toBe("failed");
    expect(st.createdName).toMatch(/^sample-a-\d{8}$/);
    expect(st.text).toMatch(/dort pruefen und loeschen/);
    expect(drivers[0]?.closed).toBe(true);
    expect(rt.issuances.list()).toHaveLength(0);
  });

  it("liefert ohne Playwright/Chrome eine klare Meldung statt eines Absturzes", async () => {
    await sodium.ready;
    const { rt } = await setup({ automation: "automation: { chromePath: /gibt/es/nicht }\n" });
    const real = await createRuntime(rt.configPath, { vault: null, env: { GH_TEST: "ghp_x" }, bundledRecipes: null });
    await expect(requestIssuance(real, human, "sample-a")).rejects.toThrow(/Chrome nicht gefunden|playwright-core/);
    expect(real.automation.state("sample-a").status).toBe("failed");
  });
});

describe("Agenten", () => {
  it("brauchen fuer einen Browser-Anbieter immer eine Freigabe, auch in einer freigegebenen Stage", async () => {
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

  it("duerfen Zustand und Abbruch nicht aufrufen", async () => {
    const { rt } = await setup();
    expect(() => getAutomation(rt, agent)).toThrow(PolicyError);
    expect(() => getAutomationRun(rt, agent, "sample-a")).toThrow(PolicyError);
    expect(() => cancelAutomationRun(rt, agent, "sample-a")).toThrow(PolicyError);
  });
});
