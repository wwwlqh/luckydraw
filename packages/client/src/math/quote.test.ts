/// Independent tests for the advisory entry preview (SPEC §5.1, §5.3, §8.1; §11.2 Client/indexer
/// "no client-only minimum bypass").
///
/// The precedence tests construct inputs that trip two or more checks at once and assert that the earlier one
/// wins, for every adjacent pair of the order `quoteBuy` implements. That is the property that keeps the
/// preview honest: if the client ever reported a later reason, it would be describing a purchase the contract
/// rejects for a different, earlier, cause.

import assert from "node:assert/strict";
import test from "node:test";
import {MAX_UINT256} from "./constants.ts";
import {feeOf} from "./fee.ts";
import {QUOTE_REASON, ROUND_STATE} from "./localTypes.ts";
import {MathError} from "./mathError.ts";
import type {ObservationInput} from "./price.ts";
import {minGrossRaw, targetGross} from "./price.ts";
import {
  type EntryPreviewInput,
  type PreviewBuyer,
  type PreviewRound,
  type PreviewSeed,
  previewEntry,
  seedStatus,
} from "./quote.ts";

const NOW = 1_790_000_000n;
const PRICE = 600n * 10n ** 8n;
const MINIMUM = minGrossRaw(18, 8, PRICE); // 1,666,666,666,666,667 wei at USD 600/BNB
const SEED_ACCOUNT = "0x00000000000000000000000000000000000000aa";

function round(overrides: Partial<PreviewRound> = {}): PreviewRound {
  return {
    id: 7n,
    state: ROUND_STATE.Open,
    opensAt: NOW - 1000n,
    closesAt: NOW + 1000n,
    tokenDecimals: 18,
    feedDecimals: 8,
    targetUsd: 1000n,
    grossTotal: 0n,
    feeReserved: 0n,
    playerCount: 0n,
    seeded: true,
    ...overrides,
  };
}

function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    available: true,
    decimals: 8,
    expectedDecimals: 8,
    roundId: 1n,
    answer: PRICE,
    updatedAt: NOW - 10n,
    now: NOW,
    maxPriceAge: 3600n,
    minAnswer: 0n,
    maxAnswer: 0n,
    ...overrides,
  };
}

function buyer(overrides: Partial<PreviewBuyer> = {}): PreviewBuyer {
  return {
    grossByUser: 0n,
    availableBalance: 10n ** 24n,
    seedMaxPerRound: 0n,
    ...overrides,
  };
}

function seed(overrides: Partial<PreviewSeed> = {}): PreviewSeed {
  return {
    account: SEED_ACCOUNT,
    amount: 10n ** 18n,
    maxPerRound: 10n ** 18n,
    availableBalance: 10n ** 20n,
    grossByUser: 0n,
    ...overrides,
  };
}

function input(overrides: Partial<EntryPreviewInput> = {}): EntryPreviewInput {
  return {
    now: NOW,
    round: round(),
    grossAmount: 10n ** 18n,
    observation: observation(),
    buyer: buyer(),
    buysPaused: false,
    poolBuysPaused: false,
    seed: undefined,
    ...overrides,
  };
}

test("an admissible purchase quotes the fee split, both shares and the USD projection", () => {
  const preview = previewEntry(
    input({
      round: round({grossTotal: 4n * 10n ** 18n, feeReserved: feeOf(4n * 10n ** 18n), playerCount: 2n}),
      grossAmount: 10n ** 18n,
      buyer: buyer({grossByUser: 2n * 10n ** 18n}),
    }),
  );

  assert.strictEqual(preview.reason, QUOTE_REASON.None);
  assert.strictEqual(preview.reasonName, "None");
  assert.strictEqual(preview.minGross, MINIMUM);
  assert.strictEqual(preview.feeDelta, feeOf(5n * 10n ** 18n) - feeOf(4n * 10n ** 18n));
  assert.strictEqual(preview.netDelta, 10n ** 18n - preview.feeDelta);
  assert.strictEqual(preview.shareNumeratorBefore, 2n * 10n ** 18n);
  assert.strictEqual(preview.shareDenominatorBefore, 4n * 10n ** 18n);
  assert.strictEqual(preview.shareNumeratorAfter, 3n * 10n ** 18n);
  assert.strictEqual(preview.shareDenominatorAfter, 5n * 10n ** 18n);
  assert.strictEqual(preview.usdValueBefore, 2400n, "4 BNB at USD 600");
  assert.strictEqual(preview.usdValueAfter, 3000n, "5 BNB at USD 600");
  assert.strictEqual(
    preview.reachesTarget,
    true,
    "USD 3,000 is past the USD 1,000 target with two addresses",
  );
  assert.strictEqual(preview.closesAt, NOW + 1000n);
});

