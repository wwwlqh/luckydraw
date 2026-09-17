// Every branch of the SPEC §9.6 state machine, with a fake signer and a fake node.

import {
  catalogEntryFor,
  prepareDepositNative,
  type VerifiedDeployment,
  vaultErrorSelectors,
  verifyDeployment,
} from "@luckydraw/client";
import type {JsonRpcProvider} from "ethers";
import {beforeEach, describe, expect, it} from "vitest";
import {en} from "../../strings/en.ts";
import {fakeNode, testManifest} from "../../test/harness.tsx";
import {toVerifyProvider} from "../deployment/provider.ts";
import {WalletError} from "../wallet/errors.ts";
import {INTENT_STORAGE_KEY, loadIntent, type PendingIntent} from "./intent.ts";
import {resumeIntent, runWrite, type TxRuntime} from "./machine.ts";
import type {TxBodyLike, TxReceiptLike, TxRequest, TxState} from "./types.ts";

const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;
const HASH = `0x${"ab".repeat(32)}`;

async function verified(): Promise<VerifiedDeployment> {
  const manifest = testManifest();
  const node = fakeNode(manifest);
  const result = await verifyDeployment(toVerifyProvider(node as unknown as JsonRpcProvider), manifest);
  if (!result.ok) throw new Error(`fixture did not verify: ${JSON.stringify(result.failure)}`);
  return result.verified;
}

type NodeScript = {
  receipts?: (TxReceiptLike | null)[];
  transactions?: (TxBodyLike | null)[];
  nonces?: number[];
  /** Revert data the replay of a failed transaction produces. */
  replayRevert?: string | null;
  finalityHead?: bigint | null;
  head?: number;
  /** One head per `getBlockNumber` call, so a confirmation can be watched moving with the receipt's block. */
  heads?: number[];
  receiptPollMs?: number;
  maxPollMs?: number;
};

function makeRuntime(
  script: NodeScript = {},
  signerScript: {estimateError?: unknown; sendError?: unknown} = {},
) {
  let clock = 1_000;
  const sent: (TxRequest & {gasLimit: bigint})[] = [];
  const receipts = [...(script.receipts ?? [])];
  const transactions = [...(script.transactions ?? [])];
  const nonces = [...(script.nonces ?? [])];
  const heads = [...(script.heads ?? [])];
  const sleeps: number[] = [];
  let headReads = 0;
  const storage = window.sessionStorage;

  const runtime: TxRuntime = {
    signer: {
      estimateGas: () => {
        if (signerScript.estimateError !== undefined) return Promise.reject(signerScript.estimateError);
        return Promise.resolve(100_000n);
      },
      sendTransaction: (tx) => {
        if (signerScript.sendError !== undefined) return Promise.reject(signerScript.sendError);
        sent.push(tx);
        return Promise.resolve({hash: HASH, nonce: 7});
      },
    },
    watcher: {
      getTransactionReceipt: () => Promise.resolve(receipts.length > 0 ? (receipts.shift() ?? null) : null),
      getTransaction: () => Promise.resolve(transactions.length > 0 ? (transactions.shift() ?? null) : null),
      getTransactionCount: () => Promise.resolve(nonces.length > 0 ? (nonces.shift() ?? 7) : 7),
      getBlockNumber: () => {
        headReads += 1;
        return Promise.resolve(heads.length > 0 ? (heads.shift() ?? 10_000) : (script.head ?? 10_000));
      },
      getFinalityHead: () => Promise.resolve(script.finalityHead ?? null),
      call: () => {
        if (script.replayRevert == null) return Promise.resolve("0x");
        return Promise.reject(
          Object.assign(new Error("execution reverted"), {
            code: "CALL_EXCEPTION",
            data: script.replayRevert,
          }),
        );
      },
    },
    chainId: 31_337n,
    finalityTag: null,
    confirmationDepth: 200n,
    storage,
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    receiptPollMs: script.receiptPollMs ?? 1_000,
    ...(script.maxPollMs === undefined ? {} : {maxPollMs: script.maxPollMs}),
    dropAfterMs: 5_000,
  };
  return {runtime, sent, sleeps, headReads: () => headReads};
}

