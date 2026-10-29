import { describe, expect, it } from "vitest";
import { InventoryStore } from "../src/inventory.js";
import { computeStatus, findings, placeKey, type LiveSnapshot } from "../src/status.js";
import { INVENTORY_YAML } from "./fixtures.js";

const store = InventoryStore.fromText(INVENTORY_YAML);
const cf = store.getSecret("cf-deploy-acme-app")!;
const day = (d: string) => new Date(`${d}T12:00:00Z`);

describe("computeStatus", () => {
  it("ok well before expiry", () => expect(computeStatus(cf, day("2026-10-23")).status).toBe("ok"));
  it("soon within 30 days", () => expect(computeStatus(cf, day("2026-12-25")).status).toBe("soon"));
  it("due within 7 days", () => {
    const r = computeStatus(cf, day("2027-01-15"));
    expect(r.status).toBe("due");
    expect(r.daysLeft).toBe(6);
  });
  it("expired after expiry", () => expect(computeStatus(cf, day("2027-01-22")).status).toBe("expired"));
  it("today is due, not expired", () => expect(computeStatus(cf, day("2027-01-21")).status).toBe("due"));
  it("no-date on forced expiry without date", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML.replace('expiry: possible\n    expires: "2027-01-21"', "expiry: required"));
    expect(computeStatus(s.getSecret("cf-deploy-acme-app")!, day("2026-10-23")).status).toBe("no-date");
  });
  it("missing when a target is absent in the live state", () => {
    const live: LiveSnapshot = new Map([[placeKey("acme", cf.places[0]!, cf.name), { name: cf.name, updatedAt: "x" }]]);
    const r = computeStatus(cf, day("2026-10-23"), { live, owner: "acme" });
    expect(r.status).toBe("missing");
    expect(r.missingPlaces).toHaveLength(1);
  });
});

describe("findings", () => {
  it("one message per level with a unique key", () => {
    const a = findings(store.data, day("2026-12-25"));
    const b = findings(store.data, day("2027-01-15"));
    expect(a[0]!.key).not.toBe(b[0]!.key);
    expect(b[0]!.level).toBe("due");
  });
});
