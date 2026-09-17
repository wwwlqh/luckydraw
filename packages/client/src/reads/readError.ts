// The one error type the read adapters throw.
//
// SPEC §8.1: "Reverts must not be shown as raw stack traces in the app." A read that fails carries the
// decoded revert (`src/errors/`) so the caller can look the condition up in `src/catalog/` instead of
// printing a provider message. A `readFeed` whose feed reverts is *not* an error: the price being
// unavailable is a modelled state (SPEC §3.2), not a failure of the read.

import type {DecodedRevert} from "../errors/decode.ts";
import type {Hex} from "../types/common.ts";

/** Which contract a failing call was addressed to. */
export type ReadTarget = "vault" | "draw" | "feed" | "multicall3";

export type ReadErrorCode =
  /** A page limit outside 1-100 (SPEC §8.1). */
  | "InvalidLimit"
  /** A negative cursor, or one that cannot be a uint256. */
  | "InvalidCursor"
  /** `readAllRanges` would have to page past its caller's cap. */
  | "RangeLimitExceeded"
  /** Neither `finalized`, `safe` nor the fixed depth produced a usable block. */
  | "SnapshotUnavailable"
  /** A head-pinned block changed hash between choosing it and reading at it; retry the snapshot. */
  | "SnapshotReorged"
  /** A call in the batch reverted; `revert` carries the decoded reason. */
  | "CallReverted"
  /** The return data did not decode against the generated ABI. */
  | "DecodeFailed"
  /** The batch returned a different number of results than it was given calls. */
  | "BatchMismatch";

export type ReadErrorOptions = {
  target?: ReadTarget | undefined;
  method?: string | undefined;
  revertData?: Hex | undefined;
  revert?: DecodedRevert | undefined;
};

/** Every failure the read layer raises, with the contract, method and decoded revert when there is one. */
export class ReadError extends Error {
  readonly code: ReadErrorCode;
  readonly target: ReadTarget | null;
  readonly method: string | null;
  readonly revertData: Hex | null;
  readonly revert: DecodedRevert | null;

  constructor(code: ReadErrorCode, message: string, options?: ReadErrorOptions) {
    super(message);
    this.name = "ReadError";
    this.code = code;
    this.target = options?.target ?? null;
    this.method = options?.method ?? null;
    this.revertData = options?.revertData ?? null;
    this.revert = options?.revert ?? null;
  }
}
