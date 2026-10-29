import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { messages } from "../src/messages";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFile(join(here, "..", "src", p), "utf8");

async function deps(): Promise<RouterDeps> {
  const dir = await mkdtemp(join(tmpdir(), "sd-about-r-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_token_made_up_for_about" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  return { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
}
const get = (d: RouterDeps) => new Request("http://127.0.0.1:4747/api/ui/about", { headers: { host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747", cookie: `sd_session=${d.session.cookie}`, "x-secret-desk-csrf": d.session.csrf } });

describe("about API", () => {
  it("returns version, the MIT license text, the creator and the third-party list, without secrets", async () => {
    const d = await deps();
    const r = await route(get(d), d);
    expect(r.status).toBe(200);
    const text = await r.text();
    const a = JSON.parse(text) as { version: string; license: string; licenseText: string; createdBy: string; thirdParty: unknown[]; privacy: { telemetry: boolean } };
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(a.license).toBe("MIT");
    expect(a.licenseText).toContain("MIT License");
    expect(a.createdBy).toBe("Pineflight");
    expect(a.thirdParty.length).toBeGreaterThan(20);
    expect(a.privacy.telemetry).toBe(false);
    expect(text).not.toContain("gh_token_made_up_for_about");
    expect(text).not.toContain(d.session.cookie);
  });
  it("agents may read it too (no secrets in it)", async () => {
    const d = await deps();
    const r = await route(new Request("http://127.0.0.1:4747/api/agent/about", { headers: { host: "127.0.0.1:4747", authorization: `Bearer ${d.agentToken}` } }), d);
    expect(r.status).toBe(200);
  });
});

describe("about page and footer", () => {
  it("texts exist in German and English", () => {
    const keys = Object.keys(messages.de).filter((k) => k.startsWith("about."));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(messages.en[k], k).toBeTruthy();
    expect(messages.de["about.footer"]).toContain("Pineflight");
    expect(messages.en["about.footer"]).toContain("Pineflight");
  });
  it("the footer in the sidebar names Pineflight, links to /about and the repository", async () => {
    const shell = await src("components/Shell.tsx");
    expect(shell).toContain('t("about.footer")');
    expect(shell).toContain('href="/about"');
    expect(shell).toContain("https://github.com/Pineflight/secret-desk");
  });
  it("the page loads nothing from outside: no external src, scripts or styles, only plain links", async () => {
    const page = await src("app/about/page.tsx");
    expect(page).not.toMatch(/(src|href)=["']https?:\/\/(?!github\.com\/Pineflight)/);
    expect(page).not.toMatch(/<script|<link|@import|url\(http/);
    expect(page).toContain('rel="noopener noreferrer"');
    expect(page).toContain('src="/logo.png"');
  });
  it("the Content-Security-Policy stays strict", async () => {
    const cfg = await readFile(join(here, "..", "next.config.ts"), "utf8");
    expect(cfg).toContain("\"default-src 'self'\"");
    expect(cfg).toContain("\"connect-src 'self'\"");
    expect(cfg).not.toMatch(/https?:\/\//);
  });
});
