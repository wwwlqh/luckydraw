// Turning a revert or a wallet error into the three columns SPEC §9.6 requires: message, funds effect and
// next action.
//
// Every sentence comes from `@luckydraw/client`'s catalog, which is where §9.6 is actually implemented; this
// file only chooses the key and substitutes the placeholders. An unrecognized revert falls through to the
// `UnknownRevert` row with its selector and data kept for copying, exactly as §9.6 requires.

import {
  type CatalogKey,
  CatalogRenderError,
  catalogEntryFor,
  type DecodedRevert,
  hasCatalogEntry,
  panicCatalogKey,
  renderMessage,
} from "@luckydraw/client";
import {en} from "../../strings/en.ts";
import {WalletError, walletSaid} from "../wallet/errors.ts";
import type {TxFailure} from "./types.ts";

/** Supplies already-formatted values for a catalog message's placeholders (amounts, symbols, times). */
export type RevertParamFormatter = (decoded: DecodedRevert) => Readonly<Record<string, string>>;

function render(key: CatalogKey, params: Readonly<Record<string, string>>): string {
  const entry = catalogEntryFor(key);
  try {
    return renderMessage(entry, params);
  } catch (error) {
    if (!(error instanceof CatalogRenderError)) throw error;
    // A placeholder the caller could not fill: never print braces next to money (SPEC §9.7). The em dash
    // says "not available here" and the surface that owns the numbers passes a formatter to avoid it.
    return renderMessage(entry, Object.fromEntries((entry.params ?? []).map((name) => [name, "—"])));
  }
}

function fromKey(key: CatalogKey, params: Readonly<Record<string, string>>): TxFailure {
  const entry = catalogEntryFor(key);
  return {
    catalogKey: key,
    message: render(key, params),
    funds: entry.funds,
    nextAction: entry.nextAction,
    selector: null,
    data: null,
  };
}

/** The `UnknownRevert` row with the copyable evidence §9.6 asks for. */
export function unknownRevertFailure(selector: string | null, data: string | null): TxFailure {
  return {...fromKey("UnknownRevert", {}), selector, data};
}

/** Maps a decoded revert onto its catalog row. */
export function failureFromRevert(decoded: DecodedRevert, formatParams?: RevertParamFormatter): TxFailure {
  const params = formatParams?.(decoded) ?? {};
  switch (decoded.kind) {
    case "custom": {
      // A custom error the token raised is the token's rule, not LuckyDraw's (SPEC §9.6 TokenReverted).
      if (decoded.contract === "token") return fromKey("TokenReverted", params);
      if (hasCatalogEntry(decoded.name)) return fromKey(decoded.name, params);
      return unknownRevertFailure(decoded.selector, null);
    }
    case "panic": {
      const key = panicCatalogKey(decoded.code);
      if (key === undefined) return unknownRevertFailure(null, null);
      return fromKey(key, params);
    }
    case "reason": {
      const failure = fromKey("UnknownRevert", params);
      return {...failure, message: decoded.message};
    }
    case "unknown":
      return unknownRevertFailure(decoded.selector, decoded.data);
    case "none":
      return unknownRevertFailure(null, null);
    default:
      return unknownRevertFailure(null, null);
  }
}

/** Maps a wallet-layer failure onto its catalog row. */
export function failureFromWalletError(error: WalletError): TxFailure {
  switch (error.code) {
    case "UserRejected":
      return fromKey("WalletRejected", {});
    case "Disconnected":
      return fromKey("WalletUnreachable", {});
    case "WrongChain": {
      // The wallet layer wrote this message with the deployment chain's display name (useSigner) or with
      // both chain ids (ethersAdapters); the row here supplies the funds effect and the next action. Rendering
      // the row itself would have no chain to name.
      const entry = catalogEntryFor("WrongChain");
      return {
        catalogKey: "WrongChain",
        message: error.message,
        funds: entry.funds,
        nextAction: entry.nextAction,
        selector: null,
        data: null,
      };
    }
    case "AccountMismatch":
      return {
        catalogKey: null,
        message: error.message,
        funds: "Nothing sent",
        nextAction: "Review this action again with the account you want to use",
        selector: null,
        data: null,
      };
    case "RequestPending":
      return {
        catalogKey: null,
        message: "Your wallet already has a request open. Finish it there, then try again.",
        funds: "Nothing sent",
        nextAction: "Open your wallet and answer the request that is already waiting",
        selector: null,
        data: null,
      };
    default:
      // The wallet's own words are not the app's sentence: an extension can put anything in `message`, and
      // rendering it alone in an alert makes whatever it says read as LuckyDraw speaking (SPEC §9.7). The
      // app says what happened; the wallet's text is carried separately and labelled by the surface.
      return {
        catalogKey: null,
        message: en.wallet.errorReported,
        walletText: walletSaid(error.message),
        funds: "Nothing sent",
        nextAction: "Try again; nothing was sent",
        selector: null,
        data: null,
      };
  }
}

