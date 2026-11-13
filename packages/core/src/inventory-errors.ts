export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

/**
 * The file changed on disk and a pending change could not be applied to the new content (or the new content is not
 * valid). Nothing was overwritten. Subclass of InventoryError so existing handlers still catch it; the portal maps it to 409.
 */
export class InventoryConflictError extends InventoryError {
  constructor(message: string) {
    super(message);
    this.name = "InventoryConflictError";
  }
}

/** The file on disk cannot be parsed or validated (a writer may still be working on it). */
export class InvalidDiskError extends InventoryConflictError {}
