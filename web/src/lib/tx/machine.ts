// The transaction state machine (SPEC §9.6, §10.1).
//
// One run is one transaction. The machine is written as a plain async function over the narrow interfaces in
// `types.ts` rather than as a hook, so every branch — rejected, reverted, replaced, dropped, wallet
// unreachable — is reachable in a test with a fake signer and a fake watcher, with no React and no node.
//
// Four rules this file exists to keep:
//
//  1. gas is estimated against current state with the full calldata every time (SPEC §9.5: "a gas budget
//     from the test table is not a transaction gas limit"), and a revert found during that estimate is shown
//     from the catalog without ever opening the wallet;
//  2. nothing is called confirmed before the §10.1 policy: `included` is explicitly provisional, and
//     `confirmed` waits for the chain record's finality tag, or a fixed depth behind the head when the node
//     has no such tag. The receipt is re-read on every poll until then, so a transaction that is reorged out
//     of its block rolls back to `submitted` instead of being announced as confirmed (SPEC §9.6: "On reorg
//     roll back confirmation and UI state and reconcile");
//  3. a replacement is tracked by account and nonce, and a transaction the node has forgotten is reported as
//     dropped: neither is ever resent by this code. SPEC §9.6: "never blindly duplicate a deposit or entry".
//     An RPC call that throws is "unknown, keep polling" — never evidence that a transaction is gone;
//  4. the intent is persisted as soon as a hash exists, so a reload reattaches instead of re-signing. That
//     includes the hash ethers reports on `error.info.sendTransactionHash` when the broadcast succeeded but
//     the follow-up poll failed.

import {type Address, decodeOptionsForWrite, decodeRevert, type PreparedWrite} from "@luckydraw/client";
import {toWalletError, WalletError} from "../wallet/errors.ts";
import {
  failureFromRevert,
  failureFromUnknown,
  failureFromWalletError,
  hashMismatchFailure,
  nonceOrReplacementFailure,
  type RevertParamFormatter,
  unknownRevertFailure,
  walletUnreachableWithHashFailure,
  wrongChainWithHashFailure,
} from "./failure.ts";
import {clearIntent, clearIntentFor, type IntentStorage, type PendingIntent, saveIntent} from "./intent.ts";
import {
  IDLE_TX_STATE,
  type TxBodyLike,
  type TxReceiptLike,
  type TxRequest,
  type TxSignerLike,
  type TxState,
  type TxStepName,
  type TxWatcherLike,
} from "./types.ts";

export type TxRuntime = {
  signer: TxSignerLike;
  watcher: TxWatcherLike;
  chainId: bigint;
  /** The chain record's `finalityTag`, or null. SPEC §10.1 then walks `finalized` -> `safe` -> depth. */
  finalityTag: string | null;
  confirmationDepth: bigint;
  storage: IntentStorage | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  receiptPollMs: number;
  /**
   * Ceiling the poll interval backs off to while a transaction is pending or provisionally included. Optional;
   * `DEFAULT_MAX_POLL_MS` when absent. SPEC §10.1 caps an idle tab's RPC traffic, and a transaction that is
   * still not final after several minutes does not need three calls every three seconds.
   */
  maxPollMs?: number;
  /** With no receipt, no replacement and no nonce movement for this long, the transaction is dropped. */
  dropAfterMs: number;
  /**
   * Aborts this run's tracking loop. `useTransaction` creates one per run and aborts it on `reset()`, on a
   * superseding `send` and on unmount, so an orphaned loop stops making RPC calls and — more importantly —
   * stops being able to write a verdict into the one intent slot that a newer run now owns.
   */
  signal?: AbortSignal;
};

/** The ceiling the receipt poll backs off to, when the runtime does not name its own. */
export const DEFAULT_MAX_POLL_MS = 15_000;

export type SendOptions = {
  /** The account the write was quoted for. The signer layer refuses any other (SPEC §9.5). */
  account: Address;
  /** A short human label for the stepper and the toast, for example "Deposit 1 BNB". */
  label: string;
  /** Supplies already-formatted values for a catalog message's placeholders. */
  formatParams?: RevertParamFormatter;
};

export type Emit = (state: TxState) => void;

