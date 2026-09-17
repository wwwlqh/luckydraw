// The provider surface the read adapters need, and nothing more (SPEC §10.1).
//
// An ethers v6 `JsonRpcProvider` satisfies this structurally, with no adapter and no `import {ethers}` in
// this file: the four members below are declared with exactly the shapes ethers already has. Keeping the
// surface this small is what lets the keeper, the indexer and a test fake all serve the same adapters.
//
// Block numbers and timestamps arrive from a provider as JS `number`, because that is what `eth_getBlockByNumber`
// decoding gives; they are converted to `bigint` at this boundary (`src/reads/snapshot.ts`) and no public
// signature below this file carries a `number` for a chain integer (README "bigint everywhere").

/** The subset of a block header a snapshot needs. An ethers `Block` satisfies it. */
export type BlockSummary = {
  number: number;
  /** Null only for a pending block, which is never a snapshot block. */
  hash: string | null;
  timestamp: number;
};

/**
 * The read surface. Every call an adapter makes is pinned to one explicit block: SPEC §10.1 requires that
 * "related direct reads use one blockTag".
 */
export type ReadProvider = {
  /** `eth_call`. `blockTag` is a hex quantity produced by `blockTagOf`, never a bare decimal. */
  call(tx: {to: string; data: string; blockTag?: string | number}): Promise<string>;
  /** `eth_getBlockByNumber` for `finalized`, `safe`, `latest` or a hex quantity. Null when unknown. */
  getBlock(tag: string | number): Promise<BlockSummary | null>;
  /** `eth_blockNumber`, used only for the fixed-depth fallback of SPEC §10.1. */
  getBlockNumber(): Promise<number>;
  /** `eth_chainId`. The snapshot's `chainId` comes from the verified deployment, not from here. */
  getNetwork(): Promise<{chainId: bigint}>;
};

/**
 * A block number as the JSON-RPC quantity a `blockTag` must be.
 *
 * Deliberately not a JS `number`: a block number is a chain integer and stays a bigint all the way to the
 * wire. ethers passes a `0x`-prefixed string blockTag through `toQuantity` unchanged, so this is also what
 * an ethers provider wants.
 */
export function blockTagOf(blockNumber: bigint): string {
  if (blockNumber < 0n) throw new RangeError(`block number must not be negative: ${blockNumber}`);
  return `0x${blockNumber.toString(16)}`;
}
