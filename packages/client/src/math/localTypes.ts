// The Solidity enums the math module needs, taken from the generated types (contracts/src/Types.sol in ABI
// order, written by scripts/generate.ts). The value maps keep the names the math sources use; the types are
// the generated numeric literal unions, so nothing here can drift from the ABI.
//
// Not re-exported from the package root: consumers import `Kind`, `State` and `QuoteReason` from `src/types`.

import {Cadence, Kind, QuoteReason, quoteReasonName, State} from "../types/generated.ts";

export type {Cadence, Kind, QuoteReason, QuoteReasonName} from "../types/generated.ts";

/** The lifecycle state, under the name the math sources use for it. */
export type RoundState = State;

/** Named `Kind` values. */
export const KIND = Kind;

/** Named `Cadence` values. */
export const CADENCE = Cadence;

/// The cutoff cadence of each `Kind`, mirroring `Kinds.cadenceOf` in contracts/src/Types.sol (SPEC §6.1).
const CADENCE_OF_KIND: Readonly<Record<Kind, Cadence>> = {
  [Kind.Day100]: Cadence.Day,
  [Kind.Day1k]: Cadence.Day,
  [Kind.Day10k]: Cadence.Day,
  [Kind.Week1k]: Cadence.Week,
  [Kind.Week10k]: Cadence.Week,
  [Kind.Week100k]: Cadence.Week,
  [Kind.Month100k]: Cadence.Month,
};

/// The default whole-USD target of each `Kind`, mirroring `Kinds.defaultTargetUsd` (SPEC §6.1, ADR 036).
const DEFAULT_TARGET_USD: Readonly<Record<Kind, bigint>> = {
  [Kind.Day100]: 100n,
  [Kind.Day1k]: 1000n,
  [Kind.Day10k]: 10_000n,
  [Kind.Week1k]: 1000n,
  [Kind.Week10k]: 10_000n,
  [Kind.Week100k]: 100_000n,
  [Kind.Month100k]: 100_000n,
};

/** The cutoff cadence a sequence kind follows; throws on a value outside the enum. */
export function cadenceOf(kind: Kind): Cadence {
  const cadence = CADENCE_OF_KIND[kind];
  if (cadence === undefined) throw new RangeError(`Kind value out of range: ${String(kind)}`);
  return cadence;
}

/** The whole-USD target a freshly added pool starts a sequence with; throws on a value outside the enum. */
export function defaultTargetUsd(kind: Kind): bigint {
  const target = DEFAULT_TARGET_USD[kind];
  if (target === undefined) throw new RangeError(`Kind value out of range: ${String(kind)}`);
  return target;
}

/** Named `State` values. */
export const ROUND_STATE = State;

/** Named `QuoteReason` values. The numeric order is the ABI order, not the check precedence (SPEC §5.1). */
export const QUOTE_REASON = QuoteReason;

/** Name of a `QuoteReason` value, for logs and tests; user-facing copy comes from `src/catalog/`. */
export const quoteReasonNameOf = quoteReasonName;
