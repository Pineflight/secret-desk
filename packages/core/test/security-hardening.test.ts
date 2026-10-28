import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { EvidenceStore } from "../src/evidence.js";
import { buildEnvFile, formatEnvValue } from "../src/env-export.js";
import { InventoryError, InventoryStore, PATCHABLE_SECRET_KEYS } from "../src/inventory.js";
import { SECRET_PATCH_KEYS, SecretAgentCreateSchema, SecretAgentPatchSchema, SecretHumanPatchSchema, VariablePatchSchema, parseInput } from "../src/patch.js";
import { ProviderRegistry } from "../src/provider.js";
import { secretApprovalSnapshot, variableApprovalSnapshot } from "../src/snapshot.js";
import { EnvEntrySchema, EnvTemplateSchema, ProviderDefSchema } from "../src/types.js";
import { INVENTORY_YAML } from "./fixtures.js";

const posix = process.platform !== "win32";

describe("F2: strikte Patch-Schemas (Mass-Assignment)", () => {
  it("Agent darf nur Metadaten: stage, places, provider, params, Pruefstempel, Kennung -> Fehler mit Feldname", () => {
    for (const bad of [{ stage: "dev" }, { places: [] }, { provider: "manual" }, { params: { baseUrl: "https://evil.example" } }, { expires: null }, { rotatedAt: "2026-01-01" }, { verifiedAt: "2026-01-01" }, { verifiedBy: "alice" }, { externalId: "x" }, { ttlDays: 1 }, { expiry: "none" }, { id: "x" }, { name: "X" }]) {
      expect(() => parseInput(SecretAgentPatchSchema, bad), JSON.stringify(bad)).toThrow(/Feld nicht erlaubt/);
    }
    expect(parseInput(SecretAgentPatchSchema, { title: "t", description: "d", owner: "o", link: "https://example.com", tags: ["a"], notes: "n", product: "p" })).toMatchObject({ title: "t", product: "p" });
  });
  it("Mensch darf Stempel und Ablauf aendern, aber auch er nicht stage/places/provider/params", () => {
    expect(parseInput(SecretHumanPatchSchema, { expires: "2027-01-01", verifiedBy: "alice", externalId: "x" })).toMatchObject({ expires: "2027-01-01" });
    for (const bad of [{ stage: "dev" }, { places: [] }, { provider: "manual" }, { params: {} }]) expect(() => parseInput(SecretHumanPatchSchema, bad)).toThrow(/Feld nicht erlaubt/);
  });
  it("patchSecret lehnt unbekannte Schluessel selbst ab (Verteidigung in der Tiefe) und hat dieselbe Liste wie das Schema", () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML);
    expect(() => inv.patchSecret("cf-deploy-acme-app", { stage: "dev" } as never)).toThrow(InventoryError);
    expect(() => inv.patchSecret("cf-deploy-acme-app", { places: [] } as never)).toThrow(/Feld nicht erlaubt: places/);
    expect(inv.getSecret("cf-deploy-acme-app")!.stage).toBe("shared");
    expect([...PATCHABLE_SECRET_KEYS].sort()).toEqual([...SECRET_PATCH_KEYS].sort());
  });
  it("Agent-Neuanlage: keine Pruefstempel, keine Kennung", () => {
    const base = { id: "x-y", name: "X_Y", service: "s", stage: "dev" };
    expect(() => parseInput(SecretAgentCreateSchema, base)).not.toThrow();
    for (const extra of [{ expires: "2027-01-01" }, { rotatedAt: "2026-01-01" }, { verifiedAt: "2026-01-01" }, { verifiedBy: "alice" }, { externalId: "x" }]) {
      expect(() => parseInput(SecretAgentCreateSchema, { ...base, ...extra })).toThrow(/Feld nicht erlaubt/);
    }
  });
  it("Variablen-Patch: nur Sollwert und Beschreibung, nie Stage oder Ziele", () => {
    expect(parseInput(VariablePatchSchema, { value: "x", acknowledgedPublic: true })).toMatchObject({ value: "x" });
    for (const bad of [{ stage: "production" }, { places: [] }, { id: "a" }, { name: "A" }]) expect(() => parseInput(VariablePatchSchema, bad)).toThrow(/Feld nicht erlaubt/);
  });
});

describe("F3: Snapshot-Hash fuer Freigaben", () => {
  const inv = InventoryStore.fromText(INVENTORY_YAML);
  it("aendert sich bei Ziel, Anbieter, Parameter, Stage und Sollwert", () => {
    const s = inv.getSecret("cf-deploy-acme-app")!;
    const h = secretApprovalSnapshot(s).hash;
    expect(secretApprovalSnapshot({ ...s }).hash).toBe(h);
    expect(secretApprovalSnapshot({ ...s, places: [{ repo: "evil", scope: "repository" }] }).hash).not.toBe(h);
    expect(secretApprovalSnapshot({ ...s, provider: "manual" }).hash).not.toBe(h);
    expect(secretApprovalSnapshot({ ...s, params: { a: 1 } }).hash).not.toBe(h);
    expect(secretApprovalSnapshot({ ...s, stage: "production" }).hash).not.toBe(h);
    expect(secretApprovalSnapshot({ ...s, ttlDays: 1 }).hash).not.toBe(h);
  });
  it("Variable: Sollwert und Ziele", () => {
    const v = { id: "v", name: "V", stage: "staging", value: "a", tags: [], places: [{ repo: "r", scope: "repository" as const }] };
    const h = variableApprovalSnapshot(v).hash;
    expect(variableApprovalSnapshot({ ...v, value: "b" }).hash).not.toBe(h);
    expect(variableApprovalSnapshot({ ...v, places: [{ repo: "evil", scope: "repository" as const }] }).hash).not.toBe(h);
    expect(variableApprovalSnapshot(v).view).toMatchObject({ value: "a", variable: "v" });
  });
});

