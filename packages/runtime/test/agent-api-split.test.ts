import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as nodeApi from "../src/agent-api.js";
import * as core from "../src/agent-api-core.js";
import * as connectionCheck from "../src/connection-check.js";
import * as facade from "../src/facade.js";
import * as registry from "../src/facade-registry.js";
import * as known from "../src/known-connections.js";
import * as portable from "../src/portable.js";
import * as teamSync from "../src/team-sync.js";
import * as rights from "../src/team-token-rights.js";
import { posixBasename } from "../src/path-basename.js";

// `agent-api.ts` was split into `agent-api-core.ts` (portable) and what stays on the Node side. Nothing may be lost on the way: every
// value exported by `agent-api.ts` before the split (the list below is that module's export list on the commit before the split) is
// still exported from `agent-api.ts` and from the root, and where it moved it is the very same object as in the core module.
const MOVED = [
  "PolicyError", "IssuanceGoneError", "requireHuman", "actorRef", "SYSTEM_ROUTINES", "authorize", "authorizeSystem", "DEFAULT_AUTHORIZE_TIMEOUT_MS", "listSecrets", "getSecret",
  "overview", "listVendors", "listProviders", "listConnections", "AGENT_ENV_FILENAME", "addSecret", "preflightSecret", "updateSecretMeta", "addManualProvider", "addEnvTemplate",
  "addEnvEntry", "teamExport", "getAutomation", "getAutomationRun", "cancelAutomationRun", "requestIssuance", "submitManualValue", "listIssuances", "getIssuance", "confirmIssuance",
  "IssuanceWrittenError", "rejectIssuance", "listEvidence", "getEvidence", "attachEvidence", "readAttachment", "listVariables", "getVariable", "inspectVariableLive", "addVariable",
  "updateVariable", "removeVariable", "requestApplyVariable", "adoptVariableFromGitHub", "listApprovals", "getApproval", "resolveApproval",
] as const;
/** Stayed on the Node side: `exportEnv` needs the file system and the host, `evidenceSvg` binds the English catalogue (a wrapper of the core function). */
const STAYED = ["exportEnv", "evidenceSvg"] as const;

describe("the split of agent-api.ts loses no export", () => {
  it("every moved name is exported by agent-api.ts and the root, and is the same object as in the core module", () => {
    for (const name of MOVED) {
      expect(core[name], name).toBeDefined();
      expect(nodeApi[name], name).toBe(core[name]);
      expect(root[name], name).toBe(core[name]);
    }
  });

  it("the names that stayed are exported by agent-api.ts and the root, and are not on the portable entry as the same function where they differ", () => {
    for (const name of STAYED) {
      expect(nodeApi[name], name).toBeTypeOf("function");
      expect(root[name], name).toBe(nodeApi[name]);
    }
    expect(nodeApi.exportEnv).not.toBe((core as Record<string, unknown>)["exportEnv"]);
    // The local `evidenceSvg` wraps the core function and has the same public signature.
    expect(nodeApi.evidenceSvg).not.toBe(core.evidenceSvg);
    expect(nodeApi.evidenceSvg.length).toBe(3);
    expect(portable.evidenceSvg).toBe(core.evidenceSvg);
  });

  it("the portable entry exports the moved functions as the very same objects", () => {
    for (const name of MOVED) expect(portable[name], name).toBe(core[name]);
    // Everything the entry has under a name of the core module is the core module's own.
    for (const name of Object.keys(core)) if (name in portable) expect((portable as Record<string, unknown>)[name], name).toBe((core as Record<string, unknown>)[name]);
  });

  it("what was taken out of other modules is re-exported by them as the same objects", () => {
    expect(connectionCheck.KNOWN_CONNECTIONS).toBe(known.KNOWN_CONNECTIONS);
    expect(root.KNOWN_CONNECTIONS).toBe(known.KNOWN_CONNECTIONS);
    expect(teamSync.neededRights).toBe(rights.neededRights);
    expect(teamSync.teamPermissions).toBe(rights.teamPermissions);
    expect(root.neededRights).toBe(rights.neededRights);
    expect(root.teamPermissions).toBe(rights.teamPermissions);
    expect(facade.FACADES).toBe(registry.FACADES);
    expect(facade.facadeById).toBe(registry.facadeById);
    expect(facade.facadeConnectionForRecipe).toBe(registry.facadeConnectionForRecipe);
    expect(root.FACADES).toBe(registry.FACADES);
    expect(root.facadeById).toBe(registry.facadeById);
    expect(root.facadeConnectionForRecipe).toBe(registry.facadeConnectionForRecipe);
  });

  it("the new helper of the core module accepts exactly the file names the old one accepted", () => {
    for (const [path, allowed] of [
      [".env", true], [".env.local", true], ["/a/b/.env.development", true], ["C:\\work\\app\\.env", true], ["a/.env/", true], [".envrc", false], ["Makefile", false], ["x/.env.sh", false], ["", false], ["/", false],
    ] as const) expect(core.agentMayWriteEnvFile(path), path).toBe(allowed);
  });
});

describe("posixBasename", () => {
  it("answers like path.posix.basename over a table of paths", () => {
    const table = [
      "", "/", "//", "///", "a", "a/", "a//", "/a", "/a/", "a/b", "a/b/", "a/b//", "/a/b/c.txt", "a/.env", ".env", "./.env.local", "../x/y", "a//b", "//a//b//", "dir/with space/f ile", "no-slash.ext", "trailing/dot.", "x/..", "x/.", "ü/ö", "back\\slash", "a/b\\c/d",
    ];
    for (const path of table) expect(posixBasename(path), JSON.stringify(path)).toBe(posix.basename(path));
  });
});
