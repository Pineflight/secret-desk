import { GitHubClient, githubAppProvider, type AppJwtSigner, type GitHubAppOptions, type GitHubClientOptions, type SecretSealer, type SecretValue, type TokenProvider } from "@secret-desk/core";
import { HostCapabilityError, type RuntimeHost } from "./host.js";

/** What decides how the two GitHub cryptography operations are done: the injected functions and the host. */
export interface GitHubCrypto {
  host?: RuntimeHost | undefined;
  seal?: SecretSealer | undefined;
  sign?: AppJwtSigner | undefined;
}

/**
 * Without a host and without an injected sealer there is no way to seal a value: the Node default (libsodium) is not reached
 * on its own, the call is refused with a `HostCapabilityError` before anything is sent.
 */
const sealUnavailable: SecretSealer = async () => {
  throw new HostCapabilityError("seal", "Cannot seal a value for GitHub: pass `seal` in the runtime options or a host.");
};

/** The sealer for a client: the injected one, else the Node default of the core when a host exists, else one that refuses. */
function sealerFor(crypto: GitHubCrypto): SecretSealer | undefined {
  if (crypto.seal) return crypto.seal;
  return crypto.host ? undefined : sealUnavailable;
}

/** A GitHub client whose sealing follows `sealerFor`; everything else is the plain client of the core. */
export function createGitHubClient(crypto: GitHubCrypto, options: GitHubClientOptions): GitHubClient {
  const seal = sealerFor(crypto);
  return new GitHubClient({ ...options, ...(seal ? { seal } : {}) });
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