/** 25% headroom over the live estimate. Not a fixed limit: it scales with what the call actually costs. */
function withHeadroom(estimate: bigint): bigint {
  return estimate + estimate / 4n;
}

/**
 * The hash ethers reports on a `sendTransaction` that broadcast successfully and then failed to poll for the
 * transaction: `error.info.sendTransactionHash`. Null when the error carries no usable hash, which is the
 * ordinary "nothing was sent" case.
 */
export function broadcastHashOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  // The adapters raise their own post-broadcast failures (a wallet node that named a different chain) and
  // carry the hash on the `WalletError` itself rather than in ethers' error envelope.
  if (error instanceof WalletError && error.sendTransactionHash !== null) return error.sendTransactionHash;
  const info = (error as {info?: unknown}).info;
  if (info === null || typeof info !== "object") return null;
  const hash = (info as {sendTransactionHash?: unknown}).sendTransactionHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
}

function step(state: TxState, name: TxStepName, at: number): TxState {
  return {...state, steps: [...state.steps, {name, at, hash: state.hash}]};
}

/** The §10.1 confirmation policy: `finalized`, then `safe`, then a fixed depth behind the head. */
export async function isConfirmed(runtime: TxRuntime, blockNumber: bigint): Promise<boolean> {
  const tags = runtime.finalityTag === null ? ["finalized", "safe"] : [runtime.finalityTag, "safe"];
  for (const tag of tags) {
    let head: bigint | null = null;
    try {
      head = await runtime.watcher.getFinalityHead(tag);
    } catch {
      head = null;
    }
    if (head !== null && head > 0n) return head >= blockNumber;
  }
  const head = BigInt(await runtime.watcher.getBlockNumber());
  return head >= blockNumber && head - blockNumber >= runtime.confirmationDepth;
}

async function decodeReceiptRevert(
  runtime: TxRuntime,
  request: TxRequest,
  blockNumber: number,
  contract: PreparedWrite["contract"],
  fn: string,
  formatParams?: RevertParamFormatter,
): Promise<TxState["failure"]> {
  try {
    await runtime.watcher.call({...request, blockTag: blockNumber});
    // The replay succeeded, so the node cannot tell us why the transaction reverted.
    return unknownRevertFailure(null, null);
  } catch (error) {
    const decoded = decodeRevert(error, decodeOptionsForWrite({contract, function: fn}));
    return failureFromRevert(decoded, formatParams);
  }
}

type TrackInput = {
  request: TxRequest;
  contract: PreparedWrite["contract"];
  function: string;
  formatParams?: RevertParamFormatter;
  intent: PendingIntent;
};

/** What one `eth_getTransactionByHash` answered. A thrown call is `unknown`, which is never "gone". */
type Presence = "present" | "absent" | "unknown";

/**
 * How many consecutive "the node has never heard of this hash" answers are needed before either terminal
 * verdict is even considered, and a final receipt re-read happens after them.
 *
 * One answer is not evidence. A load-balanced public RPC puts several nodes behind one URL, and a request
 * that lands on a node whose mempool view is a second behind answers `null` for a transaction that is sitting
 * in the next block. Calling that "replaced" or "dropped" tells someone their money went somewhere it did not.
 */
const ABSENT_POLLS_BEFORE_VERDICT = 3;

