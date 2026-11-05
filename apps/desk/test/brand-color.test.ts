import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDORS } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { BRAND_ICONS } from "../src/lib/brand-icons";
import { BRAND_ICONS as GENERATED_ICONS } from "../src/lib/brand-icons.generated";
import { CUSTOM_BRAND_ICONS } from "../src/lib/brand-icons.custom";
import { DARK_SURFACE, LIGHT_SURFACE, MIN_CONTRAST, brandFill, contrast, luminance, monogram } from "../src/lib/brand-color";

describe("brand-color", () => {
  it("measures contrast like WCAG", () => {
    expect(contrast("000000", "ffffff")).toBeCloseTo(21, 0);
    expect(contrast("ffffff", "ffffff")).toBeCloseTo(1, 5);
    expect(luminance("not a color")).toBeNaN();
  });
  it("keeps a brand color only where it reads on both the light and the dark surface", () => {
    const keep = Object.entries(BRAND_ICONS).filter(([, i]) => brandFill(i.hex).startsWith("#"));
    for (const [, i] of keep) {
      expect(contrast(i.hex, LIGHT_SURFACE)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(i.hex, DARK_SURFACE)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
  it("falls back to the text color for near-black and near-white brands", () => {
    expect(brandFill("181717")).toBe("currentColor"); // GitHub black on a dark surface
    expect(brandFill("000000")).toBe("currentColor");
    expect(brandFill("FFFFFF")).toBe("currentColor");
    expect(brandFill("#635BFF")).toBe("#635BFF");
  });
  it("builds monograms for providers without a logo", () => {
    expect(monogram("OpenAI")).toBe("OP");
    expect(monogram("Vessel API")).toBe("VA");
    expect(monogram("acme-license")).toBe("AL");
    expect(monogram("  ")).toBe("?");
  });
});

describe("bundled logos", () => {
  it("has a logo for every vendor that names one, and only those", () => {
    const wanted = new Set(VENDORS.map((v) => v.icon).filter((x): x is string => x !== null));
    expect(new Set(Object.keys(BRAND_ICONS))).toEqual(wanted);
  });
  it("holds plain SVG path data and a hex color, nothing to fetch", () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.hex, slug).toMatch(/^[0-9A-F]{6}$/);
      expect(icon.path, slug).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,\-eE]+$/);
      expect(icon.path.length, slug).toBeGreaterThan(20);
    }
  });
  it("resolves the hand-kept marks for OpenAI, Peecho and VesselAPI through the same map", () => {
    for (const id of ["openai", "peecho", "vesselapi"]) {
      const slug = VENDORS.find((v) => v.id === id)?.icon;
      expect(slug, id).toBe(id);
      expect(BRAND_ICONS[slug as string], id).toBe(CUSTOM_BRAND_ICONS[id]);
      expect(GENERATED_ICONS[id], `${id} is not in simple-icons`).toBeUndefined();
    }
  });
  it("draws multi-colour marks from valid layers with their own colours", () => {
    const layered = Object.entries(CUSTOM_BRAND_ICONS).filter(([, i]) => i.layers);
    expect(layered.map(([slug]) => slug)).toEqual(["peecho"]);
    for (const [slug, icon] of layered) {
      expect(icon.layers!.length, slug).toBeGreaterThan(1);
      for (const l of icon.layers!) {
        expect(l.path, slug).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,\-eE]+$/);
        expect(l.fill, slug).toMatch(/^[0-9A-F]{6}$/);
      }
    }
  });
  it("draws every vendor with a logo or, without one, a monogram", () => {
    for (const v of VENDORS) {
      if (v.icon === null) expect(monogram(v.label), v.id).not.toBe("?");
      else expect(BRAND_ICONS[v.icon], v.id).toBeDefined();
    }
  });
  it("comes from the licensed package: the notices list simple-icons under CC0-1.0", () => {
    const notices = readFileSync(join(__dirname, "../../../THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notices).toMatch(/\| simple-icons \| [\d.]+ \| CC0-1\.0 \|/);
  });
});
