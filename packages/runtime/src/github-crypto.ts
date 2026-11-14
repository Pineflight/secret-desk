import { createSign } from "node:crypto";
import { GitHubClient as NodeGitHubClient, sealForGitHub, type AppJwtSigner, type GitHubAppOptions, type GitHubClient, type GitHubClientOptions, type SecretSealer, type SecretValue, type TokenProvider } from "@secret-desk/core";
import {
  assertCanSeal as assertCanSealCore,
  createAppTokenProvider as createAppTokenProviderCore,
  createGitHubClient as createGitHubClientCore,
  type GitHubCrypto as GitHubCryptoCore,
  type GitHubCryptoDefaults,
} from "./github-crypto-core.js";
import type { RuntimeHost } from "./host-core.js";

// The Node wrapper around `github-crypto-core.ts`: same names as before. A runtime that has a host gets the Node defaults for the
// two operations (libsodium for sealing, the Node crypto module for signing with a private key held in the process); a runtime
// without a host gets none and refuses what it cannot do. The logic lives in the core module.
export { githubAppKeyStatus, githubAppUsable } from "./github-crypto-core.js";

/**
 * What decides how the two GitHub cryptography operations are done: the injected functions and the host.
 *
 * `sign` must sign for the GitHub App named by the configured app id (`github.auth.appId`): the issuer of the token request
 * comes from the configuration, so a signer that holds the key of another App is refused by GitHub.
 */
export interface GitHubCrypto {
  host?: RuntimeHost | undefined;
  seal?: SecretSealer | undefined;
  sign?: AppJwtSigner | undefined;
}

/** The defaults of the Node edition: sealing with libsodium and signing with the Node crypto module. Given to a runtime that has a host. */
export const NODE_GITHUB_DEFAULTS: GitHubCryptoDefaults = Object.freeze({
  seal: sealForGitHub,
  signWithKey: (key: SecretValue): AppJwtSigner => async (signingInput) => createSign("RSA-SHA256").update(signingInput).sign(key.reveal()).toString("base64url"),
});

/** The crypto description of the core for a Node runtime: a live view of `crypto`, with the Node defaults when it has a host. */
export function withNodeDefaults(crypto: GitHubCrypto): GitHubCryptoCore {
  return {
    get host() {
      return crypto.host;
    },
    get seal() {
      return crypto.seal;
    },
    get sign() {
      return crypto.sign;
    },
    get defaults() {
      return crypto.host ? NODE_GITHUB_DEFAULTS : undefined;
    },
  };
}

/** Throws a `HostCapabilityError` when values cannot be sealed (no injected sealer and no host). Sends nothing. */
export function assertCanSeal(crypto: GitHubCrypto): void {
  assertCanSealCore(withNodeDefaults(crypto));
}

/** A GitHub client whose sealing follows the rules of `GitHubCrypto`; everything else is the client of the core. */
export function createGitHubClient(crypto: GitHubCrypto, options: GitHubClientOptions): GitHubClient {
  return createGitHubClientCore(withNodeDefaults(crypto), options, NodeGitHubClient);
}

/**
 * A lazy provider of GitHub App installation tokens. With an injected `sign` the private key is never read: it stays where the
 * signer is. Otherwise the key is read through `getPrivateKey` and signed in this process, which needs a host (the Node
 * crypto); without a host the call is refused with a `HostCapabilityError` before the key is read.
 */
export function createAppTokenProvider(crypto: GitHubCrypto, options: Omit<GitHubAppOptions, "privateKey" | "sign">, getPrivateKey: () => Promise<SecretValue>): TokenProvider {
  return createAppTokenProviderCore(withNodeDefaults(crypto), options, getPrivateKey);
}
