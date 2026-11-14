import type { ConnectionHost } from "@secret-desk/core";

/** A host that answers `env` from a plain object (own string properties only) and offers nothing else. Made-up values only. */
export function envHost(env: Record<string, string | undefined>): ConnectionHost {
  return { label: "test", env: (name) => (Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined) };
}
