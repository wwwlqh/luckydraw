// Catalog rows for every `QuoteReason` member (SPEC §5.1, §8.1, §9.6).
//
// quoteBuy never reverts: it returns a reason so the entry panel can explain, before any signature, why an
// amount is not admissible (SPEC §8.1 "Quote never reverts for inadmissible input and is advisory"). Where a
// reason shares its name with a custom error, this file reuses that error's row object, so the quote and the
// revert always read identically. InvalidRound and InvalidAmount are quote-only phrasings: InvalidRound has
// no error counterpart (the revert is InvalidId) and quoteBuy returns InvalidAmount only for a zero amount.
//
// Keys are prefixed `Quote:` because several reason names also name a custom error.

import {QuoteReasonNames} from "../types/generated.ts";
import {errorCatalog} from "./errors.ts";
import type {CatalogEntry, QuoteReasonName} from "./types.ts";

export const quoteReasonCatalog = {
  "Quote:None": {
    message: "This entry can go ahead.",
    funds: "Nothing debited",
    nextAction: "Review the preview, then confirm in your wallet",
  },
  "Quote:InvalidRound": {
    message: "That round does not exist.",
    funds: "Nothing debited",
    nextAction: "Return to Pools and pick a round",
  },
  "Quote:EntryWindowClosed": errorCatalog.EntryWindowClosed,
  "Quote:InvalidAmount": {
    message: "The amount is zero, so there is nothing to quote.",
    funds: "Nothing debited",
    nextAction: "Enter an amount above zero",
  },
  "Quote:BuysPaused": errorCatalog.BuysPaused,
  "Quote:PriceUnavailable": errorCatalog.PriceUnavailable,
  "Quote:PriceInvalid": errorCatalog.PriceInvalid,
  "Quote:PriceStale": errorCatalog.PriceStale,
  "Quote:PriceDecimalsChanged": errorCatalog.PriceDecimalsChanged,
  "Quote:BelowMinimum": errorCatalog.BelowMinimum,
  "Quote:InsufficientBalance": errorCatalog.InsufficientBalance,
  "Quote:SeedAccountCannotBuy": errorCatalog.SeedAccountCannotBuy,
  // SPEC §9.6 verbatim: the "ArithmeticOverflow (quote)" row. There is no ArithmeticOverflow custom error.
  "Quote:ArithmeticOverflow": {
    message: "This amount or the round value is too large to quote.",
    funds: "Nothing debited",
    nextAction: "Reduce the amount and re-quote; if it persists, contact support",
  },
} satisfies Record<`Quote:${QuoteReasonName}`, CatalogEntry>;

export type QuoteReasonCatalogKey = keyof typeof quoteReasonCatalog;

/**
 * The catalog key for a `QuoteReason` ABI value, or `undefined` when the value is outside the enum this
 * client knows (a newer deployment appended a member: SPEC §5.1 keeps QuoteReason append-only).
 */
export const quoteReasonCatalogKey = (reason: bigint | number): QuoteReasonCatalogKey | undefined => {
  const index = Number(reason);
  if (!Number.isInteger(index) || index < 0 || index >= QuoteReasonNames.length) return undefined;
  const name = QuoteReasonNames[index];
  return name === undefined ? undefined : (`Quote:${name}` as QuoteReasonCatalogKey);
};
