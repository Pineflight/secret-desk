import { describe, expect, it } from "vitest";
import { InventoryError, InventoryStore } from "../src/inventory.js";
import { INVENTORY_YAML } from "./fixtures.js";

describe("InventoryStore", () => {
  it("liest Daten und behaelt Datumsangaben als Text", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(s.data.secrets).toHaveLength(3);
    expect(s.getSecret("cf-deploy-wakemiles")!.expires).toBe("2027-01-21");
  });
  it("patchSecret schreibt zurueck und erhaelt Kommentare", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.patchSecret("cf-deploy-wakemiles", { expires: "2027-04-21", rotatedAt: "2027-01-21" });
    expect(s.getSecret("cf-deploy-wakemiles")!.expires).toBe("2027-04-21");
    expect(s.toString()).toContain("# Kommentar bleibt erhalten");
  });
  it("lehnt ungueltige Aenderungen ab und rollt zurueck", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(() => s.patchSecret("stripe-webhook-leitfaden-staging", { expires: "2027-01-01" })).toThrow(InventoryError);
    expect(s.getSecret("stripe-webhook-leitfaden-staging")!.expires).toBeNull();
  });
  it("addSecret prueft Schema und doppelte ids", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addSecret({ id: "resend-wakemiles", name: "RESEND_SMTP_KEY", service: "resend", stage: "staging", places: [{ repo: "wake-miles", scope: "environment", environment: "staging" }] });
    expect(s.data.secrets).toHaveLength(4);
    expect(() => s.addSecret({ id: "resend-wakemiles", name: "X_Y", service: "a", places: [] })).toThrow(InventoryError);
    expect(() => s.addSecret({ id: "neu", name: "kleinbuchstaben", service: "a", stage: "shared", places: [{ repo: "r", scope: "repository" }] })).toThrow(InventoryError);
  });
  it("nur dev darf ohne Ziel sein", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    expect(() => s.addSecret({ id: "ohne-ziel", name: "A_B", service: "x", stage: "staging", places: [] })).toThrow(/places/);
  });
  it("addEnvEntry und addProvider", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.addEnvEntry("web-studio-dev", { key: "FOO", from: { type: "default", value: "bar" } });
    expect(s.data.envTemplates[0]!.entries).toHaveLength(4);
    s.addProvider({ id: "peecho", label: "Peecho", url: "https://www.peecho.com", steps: ["Dashboard oeffnen"] });
    expect(s.data.providers).toHaveLength(1);
  });
  it("Env-Vorlage verweist nur auf bekannte Secrets", () => {
    const bad = INVENTORY_YAML.replace("{ key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }", "{ key: X, from: { type: issue, secret: gibt-es-nicht } }");
    expect(() => InventoryStore.fromText(bad)).toThrow(/unbekanntes Secret/);
  });
});