test("reachesTarget needs two distinct addresses, and counts this buyer", () => {
  const gross = targetGross(18, 8, PRICE, 1000n);
  // One existing player, and the buyer is that same player: still one address after the purchase.
  const samePlayer = previewEntry(
    input({
      round: round({grossTotal: gross, feeReserved: feeOf(gross), playerCount: 1n}),
      grossAmount: MINIMUM,
      buyer: buyer({grossByUser: gross}),
    }),
  );
  assert.strictEqual(samePlayer.reason, QUOTE_REASON.None);
  assert.strictEqual(samePlayer.reachesTarget, false, "a lone player never closes the round");

  // A second, new address closes it.
  const newPlayer = previewEntry(
    input({
      round: round({grossTotal: gross, feeReserved: feeOf(gross), playerCount: 1n}),
      grossAmount: MINIMUM,
      buyer: buyer({grossByUser: 0n}),
    }),
  );
  assert.strictEqual(newPlayer.reachesTarget, true);

  // One raw unit below the target value does not close it.
  const justBelow = previewEntry(
    input({
      round: round({
        grossTotal: gross - 1n - MINIMUM,
        feeReserved: feeOf(gross - 1n - MINIMUM),
        playerCount: 1n,
      }),
      grossAmount: MINIMUM,
    }),
  );
  assert.strictEqual(justBelow.usdValueAfter, 999n);
  assert.strictEqual(justBelow.reachesTarget, false);
});

test("the pending operator seed is modelled the way buy enters it", () => {
  const unseeded = round({seeded: false, playerCount: 0n});
  const seedAmount = 10n ** 18n;
  const gross = 10n ** 18n;

  const withSeed = previewEntry(
    input({round: unseeded, grossAmount: gross, seed: seed({amount: seedAmount})}),
  );
  assert.strictEqual(withSeed.reason, QUOTE_REASON.None);
  assert.strictEqual(
    withSeed.shareDenominatorAfter,
    seedAmount + gross,
    "shareDenominatorAfter includes the pending seed",
  );
  assert.strictEqual(withSeed.usdValueBefore, 0n, "usdValueBefore is the stored pot, seed excluded");
  assert.strictEqual(withSeed.usdValueAfter, 1200n, "2 BNB at USD 600, seed included");
  assert.strictEqual(withSeed.feeDelta, feeOf(seedAmount + gross) - feeOf(seedAmount));
  assert.strictEqual(withSeed.reachesTarget, true, "the seed is the second address");

  const withoutSeed = previewEntry(input({round: unseeded, grossAmount: gross, seed: undefined}));
  assert.strictEqual(withoutSeed.shareDenominatorAfter, gross);
  assert.strictEqual(withoutSeed.reachesTarget, false, "one address on its own never closes");

  // A seed the account has not authorized is not entered, so it is not in the denominator either.
  const unauthorized = previewEntry(
    input({round: unseeded, grossAmount: gross, seed: seed({maxPerRound: seedAmount - 1n})}),
  );
  assert.strictEqual(unauthorized.shareDenominatorAfter, gross);

  // Nor is a seed the account cannot fund.
  const unfunded = previewEntry(
    input({round: unseeded, grossAmount: gross, seed: seed({availableBalance: seedAmount - 1n})}),
  );
  assert.strictEqual(unfunded.shareDenominatorAfter, gross);

  // An already-seeded round does not model a second seed.
  const alreadySeeded = previewEntry(input({round: round({seeded: true}), grossAmount: gross, seed: seed()}));
  assert.strictEqual(alreadySeeded.shareDenominatorAfter, gross);
});

