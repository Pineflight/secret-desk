// Portable Base64, Base64URL and UTF-8 helpers: no Node built-ins, no `Buffer`. Built on `TextEncoder`, `TextDecoder`,
// `btoa` and `atob`, which every runtime of the portable entry provides.

const CHUNK = 0x8000;

/** Binary string (one char per byte) of the bytes, built in chunks so large inputs do not overflow the call stack. */
function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}

/** Standard Base64 (with padding) of the bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

/**
 * Bytes of a Base64 or Base64URL string. Whitespace (GitHub wraps file content in lines) is ignored and missing padding is
 * added. Anything else outside the alphabet makes `atob` throw.
 */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Standard Base64 (with padding) of the UTF-8 bytes of the text. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Text of the UTF-8 bytes in a Base64 or Base64URL string. Invalid UTF-8 becomes U+FFFD, like `Buffer` does. */
export function base64ToUtf8(text: string): string {
  return new TextDecoder().decode(base64ToBytes(text));
}

/** Base64URL without padding of the bytes. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64URL without padding of the UTF-8 bytes of the text. */
export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}
