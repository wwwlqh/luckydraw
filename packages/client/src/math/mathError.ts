/// Failure codes for the pure math helpers.
///
/// These mirror the places where the Solidity either reverts with a named error or raises a Solidity
/// `Panic`. They are *programming* errors (bad decimals, an index past the last range, a cutoff that does not
/// fit in uint64), not user-facing conditions: everything a user can trip is reported as a `QuoteReason` by
/// `previewEntry` (SPEC §8.1), never as a throw.
export type MathErrorCode =
  /// A decimal count, price, weight or amount is outside the range the spec allows.
  | "InvalidInput"
  /// A value cannot be represented in the Solidity type that holds it (uint256 or uint64). The contract
  /// surfaces this as Solidity `Panic(0x11)` (SPEC §8.1: overflow has no custom error).
  | "Overflow"
  /// A range list is empty, not strictly increasing, or the index is at or past the last cumulative gross.
  | "InvalidRangeList";

/// Error thrown by `src/math` for inputs the spec forbids.
export class MathError extends Error {
  readonly code: MathErrorCode;

  constructor(code: MathErrorCode, message: string) {
    super(message);
    this.name = "MathError";
    this.code = code;
  }
}

/// Throws `MathError(code, message)` when `condition` is false. Declared as an assertion so the compiler
/// narrows on it, the way a Solidity `require` narrows the reachable states.
export function require_(condition: boolean, code: MathErrorCode, message: string): asserts condition {
  if (!condition) throw new MathError(code, message);
}
