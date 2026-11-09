import type { ParamSpec } from "@secret-desk/core";

/** A parameter spec with sensible defaults; override what the test needs. */
export const spec = (o: Partial<ParamSpec> & Pick<ParamSpec, "key" | "type">): ParamSpec => ({ label: `${o.key} de`, labelEn: `${o.key} en`, required: false, help: "", helpEn: "", ...o });

/** A discovered resource state with options. */
export const okState = (options: { value: string | number; label: string; detail?: string; suggestedFor?: { score: number; reason: string } }[], suggested: string | number | null = null) => ({ status: "ok" as const, options, suggested });
