// The one formatting helper these components share.
//
// Every amount on these surfaces goes through the client's `formatAmount`, which is `Intl.NumberFormat` with
// an explicit locale over an exact bigint decimal string (SPEC §9.7). Nothing here does arithmetic; the only
// decision this wrapper makes is the SPEC §9.7 rounding direction for a *balance*, which is down: showing a
// user more than the chain holds is never acceptable, and a rounded-up balance invites a failed withdrawal.

import type {DecodedRevert} from "@luckydraw/client";
import {formatAmount} from "@luckydraw/client";

/** A balance, share or refund amount, rounded down, with the symbol after the number (SPEC §9.3 copy). */
export function amountText(raw: bigint, decimals: number, symbol: string): string {
  return formatAmount(raw, decimals, {rounding: "down", symbol});
}

/** A debit the user is about to pay, rounded up (SPEC §9.7: "rounds debits and fees up"). */
export function debitText(raw: bigint, decimals: number, symbol: string): string {
  return formatAmount(raw, decimals, {rounding: "up", symbol});
}

/**
 * Already-formatted values for the `{placeholders}` a §9.6 catalog message can carry.
 *
 * Without one of these the app prints an em dash rather than a brace next to money, which is correct but
 * unhelpful; with it, a revert names the same numbers the panel just showed. Every decoded uint argument is
 * formatted in the asset's own decimals, and the caller adds the two values only it knows: the balance the
 * panel read and the amount the user typed.
 */
export function revertParams(
  decimals: number,
  symbol: string,
  known: {available?: bigint | null; amount?: bigint | null},
): (decoded: DecodedRevert) => Readonly<Record<string, string>> {
  return (decoded) => {
    const params: Record<string, string> = {symbol};
    if (known.available !== null && known.available !== undefined) {
      params.available = formatAmount(known.available, decimals, {rounding: "down"});
    }
    if (known.amount !== null && known.amount !== undefined) {
      params.amount = formatAmount(known.amount, decimals, {rounding: "up"});
      params.gross = params.amount;
    }
    if (decoded.kind === "custom") {
      for (const [name, value] of Object.entries(decoded.args)) {
        if (typeof value === "bigint") params[name] = formatAmount(value, decimals, {rounding: "down"});
      }
    }
    return params;
  };
}
