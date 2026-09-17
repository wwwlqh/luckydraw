// One block per snapshot: choosing the block, and reading every call of a snapshot at it (SPEC §10.1).
//
// "Related direct reads use one blockTag; return chainId, blockNumber, blockHash, timestamp and confidence
// with the snapshot. [...] Display confirmation and cache keys use the RPC's `finalized` block tag where
// supported (BSC fast finality), falling back to `safe` and then to a 200-block depth. [...] Direct reads are
// batched through Multicall3 [...] so one call yields one consistent block."
//
// Two properties this module is responsible for:
//
//  1. every call of one snapshot carries the same explicit block number, Multicall3 or not, so the two paths
//     are interchangeable and a snapshot can never mix two blocks;
//  2. a reverting call is a per-call outcome, not a thrown batch: one bad `getRound(0)` must not lose the
//     rest of a panel.
//
// The snapshot's block hash always comes from `getBlock`, never from Multicall3: `getBlockHash` /
// `getCurrentBlockTimestamp` inside a Multicall3 aggregate would be `blockhash(block.number)`, which the EVM
// defines as zero for the block currently executing.

import {Interface} from "ethers";
import {multicall3Abi} from "../abi/generated/multicall3.ts";
import type {VerifiedDeployment} from "../deployments/verify.ts";
import {extractRevertData} from "../errors/decode.ts";
import {type Address, asHex, asHex32, type Hex, type Hex32} from "../types/common.ts";
import {
  type Confidence,
  type ConfidenceTag,
  FINALIZED,
  latestWithDepth,
  SAFE,
  type Snapshot,
} from "../types/snapshot.ts";
import {type BlockSummary, blockTagOf, type ReadProvider} from "./provider.ts";
import {ReadError} from "./readError.ts";

/** The block a snapshot is pinned to, with the confidence that produced it. */
export type SnapshotBlock = {
  blockNumber: bigint;
  blockHash: Hex32;
  /** Block timestamp in seconds. Countdowns and deadlines use this, never `Date.now()` (SPEC §9.6). */
  timestamp: bigint;
  confidence: Confidence;
};

/** The fixed depth behind `latest` of SPEC §10.1 and the §15 Chain record. */
export const DEFAULT_CONFIRMATION_DEPTH = 200n;

export type SnapshotPolicy = {
  /** Depth behind `latest` for the last-resort tag. Defaults to 200 blocks. */
  depth?: bigint | undefined;
  /**
   * Pins the snapshot to one tag instead of walking `finalized` -> `safe` -> depth.
   *
   * `"latest"` here means the head itself (`{tag: "latest", depth: 0}`), which is what the money views and
   * the post-write assertions of an integration test need: SPEC §9.6 says buy, withdraw and claim act on the
   * latest on-chain state and the confirmation policy only changes the provisional/confirmed badge.
   */
  tag?: ConfidenceTag | undefined;
};

/** One call of a snapshot: a target and its calldata. */
export type ReadCall = {to: Address; data: Hex};

/** The result of one call. A revert is data, not an exception (SPEC §8.1). */
export type CallOutcome = {ok: true; data: Hex} | {ok: false; revertData: Hex};

export type BatchOptions = {
  /** Multicall3 for this chain, when the deployment verified one. Absent means one `eth_call` per item. */
  multicall3?: Address | undefined;
};

const multicallInterface = new Interface(multicall3Abi);

async function tryBlock(provider: ReadProvider, tag: string): Promise<BlockSummary | null> {
  try {
    return await provider.getBlock(tag);
  } catch {
    // A node that does not know the tag answers with an error rather than null; both mean "fall back".
    return null;
  }
}

function toSnapshotBlock(block: BlockSummary | null, confidence: Confidence): SnapshotBlock | null {
  if (block === null || block.hash === null) return null;
  let blockHash: Hex32;
  try {
    blockHash = asHex32(block.hash);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(block.number) || block.number < 0) return null;
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) return null;
  return {
    blockNumber: BigInt(block.number),
    blockHash,
    timestamp: BigInt(block.timestamp),
    confidence,
  };
}

/**
 * Picks the block a snapshot reads at, per SPEC §10.1: the RPC's `finalized` tag where supported, then
 * `safe`, then a fixed depth behind `latest`. The returned `confidence` records which one actually answered,
 * so the app can render a provisional value differently from a confirmed one.
 *
 * A provider error and a `null` block are treated the same way, because a node without fast-finality tags
 * reports the unsupported tag either way.
 */
export async function resolveSnapshotBlock(
  provider: ReadProvider,
  policy?: SnapshotPolicy,
): Promise<SnapshotBlock> {
  const depth = policy?.depth ?? DEFAULT_CONFIRMATION_DEPTH;
  if (depth < 0n) throw new ReadError("SnapshotUnavailable", `depth must not be negative: ${depth}`);

  const forced = policy?.tag;
  if (forced === "finalized" || forced === "safe") {
    const pinned = toSnapshotBlock(
      await tryBlock(provider, forced),
      forced === "finalized" ? FINALIZED : SAFE,
    );
    if (pinned !== null) return pinned;
    throw new ReadError("SnapshotUnavailable", `the node did not return a ${forced} block`);
  }
  if (forced === "latest") {
    const head = toSnapshotBlock(await tryBlock(provider, "latest"), latestWithDepth(0n));
    if (head !== null) return head;
    throw new ReadError("SnapshotUnavailable", "the node did not return a latest block");
  }

  const finalized = toSnapshotBlock(await tryBlock(provider, "finalized"), FINALIZED);
  if (finalized !== null) return finalized;

  const safe = toSnapshotBlock(await tryBlock(provider, "safe"), SAFE);
  if (safe !== null) return safe;

  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadError("SnapshotUnavailable", `no finalized or safe tag and no block number: ${message}`);
  }
  if (!Number.isSafeInteger(head) || head < 0) {
    throw new ReadError("SnapshotUnavailable", `the node reported an unusable block number: ${head}`);
  }
  const latest = BigInt(head);
  const target = latest > depth ? latest - depth : 0n;
  const behind = toSnapshotBlock(await tryBlock(provider, blockTagOf(target)), latestWithDepth(depth));
  if (behind !== null) return behind;
  throw new ReadError(
    "SnapshotUnavailable",
    `no finalized or safe tag, and block ${target} (${depth} behind ${latest}) could not be read`,
  );
}

