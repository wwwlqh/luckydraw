// The build-time configuration of one deployment target (SPEC §12, §15).
//
// Nothing here reads the chain. `import.meta.env` values are substituted by Vite at build time, so a build
// is pinned to exactly one deployment and one set of RPC origins; `web/vite.config.ts` refuses to build when
// the pair does not name a manifest that exists.

/** Thrown when the build's environment variables are missing or malformed. Surfaced by the app shell. */
export class WebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebConfigError";
  }
}

export type WebEnv = {
  /** Decimal chain id as written in the environment, used to address `config/deployments/<chainId>/`. */
  chainIdText: string;
  chainId: bigint;
  /** Lowercase Draw address, the manifest file name. */
  drawAddress: string;
  /** Read RPC URLs in preference order. The first is used; every origin is in the CSP `connect-src`. */
  rpcUrls: readonly string[];
  /** How often the app asks for a new block number. SPEC §10.1 refreshes a snapshot at most every 4 s. */
  blockPollMs: number;
  /**
   * The operator's jurisdiction sentence (SPEC §14: "Qualified advisers must determine jurisdiction,
   * licensing, eligible audience"; the app must state the outcome). Plain text, rendered as a text node and
   * never as markup. Empty on local and testnet builds, required and non-empty on chain 56.
   */
  jurisdictionNotice: string;
};

const DEFAULT_BLOCK_POLL_MS = 3_000;
const MIN_BLOCK_POLL_MS = 1_000;

/** The chain that publishes to real customers. Its build carries obligations no other chain's does. */
export const MAINNET_CHAIN_ID = 56n;

type RawEnv = Readonly<Record<string, string | boolean | undefined>>;

function text(env: RawEnv, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parses and validates the `VITE_LUCKYDRAW_*` variables. Takes the record so tests can pass one in;
 * `webEnv()` supplies `import.meta.env`.
 */
export function parseWebEnv(env: RawEnv): WebEnv {
  const chainIdText = text(env, "VITE_LUCKYDRAW_CHAIN_ID");
  if (!/^[0-9]+$/.test(chainIdText)) {
    throw new WebConfigError(
      `VITE_LUCKYDRAW_CHAIN_ID must be a decimal chain id, got ${JSON.stringify(chainIdText)}.`,
    );
  }
  const drawAddress = text(env, "VITE_LUCKYDRAW_DRAW_ADDRESS");
  if (!/^0x[0-9a-f]{40}$/.test(drawAddress)) {
    throw new WebConfigError(
      `VITE_LUCKYDRAW_DRAW_ADDRESS must be a lowercase 0x address, got ${JSON.stringify(drawAddress)}.`,
    );
  }
  const rpcUrls = text(env, "VITE_LUCKYDRAW_RPC_URL")
    .split(/[\s,]+/)
    .filter((entry) => entry.length > 0);
  if (rpcUrls.length === 0) {
    throw new WebConfigError(
      "VITE_LUCKYDRAW_RPC_URL must name at least one RPC URL: the chain record carries the variable name " +
        "in `rpcEnvVars.public`, never a URL.",
    );
  }
  for (const url of rpcUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WebConfigError(`VITE_LUCKYDRAW_RPC_URL contains a value that is not a URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebConfigError(`RPC URLs must be http or https, got ${parsed.protocol} in ${url}`);
    }
    // A static build ships this URL to every visitor, and `wallet_addEthereumChain` hands it to the wallet
    // verbatim, so a keyed endpoint would be published twice over. Credentials and query strings are how
    // providers carry those keys, and both are refused rather than leaked (SPEC §10.4). The message names
    // only the origin and path, never the secret it is rejecting.
    const shown = `${parsed.origin}${parsed.pathname}`;
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WebConfigError(
        `VITE_LUCKYDRAW_RPC_URL must not carry credentials: ${shown} was given with a user name or ` +
          "password. A keyed endpoint cannot be baked into a public build; use a public RPC here and keep " +
          "the keyed one for the operator's own tooling (SPEC §10.4).",
      );
    }
    if (parsed.search !== "") {
      throw new WebConfigError(
        `VITE_LUCKYDRAW_RPC_URL must not carry a query string: ${shown} was given with one. That is where ` +
          "provider API keys live, and this build is public (SPEC §10.4).",
      );
    }
  }
  const pollText = text(env, "VITE_LUCKYDRAW_BLOCK_POLL_MS");
  let blockPollMs = DEFAULT_BLOCK_POLL_MS;
  if (pollText !== "") {
    const parsed = Number(pollText);
    if (!Number.isFinite(parsed) || parsed < MIN_BLOCK_POLL_MS) {
      throw new WebConfigError(
        `VITE_LUCKYDRAW_BLOCK_POLL_MS must be a number of at least ${MIN_BLOCK_POLL_MS}, got ${pollText}.`,
      );
    }
    blockPollMs = parsed;
  }
  const chainId = BigInt(chainIdText);
  // The build gate (`lib/build/releaseGate.ts`) refuses a chain 56 build without this sentence, so a
  // published mainnet bundle always carries one. The same rule is asserted here because this parser is what
  // every surface reads through: if a bundle ever reached a browser without it, the app says so loudly
  // rather than rendering a mainnet page with a silently missing legal statement (SPEC §14).
  const jurisdictionNotice = text(env, "VITE_LUCKYDRAW_JURISDICTION_NOTICE");
  if (chainId === MAINNET_CHAIN_ID && jurisdictionNotice === "") {
    throw new WebConfigError(
      "VITE_LUCKYDRAW_JURISDICTION_NOTICE must carry the operator's jurisdiction sentence on chain 56; " +
        "SPEC §14 requires the app to state the outcome of that advice.",
    );
  }
  return {chainIdText, chainId, drawAddress, rpcUrls, blockPollMs, jurisdictionNotice};
}

let cached: WebEnv | null = null;

/** The parsed build environment. Parsed once; the result never changes within a build. */
export function webEnv(): WebEnv {
  if (cached === null) cached = parseWebEnv(import.meta.env as unknown as RawEnv);
  return cached;
}
