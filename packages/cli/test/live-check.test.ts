import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

const FAKE_VALUE = "made-up-resend-value-for-live-check-tests";
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(extra = "") {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "sd-cli-live-check-"));
  await mkdir(join(dir, "data"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  const config = join(dir, "secret-desk.config.yaml");
  await writeFile(
    config,
    `inventory: ./inventory.yaml\nvault: { enabled: false }\nlinksFile: ${join(dir, "data", "repo-links.json")}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_LC_GITHUB } }\nconnections:\n  resend: { type: env, name: SD_CLI_LC_RESEND }\nserver:\n  port: ${port}\nautomation:\n  enabled: false\n${extra}`,
  );
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const seed = async (reports: unknown[]) => writeFile(join(dir, "data", "live-check-state.json"), JSON.stringify({ version: 1, reports }));
  return { dir, config, out, err, io, seed, port };
}

const connection = (id: string, result: string, detail?: string) => ({ id, result, ...(detail ? { detail } : {}) });
const report = (ageDays: number, over: Record<string, unknown> = {}) => {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  return { startedAt: at, finishedAt: at, ok: true, trigger: "schedule", connections: [connection("github", "ok"), connection("resend", "not-connected")], recipes: [{ id: "openai-api-key", result: "ok" }], ...over };
};

describe("secret-desk live-check", () => {
  it("exits 1 and says so when there is no report yet", async () => {
    const { config, io, out } = await setup();
    expect(await main(["live-check", "--config", config], io)).toBe(1);
    expect(out.join("\n")).toMatch(/Noch kein Live-Check-Bericht/);
    out.length = 0;
    expect(await main(["live-check", "--config", config, "--json"], io)).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, reason: "none", intervalDays: 7, needsSignIn: 0, report: null });
  });

  it("prints the last report and exits 0 when it is fine and recent", async () => {
    const { config, io, out, seed } = await setup();
    await seed([report(1)]);
    expect(await main(["live-check", "--config", config], io)).toBe(0);
    expect(out[0]).toMatch(/^Live-Check in Ordnung: .+ \(automatisch\)$/);
    expect(out[1]).toBe("Integrationen: 1 in Ordnung, 0 fehlgeschlagen, 1 nicht verbunden");
    expect(out[2]).toBe("Rezepte: 1 in Ordnung, 0 fehlgeschlagen, 0 brauchen Anmeldung, 0 uebersprungen");
    expect(out.slice(3)).toEqual(["[not-connected] Verbindung resend"]);
  });

  it("exits 1 for a failed report and names the failing items with step, kind and sanitized detail", async () => {
    const { config, io, out, seed } = await setup();
    await seed([
      report(0.5, {
        ok: false,
        trigger: "manual",
        connections: [connection("resend", "failed", "Key valid: HTTP 401")],
        recipes: [
          { id: "broken", result: "failed", step: 'click button "Create"', kind: "step", detail: "Step 2 failed." },
          { id: "sign", result: "needs-sign-in", step: "goto" },
          { id: "list", result: "skipped", detail: "All steps work on a list of real items." },
          { id: "bare", result: "failed" },
        ],
      }),
    ]);
    expect(await main(["live-check", "--config", config], io)).toBe(1);
    expect(out[0]).toMatch(/^Live-Check FEHLGESCHLAGEN: .+ \(von Hand\)$/);
    expect(out.slice(3)).toEqual([
      "[failed       ] Verbindung resend: Key valid: HTTP 401",
      '[failed       ] Rezept broken (click button "Create", step): Step 2 failed.',
      "[needs-sign-in] Rezept sign (goto)",
      "[skipped      ] Rezept list: All steps work on a list of real items.",
      "[failed       ] Rezept bare",
      "WARNUNG: 1 Rezepte konnten nicht geprueft werden: bitte anmelden.",
    ]);
  });

  it("exits 1 for a report older than twice the interval, 0 when the schedule is off", async () => {
    const stale = await setup();
    await stale.seed([report(20)]);
    expect(await main(["live-check", "--config", stale.config], stale.io)).toBe(1);
    expect(stale.out.at(-1)).toBe("Der letzte Bericht ist aelter als 14 Tage (das Doppelte des Intervalls): die geplante Pruefung kommt nicht hinterher.");
    stale.out.length = 0;
    expect(await main(["live-check", "--config", stale.config, "--json"], stale.io)).toBe(1);
    expect(JSON.parse(stale.out[0]!)).toMatchObject({ ok: false, reason: "stale", intervalDays: 7 });
    const edge = await setup();
    await edge.seed([report(13)]);
    expect(await main(["live-check", "--config", edge.config], edge.io)).toBe(0);
    const off = await setup("  liveCheckDays: 0\n");
    await off.seed([report(200)]);
    expect(await main(["live-check", "--config", off.config], off.io)).toBe(0);
  });

  it("recipes that need a sign-in could not be checked: a warning and exit 0, exit 1 only with --strict", async () => {
    const { config, io, out, seed } = await setup();
    await seed([report(1, { recipes: [{ id: "a", result: "needs-sign-in", step: "goto" }, { id: "b", result: "needs-sign-in" }] })]);
    expect(await main(["live-check", "--config", config], io)).toBe(0);
    expect(out.at(-1)).toBe("WARNUNG: 2 Rezepte konnten nicht geprueft werden: bitte anmelden. (Exit 0; mit --strict ist das ein Fehler.)");
    out.length = 0;
    expect(await main(["live-check", "--config", config, "--strict"], io)).toBe(1);
    expect(out.at(-1)).toBe("WARNUNG: 2 Rezepte konnten nicht geprueft werden: bitte anmelden.");
    out.length = 0;
    expect(await main(["live-check", "--config", config, "--json"], io)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, reason: null, needsSignIn: 2 });
    out.length = 0;
    expect(await main(["live-check", "--config", config, "--json", "--strict"], io)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, reason: "needs-sign-in", needsSignIn: 2 });
  });

  it("--strict changes nothing for a report without unchecked recipes", async () => {
    const { config, io, seed } = await setup();
    await seed([report(1)]);
    expect(await main(["live-check", "--config", config, "--strict"], io)).toBe(0);
  });

  it("--json prints the whole report for machines", async () => {
    const { config, io, out, seed } = await setup();
    await seed([report(1)]);
    expect(await main(["live-check", "--config", config, "--json"], io)).toBe(0);
    const doc = JSON.parse(out[0]!);
    expect(doc).toMatchObject({ ok: true, reason: null, intervalDays: 7 });
    expect(doc.report.connections).toHaveLength(2);
    expect(doc.report.summary.connections).toEqual({ ok: 1, failed: 0, notConnected: 1 });
  });

  it("--run runs a check in this process first, stores it for the portal and exits 0 when nothing failed", async () => {
    const { config, io, out, dir } = await setup();
    expect(await main(["live-check", "--config", config, "--run"], io)).toBe(0);
    expect(out[0]).toMatch(/^Live-Check in Ordnung: .+ \(von Hand\)$/);
    const stored = JSON.parse(await readFile(join(dir, "data", "live-check-state.json"), "utf8"));
    expect(stored.reports).toHaveLength(1);
    out.length = 0;
    // A second call without --run reads what the first one stored.
    expect(await main(["live-check", "--config", config], io)).toBe(0);
    expect(out[0]).toMatch(/\(von Hand\)/);
  });

  it("--run is refused while something listens on the portal port, and checks nothing", async () => {
    const { config, io, out, err, port, dir } = await setup();
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      expect(await main(["live-check", "--config", config, "--run"], io)).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(err.join("\n")).toMatch(new RegExp(`127\\.0\\.0\\.1:${port} laeuft bereits ein Portal.*Jetzt pruefen`));
    expect(out).toEqual([]);
    await expect(readFile(join(dir, "data", "live-check-state.json"), "utf8")).rejects.toThrow();
  });

  it("--run exits 1 when an integration fails, and no value appears in the output", async () => {
    const { config, io, out, err } = await setup();
    vi.stubEnv("SD_CLI_LC_RESEND", FAKE_VALUE);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response(`{"message":"rejected ${FAKE_VALUE}"}`, { status: 401 });
      }) as unknown as typeof fetch,
    );
    expect(await main(["live-check", "--config", config, "--run"], io)).toBe(1);
    expect(out.join("\n")).toMatch(/\[failed\s+\] Verbindung resend/);
    expect(out.join("\n") + err.join("\n")).not.toContain(FAKE_VALUE);
    expect(calls).toEqual(["GET https://api.resend.com/api-keys"]);
  });

  it("needs --config", async () => {
    const { io, err } = await setup();
    expect(await main(["live-check"], io)).toBe(2);
    expect(err[0]).toMatch(/live-check --config <datei>/);
  });

  it("is listed in the help", async () => {
    const { io, out } = await setup();
    await main(["help"], io);
    expect(out.join("\n")).toMatch(/live-check\s+Letzten Live-Check/);
  });
});
