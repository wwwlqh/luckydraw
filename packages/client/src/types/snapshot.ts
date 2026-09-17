// The envelope every read returns (SPEC §10.1: "Related direct reads use one blockTag; return chainId,
// blockNumber, blockHash, timestamp and confidence with the snapshot").
//
// Plain types only: no provider, no RPC, no import beyond the hex primitives. `src/reads/` supplies the
// values; the web app uses `confidence` to render provisional values differently from confirmed ones.

import type {Hex32} from "./common.ts";

/**
 * Which block tag produced the snapshot. SPEC §10.1 prefers the RPC's `finalized` tag where supported,
 * falls back to `safe`, and then to a fixed depth behind `latest`. This is a presentation parameter, not a
 * promise of economic finality.
 */
export type ConfidenceTag = "finalized" | "safe" | "latest";

/**
 * The tag in use and, when the tag is `latest` and the value was taken from a fixed depth behind the head,
 * that depth in blocks (200 per SPEC §10.1 and the Chain record in §15). `null` when no depth applies.
 */
export type Confidence = {
  readonly tag: ConfidenceTag;
  readonly depth: bigint | null;
};

/** One consistent read: the value plus the block it came from. */
export type Snapshot<T> = {
  chainId: bigint;
  blockNumber: bigint;
  blockHash: Hex32;
  /** Block timestamp in seconds (uint64 on chain, bigint here). */
  timestamp: bigint;
  confidence: Confidence;
  value: T;
};

/** The `finalized` confidence, the preferred one. */
export const FINALIZED: Confidence = Object.freeze({tag: "finalized", depth: null});

/** The `safe` confidence, used when the node does not support `finalized`. */
export const SAFE: Confidence = Object.freeze({tag: "safe", depth: null});

/** The last resort: `latest` minus a fixed depth (SPEC §10.1 uses 200 blocks). */
export function latestWithDepth(depth: bigint): Confidence {
  return {tag: "latest", depth};
}
