import sodium from "libsodium-wrappers";
import type { SecretSealer } from "./github.js";

/**
 * Default sealer of the local edition: libsodium sealed box, Base64 (original variant). Kept in its own module so that
 * `github.ts` loads libsodium only when no other sealer was injected (libsodium compiles WebAssembly at run time, which
 * some runtimes do not allow).
 */
export const sealWithLibsodium: SecretSealer = async (publicKeyBase64, plaintext) => {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
};
