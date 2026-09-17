// Wallet failures, classified (SPEC §9.6).
//
// The point of this file is one distinction the transaction state machine depends on: a user who pressed
// Reject in the wallet (EIP-1193 code 4001) is not a failure to report, retry or alert on, and it must never
// be shown with the same words as a wallet that cannot be reached. Every provider call in this app is
// wrapped so that distinction survives.

export type WalletErrorCode =
  /** EIP-1193 4001. The user pressed Reject. */
  | "UserRejected"
  /** EIP-1193 4100. The account or method has not been authorized. */
  | "Unauthorized"
  /** EIP-1193 4200. */
  | "UnsupportedMethod"
  /** EIP-1193 4900/4901, or the provider vanished mid-request. */
  | "Disconnected"
  /** EIP-3085/3326 4902. The chain is not in the wallet yet; `wallet_addEthereumChain` is the fallback. */
  | "ChainNotAdded"
  /** MetaMask -32002: a previous prompt is still open. */
  | "RequestPending"
  /** No wallet to connect: the entry is an install link. */
  | "WalletNotInstalled"
  /** The wallet answered with no accounts. */
  | "NoAccounts"
  /** The wallet's active account is not the one the write was quoted for (SPEC §9.5). */
  | "AccountMismatch"
  /** The wallet's live `eth_chainId` is not the deployment's chain (SPEC §9.2 network guard). */
  | "WrongChain"
  | "Unknown";

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  /** The provider's numeric code, when it reported one. */
  readonly providerCode: number | null;

  constructor(code: WalletErrorCode, message: string, options?: {cause?: unknown; providerCode?: number}) {
    super(message, options?.cause === undefined ? undefined : {cause: options.cause});
    this.name = "WalletError";
    this.code = code;
    this.providerCode = options?.providerCode ?? null;
  }
}

function numericCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const record = error as {code?: unknown; error?: unknown; info?: unknown};
  if (typeof record.code === "number") return record.code;
  // ethers wraps a provider error; MetaMask nests one under `info.error` or `error`.
  for (const nested of [record.error, record.info]) {
    const found = numericCode(nested);
    if (found !== null) return found;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** Classifies anything a provider throws. Already-classified errors pass through unchanged. */
export function toWalletError(
  error: unknown,
  fallback = "The wallet could not complete this request.",
): WalletError {
  if (error instanceof WalletError) return error;
  const code = numericCode(error);
  const message = messageOf(error) || fallback;
  switch (code) {
    case 4001:
      return new WalletError("UserRejected", message, {cause: error, providerCode: code});
    case 4100:
      return new WalletError("Unauthorized", message, {cause: error, providerCode: code});
    case 4200:
      return new WalletError("UnsupportedMethod", message, {cause: error, providerCode: code});
    case 4900:
    case 4901:
      return new WalletError("Disconnected", message, {cause: error, providerCode: code});
    case 4902:
      return new WalletError("ChainNotAdded", message, {cause: error, providerCode: code});
    case -32002:
      return new WalletError("RequestPending", message, {cause: error, providerCode: code});
    default:
      break;
  }
  // Some wallets report an unknown chain as a generic error whose text is the only signal (SPEC §9.2 network
  // guard still has to fall back to wallet_addEthereumChain for those).
  if (/unrecognized chain|unrecognised chain|chain.*not (been )?added|add.*chain/i.test(message)) {
    return new WalletError("ChainNotAdded", message, {
      cause: error,
      ...(code === null ? {} : {providerCode: code}),
    });
  }
  if (/user (rejected|denied|cancel)/i.test(message)) {
    return new WalletError("UserRejected", message, {
      cause: error,
      ...(code === null ? {} : {providerCode: code}),
    });
  }
  return new WalletError("Unknown", message, {cause: error, ...(code === null ? {} : {providerCode: code})});
}

/** How much wallet-authored text a surface will show. Long enough to be useful, short enough not to shout. */
export const WALLET_TEXT_MAX = 200;

/**
 * Normalizes wallet-authored text for display next to a "Wallet said:" label.
 *
 * A browser extension writes `error.message`, so it is third-party content: it is collapsed to one line and
 * capped, and the surface that renders it must label it as the wallet's words rather than present it as the
 * app's own sentence. Returns null when the wallet said nothing usable.
 */
export function walletSaid(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  const text = message.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length <= WALLET_TEXT_MAX ? text : `${text.slice(0, WALLET_TEXT_MAX - 1)}…`;
}

/**
 * The same one-line cap, for text an RPC node rather than a wallet authored.
 *
 * A node's error string is third-party content exactly as a wallet's is, and §9.7 keeps both out of the
 * app's own sentences: a surface renders this under a label, next to a catalog message, never as the
 * message.
 */
export function providerSaid(message: string | null | undefined): string | null {
  return walletSaid(message);
}

/** True for the one branch that is a user decision rather than a failure. */
export function isUserRejection(error: unknown): boolean {
  return toWalletError(error).code === "UserRejected";
}