test("seedStatus mirrors the contract's classification order", () => {
  const open = {state: ROUND_STATE.Open, closesAt: NOW + 1000n, seeded: false};
  assert.strictEqual(seedStatus(open, seed(), NOW), "ok");
  assert.strictEqual(seedStatus(open, undefined, NOW), "notConfigured");
  assert.strictEqual(seedStatus(open, seed({amount: 0n}), NOW), "notConfigured");
  assert.strictEqual(
    seedStatus(open, seed({account: "0x0000000000000000000000000000000000000000"}), NOW),
    "notConfigured",
  );
  assert.strictEqual(seedStatus(open, seed({maxPerRound: 0n}), NOW), "notAuthorized");
  // Not configured beats not authorized.
  assert.strictEqual(seedStatus(open, seed({amount: 0n, maxPerRound: 0n}), NOW), "notConfigured");
  // Not authorized beats already seeded.
  assert.strictEqual(seedStatus({...open, seeded: true}, seed({maxPerRound: 0n}), NOW), "notAuthorized");
  assert.strictEqual(seedStatus({...open, seeded: true}, seed(), NOW), "alreadySeeded");
  assert.strictEqual(seedStatus({...open, state: ROUND_STATE.Settled}, seed(), NOW), "notOpen");
  assert.strictEqual(seedStatus({...open, closesAt: NOW}, seed(), NOW), "notOpen", "the cutoff is exclusive");
  // Not open beats a short balance.
  assert.strictEqual(seedStatus({...open, closesAt: NOW}, seed({availableBalance: 0n}), NOW), "notOpen");
  assert.strictEqual(seedStatus(open, seed({availableBalance: 0n}), NOW), "insufficientSeedBalance");
});

test("every rejection zeroes the projections but keeps the panel's context", () => {
  const preview = previewEntry(
    input({
      round: round({grossTotal: 10n ** 18n, feeReserved: feeOf(10n ** 18n)}),
      grossAmount: MINIMUM - 1n,
      buyer: buyer({grossByUser: 3n}),
    }),
  );
  assert.strictEqual(preview.reason, QUOTE_REASON.BelowMinimum);
  assert.strictEqual(preview.reasonName, "BelowMinimum");
  // Context the entry panel needs to show the new minimum and preserve the input (SPEC 3.2).
  assert.strictEqual(preview.minGross, MINIMUM);
  assert.strictEqual(preview.closesAt, NOW + 1000n);
  assert.strictEqual(preview.shareNumeratorBefore, 3n);
  assert.strictEqual(preview.shareDenominatorBefore, 10n ** 18n);
  // Projections, all zero.
  assert.strictEqual(preview.feeDelta, 0n);
  assert.strictEqual(preview.netDelta, 0n);
  assert.strictEqual(preview.shareNumeratorAfter, 0n);
  assert.strictEqual(preview.shareDenominatorAfter, 0n);
  assert.strictEqual(preview.usdValueBefore, 0n);
  assert.strictEqual(preview.usdValueAfter, 0n);
  assert.strictEqual(preview.reachesTarget, false);
});

test("an unknown round returns a fully zeroed quote", () => {
  for (const missing of [undefined, round({id: 0n})]) {
    const preview = previewEntry(input({round: missing}));
    assert.strictEqual(preview.reason, QUOTE_REASON.InvalidRound);
    assert.strictEqual(preview.minGross, 0n);
    assert.strictEqual(preview.closesAt, 0n, "there is no cutoff to report");
    assert.strictEqual(preview.shareDenominatorBefore, 0n);
  }
});