describe("F5: .env-Dateien", () => {
  it("description, hint, repo, file mit Zeilenumbruch werden vom Schema abgelehnt", () => {
    for (const nl of ["\n", "\r\n", "\r", "\u2028"]) {
      expect(EnvEntrySchema.safeParse({ key: "A", from: { type: "default", value: "x" }, description: `ok${nl}EVIL=1` }).success, JSON.stringify(nl)).toBe(false);
      expect(EnvEntrySchema.safeParse({ key: "A", from: { type: "prompt", hint: `h${nl}x` } }).success).toBe(false);
      expect(EnvTemplateSchema.safeParse({ id: "t", repo: `r${nl}x`, entries: [{ key: "A", from: { type: "default", value: "x" } }] }).success).toBe(false);
    }
    expect(EnvEntrySchema.safeParse({ key: "A\nB=1", from: { type: "default", value: "x" } }).success).toBe(false);
  });
  it("Kommentar kann keine Zuweisung einschleusen, auch wenn das Schema umgangen wurde", async () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML);
    const tpl = { ...inv.data.envTemplates[0]!, repo: "r\nPWNED=1", entries: [{ key: "A", from: { type: "default" as const, value: "x" }, description: "hallo\r\nEVIL=1\u2028X=2" }] };
    const r = await buildEnvFile(tpl, { inventory: inv, providers: new ProviderRegistry(), connections: new ConnectionStore() });
    const lines = r.text.split(/\r\n|\n|\r|\u2028|\u2029/);
    expect(lines.filter((l) => /^(PWNED|EVIL|X)=/.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("A="))).toEqual(["A=x"]);
  });
  it("Maskierung: $(...), Backtick, $VAR, CRLF, Anfuehrungszeichen", () => {
    expect(formatEnvValue("$(touch /tmp/pwned)")).toBe("'$(touch /tmp/pwned)'");
    expect(formatEnvValue("`id`")).toBe("'`id`'");
    expect(formatEnvValue("a\r\nB=1")).toBe("'a\r\nB=1'");
    expect(formatEnvValue("it's $(id)")).toBe('"it\'s \\$(id)"');
    expect(formatEnvValue('a"b`c$d\\e\'')).toBe('"a\\"b\\`c\\$d\\\\e\'"');
    expect(formatEnvValue("plain-1.2")).toBe("plain-1.2");
  });
  it.runIf(posix)("`source .env` fuehrt nichts aus und liefert den Wert unveraendert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-shell-"));
    const marker = join(dir, "pwned");
    const values = [`$(touch ${marker})`, `\`touch ${marker}\``, "a b $HOME ${HOME}", "x\r\ny", `it's "quoted" $(touch ${marker})`, "back\\slash", "plain"];
    const text = values.map((v, i) => `V${i}=${formatEnvValue(v)}`).join("\n") + "\n";
    const file = join(dir, ".env");
    await writeFile(file, text);
    for (const [i, v] of values.entries()) {
      const out = execFileSync("sh", ["-c", `set -e; . "$1"; printf %s "$V${i}"`, "sh", file], { encoding: "utf8" });
      expect(out, JSON.stringify(v)).toBe(v);
    }
    await expect(stat(marker)).rejects.toThrow();
  }, 30_000);
});

describe("Providerdefinition: nur http(s)", () => {
  it("javascript:- und data:-Adressen werden abgelehnt", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) expect(ProviderDefSchema.safeParse({ id: "a", label: "A", url }).success, url).toBe(false);
    expect(ProviderDefSchema.safeParse({ id: "a", label: "A", url: "https://example.com" }).success).toBe(true);
  });
});

describe("N5/N6: private Dateirechte", () => {
  it.runIf(posix)("Inventar und Berichts-JSON mit Modus 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-modes-"));
    const path = join(dir, "inventory.yaml");
    const inv = InventoryStore.fromText(INVENTORY_YAML, path);
    await inv.save();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("cf-deploy-acme-app");
    const ev = new EvidenceStore(join(dir, "ev"));
    await ev.save({ id: "r1", secretId: "s1", secretName: "S", createdAt: "x", kind: "manual", provider: "manual", stage: "dev", label: "l", expiresAt: null, targets: [], checks: [], checklist: [], fingerprint: "f", attachments: [] } as never);
    expect((await stat(join(dir, "ev", "s1", "r1.json"))).mode & 0o777).toBe(0o600);
  });
});
