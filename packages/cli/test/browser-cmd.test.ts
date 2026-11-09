import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeRunError } from "@secret-desk/automation";

// The browser itself is never started: the automation package is replaced by fakes, the command wiring is under test.
const m = vi.hoisted(() => ({
  playwrightAvailable: vi.fn(),
  findChrome: vi.fn(),
  loadRecipesDetailed: vi.fn(),
  dryRunRecipe: vi.fn(),
  probeCdp: vi.fn(),
  driverOptions: [] as unknown[],
}));

vi.mock("@secret-desk/automation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@secret-desk/automation")>()),
  playwrightAvailable: m.playwrightAvailable,
  findChrome: m.findChrome,
  loadRecipesDetailed: m.loadRecipesDetailed,
  dryRunRecipe: m.dryRunRecipe,
  probeCdp: m.probeCdp,
  PlaywrightDriver: class {
    constructor(opts: unknown) {
      m.driverOptions.push(opts);
    }
  },
}));

import { main } from "../src/index.js";

async function cmd(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["browser", ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function recipeFile(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "sd-cli-recipe-")), "r.yaml");
  await writeFile(path, text);
  return path;
}
const recipe = (over: Record<string, unknown> = {}) => ({ id: "acme-token", host: "acme.test", params: [], steps: [], ...over });