test("the minimum is exact: one raw unit below is rejected, the minimum itself is accepted", () => {
  const below = previewEntry(input({grossAmount: MINIMUM - 1n}));
  const at = previewEntry(input({grossAmount: MINIMUM}));
  assert.strictEqual(below.reason, QUOTE_REASON.BelowMinimum);
  assert.strictEqual(at.reason, QUOTE_REASON.None);
  assert.strictEqual(at.minGross, MINIMUM);
});

test("each single condition reports its own reason", () => {
  const cases: [name: string, overrides: Partial<EntryPreviewInput>, expected: number][] = [
    ["closed state", {round: round({state: ROUND_STATE.AwaitingRequest})}, QUOTE_REASON.EntryWindowClosed],
    ["before opensAt", {round: round({opensAt: NOW + 1n})}, QUOTE_REASON.EntryWindowClosed],
    ["at the cutoff", {round: round({closesAt: NOW})}, QUOTE_REASON.EntryWindowClosed],
    ["zero amount", {grossAmount: 0n}, QUOTE_REASON.InvalidAmount],
    ["global pause", {buysPaused: true}, QUOTE_REASON.BuysPaused],
    ["pool pause", {poolBuysPaused: true}, QUOTE_REASON.BuysPaused],
    ["feed unavailable", {observation: observation({available: false})}, QUOTE_REASON.PriceUnavailable],
    ["decimals changed", {observation: observation({decimals: 18})}, QUOTE_REASON.PriceDecimalsChanged],
    ["invalid answer", {observation: observation({answer: 0n})}, QUOTE_REASON.PriceInvalid],
    ["stale answer", {observation: observation({updatedAt: NOW - 3601n})}, QUOTE_REASON.PriceStale],
    ["below the minimum", {grossAmount: MINIMUM - 1n}, QUOTE_REASON.BelowMinimum],
    ["a seed account", {buyer: buyer({seedMaxPerRound: 1n})}, QUOTE_REASON.SeedAccountCannotBuy],
    ["short balance", {buyer: buyer({availableBalance: 10n ** 18n - 1n})}, QUOTE_REASON.InsufficientBalance],
  ];
  for (const [name, overrides, expected] of cases) {
    assert.strictEqual(previewEntry(input(overrides)).reason, expected, name);
  }
});

test("precedence: the earlier check wins in every adjacent pair of the order", () => {
  const closedAndZero = previewEntry(input({round: round({closesAt: NOW}), grossAmount: 0n}));
  assert.strictEqual(
    closedAndZero.reason,
    QUOTE_REASON.EntryWindowClosed,
    "EntryWindowClosed before InvalidAmount",
  );

  const zeroAndPaused = previewEntry(input({grossAmount: 0n, buysPaused: true}));
  assert.strictEqual(zeroAndPaused.reason, QUOTE_REASON.InvalidAmount, "InvalidAmount before BuysPaused");

  const pausedAndUnavailable = previewEntry(
    input({buysPaused: true, observation: observation({available: false})}),
  );
  assert.strictEqual(
    pausedAndUnavailable.reason,
    QUOTE_REASON.BuysPaused,
    "BuysPaused before the price checks",
  );

  // A price failure hides the minimum check: with no usable answer there is no minimum to compare against.
  const staleAndBelow = previewEntry(
    input({observation: observation({updatedAt: NOW - 3601n}), grossAmount: 1n}),
  );
  assert.strictEqual(staleAndBelow.reason, QUOTE_REASON.PriceStale, "PriceStale before BelowMinimum");
  assert.strictEqual(staleAndBelow.minGross, 0n, "and no minimum is projected from an unusable answer");

  const belowAndSeed = previewEntry(input({grossAmount: 1n, buyer: buyer({seedMaxPerRound: 1n})}));
  assert.strictEqual(
    belowAndSeed.reason,
    QUOTE_REASON.BelowMinimum,
    "BelowMinimum before SeedAccountCannotBuy",
  );

  const seedAndBroke = previewEntry(input({buyer: buyer({seedMaxPerRound: 1n, availableBalance: 0n})}));
  assert.strictEqual(
    seedAndBroke.reason,
    QUOTE_REASON.SeedAccountCannotBuy,
    "SeedAccountCannotBuy before InsufficientBalance",
  );

  const brokeAndOverflow = previewEntry(
    input({
      round: round({grossTotal: MAX_UINT256 - 10n, feeReserved: feeOf(MAX_UINT256 - 10n)}),
      grossAmount: MAX_UINT256,
      buyer: buyer({availableBalance: 0n}),
    }),
  );
  assert.strictEqual(
    brokeAndOverflow.reason,
    QUOTE_REASON.InsufficientBalance,
    "InsufficientBalance before ArithmeticOverflow",
  );

  // And the first pair: an unknown round hides everything after it.
  const unknownAndClosed = previewEntry(input({round: undefined, grossAmount: 0n, buysPaused: true}));
  assert.strictEqual(
    unknownAndClosed.reason,
    QUOTE_REASON.InvalidRound,
    "InvalidRound before EntryWindowClosed",
  );
});

