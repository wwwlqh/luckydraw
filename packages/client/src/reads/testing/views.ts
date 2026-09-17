// View-struct fixtures for the read tests: the same values in their generated-type form and on the wire.
//
// Excluded from the published build by tsconfig.build.json ("src/**/testing/**"). The point of building them
// as `RoundView` / `Quote` / `PoolView` and then encoding with the generated ABI is that the round trip is a
// real assertion: if `src/abi/normalize.ts` mapped one field to the wrong shape, the decoded value would not
// deep-equal the fixture.

import {type Address, asAddress} from "../../types/common.ts";
import {
  CloseReason,
  Kind,
  type PoolView,
  type PricingConfig,
  type Quote,
  QuoteReason,
  type Range,
  ReferenceKind,
  RefundReason,
  type RoundView,
  State,
} from "../../types/generated.ts";

export const FEED: Address = asAddress("0xe7f1725e7734Ce288f8367e1Bb143E90bb3F0512");
export const FEE_ACCOUNT: Address = asAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
export const SEED_ACCOUNT: Address = asAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906");
export const BUYER: Address = asAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
export const NATIVE: Address = asAddress("0x0000000000000000000000000000000000000000");

export const PRICING: PricingConfig = {
  feed: FEED,
  feedDecimals: 8n,
  maxPriceAge: 3600n,
  referenceKind: ReferenceKind.ExactToken,
  minAnswer: 0n,
  maxAnswer: 0n,
};

/** A live daily round with the operator seed and one player already in it. */
export function roundFixture(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 1n,
    poolId: 1n,
    kind: Kind.Day100,
    sequence: 1n,
    asset: NATIVE,
    tokenDecimals: 18n,
    pricing: PRICING,
    feeAccount: FEE_ACCOUNT,
    opensAt: 1_790_000_000n,
    closesAt: 1_790_035_200n,
    targetUsd: 100n,
    state: State.Open,
    grossTotal: 20_000_000_000_000_000n,
    feeReserved: 600_000_000_000_000n,
    prizePot: 19_400_000_000_000_000n,
    playerCount: 2n,
    seeded: true,
    seedAccount: SEED_ACCOUNT,
    seedGross: 10_000_000_000_000_000n,
    closedAt: 0n,
    closeReason: CloseReason.Cutoff,
    requestDeadline: 0n,
    requestId: 0n,
    requestedAt: 0n,
    word0: 0n,
    word1: 0n,
    winningIndex: 0n,
    winner: NATIVE,
    settledAt: 0n,
    refundedGross: 0n,
    refundReason: RefundReason.InsufficientPlayers,
    rangeCount: 2n,
    ...overrides,
  };
}

export function poolFixture(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 1n,
    asset: NATIVE,
    enabled: true,
    buysPaused: false,
    nextPricing: PRICING,
    seedAmount: 10_000_000_000_000_000n,
    targetUsd: [100n, 1000n, 10_000n, 1000n, 10_000n, 100_000n, 100_000n],
    ...overrides,
  };
}

/** An accepted quote for a 0.01 BNB entry at USD 600 with the fee split of SPEC §5.2. */
export function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  return {
    reason: QuoteReason.None,
    observation: {roundId: 1n, answer: 60_000_000_000n, updatedAt: 1_790_000_100n},
    minGross: 1_666_666_666_666_667n,
    feeDelta: 300_000_000_000_000n,
    netDelta: 9_700_000_000_000_000n,
    shareNumeratorBefore: 0n,
    shareDenominatorBefore: 20_000_000_000_000_000n,
    shareNumeratorAfter: 10_000_000_000_000_000n,
    shareDenominatorAfter: 30_000_000_000_000_000n,
    usdValueBefore: 12n,
    usdValueAfter: 18n,
    reachesTarget: false,
    closesAt: 1_790_035_200n,
    ...overrides,
  };
}

export function rangesFixture(): readonly Range[] {
  return [
    {buyer: SEED_ACCOUNT, cumulativeGross: 10_000_000_000_000_000n},
    {buyer: BUYER, cumulativeGross: 20_000_000_000_000_000n},
  ];
}
