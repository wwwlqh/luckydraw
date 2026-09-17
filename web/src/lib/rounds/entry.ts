// The entry flow's arithmetic and its pipeline steps (SPEC §9.5).
//
// Nothing in this file renders, reads or signs. It is the part of the entry panel that can be checked without
// a DOM: how a typed amount becomes raw units, what the live preview says, what invalidates that preview, and
// which of the §9.5 disclosures apply.
//
// The panel itself owns only the order of the pipeline:
//
//   readEntryPanel -> previewEntry (live, per keystroke)
//   -> a fresh readEntryPanel/quoteBuy -> entryFromQuote -> prepareBuy -> useTransaction.send
//
// The second read is not an optimization to skip: `previewEntry` is advisory by construction ("It must never
// approve what quoteBuy would reject"), and `entryFromQuote` refuses a quote read for another round, buyer,
// asset or amount, which is the guard that makes a successor round or a switched account impossible to sign.

import {
  type Address,
  type EntryOutcome,
  type EntryPanel,
  type EntryPreview,
  entryFromQuote,
  type ParseFailureReason,
  parseDecimalInput,
  previewEntry,
  QuoteReason,
  scaleOf,
  targetGross,
  toObservationInput,
} from "@luckydraw/client";
import {previewRoundOf, usdCents} from "./derive.ts";

/** Whether the field holds an amount in the pool asset or an estimated USD amount (SPEC §9.5). */
export type EntryMode = "asset" | "usd";

/** The quick presets of SPEC §9.5, in whole USD. */
export const USD_PRESETS: readonly bigint[] = [1n, 5n, 20n, 100n];

/** Fraction digits a USD field accepts. Cents; the presets themselves are whole USD. */
export const USD_DECIMALS = 2;

/** SPEC §9.5: re-read the feed and wait when the observation is this close to its age limit. */
export const PRICE_REFRESH_MARGIN_SECONDS = 15n;

/** SPEC §9.5: the confirm control warns inside this window before the cutoff. */
export const FINAL_WARNING_SECONDS = 120n;

/** SPEC §9.5: warn when the network fee exceeds this share of the gross entry. */
export const GAS_WARNING_NUMERATOR = 1n;
export const GAS_WARNING_DENOMINATOR = 4n;

export type ParsedAmount =
  | {ok: true; raw: bigint}
  | {ok: false; reason: ParseFailureReason | "usdPrecision" | "noPrice"};

/**
 * `ceil(a / b)` for non-negative bigints. The USD field rounds *up* into raw units so the debit shown is
 * never below the USD the user asked for (SPEC §9.5: "integer upward rounding from the current quote").
 */
function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/**
 * A typed amount in raw asset units.
 *
 * The asset field is `parseDecimalInput` exactly (SPEC §9.5: "The decimal text parser rejects excess
 * precision, negatives, exponents and malformed separators without floating-point conversion"). The USD field
 * is the same parser at two decimals, then `ceil(cents * scale / (price * 100))`, which is `targetGross`
 * generalized to cents and agrees with it on every whole-USD value.
 */
export function parseEntryAmount(
  text: string,
  mode: EntryMode,
  round: {tokenDecimals: number; feedDecimals: number},
  price: bigint,
): ParsedAmount {
  if (mode === "asset") {
    const parsed = parseDecimalInput(text, round.tokenDecimals);
    return parsed.ok ? {ok: true, raw: parsed.raw} : {ok: false, reason: parsed.reason};
  }
  const parsed = parseDecimalInput(text, USD_DECIMALS);
  if (!parsed.ok) {
    return {ok: false, reason: parsed.reason === "tooManyFractionDigits" ? "usdPrecision" : parsed.reason};
  }
  if (price <= 0n) return {ok: false, reason: "noPrice"};
  const scale = scaleOf(round.tokenDecimals, round.feedDecimals);
  return {ok: true, raw: ceilDiv(parsed.raw * scale, price * 100n)};
}

/** A whole-USD preset in raw units, rounded up (SPEC §9.5: presets "converted upward to raw units"). */
export function presetGross(
  round: {tokenDecimals: number; feedDecimals: number},
  price: bigint,
  usd: bigint,
): bigint | null {
  if (price <= 0n) return null;
  return targetGross(round.tokenDecimals, round.feedDecimals, price, usd);
}

/**
 * The live preview: `previewEntry` over exactly the fields `readEntryPanel` returned, evaluated at the
 * snapshot's chain timestamp.
 */
export function previewFor(panel: EntryPanel, gross: bigint, now: bigint): EntryPreview {
  return previewEntry({
    now,
    round: previewRoundOf(panel.round),
    grossAmount: gross,
    observation: toObservationInput(panel.round, panel.feed, now),
    buyer: {
      grossByUser: panel.position.gross,
      availableBalance: panel.balance,
      seedMaxPerRound: panel.seedMaxPerRound,
    },
    buysPaused: panel.buysPaused,
    poolBuysPaused: panel.pool.buysPaused,
    seed:
      panel.seed === null
        ? undefined
        : {
            account: panel.seed.account,
            amount: panel.seed.amount,
            maxPerRound: panel.seed.maxPerRound,
            availableBalance: panel.seed.availableBalance,
            grossByUser: panel.seed.grossByUser,
          },
  });
}