test("ArithmeticOverflow replaces a projection that cannot fit in uint256", () => {
  // grossTotal + gross exceeds uint256 (the amount is above the minimum, so the earlier checks all pass).
  const sum = previewEntry(
    input({
      round: round({grossTotal: MAX_UINT256 - MINIMUM, feeReserved: feeOf(MAX_UINT256 - MINIMUM)}),
      grossAmount: MINIMUM + 1n,
      buyer: buyer({availableBalance: MAX_UINT256}),
    }),
  );
  assert.strictEqual(sum.reason, QUOTE_REASON.ArithmeticOverflow);
  assert.strictEqual(sum.usdValueAfter, 0n);

  // The sum fits, but the USD projection of the post-buy pot does not: a 0-decimal token with a huge price.
  const projection = previewEntry(
    input({
      round: round({
        tokenDecimals: 0,
        feedDecimals: 0,
        grossTotal: MAX_UINT256 / 2n,
        feeReserved: feeOf(MAX_UINT256 / 2n),
      }),
      observation: observation({decimals: 0, expectedDecimals: 0, answer: 4n}),
      grossAmount: 10n,
      buyer: buyer({availableBalance: MAX_UINT256}),
    }),
  );
  assert.strictEqual(projection.reason, QUOTE_REASON.ArithmeticOverflow);

  // The pending seed is included in that check: the seed pushes the sum past uint256.
  const seedOverflow = previewEntry(
    input({
      round: round({
        seeded: false,
        grossTotal: MAX_UINT256 - 10n ** 18n,
        feeReserved: feeOf(MAX_UINT256 - 10n ** 18n),
      }),
      grossAmount: 10n ** 18n,
      buyer: buyer({availableBalance: MAX_UINT256}),
      seed: seed({amount: 10n ** 18n}),
    }),
  );
  assert.strictEqual(seedOverflow.reason, QUOTE_REASON.ArithmeticOverflow);
});

test("omitting a seed that would enter is not conservative, so the field is required", () => {
  // Regression for a review finding: with the seed left out, an unseeded round quoted the buyer as owning the
  // whole pot and reported reachesTarget false, while `quoteBuy` reads the seed from storage unconditionally.
  const unseeded = round({seeded: false, playerCount: 0n});
  const gross = 10n ** 18n;
  const modelled = previewEntry(input({round: unseeded, grossAmount: gross, seed: seed({amount: gross})}));
  const omitted = previewEntry(input({round: unseeded, grossAmount: gross, seed: undefined}));

  assert.strictEqual(modelled.shareDenominatorAfter, 2n * gross);
  assert.strictEqual(modelled.reachesTarget, true);
  assert.strictEqual(omitted.shareDenominatorAfter, gross, "omitting it really does change the share");
  assert.strictEqual(omitted.reachesTarget, false, "and really does hide the target close");
  // So `seed` carries no `?`: TypeScript forces every call site to state what the snapshot found.
  // @ts-expect-error seed is a required field of EntryPreviewInput
  const missingSeed: EntryPreviewInput = {
    now: NOW,
    round: unseeded,
    grossAmount: gross,
    observation: observation(),
    buyer: buyer(),
    buysPaused: false,
    poolBuysPaused: false,
  };
  void missingSeed;
});