beforeEach(() => {
  vi.stubEnv("SECRET_DESK_BROWSER_CDP", "");
  m.playwrightAvailable.mockReset().mockResolvedValue(true);
  m.findChrome.mockReset().mockReturnValue("/opt/chrome");
  m.loadRecipesDetailed.mockReset().mockResolvedValue({ recipes: [], errors: [] });
  m.dryRunRecipe.mockReset();
  m.probeCdp.mockReset().mockResolvedValue({ reachable: true });
  m.driverOptions.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("browser", () => {
  it("an unknown sub command prints the usage", async () => {
    expect(await cmd("fly")).toMatchObject({ code: 2, err: "browser doctor | browser run <rezept-id> --dry" });
  });
});

describe("browser doctor (fakes)", () => {
  it("fails when playwright-core is missing", async () => {
    m.playwrightAvailable.mockResolvedValue(false);
    const r = await cmd("doctor");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[fail] playwright-core fehlt (pnpm install)");
    expect(r.out).toContain("1 Problem(e) beheben.");
  });

  it("local mode: names Chrome and the profile folder, and loads the bundled and extra recipe folders", async () => {
    const r = await cmd("doctor", "--profile-dir", "/tmp/profile", "--chrome-path", "/opt/chrome", "--recipes", "/extra");
    expect(m.findChrome).toHaveBeenCalledWith("/opt/chrome");
    expect(m.loadRecipesDetailed.mock.calls[0]![0]).toHaveLength(2);
    expect(m.loadRecipesDetailed.mock.calls[0]![0][1]).toBe("/extra");
    expect(r.out).toContain("[ok  ] playwright-core installiert");
    expect(r.out).toContain("[ok  ] Mode: local Chrome");
    expect(r.out).toContain("[ok  ] Chrome gefunden: /opt/chrome");
    expect(r.out).toContain("Profilordner: /tmp/profile (wird beim ersten Lauf angelegt, Modus 700)");
    expect(r.out).toContain("[warn] Keine Rezepte gefunden");
    expect(r.code).toBe(0);
  });

  it("local mode on Windows mentions the user profile instead of mode 700", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect((await cmd("doctor")).out).toContain("Schutz ueber das Benutzerprofil");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("local mode: no Chrome at the usual places is only a warning with the install hint", async () => {
    m.findChrome.mockReturnValue(undefined);
    const r = await cmd("doctor");
    expect(r.out).toContain('[warn] Kein Chrome an den ueblichen Orten; es wird channel "chrome" versucht.');
    expect(r.code).toBe(0);
  });

  it("local mode: a --chrome-path that does not exist fails", async () => {
    m.findChrome.mockImplementation(() => {
      throw new Error("Chrome nicht gefunden unter /nope.");
    });
    const r = await cmd("doctor", "--chrome-path", "/nope");
    expect(r.out).toContain("[fail] Chrome nicht gefunden unter /nope.");
    expect(r.code).toBe(1);
  });

  it("lists valid recipes with their status comment and reports invalid ones", async () => {
    const withStatus = await recipeFile("# STATUS: nur Probelauf getestet\nid: acme-token\n");
    const without = await recipeFile("id: other\n");
    m.loadRecipesDetailed.mockResolvedValue({
      recipes: [{ recipe: recipe({ hosts: { app: "app.acme.test", api: "api.acme.test" } }), file: withStatus }, { recipe: recipe({ id: "other" }), file: without }],
      errors: [{ message: "broken.yaml: step 3 unknown" }],
    });
    const r = await cmd("doctor");
    expect(r.out).toContain("[ok  ] Rezept acme-token (app.acme.test, api.acme.test): nur Probelauf getestet");
    expect(r.out).toContain("[ok  ] Rezept other (acme.test): kein Status-Kommentar");
    expect(r.out).toContain("[fail] Rezept ungueltig: broken.yaml: step 3 unknown");
    expect(r.code).toBe(1);
  });

  it("remote mode: an endpoint that answers without a browser name", async () => {
    m.probeCdp.mockResolvedValue({ reachable: true });
    const r = await cmd("doctor", "--cdp", "http://127.0.0.1:9222");
    expect(r.out).toContain("[ok  ] Remote browser answers\n");
    expect(m.findChrome).not.toHaveBeenCalled();
  });

  it("remote mode: an endpoint that does not answer and gives no detail", async () => {
    m.probeCdp.mockResolvedValue({ reachable: false });
    const r = await cmd("doctor", "--cdp", "http://127.0.0.1:9222");
    expect(r.out).toContain("[fail] Remote browser not reachable: no answer");
    expect(r.code).toBe(1);
  });
});

describe("browser run (fakes)", () => {
  const found = (r = recipe()) => m.loadRecipesDetailed.mockResolvedValue({ recipes: [{ recipe: r, file: "r.yaml" }], errors: [] });
  const result = (over: Record<string, unknown> = {}) => ({ executed: 3, screenshots: [], ...over });

  it("needs a recipe id", async () => {
    const r = await cmd("run", "--dry");
    expect(r).toMatchObject({ code: 2 });
    expect(r.err).toContain("browser run <rezept-id> --dry");
  });

  it("only the dry run is possible from the command line", async () => {
    const r = await cmd("run", "acme-token");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Nur der Probelauf ist ueber die Kommandozeile moeglich: --dry");
    expect(m.dryRunRecipe).not.toHaveBeenCalled();
  });

  it("an unknown recipe lists the known ones and the load errors", async () => {
    m.loadRecipesDetailed.mockResolvedValue({ recipes: [{ recipe: recipe({ id: "a" }), file: "a" }, { recipe: recipe({ id: "b" }), file: "b" }], errors: [{ message: "bad.yaml: invalid" }] });
    const r = await cmd("run", "nope", "--dry");
    expect(r.code).toBe(2);
    expect(r.err).toContain("bad.yaml: invalid");
    expect(r.err).toContain("Rezept nope nicht gefunden (bekannt: a, b)");
  });

  it("an unknown recipe with no recipes at all says keine", async () => {
    const r = await cmd("run", "nope", "--dry");
    expect(r.err).toContain("(bekannt: keine)");
  });

  it("dry run: reports progress and waiting for the human, then the summary", async () => {
    found();
    m.dryRunRecipe.mockImplementation(async (_r, _v, _d, hooks) => {
      hooks.onWaitingForHuman({ reason: "Anmeldung", url: "https://acme.test/login" });
      hooks.onWaitingForHuman({ reason: "Code" });
      hooks.onProgress({ index: 1, total: 3, label: "Seite oeffnen" });
      return result();
    });
    const r = await cmd("run", "acme-token", "--dry");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Probelauf acme-token: ein Browserfenster oeffnet sich. Es wird nichts erzeugt.",
        "Warte auf dich im Browserfenster: Anmeldung (https://acme.test/login)",
        "Warte auf dich im Browserfenster: Code",
        "  Schritt 1/3: Seite oeffnen",
        "Fertig: 3 Schritt(e) bis vor das Erzeugen, 0 Beleg(e). Es wurde kein Token angelegt.",
      ].join("\n"),
    );
    expect(m.driverOptions).toEqual([{}]);
  });

  it("passes the browser options to the driver and the login timeout to the run", async () => {
    found();
    m.dryRunRecipe.mockResolvedValue(result());
    await cmd("run", "acme-token", "--dry", "--cdp", "http://127.0.0.1:9222", "--chrome-path", "/opt/chrome", "--profile-dir", "/tmp/profile", "--login-timeout", "5");
    expect(m.driverOptions).toEqual([{ cdpEndpoint: "http://127.0.0.1:9222", chromePath: "/opt/chrome", profileDir: "/tmp/profile" }]);
    expect(m.dryRunRecipe.mock.calls[0]![4]).toMatchObject({ loginTimeoutMinutes: 5 });
  });

  it("without --login-timeout no timeout is passed", async () => {
    found();
    m.dryRunRecipe.mockResolvedValue(result());
    await cmd("run", "acme-token", "--dry");
    expect(m.dryRunRecipe.mock.calls[0]![4]).not.toHaveProperty("loginTimeoutMinutes");
  });

  it("Ctrl+C aborts the run", async () => {
    found();
    const handlers: (() => void)[] = [];
    vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
      if (event === "SIGINT") handlers.push(handler);
      return process;
    }) as never);
    m.dryRunRecipe.mockResolvedValue(result());
    await cmd("run", "acme-token", "--dry");
    const signal = m.dryRunRecipe.mock.calls[0]![4].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    handlers[0]!();
    expect(signal.aborted).toBe(true);
  });

  it("--out writes one PNG per screenshot and names the folder in the summary", async () => {
    found();
    const out = join(await mkdtemp(join(tmpdir(), "sd-cli-shots-")), "nested");
    m.dryRunRecipe.mockResolvedValue(result({ screenshots: [{ name: "step-1", png: Buffer.from("png-1") }, { name: "step-2", png: Buffer.from("png-2") }] }));
    const r = await cmd("run", "acme-token", "--dry", "--out", out);
    expect(await readFile(join(out, "step-1.png"), "utf8")).toBe("png-1");
    expect(await readFile(join(out, "step-2.png"), "utf8")).toBe("png-2");
    expect(r.out).toContain(`2 Beleg(e) in ${out}.`);
  });

  describe("variables for the recipe", () => {
    const varsOf = () => m.dryRunRecipe.mock.calls[0]![1] as Record<string, string>;
    beforeEach(() => m.dryRunRecipe.mockResolvedValue(result()));

    it("defaults: parameter defaults, today's date, a generated name, dev stage", async () => {
      found(recipe({ params: [{ key: "scope", default: "read" }, { key: "region" }] }));
      await cmd("run", "acme-token", "--dry");
      const v = varsOf();
      expect(v).toMatchObject({ scope: "read", region: "", owner: "", days: "30", description: "Probelauf", repos: "", permissions: "", permissionsQuery: "", stage: "dev", secretId: "probelauf" });
      expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.name).toBe(`acme-token-probe-${v.date!.replaceAll("-", "")}`);
    });

    it("explicit options win; permissions become an encoded query; a long generated name is cut to 40 characters", async () => {
      found(recipe({ id: "a-very-long-recipe-identifier-that-goes-on" }));
      await cmd("run", "a-very-long-recipe-identifier-that-goes-on", "--dry", "--name", "my-token", "--owner", "me", "--days", "7", "--date", "2026-03-01", "--description", "d", "--repos", "a,b", "--permissions", "read=a b,write", "--stage", "staging", "--secret-id", "s1");
      expect(varsOf()).toMatchObject({ name: "my-token", owner: "me", days: "7", date: "2026-03-01", description: "d", repos: "a,b", permissions: "read=a b,write", permissionsQuery: "read=a%20b&write", stage: "staging", secretId: "s1" });
      m.dryRunRecipe.mockClear();
      await cmd("run", "a-very-long-recipe-identifier-that-goes-on", "--dry", "--date", "2026-03-01");
      expect(varsOf().name).toBe("a-very-long-recipe-identifier-that-goes-on-probe-20260301".slice(0, 40));
      expect(varsOf().name).toHaveLength(40);
    });

    it("--param overrides a default", async () => {
      found(recipe({ params: [{ key: "scope", default: "read" }] }));
      await cmd("run", "acme-token", "--dry", "--param", "scope=write=all");
      expect(varsOf().scope).toBe("write=all");
    });

    it("an unknown --param fails and names the known ones", async () => {
      found(recipe({ params: [{ key: "scope" }, { key: "region" }] }));
      const r = await cmd("run", "acme-token", "--dry", "--param", "zone=1");
      expect(r.code).toBe(2);
      expect(r.err).toContain("--param zone: das Rezept acme-token kennt diesen Parameter nicht (bekannt: scope, region)");
      expect(m.dryRunRecipe).not.toHaveBeenCalled();
    });

    it("a --param without = is rejected; a recipe without parameters says keine", async () => {
      found(recipe());
      const r = await cmd("run", "acme-token", "--dry", "--param", "scope");
      expect(r.code).toBe(2);
      expect(r.err).toContain("--param scope: das Rezept acme-token kennt diesen Parameter nicht (bekannt: keine)");
    });
  });

  it("a recipe run error is reported with its kind and exits 1", async () => {
    found();
    m.dryRunRecipe.mockRejectedValue(new RecipeRunError("timeout", "Anmeldung nicht rechtzeitig."));
    const r = await cmd("run", "acme-token", "--dry");
    expect(r).toMatchObject({ code: 1 });
    expect(r.err).toBe("Abbruch (timeout): Anmeldung nicht rechtzeitig.");
  });

  it("any other error ends the command with exit 2", async () => {
    found();
    m.dryRunRecipe.mockRejectedValue(new Error("driver crashed"));
    expect(await cmd("run", "acme-token", "--dry")).toMatchObject({ code: 2, err: "Fehler: driver crashed" });
  });
});
