import { BRAND_ICONS as GENERATED_ICONS, type BrandIcon } from "./brand-icons.generated";
import { CUSTOM_BRAND_ICONS, type BrandLayer } from "./brand-icons.custom";

export type { BrandIcon, BrandLayer };

/** A logo as the page draws it: one monochrome path, or `layers` for a hand-kept multi-colour mark. */
export type DrawnBrandIcon = BrandIcon & { layers?: BrandLayer[] };

/** Every logo the page can draw: the generated simple-icons ones plus the hand-kept marks of `brand-icons.custom.ts`. */
export const BRAND_ICONS: Record<string, DrawnBrandIcon> = { ...GENERATED_ICONS, ...CUSTOM_BRAND_ICONS };
