import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as portable from "../src/portable.js";
import * as root from "../src/index.js";
import * as githubFacade from "../src/github.js";
import * as inventoryFacade from "../src/inventory.js";
import * as connectionsFacade from "../src/connections.js";
import * as envExportFacade from "../src/env-export.js";
import * as configFacade from "../src/config.js";
import * as configCore from "../src/config-core.js";
import * as guards from "../src/guards.js";
import { MAX_TEAM_FILE_BYTES, parseTeamBundle, TeamBundleError } from "../src/team.js";

describe("class identity across the facades and the portable entry", () => {
  it("shares one class per error type", () => {
    expect(githubFacade.GitHubError).toBe(portable.GitHubError);
    expect(githubFacade.GitHubTruncatedError).toBe(portable.GitHubTruncatedError);
    expect(inventoryFacade.InventoryError).toBe(portable.InventoryError);
    expect(connectionsFacade.NotConnectedError).toBe(portable.NotConnectedError);
    expect(envExportFacade.EnvExportError).toBe(portable.EnvExportError);
    expect(envExportFacade.PromptsRequiredError).toBe(portable.PromptsRequiredError);
    expect(root.EnvExportError).toBe(portable.EnvExportError);
    expect(root.NotConnectedError).toBe(portable.NotConnectedError);
  });

  it("keeps the facade clients subclasses of the portable ones", () => {
    expect(Object.getPrototypeOf(githubFacade.GitHubClient)).toBe(portable.GitHubClient);
    expect(Object.getPrototypeOf(inventoryFacade.InventoryStore)).toBe(portable.InventoryStoreCore);
    expect(Object.getPrototypeOf(connectionsFacade.ConnectionStore)).toBe(portable.ConnectionStoreCore);
  });

  it("keeps the instanceof relations of the env export errors", () => {
    const err = new portable.PromptsRequiredError(["A", "B"]);
    expect(err).toBeInstanceOf(envExportFacade.EnvExportError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PromptsRequiredError");
    expect(err.keys).toEqual(["A", "B"]);
    expect(err.message).toBe("Eingabe noetig fuer: A, B");
    const base = new envExportFacade.EnvExportError("boom");
    expect(base.name).toBe("EnvExportError");
    expect(base).not.toBeInstanceOf(portable.PromptsRequiredError);
  });

  it("shares the configuration schema between the facade, the core module and both entries", () => {
    expect(configFacade.ConfigSchema).toBe(configCore.ConfigSchema);
    expect(root.ConfigSchema).toBe(portable.ConfigSchema);
    expect(root.TEAM_SYNC_CONNECTION).toBe(portable.TEAM_SYNC_CONNECTION);
    expect(root.agentStageIds).toBe(portable.agentStageIds);
    expect(root.parseCdpEndpoint).toBe(portable.parseCdpEndpoint);
  });

  it("the root entry still exports every name of the portable modules with the same binding", () => {
    const rootNames: Record<string, unknown> = { ...root };
    for (const [key, value] of Object.entries(portable)) {
      // The Node facades replace these on the root; every other name is the very same binding.
      if (["GitHubClient", "InventoryStore", "ConnectionStore", "githubAppProvider"].includes(key)) continue;
      // The digest helpers are internal: the root surface does not gain them.
      if (["sha256Hex", "sha256HexBytes"].includes(key)) {
        expect(rootNames, key).not.toHaveProperty(key);
        continue;
      }
      expect(rootNames[key], key).toBe(value);
    }
  });
});

describe("parseConfig and loadConfig", () => {
  const MINIMAL = "inventory: inventory.yaml\ngithub:\n  owner: acme\n  auth:\n    type: pat\n";

  it("parses a document without touching the file system", () => {
    const config = configCore.parseConfig(MINIMAL);
    expect(config.inventory).toBe("inventory.yaml");
    expect(config.github.owner).toBe("acme");
    expect(config.server.port).toBe(4747);
  });

  it("reports an invalid document with the same message loadConfig gives", async () => {
    const bad = "inventory: 1\n";
    expect(() => configCore.parseConfig(bad)).toThrow(/^Konfiguration ungueltig: inventory: /);
    const dir = await mkdtemp(join(tmpdir(), "config-core-"));
    const file = join(dir, "config.yaml");
    await writeFile(file, bad);
    await expect(configFacade.loadConfig(file)).rejects.toThrow(/^Konfiguration ungueltig: inventory: /);
    await writeFile(file, MINIMAL);
    await expect(configFacade.loadConfig(file)).resolves.toEqual(configCore.parseConfig(MINIMAL));
  });

  it("lets a YAML syntax error through unchanged", () => {
    expect(() => configCore.parseConfig("inventory: [unclosed")).toThrow();
  });
});

describe("team file size is counted in UTF-8 bytes", () => {
  it("rejects a text that is short in characters but over the limit in bytes", () => {
    const text = "€".repeat(Math.floor(MAX_TEAM_FILE_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(MAX_TEAM_FILE_BYTES);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_TEAM_FILE_BYTES);
    expect(() => parseTeamBundle(text)).toThrow(TeamBundleError);
  });

  it("counts a lone surrogate as three bytes, like Buffer does", () => {
    const text = "\ud800".repeat(Math.floor(MAX_TEAM_FILE_BYTES / 3) + 1);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_TEAM_FILE_BYTES);
    expect(() => parseTeamBundle(text)).toThrow(/groesser als 1 MiB/);
  });
});

describe("looksSecret reads the JWT payload like Buffer did", () => {
  const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
  const jwt = (payload: string): string => `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
  /** The previous decoder, kept here as the reference. */
  const referenceRole = (value: string): string | null => {
    const parts = value.split(".");
    if (parts.length !== 3 || !value.startsWith("eyJ")) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { role?: string };
      return payload.role ?? "";
    } catch {
      return null;
    }
  };
  const expected = (value: string): "block" | "warn" | null => {
    const role = referenceRole(value);
    if (role === "service_role") return "block";
    if (role !== null) return "warn";
    return null;
  };
  const levelOf = (value: string): string | null => {
    const finding = guards.looksSecret("KEY_NAME_X", value);
    // Only the JWT rules decide here: the other warnings need other shapes of value.
    return finding && /Service-Role|JWT/.test(finding.reason) ? finding.level : null;
  };

  it("blocks a service role token and warns for other roles", () => {
    expect(levelOf(jwt(b64url('{"role":"service_role"}')))).toBe("block");
    expect(levelOf(jwt(b64url('{"role":"anon"}')))).toBe("warn");
    expect(levelOf(jwt(b64url("{}")))).toBe("warn");
  });

  it("ignores segments that are not a JSON object", () => {
    expect(levelOf(jwt(b64url("not json")))).toBeNull();
    expect(levelOf("eyJhbGciOiJIUzI1NiJ9.a.b.c")).toBeNull();
    expect(levelOf(jwt("%%%")) ).toBeNull();
  });

  it("matches the Buffer decoder on padding, the standard alphabet, stray characters and a byte order mark", () => {
    const json = '{"role":"service_role"}';
    const encoded = b64url(json);
    const variants = [
      encoded,
      Buffer.from(json).toString("base64"),
      `${encoded}==`,
      `${encoded}=garbage`,
      `${encoded.slice(0, 4)}!${encoded.slice(4)}`,
      `${encoded.slice(0, 8)}\n${encoded.slice(8)}`,
      `${encoded}A`,
      b64url(`﻿${json}`),
      Buffer.from(`﻿${json}`).toString("base64"),
      encoded.slice(0, -1),
    ];
    for (const payload of variants) {
      const value = jwt(payload);
      expect(levelOf(value), payload).toBe(expected(value));
    }
  });

  /** Small seeded generator (mulberry32): the same seed gives the same cases. */
  const seeded = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it("matches the Buffer decoder on random segments (seeded)", () => {
    const seed = 20241114;
    const rand = seeded(seed);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-=!. \n";
    for (let i = 0; i < 400; i += 1) {
      const bytes = Uint8Array.from({ length: i % 40 }, () => Math.floor(rand() * 256));
      const body = Buffer.from(bytes).toString("base64url");
      let noise = "";
      for (let j = 0; j < i % 6; j += 1) noise += alphabet[Math.floor(rand() * alphabet.length)]!.replace(".", "x");
      const cut = Math.floor(rand() * (body.length + 1));
      const payload = `${body.slice(0, cut)}${noise}${body.slice(cut)}`;
      const value = jwt(payload);
      expect(levelOf(value), `seed ${seed} case ${i} ${JSON.stringify(payload)}`).toBe(expected(value));
    }
    for (let i = 0; i < 200; i += 1) {
      const json = JSON.stringify({ role: ["service_role", "anon", "x"][i % 3], pad: "ä€".repeat(i % 5) });
      const payload = rand() < 0.5 ? b64url(json) : Buffer.from(json).toString("base64");
      const value = jwt(payload.slice(0, payload.length - (i % 3)));
      expect(levelOf(value), `seed ${seed} case ${i} ${payload}`).toBe(expected(value));
    }
  });

  it("matches the Buffer decoder on invalid UTF-8 in the payload", () => {
    const rand = seeded(7);
    const cases: Buffer[] = [
      Buffer.concat([Buffer.from('{"pad":"'), Buffer.from([0xff]), Buffer.from('","role":"service_role"}')]),
      Buffer.concat([Buffer.from('{"role":"service_role","pad":"'), Buffer.from([0x80, 0xc3]), Buffer.from('"}')]),
      Buffer.concat([Buffer.from('{"pad":"'), Buffer.from([0xe2, 0x82]), Buffer.from('","role":"anon"}')]),
    ];
    for (let i = 0; i < 100; i += 1) {
      const junk = Buffer.from(Array.from({ length: 1 + (i % 5) }, () => 0x80 + Math.floor(rand() * 128)));
      cases.push(Buffer.concat([Buffer.from('{"pad":"'), junk, Buffer.from(`","role":"${["service_role", "anon"][i % 2]}"}`)]));
    }
    cases.forEach((bytes, i) => {
      for (const payload of [bytes.toString("base64url"), bytes.toString("base64")]) {
        const value = jwt(payload);
        expect(levelOf(value), `case ${i} ${payload}`).toBe(expected(value));
      }
    });
  });

  it("matches the Buffer decoder on an equals sign in the middle followed by valid base64", () => {
    const first = b64url('{"role":"anon"}');
    const second = b64url('{"role":"service_role"}');
    for (const payload of [`${first}=${second}`, `${first}==${second}`, `${first.slice(0, 6)}=${first.slice(6)}`, `=${second}`, `${second}=`, `${second}=${first}=${second}`]) {
      const value = jwt(payload);
      expect(levelOf(value), payload).toBe(expected(value));
    }
  });

  it("matches the Buffer decoder when the filtered length is 1 modulo 4, also in the middle", () => {
    const encoded = b64url('{"role":"service_role"}');
    for (let cut = 0; cut <= encoded.length; cut += 1) {
      // One stray alphabet character, then a stray one outside the alphabet, so the filtered length changes by 1 and 0.
      for (const payload of [`${encoded.slice(0, cut)}A${encoded.slice(cut)}`, `${encoded.slice(0, cut)}!${encoded.slice(cut)}`, `${encoded.slice(0, cut)}A=${encoded.slice(cut)}`, `${encoded.slice(0, cut)}A!A${encoded.slice(cut)}`]) {
        const value = jwt(payload);
        expect(levelOf(value), payload).toBe(expected(value));
      }
    }
    for (const payload of ["A", "AAAAA", "AAAA=A", `${encoded}A=`]) {
      const value = jwt(payload);
      expect(levelOf(value), payload).toBe(expected(value));
    }
  });

  it("decodes a segment of about 1 MiB like Buffer does, in linear time", () => {
    const filler = "a".repeat(1024 * 1024);
    const body = Buffer.from(`{"pad":"${filler}","role":"service_role"}`).toString("base64url");
    const noisy = body.replace(/(.{4096})/g, "$1\n!");
    for (const payload of [body, noisy, `${body}A`]) {
      const value = jwt(payload);
      const started = performance.now();
      const level = levelOf(value);
      const elapsed = performance.now() - started;
      expect(level).toBe(expected(value));
      expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(2000);
    }
  });
});
