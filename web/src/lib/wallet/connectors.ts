// Turning discovery into the ordered connector list the Connect modal shows (SPEC §9.2).
//
// Order: MetaMask — the announcer whose rdns is exactly `io.metamask` — first with a "Recommended" badge,
// then every other announcer with a "detected" badge in name order, its own rdns shown under its name so two
// rows both calling themselves "MetaMask" can be told apart. When MetaMask did not announce itself, its row
// is still first but becomes an install entry
// (the mobile deep link in a standalone mobile browser, the download page otherwise), which is the "popular
// wallets with an install link" tail of the §9.2 order with the one wallet v1 recommends.
//
// `window.ethereum` is used only when nothing announced at all, and then it is labelled generically: a page
// with several injected wallets has one arbitrary winner on `window.ethereum`, so naming it would be a guess.

import type {Eip6963ProviderDetail} from "./eip6963.ts";
import {toWalletError, WalletError} from "./errors.ts";
import type {Connector, ConnectResult, Eip1193Provider} from "./types.ts";

/**
 * MetaMask's own reverse-DNS id, matched exactly.
 *
 * A prefix match is not safe here. `rdns` is self-declared by whatever announces itself, so anything in the
 * page can call itself `io.metamask.anything`, take the Recommended row from the real MetaMask and have every
 * other `io.metamask.*` announcer — the real one included — filtered out of the list entirely. Flask and
 * Institutional are real wallets with their own ids; they belong in the detected list under their own names,
 * not in place of MetaMask.
 */
export const METAMASK_RDNS = "io.metamask";

export const METAMASK_INSTALL_ID = "io.metamask.install";
export const GENERIC_INJECTED_ID = "injected.unknown";
export const METAMASK_DOWNLOAD_URL = "https://metamask.io/download/";

/** The MetaMask mobile deep link of SPEC §9.2, built from the page's own host and path. */
export function metaMaskDeepLink(location: Pick<Location, "host" | "pathname">): string {
  return `https://metamask.app.link/dapp/${location.host}${location.pathname}`;
}

/** A standalone mobile browser: an in-wallet browser injects a provider and never reaches this test. */
export function isMobileBrowser(userAgent: string): boolean {
  return /Android|webOS|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(userAgent);
}

function lowerAccounts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((a) => a.toLowerCase());
}

/** `eth_chainId` answers with a hex quantity; a few wallets answer with a number. Both become a bigint. */
export function parseChainId(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  throw new WalletError("Unknown", `The wallet reported an unusable chain id: ${String(value)}`);
}

/** Reads accounts and chain id from a provider without prompting (`eth_accounts`). */
export async function readSession(provider: Eip1193Provider): Promise<ConnectResult> {
  try {
    const accounts = lowerAccounts(await provider.request({method: "eth_accounts"}));
    const chainId = parseChainId(await provider.request({method: "eth_chainId"}));
    return {accounts, chainId};
  } catch (error) {
    throw toWalletError(error);
  }
}

function injectedConnector(
  id: string,
  name: string,
  icon: string | null,
  provider: Eip1193Provider,
  recommended: boolean,
): Connector {
  return {
    id,
    name,
    icon,
    recommended,
    detected: true,
    kind: "injected",
    installUrl: null,
    provider,
    async connect(): Promise<ConnectResult> {
      let accounts: readonly string[];
      try {
        accounts = lowerAccounts(await provider.request({method: "eth_requestAccounts"}));
      } catch (error) {
        throw toWalletError(error);
      }
      if (accounts.length === 0) {
        throw new WalletError("NoAccounts", `${name} did not return an account.`);
      }
      let chainId: bigint;
      try {
        chainId = parseChainId(await provider.request({method: "eth_chainId"}));
      } catch (error) {
        throw toWalletError(error);
      }
      return {accounts, chainId};
    },
    async disconnect(): Promise<void> {
      // EIP-1193 has no disconnect: the app forgets the session and the wallet keeps its own permission.
      // `wallet_revokePermissions` exists in MetaMask but is not in any standard, so it is not called here.
      return;
    },
  };
}

function installConnector(installUrl: string): Connector {
  return {
    id: METAMASK_INSTALL_ID,
    name: "MetaMask",
    icon: null,
    recommended: true,
    detected: false,
    kind: "install",
    installUrl,
    provider: null,
    connect(): Promise<ConnectResult> {
      return Promise.reject(
        new WalletError("WalletNotInstalled", "MetaMask is not available in this browser."),
      );
    },
    disconnect(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export type ConnectorEnvironment = {
  /** `window.ethereum`, used only when `details` is empty. */
  injected: Eip1193Provider | null;
  userAgent: string;
  location: Pick<Location, "host" | "pathname">;
};

/**
 * The ordered connector list. Pure: it reads nothing global, so the ordering and badging rules are directly
 * testable with a synthetic set of announcements.
 */
export function buildConnectors(
  details: readonly Eip6963ProviderDetail[],
  env: ConnectorEnvironment,
): readonly Connector[] {
  const metaMask = details.find((detail) => detail.info.rdns === METAMASK_RDNS);
  const others = details
    .filter((detail) => detail.info.rdns !== METAMASK_RDNS)
    .sort((a, b) => a.info.name.localeCompare(b.info.name));

  const connectors: Connector[] = [];
  if (metaMask !== undefined) {
    connectors.push(
      injectedConnector(metaMask.info.rdns, metaMask.info.name, metaMask.info.icon, metaMask.provider, true),
    );
  } else {
    connectors.push(
      installConnector(
        isMobileBrowser(env.userAgent) ? metaMaskDeepLink(env.location) : METAMASK_DOWNLOAD_URL,
      ),
    );
  }
  for (const detail of others) {
    connectors.push(
      injectedConnector(detail.info.rdns, detail.info.name, detail.info.icon, detail.provider, false),
    );
  }
  if (details.length === 0 && env.injected !== null) {
    // Nothing announced, but something is injected. It is named generically on purpose.
    connectors.push(injectedConnector(GENERIC_INJECTED_ID, "Browser wallet", null, env.injected, false));
  }
  return connectors;
}
