import { readFile } from "node:fs/promises";
import { parseConfig, type DeskConfig } from "./config-core.js";

// The schema, the parser and the helpers live in `config-core.ts` (portable). This module is the Node facade: it adds
// `loadConfig`, which reads the file. Everything that moved is re-exported, so imports of `config.js` keep working.
export {
  agentStageIds,
  ConfigSchema,
  parseCdpEndpoint,
  parseConfig,
  redactCdpEndpoint,
  SourceSpecSchema,
  TEAM_SYNC_CONNECTION,
  TeamSyncSchema,
  type DeskConfig,
  type ProviderConfig,
  type TeamSyncConfig,
} from "./config-core.js";

export async function loadConfig(path: string): Promise<DeskConfig> {
  return parseConfig(await readFile(path, "utf8"));
}