/**
 * The wallet-unreachable row for the one case where a hash is already known: the broadcast landed and only
 * the wallet's follow-up poll failed. The catalog sentence ("nothing is confirmed sent") would be read as
 * "nothing was sent", which is exactly the wrong thing to tell someone whose transaction is on its way, so
 * the message is the app's own while the funds effect and the next action stay the catalog's (SPEC §9.6).
 */
export function walletUnreachableWithHashFailure(error: WalletError): TxFailure {
  return {...failureFromWalletError(error), catalogKey: null, message: en.tx.walletUnreachableWithHash};
}

/**
 * The wrong-chain row for the one case where a hash is already known: the wallet accepted the request's
 * `chainId`, signed on another chain anyway, and told us so only after broadcasting.
 *
 * The catalog `WrongChain` row says "Nothing sent", which is right for the §9.2 network guard that fires
 * before the wallet is ever opened and wrong here: a hash exists, so §9.6 requires "Unknown until receipt".
 * The message stays the wallet layer's, because only it knows which two chain ids to name.
 */
export function wrongChainWithHashFailure(error: WalletError): TxFailure {
  return {
    catalogKey: null,
    message: error.message,
    funds: "Unknown until receipt",
    nextAction: "Check the transaction by its hash on that chain before sending anything again",
    selector: null,
    data: null,
  };
}

/** The `NonceOrReplacement` row: the outcome is unknown until a receipt says otherwise (SPEC §9.6). */
export function nonceOrReplacementFailure(): TxFailure {
  return fromKey("NonceOrReplacement", {});
}

/**
 * The node answered this hash with a transaction that is not the one this app prepared.
 *
 * Nothing about the user's own transaction is known from that answer, so the funds effect is the §9.6
 * "Unknown until receipt" row rather than anything more confident, and the app stops watching instead of
 * narrating a stranger's transaction as the user's own.
 */
export function hashMismatchFailure(): TxFailure {
  return {
    catalogKey: null,
    message: en.tx.hashMismatch,
    funds: "Unknown until receipt",
    nextAction: "Check the transaction by its hash in a block explorer before sending anything again",
    selector: null,
    data: null,
  };
}

/** ethers reports a wallet that cannot pay for gas as `INSUFFICIENT_FUNDS`; some nodes only say it in text. */
function isInsufficientFunds(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    const record = error as {code?: unknown; error?: unknown; info?: unknown};
    if (record.code === "INSUFFICIENT_FUNDS") return true;
    for (const nested of [record.error, record.info]) {
      if (nested !== null && typeof nested === "object" && isInsufficientFunds(nested)) return true;
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /insufficient funds/i.test(message);
}

/**
 * Anything thrown that is not already a `WalletError` is classified before being described.
 *
 * `hasHash` is the difference between "we do not know what happened to your money" and "nothing left this
 * browser". A gas estimate that fails happens **before** any signature exists, so the §9.6 funds effect is
 * "Nothing sent"; saying "Unknown until receipt" there sends someone hunting for a hash that was never
 * created. It defaults to true, which is the conservative answer for a caller that cannot say.
 */
export function failureFromUnknown(error: unknown, options?: {hasHash?: boolean}): TxFailure {
  if (error instanceof WalletError) return failureFromWalletError(error);
  if (isInsufficientFunds(error)) return fromKey("InsufficientGas", {});
  const hasHash = options?.hasHash ?? true;
  return {
    catalogKey: null,
    message: error instanceof Error ? error.message : String(error),
    funds: hasHash ? "Unknown until receipt" : "Nothing sent",
    nextAction: hasHash
      ? "Check the transaction by its hash before sending anything again"
      : "Retry; nothing was signed or sent",
    selector: null,
    data: null,
  };
}
