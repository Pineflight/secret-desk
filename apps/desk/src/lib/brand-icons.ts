import { BRAND_ICONS as GENERATED_ICONS, type BrandIcon } from "./brand-icons.generated";
import { CUSTOM_BRAND_ICONS } from "./brand-icons.custom";

export type { BrandIcon };

/** Every logo the page can draw: the generated simple-icons ones plus the hand-kept marks of `brand-icons.custom.ts`. */
export const BRAND_ICONS: Record<string, BrandIcon> = { ...GENERATED_ICONS, ...CUSTOM_BRAND_ICONS };
