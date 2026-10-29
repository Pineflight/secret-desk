import { describe, expect, it } from "vitest";
import { InventoryError, InventoryStore } from "../src/inventory.js";
import { INVENTORY_YAML } from "./fixtures.js";

describe("InventoryStore", () => {
  it("reads data and keeps dates as text", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(s.data.secrets).toHaveLength(3);
    expect(s.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-01-21");
  });
  it("patchSecret writes back and keeps comments", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.patchSecret("cf-deploy-acme-app", { expires: "2027-04-21", rotatedAt: "2027-01-21" });
    expect(s.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-04-21");
    expect(s.toString()).toContain("# Kommentar bleibt erhalten");
  });
  it("rejects invalid changes and rolls back", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(() => s.patchSecret("stripe-webhook-acme-docs-staging", { expires: "2027-01-01" })).toThrow(InventoryError);
    expect(s.getSecret("stripe-webhook-acme-docs-staging")!.expires).toBeNull();
  });
  it("addSecret checks schema and duplicate ids", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addSecret({ id: "resend-acme-app", name: "RESEND_SMTP_KEY", service: "resend", stage: "staging", places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect(s.data.secrets).toHaveLength(4);
    expect(() => s.addSecret({ id: "resend-acme-app", name: "X_Y", service: "a", places: [] })).toThrow(InventoryError);
    expect(() => s.addSecret({ id: "neu", name: "kleinbuchstaben", service: "a", stage: "shared", places: [{ repo: "r", scope: "repository" }] })).toThrow(InventoryError);
  });
  it("only dev may be without target", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(() => s.addSecret({ id: "ohne-ziel", name: "A_B", service: "x", stage: "staging", places: [] })).toThrow(/places/);
  });
  it("addEnvEntry and addProvider", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addEnvEntry("acme-web-dev", { key: "FOO", from: { type: "default", value: "bar" } });
    expect(s.data.envTemplates[0]!.entries).toHaveLength(4);
    s.addProvider({ id: "acme-api", label: "Acme API", url: "https://acme.example.com", steps: ["Dashboard oeffnen"] });
    expect(s.data.providers).toHaveLength(1);
  });
  it("env template references known secrets only", () => {
    const bad = INVENTORY_YAML.replace("{ key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }", "{ key: X, from: { type: issue, secret: gibt-es-nicht } }");
    expect(() => InventoryStore.fromText(bad)).toThrow(/unbekanntes Secret/);
  });
  it("stores description, owner, link and tags and validates them", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addSecret({ id: "acme-key", name: "ACME_API_KEY", service: "acme-api", stage: "staging", description: "Druckauftraege an Acme API senden (Edge Function print-order)", owner: "alice", link: "https://acme.example.com", tags: ["druck", "acme-app"], places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    expect(s.getSecret("acme-key")).toMatchObject({ owner: "alice", tags: ["druck", "acme-app"] });
    s.patchSecret("acme-key", { description: "Neu beschrieben", tags: ["druck"] });
    expect(s.getSecret("acme-key")!.description).toBe("Neu beschrieben");
    s.patchSecret("acme-key", { tags: [] });
    expect(s.getSecret("acme-key")!.tags).toEqual([]);
    expect(() => s.addSecret({ id: "x1", name: "X_Y", service: "a", stage: "dev", link: "kein-link" })).toThrow(InventoryError);
    expect(() => s.addSecret({ id: "x2", name: "X_Y", service: "a", stage: "dev", tags: ["Gross Schrift"] })).toThrow(InventoryError);
  });
  it("variables: change and remove description fields", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addVariable({ id: "site-url", name: "NEXT_PUBLIC_SITE_URL", stage: "staging", value: "https://s.example.com", places: [{ repo: "acme-web", scope: "environment", environment: "staging" }] });
    s.patchVariable("site-url", { description: "Basis-URL der Staging-Seite", owner: "alice", link: "https://example.com/doku", tags: ["url"] });
    expect(s.getVariable("site-url")).toMatchObject({ description: "Basis-URL der Staging-Seite", owner: "alice", tags: ["url"] });
    s.patchVariable("site-url", { description: null, tags: [] });
    expect(s.getVariable("site-url")!.description).toBeUndefined();
    expect(s.getVariable("site-url")!.tags).toEqual([]);
  });
});
