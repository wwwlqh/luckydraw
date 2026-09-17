/// Weighted selection: the 512-bit modular index, the range binary search and the range-list hash used by
/// the round evidence JSON (SPEC §5.1, §7.2, §10.1).
///
/// Mirrors `LuckyDraw._winningIndexOf` / `_findRange` and `spec_reference.py` (`index_modular`,
/// `binary_winner`).

import {AbiCoder, concat, keccak256} from "ethers";
import type {Address} from "../types/common.ts";
import type {Range} from "../types/generated.ts";
import {MAX_UINT256} from "./constants.ts";
import {require_} from "./mathError.ts";

// `Range` is the generated `{buyer: Address; cumulativeGross: bigint}` struct: one appended ownership range
// `[previousCumulativeGross, cumulativeGross)` (SPEC §5.1). Lists are strictly increasing in cumulativeGross.

/// `X mod W` for the 512-bit value `X = (word0 << 256) + word1`, computed the way the EVM does (SPEC §7.2,
/// `LuckyDraw._winningIndexOf`, `spec_reference.index_modular`):
///
/// ```text
/// b = addmod(MAX_UINT256 % W, 1, W)        // 2^256 mod W
/// i = addmod(mulmod(word0, b, W), word1, W)
/// ```
///
/// bigint arithmetic cannot overflow, so `addmod`/`mulmod` are plain `%`; the expression is kept in this
/// exact shape so the client and the contract stay line-for-line comparable and the modulo bias argument
/// (below 2^-256 for every positive uint256 `W`) applies unchanged.
export function winningIndex(word0: bigint, word1: bigint, weight: bigint): bigint {
  require_(word0 >= 0n && word0 <= MAX_UINT256, "InvalidInput", `word0 out of uint256 range: ${word0}`);
  require_(word1 >= 0n && word1 <= MAX_UINT256, "InvalidInput", `word1 out of uint256 range: ${word1}`);
  require_(weight > 0n && weight <= MAX_UINT256, "InvalidInput", `weight must be in (0, uint256]: ${weight}`);

  const b = ((MAX_UINT256 % weight) + 1n) % weight;
  return (((word0 * b) % weight) + word1) % weight;
}

/// Position, in the list, of the first range whose `cumulativeGross` is strictly greater than `index`
/// (SPEC §5.1, `LuckyDraw._findRange`).
///
/// The return value is a JS array position, which is why it is a `number` and not a `bigint`: it addresses the
/// array in memory and is never a chain value. The winning index it resolves is a `bigint` uint256.
///
/// Binary search with the overflow-safe midpoint `lo + (hi - lo) / 2`, O(log rangeCount). An empty list or an
/// `index` at or past the last cumulative gross throws `MathError("InvalidRangeList")`. Strict monotonicity is
/// a precondition of the search and is deliberately *not* re-checked here, because that would make every
/// lookup O(rangeCount); a caller verifying an untrusted list (the round evidence JSON of SPEC §10.1) calls
/// `requireRanges` once before searching it.
export function findRangeIndex(ranges: readonly Range[], index: bigint): number {
  const last = ranges[ranges.length - 1];
  require_(last !== undefined, "InvalidRangeList", "empty range list");
  require_(index >= 0n, "InvalidInput", `index must be non-negative: ${index}`);
  require_(
    index < last.cumulativeGross,
    "InvalidRangeList",
    `index ${index} is at or past the last cumulative gross`,
  );

  require_(ranges.length <= 0x7fff_ffff, "InvalidRangeList", "range list longer than a 32-bit index");
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo < hi) {
    // `lo + (hi - lo) / 2`, the overflow-safe midpoint of `_findRange`, as an integer shift: no division and
    // therefore no floating point anywhere in this module.
    const mid = lo + ((hi - lo) >>> 1);
    const candidate = ranges[mid];
    /* c8 ignore next */
    if (candidate === undefined) throw new Error("unreachable: range index out of bounds");
    if (candidate.cumulativeGross > index) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/// The buyer that owns `index` (SPEC §5.1, §7.2, `spec_reference.binary_winner`).
export function findWinner(ranges: readonly Range[], index: bigint): Address {
  const at = findRangeIndex(ranges, index);
  const range = ranges[at];
  /* c8 ignore next */
  if (range === undefined) throw new Error("unreachable: range index out of bounds");
  return range.buyer;
}

/// keccak256 of the ordered `(buyer, cumulativeGross)` list, the list hash the round evidence JSON carries
/// (SPEC §10.1).
///
/// Definition, so that the indexer, the client verifier and any third party produce the same value:
/// each range is ABI-encoded as `abi.encode(address buyer, uint256 cumulativeGross)`, which is exactly
/// 64 bytes (a left-padded 20-byte address followed by a 32-byte big-endian amount); those 64-byte blocks are
/// concatenated in range order, with no length prefix, no separator and no trailing padding; the keccak256 of
/// that byte string is the hash. An empty list hashes the empty byte string
/// (`0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`).
///
/// The list is hashed exactly as given: order is part of the hash, so callers must pass the ranges in the
/// order `getRanges` returns them (which is the order they were appended).
export function rangeListHash(ranges: readonly Range[]): string {
  const coder = AbiCoder.defaultAbiCoder();
  const encoded = ranges.map((range) =>
    coder.encode(["address", "uint256"], [range.buyer, range.cumulativeGross]),
  );
  return keccak256(concat(encoded));
}

/// Validates that a range list is non-empty, positive and strictly increasing (SPEC §5.1: zero-length ranges
/// are forbidden and `cumulativeGross` is append-only).
export function requireRanges(ranges: readonly Range[]): void {
  require_(ranges.length > 0, "InvalidRangeList", "empty range list");
  let previous = 0n;
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    /* c8 ignore next */
    if (range === undefined) throw new Error("unreachable: range index out of bounds");
    require_(
      range.cumulativeGross > previous,
      "InvalidRangeList",
      `range ${i} cumulativeGross ${range.cumulativeGross} is not above ${previous}`,
    );
    require_(
      range.cumulativeGross <= MAX_UINT256,
      "InvalidRangeList",
      `range ${i} cumulativeGross exceeds uint256`,
    );
    previous = range.cumulativeGross;
  }
}