/**
 * What a preview answers for. SPEC §9.5: "A new amount requires a fresh preview, and so does a new round or
 * a new signing account." A confirmed plan is kept only while this key is unchanged.
 */
export function entryKey(roundId: bigint, account: Address | null, gross: bigint): string {
  return `${roundId}|${account ?? "none"}|${gross}`;
}

/** `entryFromQuote` over a freshly read panel: the only place calldata parameters come from (SPEC §9.5). */
export function planFrom(
  panel: EntryPanel,
  request: {roundId: bigint; user: Address; gross: bigint; chainTimestamp: bigint},
): EntryOutcome {
  return entryFromQuote(
    {quote: panel.quote, quotedFor: panel.quotedFor},
    {
      roundId: request.roundId,
      user: request.user,
      asset: panel.round.asset,
      gross: request.gross,
      chainTimestamp: request.chainTimestamp,
    },
  );
}

/** True when the observation is within 15 seconds of its age limit: re-read and wait (SPEC §9.5). */
export function needsFreshPrice(ageSeconds: bigint, maxPriceAge: bigint): boolean {
  if (maxPriceAge <= PRICE_REFRESH_MARGIN_SECONDS) return ageSeconds >= maxPriceAge;
  return ageSeconds >= maxPriceAge - PRICE_REFRESH_MARGIN_SECONDS;
}

/** True inside the final 120 seconds before the cutoff (SPEC §9.5). */
export function inFinalSeconds(remaining: bigint): boolean {
  return remaining > 0n && remaining <= FINAL_WARNING_SECONDS;
}

/**
 * True when the estimated network fee exceeds a quarter of the gross entry (SPEC §9.5).
 *
 * Both sides are USD cents, each from its own feed: the gross from the round's reference price, the gas from
 * the native asset's, because a token pool's feed prices the token and not the gas.
 */
export function gasExceedsShare(gasCents: bigint | null, grossCents: bigint | null): boolean {
  if (gasCents === null || grossCents === null || grossCents <= 0n) return false;
  return gasCents * GAS_WARNING_DENOMINATOR > grossCents * GAS_WARNING_NUMERATOR;
}

/** The gross entry in USD cents, for the comparison above. */
export function grossUsdCents(panel: EntryPanel, price: bigint, gross: bigint): bigint | null {
  return usdCents(Number(panel.round.tokenDecimals), Number(panel.round.pricing.feedDecimals), price, gross);
}

/** True when the quote the panel already holds is a rejection the user can act on rather than an acceptance. */
export function quoteRejected(preview: EntryPreview): boolean {
  return preview.reason !== QuoteReason.None;
}

/**
 * The fallback operator seed the live preview modelled for this purchase (SPEC §5.4).
 *
 * `previewEntry` adds the seed it would enter to `shareDenominatorAfter`, exactly as `quoteBuy` does, so the
 * pot delta above the gross is that seed. This is the same derivation `entryFromQuote` makes from the
 * authoritative quote, which is what makes the two comparable.
 */
export function previewFallbackSeedGross(preview: EntryPreview, gross: bigint): bigint {
  const potDelta = preview.shareDenominatorAfter - preview.shareDenominatorBefore;
  return potDelta > gross ? potDelta - gross : 0n;
}

/** The disclosures a confirmed plan carries that the live preview can be checked against. */
export type PlanDisclosures = {
  feeDelta: bigint;
  netDelta: bigint;
  reachesTarget: boolean;
  fallbackSeedGross: bigint;
};

/**
 * Whether a plan read at an earlier block still describes the purchase the panel is showing now.
 *
 * A confirmed plan is calldata plus the disclosures SPEC §9.5 requires beside it. The panel keeps re-reading
 * while the plan is held (SPEC §10.1: "every 10 seconds while the entry panel is open"), so the live preview
 * is the check: if the round has moved under the plan — the fee split changed, a fallback seed appeared or
 * left, the purchase no longer reaches the target, the balance no longer covers the gross, or the quote would
 * now be rejected outright — the disclosures on screen are no longer the ones this calldata would produce and
 * the plan is dropped rather than confirmed beside figures that belong to another block (§9.1 X1, X2).
 */
export function planStillAgrees(
  plan: PlanDisclosures,
  preview: EntryPreview,
  context: {gross: bigint; balance: bigint},
): boolean {
  if (preview.reason !== QuoteReason.None) return false;
  if (context.balance < context.gross) return false;
  return (
    plan.feeDelta === preview.feeDelta &&
    plan.netDelta === preview.netDelta &&
    plan.reachesTarget === preview.reachesTarget &&
    plan.fallbackSeedGross === previewFallbackSeedGross(preview, context.gross)
  );
}
