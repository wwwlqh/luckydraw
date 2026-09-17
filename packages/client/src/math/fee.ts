/// Cumulative 3% fee arithmetic (SPEC §5.2, `spec_reference.fee` / `fee_delta`,
/// `LuckyDraw._feeSplit` / `_appendEntry`).
///
/// The fee is always computed on the round's cumulative gross and rounded down, so splitting a total across
/// buys or wallets cannot reduce the round's total fee; the sub-raw-unit remainder stays in the prize pot.

import {BPS, FEE_BPS, MAX_UINT256} from "./constants.ts";
import {require_} from "./mathError.ts";

export {BPS, FEE_BPS};

/// The running fee state of a round, as `getRound` returns it.
export interface RoundFeeState {
  /// Cumulative gross entered so far, fee reserve included.
  readonly grossTotal: bigint;
  /// `feeOf(grossTotal)`, the reserve held for the fee account.
  readonly feeReserved: bigint;
}

/// One entry applied to a round's fee state.
export interface EntryFeeResult {
  /// Fee attributed to this entry: `F(G+g) - F(G)` (SPEC §5.2).
  readonly feeDelta: bigint;
  /// Prize-pot contribution of this entry: `g - feeDelta`.
  readonly netDelta: bigint;
  /// Cumulative gross after the entry; also this entry's range `cumulativeGross` (SPEC §5.1).
  readonly grossTotal: bigint;
  /// `feeOf(grossTotal)` after the entry.
  readonly feeReserved: bigint;
  /// `grossTotal - feeReserved` after the entry.
  readonly prizePot: bigint;
}

/// `F(G) = floor(G * 300 / 10000)`, the reserve held at cumulative gross `G` (SPEC §5.2,
/// `spec_reference.fee`).
export function feeOf(gross: bigint): bigint {
  require_(gross >= 0n && gross <= MAX_UINT256, "InvalidInput", `gross out of uint256 range: ${gross}`);
  return (gross * FEE_BPS) / BPS;
}

/// `F(G + g) - F(G)`, the fee attributed to one entry of `gross` into a round already holding `grossBefore`
/// (SPEC §5.2, `spec_reference.fee_delta`). Mirrors `LuckyDraw._feeSplit` when `feeReserved == feeOf(G)`.
///
/// The result is `floor(g * 3 / 100)` or one raw unit more, depending on where the entry lands in the
/// cumulative sum; the guard in `buy` is `minNetContribution` (SPEC §5.3).
export function feeDelta(grossBefore: bigint, gross: bigint): bigint {
  require_(
    grossBefore >= 0n && grossBefore <= MAX_UINT256,
    "InvalidInput",
    `grossBefore out of uint256 range: ${grossBefore}`,
  );
  require_(gross > 0n, "InvalidInput", `gross must be positive: ${gross}`);
  require_(gross <= MAX_UINT256 - grossBefore, "Overflow", "grossTotal + gross exceeds uint256");
  return feeOf(grossBefore + gross) - feeOf(grossBefore);
}

/// Applies one entry (a player purchase or the operator seed) to a round's fee state.
///
/// Mirrors `LuckyDraw._feeSplit` followed by `_appendEntry`: `feeDelta` is measured against the *stored*
/// `feeReserved`, exactly as the contract does, so a caller that passes the values `getRound` returned gets
/// the numbers the transaction will produce.
export function applyEntry(state: RoundFeeState, gross: bigint): EntryFeeResult {
  const {grossTotal, feeReserved} = state;
  require_(
    grossTotal >= 0n && grossTotal <= MAX_UINT256,
    "InvalidInput",
    `grossTotal out of uint256 range: ${grossTotal}`,
  );
  require_(
    feeReserved >= 0n && feeReserved <= grossTotal,
    "InvalidInput",
    `feeReserved out of range: ${feeReserved}`,
  );
  require_(gross > 0n, "InvalidInput", `gross must be positive: ${gross}`);
  require_(gross <= MAX_UINT256 - grossTotal, "Overflow", "grossTotal + gross exceeds uint256");

  const nextGrossTotal = grossTotal + gross;
  const nextFeeReserved = feeOf(nextGrossTotal);
  const delta = nextFeeReserved - feeReserved;
  // The contract computes `mulDiv(G + g, FEE_BPS, BPS) - feeReserved`; a stored reserve above `feeOf(G)`
  // would make that subtraction panic. Reject it here rather than return a negative delta.
  require_(delta >= 0n, "InvalidInput", "feeReserved is above feeOf(grossTotal)");
  require_(delta <= gross, "InvalidInput", "feeDelta above the entry gross");

  return {
    feeDelta: delta,
    netDelta: gross - delta,
    grossTotal: nextGrossTotal,
    feeReserved: nextFeeReserved,
    prizePot: nextGrossTotal - nextFeeReserved,
  };
}

/// The `minNetContribution` guard to send with `buy` for a quoted `netDelta` (SPEC §5.2, §5.3, and §9.6:
/// "Set minNetContribution to max(0, quotedNetDelta-1 raw unit) to tolerate only fee rounding or order
/// movement").
///
/// A purchase's `feeDelta` can move by one raw unit if another entry lands first, so the guard accepts one
/// raw unit less than quoted and rejects anything below that with `NetContributionTooLow`. A zero quote
/// floors at zero, which disables the guard rather than making it unsatisfiable.
export function minNetContribution(netDelta: bigint): bigint {
  require_(
    netDelta >= 0n && netDelta <= MAX_UINT256,
    "InvalidInput",
    `netDelta out of uint256 range: ${netDelta}`,
  );
  return netDelta > 0n ? netDelta - 1n : 0n;
}