function lower(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

/**
 * True when what the node reports under this hash disagrees with what this app prepared and signed.
 *
 * Only fields the node actually reported are compared, so a hand-written watcher that omits them is not
 * accused of anything; the ethers adapter fills all of them in.
 */
function disagreesWithRequest(
  request: TxRequest,
  reported: {to?: string | null; from?: string | null; data?: string | null},
): boolean {
  const to = lower(reported.to);
  const from = lower(reported.from);
  const data = lower(reported.data);
  if (to !== null && to !== request.to.toLowerCase()) return true;
  if (from !== null && from !== request.from.toLowerCase()) return true;
  return data !== null && data !== request.data.toLowerCase();
}

/**
 * Follows one submitted transaction to its end: included, then confirmed, or one of the reverted, replaced
 * and dropped branches. Never sends anything.
 *
 * One loop, not two: the receipt is re-read on every poll, including after `included`, because a block can be
 * reorged away underneath a transaction. A receipt that disappears rolls the state back to a provisional
 * `submitted`; a receipt that moves to another block moves `blockNumber` with it and keeps waiting.
 */
async function track(start: TxState, input: TrackInput, runtime: TxRuntime, emit: Emit): Promise<TxState> {
  let state = start;
  const hash = state.hash;
  if (hash === null) return state;
  const account = input.request.from.toLowerCase();
  const startedAt = input.intent.startedAt;
  const ceiling = runtime.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  let delay = Math.min(runtime.receiptPollMs, ceiling);
  let included = false;
  /** Consecutive polls where the node had never heard of the hash. Any other answer resets it. */
  let absentPolls = 0;
  /**
   * Sticky: an account nonce never goes backwards, so one observation that it moved past this transaction's
   * nonce stays true even if a later nonce read lands on a node that is behind.
   */
  let nonceAdvanced = false;
  /** A receipt read ahead of the loop by the verdict path, so its answer is not thrown away. */
  let carried: {receipt: TxReceiptLike | null; known: boolean} | null = null;

  for (;;) {
    // The run that owns this loop is gone (reset, superseded, or unmounted). Stop without emitting and
    // without touching the intent slot: whatever is stored now belongs to whoever replaced this run.
    if (runtime.signal?.aborted === true) return state;

    let receipt: TxReceiptLike | null = null;
    let receiptKnown = true;
    if (carried !== null) {
      receipt = carried.receipt;
      receiptKnown = carried.known;
      carried = null;
    } else {
      try {
        receipt = await runtime.watcher.getTransactionReceipt(hash);
      } catch {
        // An RPC failure says nothing about the transaction. Poll again; never roll anything back on it.
        receiptKnown = false;
      }
    }

    if (receiptKnown && receipt !== null) {
      // Before anything is read off this receipt: is it even our transaction? SPEC §9.6 is about reporting
      // what happened to *this* write, and a receipt whose parties are not the request's is not evidence
      // about it. The intent stays so a reload can look again.
      if (disagreesWithRequest(input.request, receipt)) {
        state = {...state, phase: "replaced", failure: hashMismatchFailure(), provisional: false};
        emit(state);
        return state;
      }
      absentPolls = 0;
      const blockNumber = BigInt(receipt.blockNumber);
      if (receipt.status === 0) {
        const failure = await decodeReceiptRevert(
          runtime,
          input.request,
          receipt.blockNumber,
          input.contract,
          input.function,
          input.formatParams,
        );
        clearIntentFor(runtime.storage, hash);
        state = {...state, blockNumber, phase: "reverted", failure, provisional: false};
        emit(state);
        return state;
      }
      if (!included) {
        state = step(
          {...state, blockNumber, phase: "included", provisional: true},
          "included",
          runtime.now(),
        );
        included = true;
        emit(state);
      } else if (state.blockNumber !== blockNumber) {
        // Re-included in another block: still provisional, and confirmation now waits on the new one.
        state = {...state, blockNumber, provisional: true};
        emit(state);
      }

      // Included. Wait for the confirmation policy; the value is provisional until then (SPEC §10.1).
      let confirmed = false;
      try {
        confirmed = await isConfirmed(runtime, blockNumber);
      } catch {
        confirmed = false;
      }
      if (confirmed) {
        clearIntentFor(runtime.storage, hash);
        state = step({...state, phase: "confirmed", provisional: false}, "confirmed", runtime.now());
        emit(state);
        return state;
      }
    } else if (receiptKnown) {
      if (included) {
        // The receipt the node gave us is gone: the block was reorged away. Roll back to a provisional
        // `submitted` and re-enter the receipt loop (SPEC §9.6 "On reorg roll back confirmation and UI
        // state and reconcile").
        included = false;
        state = {
          ...state,
          phase: "submitted",
          blockNumber: null,
          provisional: true,
          steps: state.steps.filter((entry) => entry.name !== "included"),
        };
        emit(state);
      }

      // No receipt. Decide between "still pending", "replaced" and "dropped" from the account nonce, never by
      // re-sending anything (SPEC §9.6). The two reads are separate on purpose: a nonce read that fails must
      // not turn a transaction the node still has into a dropped one.
      let presence: Presence = "unknown";
      let body: TxBodyLike | null = null;
      try {
        body = await runtime.watcher.getTransaction(hash);
        presence = body === null ? "absent" : "present";
      } catch {
        presence = "unknown";
      }
      let nextNonce: number | null = null;
      try {
        nextNonce = await runtime.watcher.getTransactionCount(account, "latest");
      } catch {
        nextNonce = null;
      }

      if (presence === "present" && body !== null) {
        // The same check the receipt gets: a body under this hash that is not the request this app built is
        // not this transaction, and nothing after this point would be true of the user's own write.
        if (disagreesWithRequest(input.request, body)) {
          state = {...state, phase: "replaced", failure: hashMismatchFailure(), provisional: false};
          emit(state);
          return state;
        }
        absentPolls = 0;
      }
      if (presence === "absent") absentPolls += 1;
      if (state.nonce !== null && nextNonce !== null && nextNonce > state.nonce) nonceAdvanced = true;

      if (absentPolls >= ABSENT_POLLS_BEFORE_VERDICT) {
        // One last receipt read before either verdict. A transaction that was mined between the poll above
        // and now answers here, and "replaced" or "dropped" would have been wrong by a few hundred
        // milliseconds. The answer is carried into the next iteration rather than discarded.
        let finalReceipt: TxReceiptLike | null = null;
        let finalKnown = true;
        try {
          finalReceipt = await runtime.watcher.getTransactionReceipt(hash);
        } catch {
          finalKnown = false;
        }
        if (finalKnown && finalReceipt !== null) {
          carried = {receipt: finalReceipt, known: true};
          absentPolls = 0;
          continue;
        }
        if (finalKnown) {
          // Both verdicts are "Unknown until receipt" (SPEC §9.6), so the intent stays: the next mount
          // resumes it, and a transaction that turns up later is still reattachable by its hash.
          if (nonceAdvanced) {
            state = {...state, phase: "replaced", failure: nonceOrReplacementFailure(), provisional: false};
            emit(state);
            return state;
          }
          // Dropped is the *only* reading left: the node has forgotten the hash and the account nonce never
          // moved past it, so no replacement was mined either.
          if (runtime.now() - startedAt > runtime.dropAfterMs) {
            state = {...state, phase: "dropped", failure: nonceOrReplacementFailure(), provisional: false};
            emit(state);
            return state;
          }
        }
      }
    }

    await runtime.sleep(delay);
    // Exponential backoff to the ceiling: a transaction nobody has confirmed after minutes does not deserve
    // three RPC calls every three seconds (SPEC §10.1).
    delay = Math.min(delay * 2, ceiling);
  }
}

/**
 * Runs one write end to end: estimate, prompt, submit, track.
 *
 * `emit` receives every intermediate state. The returned state is the terminal one.
 */
export async function runWrite(
  prepared: PreparedWrite,
  options: SendOptions,
  runtime: TxRuntime,
  emit: Emit,
): Promise<TxState> {
  const request: TxRequest = {
    from: options.account,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
  };

  let state: TxState = step(
    {
      ...IDLE_TX_STATE,
      phase: "preview",
      summary: prepared.summary,
      label: options.label,
      account: options.account,
      chainId: runtime.chainId,
    },
    "preview",
    runtime.now(),
  );
  emit(state);

  // 1. Estimate against current state with the full calldata. A revert here never reaches the wallet.
  let gasLimit: bigint;
  try {
    gasLimit = withHeadroom(await runtime.signer.estimateGas(request));
  } catch (error) {
    const decoded = decodeRevert(
      error,
      decodeOptionsForWrite({contract: prepared.contract, function: prepared.function}),
    );
    // Nothing has been signed at this point: the estimate runs before the wallet is opened. Whatever went
    // wrong, no transaction exists, so the funds effect is "Nothing sent" rather than the §9.6
    // "Unknown until receipt" row that sends someone looking for a hash that was never created.
    const failure =
      decoded.kind === "none"
        ? failureFromUnknown(error, {hasHash: false})
        : failureFromRevert(decoded, options.formatParams);
    state = {...state, phase: "reverted", failure};
    emit(state);
    return state;
  }

  // 2. The wallet prompt.
  state = step({...state, phase: "walletConfirmation"}, "walletConfirmation", runtime.now());
  emit(state);

  const intentFor = (hash: string | null, nonce: number | null): PendingIntent => ({
    action: prepared.summary.action,
    contract: prepared.contract,
    function: prepared.function,
    label: options.label,
    account: options.account,
    chainId: runtime.chainId.toString(),
    to: prepared.to,
    data: prepared.data,
    value: prepared.value.toString(),
    nonce,
    hash,
    startedAt: runtime.now(),
  });

  let sent: {hash: string; nonce: number};
  try {
    sent = await runtime.signer.sendTransaction({...request, gasLimit});
  } catch (error) {
    const walletError = error instanceof WalletError ? error : toWalletError(error);
    const phase = walletError.code === "UserRejected" ? "rejected" : "walletUnreachable";
    // ethers' `JsonRpcSigner.sendTransaction` broadcasts first and only then polls for the transaction. When
    // that poll fails (NETWORK_ERROR, BAD_DATA) it rejects with the hash it already has. Throwing that away
    // would tell the user nothing was sent while a signed transaction is on its way to a block, so the hash
    // is kept, the intent is persisted under it and a reload reattaches (SPEC §9.6 wallet-unreachable).
    const broadcast = phase === "walletUnreachable" ? broadcastHashOf(error) : null;
    if (broadcast !== null) {
      saveIntent(runtime.storage, intentFor(broadcast, null));
      // Whatever went wrong, a hash exists, so neither row may say "Nothing sent" (SPEC §9.6).
      const failure =
        walletError.code === "WrongChain"
          ? wrongChainWithHashFailure(walletError)
          : walletUnreachableWithHashFailure(walletError);
      state = step({...state, phase, hash: broadcast, failure}, "submitted", runtime.now());
      state = {
        ...state,
        steps: state.steps.map((entry) => (entry.name === "submitted" ? {...entry, hash: broadcast} : entry)),
      };
      emit(state);
      return state;
    }
    state = {...state, phase, failure: failureFromWalletError(walletError)};
    emit(state);
    return state;
  }

  // 3. Submitted: persist the intent before anything else, so a reload reattaches to this hash.
  const intent: PendingIntent = intentFor(sent.hash, sent.nonce);
  saveIntent(runtime.storage, intent);

  state = step(
    {...state, phase: "submitted", hash: sent.hash, nonce: sent.nonce},
    "submitted",
    runtime.now(),
  );
  // The step just pushed predates the hash on `state`; rewrite it so every step carries the link.
  state = {
    ...state,
    steps: state.steps.map((entry) => (entry.name === "submitted" ? {...entry, hash: sent.hash} : entry)),
  };
  emit(state);

  const trackInput: TrackInput = {
    request,
    contract: prepared.contract,
    function: prepared.function,
    intent,
    ...(options.formatParams === undefined ? {} : {formatParams: options.formatParams}),
  };
  return await track(state, trackInput, runtime, emit);
}

/**
 * Reattaches to a transaction this browser had in progress and resumes receipt tracking (SPEC §9.6).
 * Nothing is signed and nothing is sent: an intent with no hash is simply discarded.
 */
export async function resumeIntent(
  intent: PendingIntent,
  runtime: TxRuntime,
  emit: Emit,
  formatParams?: RevertParamFormatter,
): Promise<TxState> {
  if (intent.hash === null) {
    clearIntent(runtime.storage);
    return IDLE_TX_STATE;
  }
  const request: TxRequest = {
    from: intent.account,
    to: intent.to,
    data: intent.data,
    value: BigInt(intent.value),
  };
  let state: TxState = {
    ...IDLE_TX_STATE,
    phase: "submitted",
    label: intent.label,
    account: intent.account as Address,
    chainId: BigInt(intent.chainId),
    hash: intent.hash,
    nonce: intent.nonce,
    steps: [{name: "submitted", at: intent.startedAt, hash: intent.hash}],
    provisional: true,
  };
  emit(state);
  const trackInput: TrackInput = {
    request,
    contract: intent.contract,
    function: intent.function,
    intent,
    ...(formatParams === undefined ? {} : {formatParams}),
  };
  state = await track(state, trackInput, runtime, emit);
  return state;
}