function collect(): {emit: (state: TxState) => void; phases: string[]} {
  const phases: string[] = [];
  return {
    emit: (state) => {
      if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
    },
    phases,
  };
}

describe("runWrite", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("walks preview -> wallet -> submitted -> included -> confirmed and clears the intent", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sent} = makeRuntime({
      receipts: [null, {hash: HASH, status: 1, blockNumber: 500}],
      transactions: [{blockNumber: null}],
      nonces: [7],
      head: 900,
    });
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(phases).toEqual(["preview", "walletConfirmation", "submitted", "included", "confirmed"]);
    expect(state.hash).toBe(HASH);
    expect(state.nonce).toBe(7);
    expect(state.blockNumber).toBe(500n);
    expect(state.provisional).toBe(false);
    expect(state.steps.map((entry) => entry.name)).toEqual([
      "preview",
      "walletConfirmation",
      "submitted",
      "included",
      "confirmed",
    ]);
    // The gas limit came from the live estimate, not from a table.
    expect(sent[0]?.gasLimit).toBe(125_000n);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("shows a revert found during the estimate from the catalog and never opens the wallet", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sent} = makeRuntime(
      {},
      {
        estimateError: Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
          data: vaultErrorSelectors.DepositsPaused,
        }),
      },
    );
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(phases).toEqual(["preview", "reverted"]);
    expect(state.failure?.catalogKey).toBe("DepositsPaused");
    expect(state.failure?.message).toBe(catalogEntryFor("DepositsPaused").message);
    expect(state.failure?.funds).toBe(catalogEntryFor("DepositsPaused").funds);
    expect(sent).toHaveLength(0);
  });

  it("separates a user rejection from an unreachable wallet", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);

    const rejected = makeRuntime({}, {sendError: Object.assign(new Error("User rejected"), {code: 4001})});
    const rejectedState = await runWrite(
      prepared,
      {account: ACCOUNT, label: "Deposit"},
      rejected.runtime,
      () => undefined,
    );
    expect(rejectedState.phase).toBe("rejected");
    expect(rejectedState.failure?.catalogKey).toBe("WalletRejected");

    const gone = makeRuntime({}, {sendError: new WalletError("Disconnected", "provider gone")});
    const goneState = await runWrite(
      prepared,
      {account: ACCOUNT, label: "Deposit"},
      gone.runtime,
      () => undefined,
    );
    expect(goneState.phase).toBe("walletUnreachable");
    expect(goneState.failure?.catalogKey).toBe("WalletUnreachable");
    expect(goneState.failure?.funds).toBe("Unknown until receipt");
  });

  it("decodes an on-chain revert from the receipt by replaying the call", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [{hash: HASH, status: 0, blockNumber: 501}],
      replayRevert: vaultErrorSelectors.DepositsDisabled,
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("reverted");
    expect(state.failure?.catalogKey).toBe("DepositsDisabled");
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("reports an unrecognized revert with its copyable selector and data", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [{hash: HASH, status: 0, blockNumber: 501}],
      replayRevert: "0xdeadbeef",
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.failure?.catalogKey).toBe("UnknownRevert");
    expect(state.failure?.selector).toBe("0xdeadbeef");
  });

  it("reports a replacement by nonce and never sends twice", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sent} = makeRuntime({
      receipts: [null],
      transactions: [null],
      nonces: [8],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("replaced");
    expect(state.failure?.catalogKey).toBe("NonceOrReplacement");
    expect(state.failure?.funds).toBe("Unknown until receipt");
    expect(sent).toHaveLength(1);
  });

  it("reports a dropped transaction once the node has forgotten it, without resending", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sent} = makeRuntime({
      receipts: [null, null, null, null, null, null, null, null],
      transactions: [null, null, null, null, null, null, null, null],
      nonces: [7, 7, 7, 7, 7, 7, 7, 7],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("dropped");
    expect(sent).toHaveLength(1);
  });

  it("rolls a reorged-out transaction back to submitted instead of confirming it", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    // The receipt is answered once and then never again: the block that carried it was reorged away.
    // Nothing may be called confirmed on the strength of a receipt the node no longer has (SPEC §9.6).
    const {runtime} = makeRuntime({
      receipts: [{hash: HASH, status: 1, blockNumber: 500}],
      transactions: [{blockNumber: null}],
      nonces: [7, 7, 8],
      head: 600,
    });
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(phases).toEqual([
      "preview",
      "walletConfirmation",
      "submitted",
      "included",
      "submitted",
      "replaced",
    ]);
    expect(phases).not.toContain("confirmed");
    expect(state.steps.map((entry) => entry.name)).not.toContain("included");
  });

  it("follows the receipt to a new block and waits for that one to confirm", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    // 703 is 203 blocks past 500 and only 198 past 505: a machine still waiting on the first block would
    // have confirmed on the second poll.
    const {runtime, headReads} = makeRuntime({
      receipts: [
        {hash: HASH, status: 1, blockNumber: 500},
        {hash: HASH, status: 1, blockNumber: 505},
        {hash: HASH, status: 1, blockNumber: 505},
      ],
      heads: [600, 703, 706],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("confirmed");
    expect(state.blockNumber).toBe(505n);
    expect(headReads()).toBe(3);
  });

  it("keeps polling when the receipt read throws, and still reports a replacement afterwards", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime();
    let receiptReads = 0;
    runtime.watcher.getTransactionReceipt = () => {
      receiptReads += 1;
      if (receiptReads === 1) return Promise.reject(new Error("rpc unavailable"));
      return Promise.resolve(null);
    };
    runtime.watcher.getTransaction = () => Promise.resolve(null);
    runtime.watcher.getTransactionCount = () => Promise.resolve(8);
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(state.phase).toBe("replaced");
    // The throwing read was a retry, not evidence of anything: no branch was taken on it, and the verdict
    // still needed three absent polls plus the final re-read afterwards.
    expect(receiptReads).toBeGreaterThan(2);
    expect(phases).toEqual(["preview", "walletConfirmation", "submitted", "replaced"]);
  });

  it("does not report a pending transaction as dropped when the nonce read fails", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({head: 10_000});
    let polls = 0;
    runtime.watcher.getTransactionReceipt = () => {
      polls += 1;
      // Six polls of backoff take the clock well past `dropAfterMs` (5 s).
      return Promise.resolve(polls < 6 ? null : {hash: HASH, status: 1, blockNumber: 500});
    };
    // The node still has the transaction; only the nonce read is broken.
    runtime.watcher.getTransaction = () => Promise.resolve({blockNumber: null});
    runtime.watcher.getTransactionCount = () => Promise.reject(new Error("rpc unavailable"));
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(phases).not.toContain("dropped");
    expect(state.phase).toBe("confirmed");
  });

  it("keeps the hash ethers reports when the broadcast succeeded but the wallet poll failed", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime(
      {},
      {
        sendError: Object.assign(new Error("could not coalesce error"), {
          code: "NETWORK_ERROR",
          info: {sendTransactionHash: HASH},
        }),
      },
    );

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("walletUnreachable");
    expect(state.hash).toBe(HASH);
    // The copy must not say nothing was sent when a signed transaction is on its way.
    expect(state.failure?.message).toBe(en.tx.walletUnreachableWithHash);
    expect(state.failure?.message).not.toBe(catalogEntryFor("WalletUnreachable").message);
    const stored = JSON.parse(window.sessionStorage.getItem(INTENT_STORAGE_KEY) ?? "{}") as PendingIntent;
    expect(stored).toMatchObject({hash: HASH, nonce: null, account: ACCOUNT});
  });

  it("backs the receipt poll off exponentially to the ceiling", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sleeps} = makeRuntime({
      receipts: [null, null, null, null, null, null, null, null],
      transactions: [null, null, null, null, null, null, null, null],
      nonces: [7, 7, 7, 7, 7, 7, 7, 7],
      receiptPollMs: 4_000,
      maxPollMs: 15_000,
    });

    await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(sleeps).toEqual([4_000, 8_000]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(15_000);
  });

  it("never sleeps longer than the ceiling", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime, sleeps} = makeRuntime({receiptPollMs: 1_000, maxPollMs: 3_000, head: 10_000});
    let polls = 0;
    runtime.watcher.getTransactionReceipt = () => {
      polls += 1;
      return Promise.resolve(polls < 7 ? null : {hash: HASH, status: 1, blockNumber: 500});
    };
    runtime.watcher.getTransaction = () => Promise.resolve({blockNumber: null});
    runtime.watcher.getTransactionCount = () => Promise.resolve(7);

    await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(sleeps).toEqual([1_000, 2_000, 3_000, 3_000, 3_000, 3_000]);
  });

  it("does not call one stale absent answer a replacement when the receipt turns up next", async () => {
    // One poll with no receipt, no transaction and an advanced nonce used to be enough for `replaced`.
    // A load-balanced RPC answers that way whenever the request lands on a node a second behind, and the
    // very next poll has the receipt. Three consecutive absents and a final re-read are the bar now.
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [null, {hash: HASH, status: 1, blockNumber: 500}],
      transactions: [null],
      nonces: [8],
      head: 900,
    });
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(state.phase).toBe("confirmed");
    expect(phases).not.toContain("replaced");
    expect(phases).toEqual(["preview", "walletConfirmation", "submitted", "included", "confirmed"]);
  });

  it("keeps the intent on a replaced verdict, because the outcome is unknown until a receipt", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [null, null, null, null, null, null],
      transactions: [null, null, null, null, null, null],
      nonces: [8, 8, 8, 8, 8, 8],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("replaced");
    // "Unknown until receipt" means the next mount must be able to look again (SPEC §9.6).
    const stored = JSON.parse(window.sessionStorage.getItem(INTENT_STORAGE_KEY) ?? "null") as PendingIntent;
    expect(stored?.hash).toBe(HASH);
  });

  it("never calls a transaction dropped while the account nonce has moved past it", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [null, null, null, null, null, null, null, null],
      transactions: [null, null, null, null, null, null, null, null],
      nonces: [7, 7, 9, 7, 7, 7, 7, 7],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    // The nonce observation is sticky: an account nonce never goes backwards, so one sighting settles it.
    expect(state.phase).toBe("replaced");
  });

  it("refuses to report a receipt whose parties are not the ones this app prepared", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [
        {
          hash: HASH,
          status: 1,
          blockNumber: 500,
          to: "0x000000000000000000000000000000000000dead",
          from: ACCOUNT,
        },
      ],
      head: 10_000,
    });
    const {emit, phases} = collect();

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, emit);

    expect(phases).not.toContain("included");
    expect(phases).not.toContain("confirmed");
    expect(state.failure?.message).toBe(en.tx.hashMismatch);
    expect(state.failure?.funds).toBe("Unknown until receipt");
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it("refuses to track a transaction body signed by another account", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [null, null],
      transactions: [
        {blockNumber: null, to: prepared.to, from: "0x0000000000000000000000000000000000000001"},
      ],
    });

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.failure?.message).toBe(en.tx.hashMismatch);
  });

  it("stops the moment the run is aborted and leaves the intent slot alone", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const controller = new AbortController();
    const {runtime} = makeRuntime({receipts: [null], transactions: [null], nonces: [7]});
    let polls = 0;
    runtime.signal = controller.signal;
    runtime.watcher.getTransactionReceipt = () => {
      polls += 1;
      if (polls === 2) controller.abort();
      return Promise.resolve(null);
    };

    const state = await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, () => undefined);

    expect(state.phase).toBe("submitted");
    expect(polls).toBe(2);
    // The intent this run persisted is still there: an abort is "someone else owns this now", never a
    // verdict about the transaction.
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it("clears only its own intent when a different run's intent is stored", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({
      receipts: [{hash: HASH, status: 1, blockNumber: 500}],
      head: 10_000,
    });
    const other: PendingIntent = {
      action: "deposit",
      contract: "vault",
      function: "depositNative",
      label: "Another run",
      account: ACCOUNT,
      chainId: "31337",
      to: prepared.to,
      data: prepared.data,
      value: "0",
      nonce: 9,
      hash: `0x${"cd".repeat(32)}`,
      startedAt: 1_000,
    };

    await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, (state) => {
      // Run B saves its intent while run A is still walking towards `confirmed`.
      if (state.phase === "submitted")
        window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(other));
    });

    const stored = JSON.parse(window.sessionStorage.getItem(INTENT_STORAGE_KEY) ?? "null") as PendingIntent;
    expect(stored?.hash).toBe(other.hash);
  });

  it("stores the pending intent as soon as a hash exists", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const {runtime} = makeRuntime({receipts: [null], transactions: [null], nonces: [7]});
    let seen: string | null = null;

    await runWrite(prepared, {account: ACCOUNT, label: "Deposit"}, runtime, (state) => {
      if (state.phase === "submitted" && seen === null) {
        seen = window.sessionStorage.getItem(INTENT_STORAGE_KEY);
      }
    });

    expect(seen).not.toBeNull();
    const stored = JSON.parse(seen ?? "{}") as PendingIntent;
    expect(stored).toMatchObject({account: ACCOUNT, chainId: "31337", hash: HASH, nonce: 7});
    expect(stored.value).toBe("1000");
  });
});

