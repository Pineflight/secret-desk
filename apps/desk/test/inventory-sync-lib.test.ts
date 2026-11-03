import { describe, expect, it } from "vitest";
import { INVENTORY_POLL_MS, inventoryChanged } from "../src/lib/inventory-sync";
import { notifyInventoryChange, subscribeInventoryChange } from "../src/lib/refresh";

describe("inventory sync (client)", () => {
  it("remembers the first version and reports later differences only", () => {
    expect(inventoryChanged(null, 3)).toBe(false);
    expect(inventoryChanged(3, 3)).toBe(false);
    expect(inventoryChanged(3, 4)).toBe(true);
  });
  it("polls at a modest interval", () => {
    expect(INVENTORY_POLL_MS).toBeGreaterThanOrEqual(3000);
  });
  it("notifies subscribers until they unsubscribe", () => {
    let n = 0;
    const off = subscribeInventoryChange(() => n++);
    notifyInventoryChange();
    off();
    notifyInventoryChange();
    expect(n).toBe(1);
  });
});