/** ethers marks an EVM execution failure with `code: "CALL_EXCEPTION"`; a dead or slow node uses other codes. */
function isCallException(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as {code?: unknown}).code === "CALL_EXCEPTION";
}

function encodeAggregate3(calls: readonly ReadCall[]): Hex {
  const items = calls.map((call) => [call.to, true, call.data]);
  return asHex(multicallInterface.encodeFunctionData("aggregate3", [items]));
}

function decodeAggregate3(raw: string, expected: number): readonly CallOutcome[] {
  let results: readonly unknown[];
  try {
    const decoded = multicallInterface.decodeFunctionResult("aggregate3", raw);
    results = decoded[0] as readonly unknown[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadError("DecodeFailed", `Multicall3 aggregate3 did not decode: ${message}`, {
      target: "multicall3",
      method: "aggregate3",
    });
  }
  if (results.length !== expected) {
    throw new ReadError(
      "BatchMismatch",
      `Multicall3 returned ${results.length} results for ${expected} calls`,
      {target: "multicall3", method: "aggregate3"},
    );
  }
  return results.map((entry) => {
    const item = entry as {success?: unknown; returnData?: unknown; 0?: unknown; 1?: unknown};
    const success = item.success ?? item[0];
    const data = asHex(String(item.returnData ?? item[1] ?? "0x"));
    return success === true ? {ok: true as const, data} : {ok: false as const, revertData: data};
  });
}

/**
 * A head-pinned snapshot (`{tag: "latest", depth: 0}`, what the money views use) is read by block number,
 * and a one-block reorg between `getBlock` and the calls would answer from the other fork while the snapshot
 * still carries the first hash: a mislabelled entry under SPEC §10.1, where the hash is the snapshot's
 * identity and its cache key. Re-reading the header after the calls costs one light request and turns that
 * into a retryable `SnapshotReorged`. Deeper tags are not re-checked: `finalized` and `safe` do not reorg,
 * and 200 blocks behind the head is beyond any reorg the design cares about.
 */
async function requireSameHead(provider: ReadProvider, block: SnapshotBlock): Promise<void> {
  if (block.confidence.tag !== "latest" || block.confidence.depth !== 0n) return;
  const after = toSnapshotBlock(await tryBlock(provider, blockTagOf(block.blockNumber)), block.confidence);
  if (after === null || after.blockHash !== block.blockHash) {
    throw new ReadError(
      "SnapshotReorged",
      `block ${block.blockNumber} changed from ${block.blockHash} to ${after?.blockHash ?? "unknown"} during the read; retry the snapshot`,
    );
  }
}

/**
 * Runs every call of one snapshot at one block.
 *
 * With `multicall3` this is a single `aggregate3` with `allowFailure` set on every item, so the node answers
 * from one state root; without it, one `eth_call` per item, every one carrying the same explicit block
 * number. The two paths return equal values, which `snapshot.test.ts` asserts directly. A head-pinned block
 * is re-read afterwards and must still carry the same hash (`requireSameHead`).
 *
 * A revert (an `aggregate3` item with `success === false`, or a failing `eth_call` that carried revert bytes)
 * becomes `{ok: false, revertData}`. A failure with no revert bytes at all is a transport failure, not a
 * contract answer, and is rethrown: losing the whole snapshot is the correct outcome when the node is
 * unreachable, while losing it because one round id does not exist is not.
 */
export async function readBatch(
  provider: ReadProvider,
  block: SnapshotBlock,
  calls: readonly ReadCall[],
  options?: BatchOptions,
): Promise<readonly CallOutcome[]> {
  if (calls.length === 0) return [];
  const blockTag = blockTagOf(block.blockNumber);
  const multicall3 = options?.multicall3;

  let outcomes: readonly CallOutcome[];
  if (multicall3 !== undefined) {
    const raw = await provider.call({to: multicall3, data: encodeAggregate3(calls), blockTag});
    outcomes = decodeAggregate3(raw, calls.length);
  } else {
    outcomes = await Promise.all(
      calls.map(async (call): Promise<CallOutcome> => {
        try {
          return {ok: true, data: asHex(await provider.call({to: call.to, data: call.data, blockTag}))};
        } catch (error) {
          const revertData = extractRevertData(error);
          if (revertData !== null) return {ok: false, revertData};
          // An execution failure the node reported without revert bytes (invalid opcode, out of gas):
          // Multicall3 answers `(false, "0x")` for exactly this, so the direct path must too, or one broken
          // feed loses a whole panel on a client without Multicall3. A transport failure carries another code
          // and is rethrown.
          if (isCallException(error)) return {ok: false, revertData: asHex("0x")};
          throw error;
        }
      }),
    );
  }
  await requireSameHead(provider, block);
  return outcomes;
}

/** Wraps a value in the SPEC §10.1 envelope. `chainId` comes from the verified deployment, never a re-fetch. */
export function snapshotOf<T>(deployment: VerifiedDeployment, block: SnapshotBlock, value: T): Snapshot<T> {
  return {
    chainId: deployment.chainId,
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    timestamp: block.timestamp,
    confidence: block.confidence,
    value,
  };
}