describe("resumeIntent", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("reattaches to a persisted hash and resumes receipt tracking without signing", async () => {
    const deployment = await verified();
    const prepared = prepareDepositNative(deployment, 1_000n);
    const intent: PendingIntent = {
      action: prepared.summary.action,
      contract: prepared.contract,
      function: prepared.function,
      label: "Deposit",
      account: ACCOUNT,
      chainId: "31337",
      to: prepared.to,
      data: prepared.data,
      value: prepared.value.toString(),
      nonce: 7,
      hash: HASH,
      startedAt: 1_000,
    };
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));

    const {runtime, sent} = makeRuntime({
      receipts: [{hash: HASH, status: 1, blockNumber: 500}],
      head: 900,
    });
    const {emit, phases} = collect();

    const state = await resumeIntent(intent, runtime, emit);

    expect(phases).toEqual(["submitted", "included", "confirmed"]);
    expect(state.hash).toBe(HASH);
    expect(sent).toHaveLength(0);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("does not return an intent that belongs to another chain or account", () => {
    const intent: PendingIntent = {
      action: "deposit",
      contract: "vault",
      function: "depositNative",
      label: null,
      account: ACCOUNT,
      chainId: "56",
      to: ACCOUNT,
      data: "0x",
      value: "0",
      nonce: 1,
      hash: HASH,
      startedAt: 1,
    };
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
    expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).toBeNull();
    expect(loadIntent(window.sessionStorage, 56n, "0x0000000000000000000000000000000000000001")).toBeNull();
    expect(loadIntent(window.sessionStorage, 56n, ACCOUNT)).not.toBeNull();
  });

  it("returns nothing while the session has not named an account yet", () => {
    const intent: PendingIntent = {
      action: "deposit",
      contract: "vault",
      function: "depositNative",
      label: null,
      account: ACCOUNT,
      chainId: "31337",
      to: ACCOUNT,
      data: "0x",
      value: "0",
      nonce: 1,
      hash: HASH,
      startedAt: 1,
    };
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
    // An intent belongs to an account. Handing it out before one is known is how another address's
    // transaction gets reattached to whoever connects next (SPEC §9.6).
    expect(loadIntent(window.sessionStorage, 31_337n, null)).toBeNull();
    expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).not.toBeNull();
  });
});
