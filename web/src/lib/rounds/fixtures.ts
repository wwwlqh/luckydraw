// Test fixtures for the pools page, the round page and the entry panel.
//
// Exact enums and raw units, as SPEC §9.3 requires of a component fixture: an 18-decimal native pool at a
// USD 100 target, a feed at USD 600.00000000 with eight decimals, and a seed of 0.01 BNB. Nothing here is
// imported by application code, so none of it reaches the bundle.
//
// Only tests import this file. It lives next to the derivations it feeds so a fixture and the function it
// exercises move together.

import {
  type Address,
  type EntryPanel,
  type FeedReading,
  type PoolView,
  type Position,
  type Quote,
  QuoteReason,
  type Range,
  type RoundView,
  State,
} from "@luckydraw/client";

export const ASSET: Address = "0x0000000000000000000000000000000000000000";
export const TOKEN: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const FEED: Address = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
export const PLAYER: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const OTHER: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const SEED_ACCOUNT: Address = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
export const FEE_ACCOUNT: Address = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

/** The snapshot's chain timestamp in every fixture: 2026-10-01 00:00:00 UTC minus one day. */
export const NOW = 1_790_812_800n;
export const CUTOFF = NOW + 86_400n;

/** USD 600.00000000 at eight feed decimals. */
export const PRICE = 60_000_000_000n;

export function feedReading(overrides: Partial<FeedReading> = {}): FeedReading {
  return {
    available: true,
    decimals: 8n,
    observation: {roundId: 42n, answer: PRICE, updatedAt: NOW - 60n},
    ...overrides,
  };
}

export function round(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 1n,
    poolId: 1n,
    kind: 0,
    sequence: 7n,
    asset: ASSET,
    tokenDecimals: 18n,
    pricing: {
      feed: FEED,
      feedDecimals: 8n,
      maxPriceAge: 3_600n,
      referenceKind: 0,
      minAnswer: 0n,
      maxAnswer: 0n,
    },
    feeAccount: FEE_ACCOUNT,
    opensAt: NOW - 3_600n,
    closesAt: CUTOFF,
    targetUsd: 100n,
    state: State.Open,
    // 1 BNB entered, 3% reserved.
    grossTotal: 1_000_000_000_000_000_000n,
    feeReserved: 30_000_000_000_000_000n,
    prizePot: 970_000_000_000_000_000n,
    playerCount: 2n,
    seeded: true,
    seedAccount: SEED_ACCOUNT,
    seedGross: 10_000_000_000_000_000n,
    closedAt: 0n,
    closeReason: 0,
    requestDeadline: 0n,
    requestId: 0n,
    requestedAt: 0n,
    word0: 0n,
    word1: 0n,
    winningIndex: 0n,
    winner: "0x0000000000000000000000000000000000000000",
    settledAt: 0n,
    refundedGross: 0n,
    refundReason: 0,
    rangeCount: 2n,
    ...overrides,
  };
}

export function pool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 1n,
    asset: ASSET,
    enabled: true,
    buysPaused: false,
    nextPricing: {
      feed: FEED,
      feedDecimals: 8n,
      maxPriceAge: 3_600n,
      referenceKind: 0,
      minAnswer: 0n,
      maxAnswer: 0n,
    },
    seedAmount: 10_000_000_000_000_000n,
    targetUsd: [100n, 1_000n, 10_000n, 1_000n, 10_000n, 100_000n, 100_000n],
    ...overrides,
  };
}

export function position(overrides: Partial<Position> = {}): Position {
  return {gross: 0n, refunded: false, shareNumerator: 0n, shareDenominator: 0n, ...overrides};
}

export function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    reason: QuoteReason.None,
    observation: {roundId: 42n, answer: PRICE, updatedAt: NOW - 60n},
    minGross: 1_666_666_666_666_667n,
    feeDelta: 0n,
    netDelta: 0n,
    shareNumeratorBefore: 0n,
    shareDenominatorBefore: 1_000_000_000_000_000_000n,
    shareNumeratorAfter: 0n,
    shareDenominatorAfter: 1_000_000_000_000_000_000n,
    usdValueBefore: 600n,
    usdValueAfter: 600n,
    reachesTarget: false,
    closesAt: CUTOFF,
    ...overrides,
  };
}

/**
 * A panel whose quote answers for `gross` from this round and this buyer, exactly as `readEntryPanel` stamps
 * it. The fee split is the contract's: `feeOf(grossTotal + gross) - feeReserved`.
 */
export function entryPanel(
  gross: bigint,
  overrides: {
    round?: Partial<RoundView>;
    pool?: Partial<PoolView>;
    balance?: bigint;
    user?: Address;
    position?: Partial<Position>;
    quote?: Partial<Quote>;
    feed?: Partial<FeedReading>;
    seed?: EntryPanel["seed"];
    buysPaused?: boolean;
    seedMaxPerRound?: bigint;
  } = {},
): EntryPanel {
  const view = round(overrides.round ?? {});
  const user = overrides.user ?? PLAYER;
  const positionValue = position(overrides.position ?? {});
  const feeAfter = ((view.grossTotal + gross) * 300n) / 10_000n;
  const feeDelta = feeAfter - view.feeReserved;
  const feed = feedReading(overrides.feed ?? {});
  // `quoteBuy` (and `previewEntry` with it) reports the whole-USD value of the pot after the purchase and
  // whether that reaches the target with at least two distinct addresses in the round. The fixture computes
  // both the same way, so a quote read from this panel agrees with a preview taken over the same round
  // instead of contradicting it (SPEC §5.3).
  const price = feed.observation?.answer ?? 0n;
  const usdValueBefore = (view.grossTotal * price) / 10n ** (view.tokenDecimals + view.pricing.feedDecimals);
  const usdValueAfter =
    ((view.grossTotal + gross) * price) / 10n ** (view.tokenDecimals + view.pricing.feedDecimals);
  const players = view.playerCount + (positionValue.gross === 0n && gross > 0n ? 1n : 0n);
  return {
    round: view,
    pool: pool(overrides.pool ?? {}),
    buysPaused: overrides.buysPaused ?? false,
    position: positionValue,
    balance: overrides.balance ?? 10_000_000_000_000_000_000n,
    seedMaxPerRound: overrides.seedMaxPerRound ?? 0n,
    quote: quote({
      feeDelta,
      netDelta: gross - feeDelta,
      shareNumeratorBefore: positionValue.gross,
      shareDenominatorBefore: view.grossTotal,
      shareNumeratorAfter: positionValue.gross + gross,
      shareDenominatorAfter: view.grossTotal + gross,
      usdValueBefore,
      usdValueAfter,
      reachesTarget: players >= 2n && usdValueAfter >= view.targetUsd,
      closesAt: view.closesAt,
      ...(overrides.quote ?? {}),
    }),
    quotedFor: {roundId: view.id, user, asset: view.asset, seeded: view.seeded},
    feed,
    seed:
      overrides.seed === undefined
        ? {
            account: SEED_ACCOUNT,
            amount: 10_000_000_000_000_000n,
            maxPerRound: 10_000_000_000_000_000n,
            availableBalance: 1_000_000_000_000_000_000n,
            grossByUser: 10_000_000_000_000_000n,
          }
        : overrides.seed,
  };
}

/** Two ranges: the operator seed first, then a player. Cumulative, as the contract stores them. */
export function ranges(): readonly Range[] {
  return [
    {buyer: SEED_ACCOUNT, cumulativeGross: 10_000_000_000_000_000n},
    {buyer: PLAYER, cumulativeGross: 1_000_000_000_000_000_000n},
  ];
}
