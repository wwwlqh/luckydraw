// Building, sorting and filtering the pools list (SPEC §9.4 `/`).
//
// The read composition lives here too: one snapshot block resolved once, then `readPools`, `readCurrent` per
// pool and kind, `readRound` for every non-zero pointer and one `readFeed` per distinct feed address, all
// pinned to that block (SPEC §10.1: "Related direct reads use one blockTag"). The page therefore re-renders
// only when the block hash changes, which is what §9.3 asks of a list.

import {
  type Address,
  type FeedReading,
  type Kind,
  type ManifestAsset,
  type PoolView,
  type Position,
  type ReadContext,
  type RoundView,
  readBuysPaused,
  readCurrent,
  readFeed,
  readPools,
  readPosition,
  readRound,
  resolveSnapshotBlock,
  type Snapshot,
  type SnapshotBlock,
  snapshotOf,
} from "@luckydraw/client";
import {
  type CardState,
  cardStateOf,
  KINDS,
  type PriceState,
  priceStateOf,
  type TargetProgress,
  targetProgressOf,
} from "./derive.ts";

/** One RoundCard's worth of state: a pool, one of its seven tiers and that tier's current round. */
export type PoolCard = {
  /** `${poolId}:${kind}`; stable across blocks, so React keys never churn. */
  key: string;
  poolId: bigint;
  kind: Kind;
  pool: PoolView;
  /** The manifest asset for the pool, or null when the pool's asset is not in the pinned manifest. */
  asset: ManifestAsset | null;
  /** The current round of this pool and kind, or null when the pool has none open. */
  round: RoundView | null;
  price: PriceState | null;
  state: CardState;
  /** The frozen target of the open round, or the pool's configured target for the tier when none is open. */
  targetUsd: bigint;
  progress: TargetProgress | null;
  closesAt: bigint | null;
  /** The connected account's position in this round, when one has been read. */
  position: Position | null;
};

export type BuildCardsInput = {
  pools: readonly PoolView[];
  /** Round for each `${poolId}:${kind}`, or null where the pointer is zero. */
  rounds: ReadonlyMap<string, RoundView | null>;
  /** Feed reading per lowercase feed address. */
  feeds: ReadonlyMap<Address, FeedReading>;
  assets: readonly ManifestAsset[];
  buysPaused: boolean;
  now: bigint;
  positions?: ReadonlyMap<string, Position> | undefined;
};

export function cardKey(poolId: bigint, kind: Kind): string {
  return `${poolId}:${kind}`;
}

export function buildCards(input: BuildCardsInput): readonly PoolCard[] {
  const cards: PoolCard[] = [];
  for (const pool of input.pools) {
    const asset = input.assets.find((entry) => entry.asset === pool.asset) ?? null;
    for (const kind of KINDS) {
      const key = cardKey(pool.id, kind);
      const round = input.rounds.get(key) ?? null;
      const feed = round === null ? undefined : input.feeds.get(round.pricing.feed);
      const price = round === null || feed === undefined ? null : priceStateOf(round, feed, input.now);
      cards.push({
        key,
        poolId: pool.id,
        kind,
        pool,
        asset,
        round,
        price,
        state: cardStateOf(round, pool, price, input.buysPaused, input.now),
        targetUsd: round === null ? (pool.targetUsd[kind] ?? 0n) : round.targetUsd,
        progress: round === null || price === null ? null : targetProgressOf(round, price.price),
        closesAt: round === null ? null : round.closesAt,
        position: input.positions?.get(key) ?? null,
      });
    }
  }
  return cards;
}

/**
 * Closing soonest first (SPEC §9.4).
 *
 * A tier with no open round has no cutoff at all, so it sorts after every round that has one rather than
 * before all of them; ties break on pool id then kind so the order is total and stable across blocks.
 */
export function sortByClosingSoonest(cards: readonly PoolCard[]): readonly PoolCard[] {
  return [...cards].sort((a, b) => {
    if (a.closesAt !== b.closesAt) {
      if (a.closesAt === null) return 1;
      if (b.closesAt === null) return -1;
      return a.closesAt < b.closesAt ? -1 : 1;
    }
    if (a.poolId !== b.poolId) return a.poolId < b.poolId ? -1 : 1;
    return a.kind - b.kind;
  });
}

/** The filter chips of SPEC §9.4: by asset address and by tier. An empty set means "all". */
export type CardFilter = {assets: readonly Address[]; kinds: readonly Kind[]};

export const NO_FILTER: CardFilter = {assets: [], kinds: []};

export function filterCards(cards: readonly PoolCard[], filter: CardFilter): readonly PoolCard[] {
  return cards.filter((card) => {
    if (filter.assets.length > 0 && !filter.assets.includes(card.pool.asset)) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(card.kind)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Everything `/` needs from the chain, from one block. */
export type HomeData = {
  pools: readonly PoolView[];
  rounds: ReadonlyMap<string, RoundView | null>;
  feeds: ReadonlyMap<Address, FeedReading>;
  buysPaused: boolean;
};

/** Page ceiling for `getPools`; the contract caps a page at 100 (SPEC §8.1). */
const POOL_PAGE = 100n;

/**
 * `readPools` -> `readCurrent` per pool and kind -> `readRound`, plus one feed reading per distinct feed,
 * every call pinned to the block resolved once at the top (SPEC §10.1).
 */
export async function readHome(ctx: ReadContext): Promise<Snapshot<HomeData>> {
  const block: SnapshotBlock =
    ctx.block ?? (await resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag}));
  const inner: ReadContext = {...ctx, block};

  const pools: PoolView[] = [];
  let cursor = 0n;
  for (;;) {
    const page = (await readPools(inner, cursor, POOL_PAGE)).value;
    pools.push(...page.page);
    if (page.page.length === 0 || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }

  const pointers = await Promise.all(
    pools.flatMap((pool) =>
      KINDS.map(async (kind) => ({
        key: cardKey(pool.id, kind),
        roundId: (await readCurrent(inner, pool.id, kind)).value,
      })),
    ),
  );

  const rounds = new Map<string, RoundView | null>();
  await Promise.all(
    pointers.map(async (pointer) => {
      if (pointer.roundId === 0n) {
        rounds.set(pointer.key, null);
        return;
      }
      rounds.set(pointer.key, (await readRound(inner, pointer.roundId)).value);
    }),
  );

  const feedAddresses = new Set<Address>();
  for (const round of rounds.values()) if (round !== null) feedAddresses.add(round.pricing.feed);
  const feeds = new Map<Address, FeedReading>();
  await Promise.all(
    [...feedAddresses].map(async (feed) => {
      feeds.set(feed, (await readFeed(inner, feed)).value);
    }),
  );

  const paused = (await readBuysPaused(inner)).value;

  return snapshotOf(ctx.deployment, block, {pools, rounds, feeds, buysPaused: paused});
}

/** The connected account's position in every listed round, from one block, keyed like the cards. */
export async function readHomePositions(
  ctx: ReadContext,
  roundIds: ReadonlyMap<string, bigint>,
  user: Address,
): Promise<Snapshot<ReadonlyMap<string, Position>>> {
  const block: SnapshotBlock =
    ctx.block ?? (await resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag}));
  const inner: ReadContext = {...ctx, block};
  const positions = new Map<string, Position>();
  await Promise.all(
    [...roundIds].map(async ([key, roundId]) => {
      positions.set(key, (await readPosition(inner, roundId, user)).value);
    }),
  );
  return snapshotOf(ctx.deployment, block, positions);
}
