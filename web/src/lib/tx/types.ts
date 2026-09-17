// The transaction state machine's vocabulary (SPEC §9.6).
//
// "The state machine is idle -> preview -> wallet confirmation -> submitted -> included -> confirmed, with
// rejected, reverted, replaced and dropped branches", plus the `wallet-unreachable` branch of the paragraph
// below it. Those eleven phases are the whole surface: nothing in this app has a twelfth.
//
// The chain-facing dependencies are declared here as the narrowest possible interfaces rather than as ethers
// types, for the same reason the client library does it: the machine is then driven end to end in tests by
// a fake with no node, and an ethers signature change is a compile error in one adapter file.

import type {Address, CatalogKey, WriteSummary} from "@luckydraw/client";

export type TxPhase =
  | "idle"
  | "preview"
  | "walletConfirmation"
  | "submitted"
  | "included"
  | "confirmed"
  | "rejected"
  | "reverted"
  | "replaced"
  | "dropped"
  | "walletUnreachable";

/** The five steps the TxStepper shows. The branch phases are rendered against the step they interrupted. */
export type TxStepName = "preview" | "walletConfirmation" | "submitted" | "included" | "confirmed";

export const TX_STEP_ORDER: readonly TxStepName[] = [
  "preview",
  "walletConfirmation",
  "submitted",
  "included",
  "confirmed",
];

export type TxStep = {
  name: TxStepName;
  /** Wall-clock milliseconds, for the timestamp each step shows (SPEC §9.6). */
  at: number;
  /** The transaction hash once there is one, so each step can carry its explorer link. */
  hash: string | null;
};

/** A failure, already reduced to the three columns of the SPEC §9.6 table plus the copyable evidence. */
export type TxFailure = {
  /** The client catalog key this came from, or null when the message is the wallet's own. */
  catalogKey: CatalogKey | null;
  message: string;
  /** One of the fixed funds phrases of §9.6. */
  funds: string;
  nextAction: string;
  /** Copyable evidence for an unrecognized revert (§9.6). */
  selector: string | null;
  data: string | null;
  /**
   * Text the *wallet* wrote, kept apart from `message` so a surface can label it as the wallet's words rather
   * than render it as the app's own sentence (SPEC §9.7: the app's voice is the app's). Already trimmed and
   * capped; null when there is nothing the wallet said.
   */
  walletText?: string | null;
};

export type TxState = {
  phase: TxPhase;
  /** The decoded summary shown before the prompt (§9.6). */
  summary: WriteSummary | null;
  /** A short human label for this transaction, supplied by the calling surface. */
  label: string | null;
  /** The account the write was quoted for and signed by. */
  account: Address | null;
  chainId: bigint | null;
  hash: string | null;
  nonce: number | null;
  /** Block of the receipt, once included. */
  blockNumber: bigint | null;
  steps: readonly TxStep[];
  failure: TxFailure | null;
  /** True between `included` and `confirmed`: the value is real but not yet final (§10.1). */
  provisional: boolean;
};

export const IDLE_TX_STATE: TxState = {
  phase: "idle",
  summary: null,
  label: null,
  account: null,
  chainId: null,
  hash: null,
  nonce: null,
  blockNumber: null,
  steps: [],
  failure: null,
  provisional: false,
};

// ---------------------------------------------------------------------------
// The chain surface the machine needs
// ---------------------------------------------------------------------------

export type TxRequest = {
  from: string;
  to: string;
  data: string;
  value: bigint;
};

export type TxReceiptLike = {
  hash: string;
  /** 1 for success, 0 for a reverted transaction, null when the node did not say. */
  status: number | null;
  blockNumber: number;
  /**
   * The parties the node reports for this hash. Optional so a hand-written double can omit them, but the
   * ethers adapter always fills them in and the machine refuses to call a transaction included or confirmed
   * when either disagrees with the request this app prepared (SPEC §9.6: never present someone else's
   * transaction as this one).
   */
  to?: string | null;
  from?: string | null;
};

/** What `eth_getTransactionByHash` answered. Everything but `blockNumber` is optional for the same reason. */
export type TxBodyLike = {
  blockNumber: number | null;
  to?: string | null;
  from?: string | null;
  data?: string | null;
  value?: bigint | null;
  nonce?: number | null;
};

export type TxSignerLike = {
  /** SPEC §9.5: always estimate the full calldata against current state; never a fixed limit. */
  estimateGas(tx: TxRequest): Promise<bigint>;
  sendTransaction(tx: TxRequest & {gasLimit: bigint}): Promise<{hash: string; nonce: number}>;
};

export type TxWatcherLike = {
  getTransactionReceipt(hash: string): Promise<TxReceiptLike | null>;
  /** Null when the node has never heard of the hash, which is how a dropped transaction shows up. */
  getTransaction(hash: string): Promise<TxBodyLike | null>;
  /** `eth_getTransactionCount` at `latest`: the account's next nonce. Replacement tracking uses it. */
  getTransactionCount(account: string, blockTag: string): Promise<number>;
  getBlockNumber(): Promise<number>;
  /** The `finalized` (or `safe`) head, or null when the node does not support the tag (SPEC §10.1). */
  getFinalityHead(tag: string): Promise<bigint | null>;
  /** Replays a reverted call at its own block so the revert data can be decoded. */
  call(tx: TxRequest & {blockTag: number}): Promise<string>;
};
