import { readFileSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightDriver, RecipeSchema, findChrome, runRecipe } from "../src/index.js";

let chrome: string | undefined;
try {
  chrome = findChrome();
} catch {
  chrome = undefined;
}

const html = readFileSync(resolve(import.meta.dirname, "fixtures/token-form.html"), "utf8");
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

describe.skipIf(!chrome)("PlaywrightDriver gegen lokales Formular", () => {
  it("fuellt aus, erzeugt, liest den Token und verdeckt ihn im Beleg", async () => {
    const recipe = RecipeSchema.parse({
      id: "local-form",
      label: "Lokal",
      host: "127.0.0.1",
      steps: [
        { goto: `http://127.0.0.1:${port}/new?name={{name}}` },
        { fill: { label: "Name", value: "{{name}}" } },
        { select: { label: "Ablauf", value: "90 days" } },
        { check: { label: "Nur lesen" } },
        { screenshot: "vorher" },
        { click: { role: "button", name: "Create token", createsToken: true } },
        { waitFor: { visible: { css: "#tok" } } },
      ],
      capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$" }, externalId: { from: "name" } },
      mask: [{ css: "#tok" }],
    });
    const profileDir = join(await mkdtemp(join(tmpdir(), "sd-profile-")), "p");
    const driver = new PlaywrightDriver({ headless: true, profileDir, ...(chrome ? { chromePath: chrome } : {}) });
    const vars = { name: "demo1", date: "2026-10-27", days: "30" };
    const r = await runRecipe(recipe, vars, driver);
    expect(r.value.reveal()).toBe("tok_demo1ok42");
    expect(r.externalId).toBe("demo1");
    expect(r.screenshots.map((s) => s.name)).toEqual(["vorher", "nach-erzeugen"]);
    for (const s of r.screenshots) expect(s.png.subarray(1, 4).toString()).toBe("PNG");
    expect((await stat(profileDir)).mode & 0o777).toBe(0o700);
  }, 60_000);
});
