import type { BrandIcon } from "./brand-icons.generated";

/**
 * Brand marks that the `simple-icons` package does not carry, kept by hand. The vendor catalog names them by slug exactly like a
 * simple-icons logo (`icon` in packages/core/src/vendors.ts); `brand-icons.ts` merges them with the generated map, so the page renders
 * them through the same path (24 x 24 grid, monochrome, colour decided by `brandFill`).
 *
 * Every entry records where the mark comes from. The marks only identify the integration they belong to and stay the trademarks
 * of their owners. `scripts/brand-icons.mjs` skips the slugs listed here.
 */
export const CUSTOM_BRAND_ICONS: Record<string, BrandIcon> = {
  // Source: the penguin mark inside the logo file https://cdn.prod.website-files.com/635f8e3c0124f43ef3012c00/65fc217880715f6b2ee3e175_Peecho%20logo%20FULL.svg
  // (linked from https://www.peecho.com, retrieved 2026-11-04). The body and the beak were taken from that file, converted to one
  // monochrome path (the white triangle is a cut-out) and scaled to 22 x 22 inside the 24 x 24 grid. Colour: the navy of the logo.
  peecho: { title: "Peecho", hex: "252958", path: "M4.86 6.2C4.87 5.62 5.03 5.07 5.28 4.56C6.08 2.84 7.47 1.73 9.37 1.25C11.72 0.65 13.86 1.13 15.67 2.71C16.56 3.48 17.12 4.47 17.38 5.6C17.39 5.68 17.4 5.75 17.41 5.83C17.33 5.92 17.24 5.86 17.16 5.83C15.96 5.42 14.76 5.03 13.57 4.59C12.48 4.2 11.4 4.47 10.72 5.31C10.04 6.15 10.19 7.42 11.05 8.08C11.8 8.67 12.64 8.79 13.54 8.46C14.7 8.03 15.85 7.63 17.01 7.2C17.15 7.16 17.28 7.1 17.42 7.17C17.49 7.24 17.47 7.33 17.47 7.41C17.47 12.51 17.47 17.62 17.48 22.73C17.48 22.94 17.42 23 17.19 23C13.18 22.99 9.15 23 5.14 23C4.83 23 4.79 22.98 4.78 22.68C4.77 21.89 4.73 21.09 4.79 20.31C4.85 19.63 4.84 18.94 4.84 18.25C4.85 14.33 4.84 10.42 4.84 6.49C4.85 6.4 4.83 6.3 4.86 6.2M17.32 7.14C16.86 7.27 16.41 7.44 15.97 7.6C15.16 7.89 14.34 8.16 13.54 8.47C12.32 8.96 10.88 8.41 10.4 7.29C9.89 6.13 10.57 4.82 11.87 4.43C12.45 4.26 13.01 4.31 13.57 4.5C14.82 4.94 16.09 5.36 17.35 5.79C17.36 5.79 17.39 5.79 17.41 5.81C18 6.01 18.59 6.21 19.24 6.44C18.63 6.7 18.04 6.85 17.48 7.09C17.46 7.17 17.36 7.1 17.32 7.14M7.13 21.47V21.47H7.35C10.21 21.47 13.06 21.47 15.92 21.47C15.97 21.47 16.01 21.47 16.06 21.47C16.13 21.47 16.17 21.44 16.17 21.36C16.17 21.32 16.17 21.26 16.17 21.22C16.17 17.42 16.17 13.63 16.17 9.84C16.17 9.79 16.21 9.73 16.13 9.66C13.14 13.59 10.15 17.5 7.13 21.47Z" },
  // Simplified monogram glyph: https://openai.com blocks automated downloads (HTTP 403 on 2026-11-04) and the page offers no vector
  // mark that could be fetched, so this is a plain ring drawn for the catalog, not OpenAI's own mark.
  openai: { title: "OpenAI", hex: "000000", path: "M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20ZM12 6.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z" },
  // Simplified monogram glyph: https://vesselapi.com publishes its logo only as PNG/ICO favicons (retrieved 2026-11-04, no SVG), so
  // this is a small ship drawn for the catalog (hull, deckhouse, bridge, mast, waterline), not VesselAPI's own mark.
  vesselapi: { title: "VesselAPI", hex: "000000", path: "M3 14H21L18 20H6ZM7 11H17V13H7ZM10 8H14V10H10ZM11.5 3H12.5V8H11.5ZM4 22H20V23H4Z" },
};