test("a malformed snapshot throws where quoteBuy itself would revert", () => {
  // `feeReserved` above `feeOf(grossTotal)` makes the contract's `_feeSplit` subtraction panic.
  assert.throws(
    () =>
      previewEntry(
        input({round: round({grossTotal: 10n ** 18n, feeReserved: 10n ** 18n}), grossAmount: 10n ** 18n}),
      ),
    (error: unknown) => error instanceof MathError && error.code === "InvalidInput",
  );
  // And a `feeReserved` below it panics on `gross - feeDelta` instead; a negative netDelta must never be
  // returned with reason None (review regression).
  assert.throws(
    () =>
      previewEntry(
        input({
          round: round({grossTotal: 10n ** 18n, feeReserved: 0n}),
          grossAmount: 2n * 10n ** 15n,
        }),
      ),
    (error: unknown) => error instanceof MathError && error.code === "InvalidInput",
  );
  // Decimals outside 0-18 revert `InvalidConfig` inside `PriceReader._scale`.
  assert.throws(
    () =>
      previewEntry(
        input({
          round: round({tokenDecimals: 19}),
          observation: observation({decimals: 8, expectedDecimals: 8}),
        }),
      ),
    MathError,
  );
});

test("the preview never approves what the minimum rejects, across a sweep of amounts", () => {
  // "No client-only minimum bypass" (SPEC 11.2): approval implies gross >= the contract's minGrossRaw.
  for (const price of [1n, 3n, PRICE, 987_654_321n]) {
    const minimum = minGrossRaw(18, 8, price);
    for (const gross of [1n, minimum - 2n, minimum - 1n, minimum, minimum + 1n, minimum * 1000n]) {
      if (gross <= 0n) continue;
      const preview = previewEntry(
        input({
          grossAmount: gross,
          observation: observation({answer: price}),
          buyer: buyer({availableBalance: MAX_UINT256}),
        }),
      );
      if (preview.reason === QUOTE_REASON.None) {
        assert.ok(gross >= minimum, `approved ${gross} below the minimum ${minimum} at price ${price}`);
      } else {
        assert.ok(
          gross < minimum || preview.reason !== QUOTE_REASON.BelowMinimum,
          `rejected ${gross} at or above the minimum ${minimum} at price ${price}`,
        );
      }
    }
  }
});

test("the preview uses one clock: the observation's own `now` never outranks the snapshot timestamp", () => {
  // The feed answer is 10 seconds old at the snapshot but 2 hours old by the round's clock. A split clock
  // would classify it fresh; the contract evaluates both against one block.timestamp.
  const stale = previewEntry(
    input({
      now: NOW + 7200n,
      round: round({closesAt: NOW + 10_000n}),
      observation: observation({updatedAt: NOW - 10n, now: NOW}),
    }),
  );
  assert.strictEqual(stale.reason, QUOTE_REASON.PriceStale);
});

test("a clamped answer at a frozen bound is PriceInvalid; the bounds cannot be left out", () => {
  const clamped = previewEntry(input({observation: observation({minAnswer: PRICE, maxAnswer: 0n})}));
  assert.strictEqual(clamped.reason, QUOTE_REASON.PriceInvalid);
  const ceiling = previewEntry(input({observation: observation({minAnswer: 0n, maxAnswer: PRICE})}));
  assert.strictEqual(ceiling.reason, QUOTE_REASON.PriceInvalid);
  const inside = previewEntry(
    input({observation: observation({minAnswer: PRICE - 1n, maxAnswer: PRICE + 1n})}),
  );
  assert.strictEqual(inside.reason, QUOTE_REASON.None);
});
