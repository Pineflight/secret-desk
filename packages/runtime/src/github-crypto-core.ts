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
} from "@secret-desk/core/portable";
import { HostCapabilityError, type RuntimeHost } from "./host-core.js";
import type { RuntimeCore } from "./runtime-core.js";

// The GitHub cryptography of a runtime on the portable client of the core: no Node API. What cannot be done without one (sealing with
// libsodium, signing the App token with a private key held in the process) is a default the embedder or the Node wrapper
// (`github-crypto.ts`) hands in; without it the operation is refused with a `HostCapabilityError`.

/** The defaults a host brings along for the two cryptographic operations. Used only when nothing was injected. */
export interface GitHubCryptoDefaults {
  /** Seals a value for the GitHub secret store. */
  seal?: SecretSealer;
  /** Builds a signer for the GitHub App token request from the private key (held in this process, read only when it signs). */
  signWithKey?: (key: SecretValue) => AppJwtSigner;
}

/**
 * What decides how the two GitHub cryptography operations are done: the injected functions first, then the defaults of the host.
 *
 * `sign` must sign for the GitHub App named by the configured app id (`github.auth.appId`): the issuer of the token request
 * comes from the configuration, so a signer that holds the key of another App is refused by GitHub.
 */
export interface GitHubCrypto {
  host?: RuntimeHost | undefined;
  seal?: SecretSealer | undefined;
  sign?: AppJwtSigner | undefined;
  /** What to use when no `seal` or `sign` is injected. Without a default the operation is refused. */
  defaults?: GitHubCryptoDefaults | undefined;
}

const sealRefusal = (): HostCapabilityError => new HostCapabilityError("seal", "Cannot seal a value for GitHub: pass `seal` in the runtime options or a host.");

/** Without an injected sealer and without a default there is no way to seal a value: the call is refused with a `HostCapabilityError`. */
const sealUnavailable: SecretSealer = async () => {
  throw sealRefusal();
};

/** Throws a `HostCapabilityError` when values cannot be sealed (no injected sealer and no default). Sends nothing. */
export function assertCanSeal(crypto: GitHubCrypto): void {
  if (sealerOf(crypto) === undefined) throw sealRefusal();
}

/** The sealer that is really there: the injected one, else the default. Anything that is not a function (an untyped caller) counts as absent. */
function sealerOf(crypto: GitHubCrypto): SecretSealer | undefined {
  if (typeof crypto.seal === "function") return crypto.seal;
  return typeof crypto.defaults?.seal === "function" ? crypto.defaults.seal : undefined;
}

/** The sealer for a client: the one that is there, else one that refuses. Decided the same way as `assertCanSeal`. */
function sealerFor(crypto: GitHubCrypto): SecretSealer {
  return sealerOf(crypto) ?? sealUnavailable;
}

/** A class whose instances are GitHub clients: the portable client of the core, or a subclass of it (the Node facade of the core). */
export type GitHubClientClass = new (options: GitHubClientOptions) => GitHubClient;

/**
 * The client of the runtime: `Base` (default: the portable client of the core), except that writing a secret checks the seal
 * capability first, so a runtime that cannot seal makes no request at all (the plain client would fetch the public key before it
 * tries to seal). The class is derived from `Base`, so the members of `Base.prototype` stay what a call finds first.
 */
function runtimeClientClass(Base: GitHubClientClass): new (crypto: GitHubCrypto, options: GitHubClientOptions) => GitHubClient {
  return class RuntimeGitHubClient extends Base {
    readonly #crypto: GitHubCrypto;
    constructor(crypto: GitHubCrypto, options: GitHubClientOptions) {
      super(options);
      this.#crypto = crypto;
    }
    override async putSecret(target: GitHubTarget, name: string, value: SecretValue): Promise<"created" | "updated"> {
      assertCanSeal(this.#crypto);
      return super.putSecret(target, name, value);
    }
  };
}

/** A GitHub client whose sealing follows `sealerFor`; everything else is the portable client of the core. */
export function createGitHubClient(crypto: GitHubCrypto, options: GitHubClientOptions): GitHubClient {
  return createGitHubClientOn(undefined, crypto, options);
}

/**
 * @internal Not exported from the portable entry. Like `createGitHubClient`, on the client class `Base` (the Node entry passes the Node
 * facade of the core). A class whose instances carry their own `putSecret` is refused: it would shadow the check that makes a runtime
 * that cannot seal send no request.
 */
export function createGitHubClientOn(Base: GitHubClientClass | undefined, crypto: GitHubCrypto, options: GitHubClientOptions): GitHubClient {
  const Client = runtimeClientClass(Base ?? GitHubClient);
  const client = new Client(crypto, { ...options, seal: sealerFor(crypto) });
  if (Object.hasOwn(client, "putSecret")) throw new Error("The GitHub client class defines putSecret on its instances, which would bypass the seal check of the runtime.");
  return client;
}

/**
 * A lazy provider of GitHub App installation tokens. With an injected `sign` the private key is never read: it stays where the
 * signer is. Otherwise the key is read through `getPrivateKey` and signed in this process with the `signWithKey` default of the
 * host; without one the call is refused with a `HostCapabilityError` before the key is read.
 */
export function createAppTokenProvider(
  crypto: GitHubCrypto,
  options: Omit<GitHubAppOptions, "sign">,
  getPrivateKey: () => Promise<SecretValue>,
): TokenProvider {
  let inner: TokenProvider | null = null;
  return async () => {
    if (!inner) {
      if (crypto.sign) {
        inner = githubAppProvider({ ...options, sign: crypto.sign });
      } else {
        const signWithKey = crypto.defaults?.signWithKey;
        if (!signWithKey) throw new HostCapabilityError("sign", "Cannot sign a GitHub App token: pass `sign` in the runtime options or a host.");
        inner = githubAppProvider({ ...options, sign: signWithKey(await getPrivateKey()) });
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
export async function githubAppKeyStatus(rt: Pick<RuntimeCore, "connections" | "sign" | "config">, id = "github-app-key"): Promise<ConnectionStatus> {
  const stored = await rt.connections.status(id);
  if (stored.connected || !rt.sign || rt.config.github.auth.type !== "app") return stored;
  return { id, connected: true, source: "injected", hint: "The private key is held by the embedder (injected signer); none is stored here." };
}

/** Whether the GitHub App can be used (see `githubAppKeyStatus`). */
export async function githubAppUsable(rt: Pick<RuntimeCore, "connections" | "sign" | "config">): Promise<boolean> {
  return (await githubAppKeyStatus(rt)).connected;
}
