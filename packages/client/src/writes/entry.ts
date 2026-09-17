// A quote turned into `buy` parameters, with the disclosures the entry panel must show (SPEC §5.3, §9.5).
//
// Three rules from SPEC §9.5, implemented here and nowhere else:
//
//   "Set minNetContribution to max(0, quotedNetDelta-1 raw unit) to tolerate only fee rounding or order
//    movement."
//   "Default deadline=min(now+300 seconds, closesAt-1); refuse if no time remains."
//   "A new amount requires a fresh preview."
//
// The deadline comes from the chain timestamp the quote was read at, never from `Date.now()`: SPEC §9.6 says
// "Countdown uses a recent chain timestamp plus monotonic elapsed time; the client clock never authorizes an
// entry", and a wall-clock deadline on a skewed machine either expires instantly or outlives the cutoff.
//
// A quote is bound to what it was read for. `ILuckyDraw.Quote` carries no round id, buyer or asset, so the
// read adapters stamp each quote with a `QuoteContext` (`types/quoted.ts`) and this module refuses a request
// that names another round, another buyer or another asset, or an amount the quote did not describe. Without
// that binding the two events SPEC §9.5 anticipates between a preview and a prompt - a purchase reaching the
// target so the successor opens, and the wallet switching accounts - would let an old quote sign calldata
// whose disclosures belong to another round or another buyer, and the contract would execute it: the
// successor shares the pool, the asset and the calendar cutoff, so neither the deadline nor the guard would
// catch it, and the entry is final.

import {minNetContribution as guardFor} from "../math/fee.ts";
import type {Address} from "../types/common.ts";
import {QuoteReason, type QuoteReasonName, quoteReasonName} from "../types/generated.ts";
import type {QuoteContext, QuotedBuy} from "../types/quoted.ts";
import type {BuyParams} from "./prepare.ts";

/** SPEC §9.5: "Default deadline=min(now+300 seconds, closesAt-1)". */
export const DEFAULT_DEADLINE_SECONDS = 300n;

export type EntryRequest = {
  /** The round the app is about to enter. Must be the round the quote was read for. */
  roundId: bigint;
  /** The account that will sign, as the wallet reports it at prompt time. Must be the quoted `user`. */
  user: Address;
  /** The asset the decoded summary will name (SPEC §9.6). Must be the quoted round's asset. */
  asset: Address;
  /**
   * The gross the quote was taken for. A different amount needs a fresh quote (SPEC §9.5), and the quote
   * itself is checked against it: an accepted quote carries its gross as `feeDelta + netDelta` and as
   * `shareNumeratorAfter - shareNumeratorBefore`, so a stale quote cannot dress up different calldata.
   */
  gross: bigint;
  /** The snapshot's block timestamp (SPEC §10.1), not a wall clock. */
  chainTimestamp: bigint;
  /** Seconds of validity to ask for, before the `closesAt - 1` clamp. Defaults to 300 (SPEC §9.5). */
  deadlineSeconds?: bigint | undefined;
};

/** What the confirmation has to say about this particular purchase (SPEC §5.3, §9.5). */
export type EntryDisclosures = {
  /**
   * The purchase closes the round as TargetReached and, while the pool stays enabled, opens its successor:
   * "the network fee is higher" (SPEC §5.3, §9.5).
   */
  reachesTarget: boolean;
  /**
   * This purchase also enters the fallback operator seed, which SPEC §5.3 and §9.5 require the confirmation
   * to disclose as a higher network fee. Taken from the quote itself: `quoteBuy` adds the seed it would enter
   * to `shareDenominatorAfter`, so the quoted pot delta above the gross is the seed (SPEC §5.4).
   */
  paysFallbackSeed: boolean;
  /** The fallback seed's gross when `paysFallbackSeed`, zero otherwise. */
  fallbackSeedGross: bigint;
  /** Fee attributed to this purchase, for the "3% reserved fee (raw precision disclosure)" line. */
  feeDelta: bigint;
  /** Prize contribution, for the "net addition to the prize" line. */
  netDelta: bigint;
  /** The USD 1 admission minimum at the quoted price. */
  minGross: bigint;
  /** The buyer's gross after the purchase, for "current share, changes until cutoff as others enter". */
  shareNumeratorAfter: bigint;
  /** The round's gross after the purchase, pending seed included. */
  shareDenominatorAfter: bigint;
  /** Whole-USD reference value of the pot after the purchase. */
  usdValueAfter: bigint;
  /** The round's frozen cutoff, for the UTC and local cutoff line. */
  closesAt: bigint;
};

export type EntryPlan = {
  ok: true;
  params: BuyParams;
  disclosures: EntryDisclosures;
};

/** Which part of the quoted context a request disagreed with. */
export type QuoteContextField = "roundId" | "user" | "asset" | "seeded";

