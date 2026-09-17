/// Spec math over `bigint`: fee partition, the USD 1 minimum and USD value, target gross, calendar cutoffs,
/// the 512-bit modular index, range binary search and the advisory entry preview.
///
/// Every function here mirrors both `scripts/spec_reference.py` and the Solidity it is named after, and the
/// whole module is checked against `contracts/test/vectors/spec_vectors.json` (SPEC §11.2 "Math"). Nothing in
/// this module reads the chain, formats a string or uses a floating-point number.

export * from "./constants.ts";
export * from "./fee.ts";
// The enum values and types the math functions take are the generated ones: import `Kind`, `State` and
// `QuoteReason` from `src/types`. `localTypes.ts` only aliases them for the math sources.
// `require_` stays internal to the module; only the error type is part of the public surface.
export {MathError, type MathErrorCode} from "./mathError.ts";
export * from "./price.ts";
export * from "./quote.ts";
export * from "./schedule.ts";
export * from "./selection.ts";
