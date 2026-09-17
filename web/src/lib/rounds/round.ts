// The round page's reads and its two derived tables (SPEC §9.4 `/round/:chainId/:roundId`, §9.8).
//
// One block for everything the header, the pot card, the timeline and the lifecycle control show; the ranges
// are a second, heavier read because a large round pages them 100 at a time (`readAllRanges`).

import {
  type Address,
  type FeedReading,
  type PoolView,
  type Position,
  type Range,
  type ReadContext,
  type RoundView,
  readAllRanges,
  readBuysPaused,
  readCurrent,
  readFeed,
  readPool,
  readPosition,
  readRound,
  readSeedAccount,
  resolveSnapshotBlock,
  type Snapshot,
  type SnapshotBlock,
  snapshotOf,
  ZERO_ADDRESS,
} from "@luckydraw/client";

/** Everything the round page reads from one block. */
export type RoundData = {
  round: RoundView;
  pool: PoolView;
  feed: FeedReading;
  /** The Draw's global new-entry stop; the pool's own flag is `pool.buysPaused`. */
  buysPaused: boolean;
  /** The Draw's seed pointer now; `round.seedAccount` is the one that actually seeded this round. */
  seedAccount: Address;
  /** The pool and kind's current round, so a closed round can link to its successor (SPEC §9.5). */
  currentRoundId: bigint;
};

export async function readRoundPage(ctx: ReadContext, roundId: bigint): Promise<Snapshot<RoundData>> {
  const block: SnapshotBlock =
    ctx.block ?? (await resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag}));
  const inner: ReadContext = {...ctx, block};

  const round = (await readRound(inner, roundId)).value;
  const [pool, feed, buysPaused, seedAccount, currentRoundId] = await Promise.all([
    readPool(inner, round.poolId).then((snapshot) => snapshot.value),
    readFeed(inner, round.pricing.feed).then((snapshot) => snapshot.value),
    readBuysPaused(inner).then((snapshot) => snapshot.value),
    readSeedAccount(inner).then((snapshot) => snapshot.value),
    readCurrent(inner, round.poolId, round.kind).then((snapshot) => snapshot.value),
  ]);

  return snapshotOf(ctx.deployment, block, {round, pool, feed, buysPaused, seedAccount, currentRoundId});
}

/** The connected account's position in one round. */
export async function readRoundPosition(
  ctx: ReadContext,
  roundId: bigint,
  user: Address,
): Promise<Snapshot<Position>> {
  return readPosition(ctx, roundId, user);
}

/**
 * Every range of a round, for the holders table and the entry ledger.
 *
 * Capped well below `readAllRanges`'s own 100,000 default: a browser paging 1,000 `getRanges` calls is not a
 * page load, and SPEC §9.4 only promises the top ten plus pagination. Above the cap the read refuses and the
 * table says so rather than hanging (`ReadError("RangeLimitExceeded")`).
 */
export const MAX_PAGED_RANGES = 2_000n;

export async function readRoundRanges(
  ctx: ReadContext,
  roundId: bigint,
): Promise<Snapshot<readonly Range[]>> {
  return readAllRanges(ctx, roundId, {maxRanges: MAX_PAGED_RANGES});
}

// ---------------------------------------------------------------------------
// Derived tables
// ---------------------------------------------------------------------------

/** One row of the entry ledger: the ranges in the order the contract recorded them (SPEC §5.1). */
export type LedgerRow = {
  index: number;
  buyer: Address;
  /** This entry's own gross: the difference between its cumulative total and the previous one. */
  gross: bigint;
  cumulativeGross: bigint;
  isSeed: boolean;
};

export function ledgerOf(ranges: readonly Range[], seedAccount: Address): readonly LedgerRow[] {
  const rows: LedgerRow[] = [];
  let previous = 0n;
  ranges.forEach((range, index) => {
    rows.push({
      index,
      buyer: range.buyer,
      gross: range.cumulativeGross - previous,
      cumulativeGross: range.cumulativeGross,
      isSeed: seedAccount !== ZERO_ADDRESS && range.buyer === seedAccount,
    });
    previous = range.cumulativeGross;
  });
  return rows;
}

/** One holder: an account's total gross in the round, which is exactly its weight (SPEC §9.8). */
export type HolderRow = {
  account: Address;
  gross: bigint;
  isSeed: boolean;
};

/**
 * Holders aggregated by account, largest first (SPEC §9.8: "holders aggregate grossByUser").
 *
 * The seed is one row labelled "Operator seed", never an anonymous address (SPEC §9.5); it is aggregated like
 * any other account so its share is the truth, and only its label differs.
 */
export function aggregateHolders(ranges: readonly Range[], seedAccount: Address): readonly HolderRow[] {
  const totals = new Map<Address, bigint>();
  let previous = 0n;
  for (const range of ranges) {
    totals.set(range.buyer, (totals.get(range.buyer) ?? 0n) + (range.cumulativeGross - previous));
    previous = range.cumulativeGross;
  }
  const rows: HolderRow[] = [...totals].map(([account, gross]) => ({
    account,
    gross,
    isSeed: seedAccount !== ZERO_ADDRESS && account === seedAccount,
  }));
  rows.sort((a, b) => {
    if (a.gross !== b.gross) return a.gross > b.gross ? -1 : 1;
    return a.account < b.account ? -1 : 1;
  });
  return rows;
}
