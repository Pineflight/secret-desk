import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readAbout } from "../src/about.js";

async function fixture(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-about-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "secret-desk", version: "9.8.7", description: "A test", license: "MIT" }));
  await writeFile(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Someone\n");
  await writeFile(join(dir, "third-party.json"), JSON.stringify({ components: [{ name: "left-pad", version: "1.0.0", license: "MIT", source: "x", status: "allowed" }], platformFamilies: ["@next/swc-*"] }));
  return { dir, tp: join(dir, "third-party.json"), env: extra as NodeJS.ProcessEnv };
}

describe("readAbout", () => {
  it("reads version, license text and third-party components from local files", async () => {
    const f = await fixture();
    const a = readAbout({ rootDir: f.dir, thirdPartyFile: f.tp, env: f.env });
    expect(a).toMatchObject({ name: "secret-desk", version: "9.8.7", createdBy: "Pineflight", license: "MIT", buildTag: null, commit: null });
    expect(a.licenseText).toContain("MIT License");
    expect(a.thirdParty).toHaveLength(1);
    expect(a.platformFamilies).toEqual(["@next/swc-*"]);
    expect(a.links.source).toBe("https://github.com/Pineflight/secret-desk");
  });
  it("build arguments override the version and add tag and commit (short)", async () => {
    const f = await fixture({ SECRET_DESK_VERSION: "1.2.3", SECRET_DESK_BUILD_TAG: "v1.2.3-45", SECRET_DESK_COMMIT: "0123456789abcdef0123" });
    const a = readAbout({ rootDir: f.dir, thirdPartyFile: f.tp, env: f.env });
    expect(a).toMatchObject({ version: "1.2.3", buildTag: "v1.2.3-45", commit: "0123456789ab" });
  });
  it("missing files give defaults instead of an error", () => {
    const a = readAbout({ rootDir: "/nonexistent-dir", thirdPartyFile: "/nonexistent/x.json", env: {} as NodeJS.ProcessEnv });
    expect(a).toMatchObject({ version: "0.0.0", license: "MIT", licenseText: "", thirdParty: [] });
  });
  it("carries no values, tokens or paths", async () => {
    const f = await fixture({ GH_TOKEN: "token_value_not_exposed" });
    const text = JSON.stringify(readAbout({ rootDir: f.dir, thirdPartyFile: f.tp, env: f.env }));
    expect(text).not.toContain("token_value_not_exposed");
    expect(text).not.toContain(f.dir);
  });
});

// Beleg fuer die Datenschutzaussage auf /about und in der README: der Quelltext enthaelt keine Telemetrie und keine Adresse eines Pineflight-Servers.
describe("privacy audit of the source", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  async function sources(dir: string, out: string[] = []): Promise<string[]> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "test"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await sources(p, out);
      else if (/\.(ts|tsx|mjs|yaml)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  it("has no telemetry libraries and no Pineflight host", async () => {
    const files = [...(await sources(join(root, "packages"))), ...(await sources(join(root, "apps", "desk", "src"))), ...(await sources(join(root, "recipes")))];
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(f, "utf8");
      if (/sentry|posthog|mixpanel|plausible\.io|google-analytics|gtag\(|segment\.io|amplitude/i.test(text)) offenders.push(`${f}: telemetry library`);
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]*pineflight[a-z0-9.-]*)/gi)) if (!/^(github\.com)$/i.test(m[1]!)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
  it("only links to the public repository of the project", async () => {
    const text = await readFile(join(root, "packages", "runtime", "src", "about.ts"), "utf8");
    const urls = [...text.matchAll(/https?:\/\/[^"'`\s)]+/g)].map((m) => m[0]);
    for (const u of urls) expect(u).toMatch(/^https:\/\/github\.com\/Pineflight\/secret-desk/);
  });
});
