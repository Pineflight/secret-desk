import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Synchronous SHA-256 without Node built-ins. Web Crypto's `digest` is asynchronous, and the callers (snapshot hashes,
// value fingerprints) are synchronous, so the digest comes from `@noble/hashes` (pure JavaScript, no dependencies).

/** Lowercase hex SHA-256 of the UTF-8 bytes of the text (a lone surrogate encodes as U+FFFD, like `node:crypto` does). */
export function sha256Hex(text: string): string {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** Lowercase hex SHA-256 of the bytes. */
export function sha256HexBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
