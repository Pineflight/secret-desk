import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED, classify, collect, normalizeLicense, platformFamily, policyReport, renderJson, renderNotices } from "../../../scripts/licenses-lib.mjs";

async function fakeInstall(pkgs: Record<string, { version: string; license?: unknown; os?: string[] }>) {
  const root = await mkdtemp(join(tmpdir(), "sd-lic-"));
  const deps: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(pkgs)) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: p.version, ...(p.license !== undefined ? { license: p.license } : {}), ...(p.os ? { os: p.os } : {}), repository: `git+https://github.com/x/${name.replace("@", "").replace("/", "-")}.git` }));
    deps[name] = { version: p.version, path: dir };
  }
  return [{ name: "root", dependencies: deps }];
}

describe("license policy", () => {
  it("allows the permissive list and warns for MPL-2.0", () => {
    for (const id of ALLOWED) expect(classify(id)).toBe("allowed");
    expect(classify("MPL-2.0")).toBe("warn");
  });
  it("rejects GPL/AGPL and unknown, flags other known licenses for review", () => {
    expect(classify("GPL-3.0-only")).toBe("denied");
    expect(classify("AGPL-3.0-or-later")).toBe("denied");
    expect(classify("UNKNOWN")).toBe("unknown");
    expect(classify("LGPL-3.0-or-later")).toBe("review");
    expect(classify("CC-BY-4.0")).toBe("review");
  });
  it("handles SPDX expressions: OR takes the best, AND the worst", () => {
    expect(classify("MIT OR GPL-3.0-only")).toBe("allowed");
    expect(classify("(MIT OR Apache-2.0) AND BSD-3-Clause")).toBe("allowed");
    expect(classify("MIT AND GPL-3.0-only")).toBe("denied");
    expect(classify("Apache-2.0 AND LGPL-3.0-or-later")).toBe("review");
  });
  it("normalizes the license field variants", () => {
    expect(normalizeLicense({ license: "MIT" })).toBe("MIT");
    expect(normalizeLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(normalizeLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
    expect(normalizeLicense({})).toBe("UNKNOWN");
  });
  it("recognizes platform binary families", () => {
    expect(platformFamily("@next/swc-darwin-arm64")).toBe("@next/swc-*");
    expect(platformFamily("@img/sharp-libvips-linuxmusl-x64")).toBe("@img/sharp-libvips-*");
    expect(platformFamily("react")).toBeNull();
  });
});

describe("collect and render", () => {
  it("is deterministic, sorted, and free of paths and timestamps", async () => {
    const a = await fakeInstall({ zeta: { version: "1.0.0", license: "MIT" }, alpha: { version: "2.0.0", license: "ISC" } });
    const b = await fakeInstall({ alpha: { version: "2.0.0", license: "ISC" }, zeta: { version: "1.0.0", license: "MIT" } });
    const da = collect("/ignored", a);
    const db = collect("/ignored", b);
    expect(renderNotices(da)).toBe(renderNotices(db));
    expect(renderJson(da)).toBe(renderJson(db));
    expect(da.entries.map((e: { name: string }) => e.name)).toEqual(["alpha", "zeta"]);
    expect(renderNotices(da)).not.toMatch(/sd-lic-|\/tmp|\/var\/folders|20\d\d-\d\d-\d\d/);
  });
  it("detects a forbidden test license and fails the policy", async () => {
    const inst = await fakeInstall({ fine: { version: "1.0.0", license: "MIT" }, copyleft: { version: "1.0.0", license: "GPL-3.0-only" }, nolicense: { version: "1.0.0" } });
    const data = collect("/ignored", inst);
    const r = policyReport(data);
    expect(r.ok).toBe(false);
    expect(r.fail.map((e: { name: string }) => e.name).sort()).toEqual(["copyleft", "nolicense"]);
  });
  it("only allowed licenses pass; warnings do not fail", async () => {
    const inst = await fakeInstall({ a: { version: "1.0.0", license: "MIT" }, b: { version: "1.0.0", license: "MPL-2.0" } });
    const r = policyReport(collect("/ignored", inst));
    expect(r.ok).toBe(true);
    expect(r.warn.map((e: { name: string }) => e.name)).toEqual(["b"]);
  });
  it("platform packages are listed as families by name only", async () => {
    const inst = await fakeInstall({ "@next/swc-darwin-arm64": { version: "16.0.0", license: "MIT", os: ["darwin"] }, next: { version: "16.0.0", license: "MIT" } });
    const d = collect("/ignored", inst);
    expect(d.entries.map((e: { name: string }) => e.name)).toEqual(["next"]);
    expect(d.families.map((f: { name: string }) => f.name)).toEqual(["@next/swc-*"]);
    expect(renderNotices(d)).toContain("- @next/swc-*");
  });
  it("skips the own workspace packages", async () => {
    const inst = await fakeInstall({ "@secret-desk/core": { version: "0.1.0", license: "MIT" }, left: { version: "1.0.0", license: "MIT" } });
    expect(collect("/ignored", inst).entries.map((e: { name: string }) => e.name)).toEqual(["left"]);
  });
});
