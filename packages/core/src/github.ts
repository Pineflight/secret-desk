import { createSign } from "node:crypto";
import {
  GitHubClient as PortableGitHubClient,
  githubAppProvider as portableGitHubAppProvider,
  GitHubError,
  type AppJwtSigner,
  type GitHubAppOptions as PortableGitHubAppOptions,
  type GitHubClientOptions,
  type TokenProvider,
} from "./github-core.js";
import type { SecretValue } from "./secret.js";

// Node facade of the GitHub client: the portable client lives in `github-core.ts` (no Node built-ins, see
// `portable-modules.test.ts`). This module adds what needs Node: the libsodium default sealer and signing the App JWT
// with a private key held in this process. Names and behaviour of the local edition are unchanged.
export {
  GitHubError,
  GitHubTruncatedError,
  patProvider,
  placeToTarget,
  type AppJwtSigner,
  type FetchLike,
  type GitHubClientOptions,
  type GitHubTarget,
  type RemoteRepo,
  type RemoteSecret,
  type RemoteVariable,
  type SecretSealer,
  type SnapshotError,
  type SnapshotResult,
  type TokenProvider,
  type VisibleRepo,
} from "./github-core.js";

/** Verschluesselt einen Wert so, wie GitHub es verlangt (libsodium sealed box, base64). libsodium wird erst hier geladen. */
export async function sealForGitHub(publicKeyBase64: string, plaintext: string): Promise<string> {
  const { sealWithLibsodium } = await import("./github-seal-libsodium.js");
  return sealWithLibsodium(publicKeyBase64, plaintext);
}

/** The GitHub client of the local edition: like the portable one, but seals with libsodium unless a sealer is injected. */
export class GitHubClient extends PortableGitHubClient {
  constructor(options: GitHubClientOptions) {
    super({ ...options, seal: options.seal ?? sealForGitHub });
  }
}

export type GitHubAppOptions = Omit<PortableGitHubAppOptions, "sign"> & {
  /** The App's private key (PEM), held in this process. Give exactly one of `privateKey` and `sign`. */
  privateKey?: SecretValue;
  /** Signs the JWT elsewhere, so the private key never enters this module. Give exactly one of `privateKey` and `sign`. */
  sign?: AppJwtSigner;
};

/** Erzeugt bei Bedarf ein Installations-Token (eine Stunde gueltig) und cached es bis kurz vor Ablauf. */
export function githubAppProvider(options: GitHubAppOptions): TokenProvider {
  // Untyped callers may pass null: treat it like "not given".
  const privateKey = options.privateKey ?? undefined;
  const sign = options.sign ?? undefined;
  if ((privateKey === undefined) === (sign === undefined) || (sign !== undefined && typeof sign !== "function")) {
    throw new GitHubError(0, "GitHub App: genau eines von privateKey und sign muss angegeben werden");
  }
  const signer: AppJwtSigner = privateKey ? async (data) => createSign("RSA-SHA256").update(data).sign(privateKey.reveal()).toString("base64url") : sign!;
  return portableGitHubAppProvider({ ...options, sign: signer });
}