export type EntryRefusal =
  | {
      ok: false;
      kind: "QuoteRejected";
      reason: QuoteReason;
      reasonName: QuoteReasonName;
    }
  | {
      ok: false;
      kind: "NoTimeRemaining";
      closesAt: bigint;
      chainTimestamp: bigint;
    }
  | {
      ok: false;
      kind: "QuoteAmountMismatch";
      quotedGross: bigint;
      requestedGross: bigint;
    }
  | {
      ok: false;
      kind: "QuoteContextMismatch";
      field: QuoteContextField;
      quotedFor: QuoteContext;
    };

export type EntryOutcome = EntryPlan | EntryRefusal;

function mismatch(field: QuoteContextField, quotedFor: QuoteContext): EntryRefusal {
  return {ok: false, kind: "QuoteContextMismatch", field, quotedFor};
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function noTimeRemaining(closesAt: bigint, chainTimestamp: bigint): EntryRefusal {
  return {ok: false, kind: "NoTimeRemaining", closesAt, chainTimestamp};
}

/**
 * Turns an accepted `quoteBuy` result into the exact `buy` arguments, or refuses.
 *
 * Refuses when the quote itself is not `None` - the client never builds a transaction the contract already
 * said it would reject - when the request names a round, buyer, asset or amount the quote was not read for,
 * and when no time remains before the cutoff, because a deadline at or after `closesAt` would let a
 * transaction be included into a window that has closed and revert `EntryWindowClosed` with gas spent
 * (SPEC §9.5). The round id and the asset of an accepted plan are the quoted ones.
 */
export function entryFromQuote(quoted: QuotedBuy, request: EntryRequest): EntryOutcome {
  const {quote, quotedFor} = quoted;
  if (quote.reason !== QuoteReason.None) {
    return {
      ok: false,
      kind: "QuoteRejected",
      reason: quote.reason,
      reasonName: quoteReasonName(quote.reason),
    };
  }

  // The quote answers only for the round, the buyer and the asset it was read for (`types/quoted.ts`).
  if (quotedFor.roundId !== request.roundId) return mismatch("roundId", quotedFor);
  if (!sameAddress(quotedFor.user, request.user)) return mismatch("user", quotedFor);
  if (!sameAddress(quotedFor.asset, request.asset)) return mismatch("asset", quotedFor);

  // SPEC §9.5: "A new amount requires a fresh preview." An accepted quote carries its own gross twice
  // (`netDelta = gross - feeDelta` in LuckyDraw._feeSplit; `shareNumeratorAfter = before + gross` in
  // quoteBuy), so calldata for a different amount than the quote described is refused here, where the
  // disclosures and the guard would otherwise belong to another purchase.
  const quotedGross = quote.feeDelta + quote.netDelta;
  const quotedShareGross = quote.shareNumeratorAfter - quote.shareNumeratorBefore;
  if (quotedGross !== request.gross || quotedShareGross !== request.gross) {
    return {ok: false, kind: "QuoteAmountMismatch", quotedGross, requestedGross: request.gross};
  }

  // The pot delta is the gross plus the fallback seed `quoteBuy` modelled: `postGross = baseGross + gross`
  // with `baseGross = grossTotal + seedAmount` when the seed would enter first (SPEC §5.4). Below the gross
  // it is no quote of this purchase at all; above it on a round that is already seeded it is a quote of
  // another round or another block, because a seeded round never models a seed.
  const potDelta = quote.shareDenominatorAfter - quote.shareDenominatorBefore;
  if (potDelta < request.gross) {
    return {ok: false, kind: "QuoteAmountMismatch", quotedGross: potDelta, requestedGross: request.gross};
  }
  const fallbackSeedGross = potDelta - request.gross;
  if (quotedFor.seeded && fallbackSeedGross > 0n) return mismatch("seeded", quotedFor);

  // A zero or negative timestamp is no chain time: a deadline built on it expires in the first real block.
  if (request.chainTimestamp <= 0n) return noTimeRemaining(quote.closesAt, request.chainTimestamp);
  const latest = quote.closesAt - 1n;
  if (latest <= request.chainTimestamp) return noTimeRemaining(quote.closesAt, request.chainTimestamp);

  const seconds = request.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  if (seconds <= 0n) return noTimeRemaining(quote.closesAt, request.chainTimestamp);
  const asked = request.chainTimestamp + seconds;
  const deadline = asked < latest ? asked : latest;

  return {
    ok: true,
    params: {
      roundId: quotedFor.roundId,
      asset: quotedFor.asset,
      gross: request.gross,
      minNetContribution: guardFor(quote.netDelta),
      deadline,
    },
    disclosures: {
      reachesTarget: quote.reachesTarget,
      paysFallbackSeed: fallbackSeedGross > 0n,
      fallbackSeedGross,
      feeDelta: quote.feeDelta,
      netDelta: quote.netDelta,
      minGross: quote.minGross,
      shareNumeratorAfter: quote.shareNumeratorAfter,
      shareDenominatorAfter: quote.shareDenominatorAfter,
      usdValueAfter: quote.usdValueAfter,
      closesAt: quote.closesAt,
    },
  };
}
