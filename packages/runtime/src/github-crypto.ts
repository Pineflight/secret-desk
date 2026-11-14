import {
  GitHubClient,
  githubAppProvider,
  type AppJwtSigner,
  type ConnectionStatus,
  type GitHubAppOptions,
  type GitHubClientOptions,
  type GitHubTarget,
  type SecretSealer,
  type SecretValue,
  type TokenProvider,
} from "@secret-desk/core";
import { HostCapabilityError, type RuntimeHost } from "./host.js";
import type { Runtime } from "./runtime.js";

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

/**
 * Without a host and without an injected sealer there is no way to seal a value: the Node default (libsodium) is not reached
 * on its own, the call is refused with a `HostCapabilityError`.
 */
const sealUnavailable: SecretSealer = async () => {
  throw sealRefusal();
};

const sealRefusal = (): HostCapabilityError => new HostCapabilityError("seal", "Cannot seal a value for GitHub: pass `seal` in the runtime options or a host.");

/** Throws a `HostCapabilityError` when values cannot be sealed (no injected sealer and no host). Sends nothing. */
export function assertCanSeal(crypto: GitHubCrypto): void {
  if (!crypto.seal && !crypto.host) throw sealRefusal();
}

/** The sealer for a client: the injected one, else the Node default of the core when a host exists, else one that refuses. */
function sealerFor(crypto: GitHubCrypto): SecretSealer | undefined {
  if (crypto.seal) return crypto.seal;
  return crypto.host ? undefined : sealUnavailable;
}

/**
 * The client of the runtime: the client of the core, except that writing a secret checks the seal capability first, so a runtime
 * that cannot seal makes no request at all (the plain client would fetch the public key before it tries to seal).
 */
class RuntimeGitHubClient extends GitHubClient {
  readonly #crypto: GitHubCrypto;
  constructor(crypto: GitHubCrypto, options: GitHubClientOptions) {
    super(options);
    this.#crypto = crypto;
  }
  override async putSecret(target: GitHubTarget, name: string, value: SecretValue): Promise<"created" | "updated"> {
    assertCanSeal(this.#crypto);
    return super.putSecret(target, name, value);
  }
}

/** A GitHub client whose sealing follows `sealerFor`; everything else is the plain client of the core. */
export function createGitHubClient(crypto: GitHubCrypto, options: GitHubClientOptions): GitHubClient {
  const seal = sealerFor(crypto);
  return new RuntimeGitHubClient(crypto, { ...options, ...(seal ? { seal } : {}) });
}

/**
 * A lazy provider of GitHub App installation tokens. With an injected `sign` the private key is never read: it stays where the
 * signer is. Otherwise the key is read through `getPrivateKey` and signed in this process, which needs a host (the Node
 * crypto of the core); without a host the call is refused with a `HostCapabilityError` before the key is read.
 */
export function createAppTokenProvider(
  crypto: GitHubCrypto,
  options: Omit<GitHubAppOptions, "privateKey" | "sign">,
  getPrivateKey: () => Promise<SecretValue>,
): TokenProvider {
  let inner: TokenProvider | null = null;
  return async () => {
    if (!inner) {
      if (crypto.sign) {
        inner = githubAppProvider({ ...options, sign: crypto.sign });
      } else {
        if (!crypto.host) throw new HostCapabilityError("sign", "Cannot sign a GitHub App token: pass `sign` in the runtime options or a host.");
        inner = githubAppProvider({ ...options, privateKey: await getPrivateKey() });
      }
    }
    return inner();
  };
}

/**
 * The one answer to "is the GitHub App usable": a stored private key that is connected, or (only when the configuration uses a
 * GitHub App) an injected signer, whose key stays with the embedder. A stored key wins when both exist, so a runtime that has a
 * key shows exactly what it showed before; a signer-only runtime shows `connected` with the source `injected`.
 */
export async function githubAppKeyStatus(rt: Pick<Runtime, "connections" | "sign" | "config">, id = "github-app-key"): Promise<ConnectionStatus> {
  const stored = await rt.connections.status(id);
  if (stored.connected || !rt.sign || rt.config.github.auth.type !== "app") return stored;
  return { id, connected: true, source: "injected", hint: "The private key is held by the embedder (injected signer); none is stored here." };
}

/** Whether the GitHub App can be used (see `githubAppKeyStatus`). */
export async function githubAppUsable(rt: Pick<Runtime, "connections" | "sign" | "config">): Promise<boolean> {
  return (await githubAppKeyStatus(rt)).connected;
}
