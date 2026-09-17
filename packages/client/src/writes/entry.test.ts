import assert from "node:assert/strict";
import test from "node:test";
import {minNetContribution} from "../math/fee.ts";
import {type Address, asAddress, ZERO_ADDRESS} from "../types/common.ts";
import {type Quote, QuoteReason} from "../types/generated.ts";
import type {QuoteContext, QuotedBuy} from "../types/quoted.ts";
import {DEFAULT_DEADLINE_SECONDS, entryFromQuote} from "./entry.ts";

const CLOSES_AT = 1_790_035_200n;
const GROSS = 10_000_000_000_000_000n;
const BUYER: Address = asAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
const OTHER: Address = asAddress("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
const TOKEN: Address = asAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    reason: QuoteReason.None,
    observation: {roundId: 1n, answer: 60_000_000_000n, updatedAt: 1_790_000_100n},
    minGross: 1_666_666_666_666_667n,
    feeDelta: 300_000_000_000_000n,
    netDelta: 9_700_000_000_000_000n,
    shareNumeratorBefore: 0n,
    shareDenominatorBefore: 20_000_000_000_000_000n,
    shareNumeratorAfter: GROSS,
    shareDenominatorAfter: 30_000_000_000_000_000n,
    usdValueBefore: 12n,
    usdValueAfter: 18n,
    reachesTarget: false,
    closesAt: CLOSES_AT,
    ...overrides,
  };
}

/** The context the read adapters stamp: round 1 of the native pool, already seeded, quoted for BUYER. */
function context(overrides: Partial<QuoteContext> = {}): QuoteContext {
  return {roundId: 1n, user: BUYER, asset: ZERO_ADDRESS, seeded: true, ...overrides};
}

function quoted(
  quoteOverrides: Partial<Quote> = {},
  contextOverrides: Partial<QuoteContext> = {},
): QuotedBuy {
  return {quote: quote(quoteOverrides), quotedFor: context(contextOverrides)};
}

const request = {
  roundId: 1n,
  user: BUYER,
  asset: ZERO_ADDRESS,
  gross: GROSS,
  chainTimestamp: 1_790_000_100n,
};

test("entryFromQuote sets the guard to max(0, netDelta - 1) from src/math", () => {
  const outcome = entryFromQuote(quoted(), request);
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  assert.equal(outcome.params.minNetContribution, 9_699_999_999_999_999n);
  assert.equal(outcome.params.minNetContribution, minNetContribution(9_700_000_000_000_000n));
  assert.equal(outcome.params.roundId, 1n);
  assert.equal(outcome.params.gross, GROSS);

  const free = entryFromQuote(quoted({netDelta: 0n, feeDelta: GROSS}), request);
  assert.ok(free.ok);
  assert.equal(
    free.params.minNetContribution,
    0n,
    "a zero quote floors at zero rather than being unsatisfiable",
  );
});

test("the deadline is now + 300 seconds by default, from the chain timestamp", () => {
  const outcome = entryFromQuote(quoted(), request);
  assert.ok(outcome.ok);
  assert.equal(DEFAULT_DEADLINE_SECONDS, 300n);
  assert.equal(outcome.params.deadline, request.chainTimestamp + 300n);
  assert.ok(outcome.params.deadline < CLOSES_AT, "never at or after the cutoff");
});

test("the deadline is clamped to closesAt - 1 near the cutoff", () => {
  const late = {...request, chainTimestamp: CLOSES_AT - 10n};
  const outcome = entryFromQuote(quoted(), late);
  assert.ok(outcome.ok);
  assert.equal(outcome.params.deadline, CLOSES_AT - 1n, "min(now + 300, closesAt - 1)");

  const longer = entryFromQuote(quoted(), {...request, deadlineSeconds: 1200n});
  assert.ok(longer.ok);
  assert.equal(longer.params.deadline, request.chainTimestamp + 1200n, "the caller may ask for longer");
});

test("entryFromQuote refuses when no time remains", () => {
  for (const chainTimestamp of [CLOSES_AT - 1n, CLOSES_AT, CLOSES_AT + 60n]) {
    const outcome = entryFromQuote(quoted(), {...request, chainTimestamp});
    assert.equal(outcome.ok, false, `at ${chainTimestamp}`);
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "NoTimeRemaining");
    assert.equal(outcome.kind === "NoTimeRemaining" ? outcome.closesAt : 0n, CLOSES_AT);
  }
  const zero = entryFromQuote(quoted(), {...request, deadlineSeconds: 0n});
  assert.ok(!zero.ok);
  assert.equal(zero.kind, "NoTimeRemaining");
});

test("a zero chain timestamp is no chain time and is refused rather than turned into a deadline", () => {
  // A deadline of 0 + 300 would be `DeadlineExpired` in the first real block; the snapshot was not read.
  for (const chainTimestamp of [0n, -1n]) {
    const outcome = entryFromQuote(quoted(), {...request, chainTimestamp});
    assert.ok(!outcome.ok, `at ${chainTimestamp}`);
    assert.equal(outcome.kind, "NoTimeRemaining");
  }
});

test("entryFromQuote refuses a rejected quote and names the reason", () => {
  const reasons: readonly [QuoteReason, string][] = [
    [QuoteReason.BelowMinimum, "BelowMinimum"],
    [QuoteReason.InsufficientBalance, "InsufficientBalance"],
    [QuoteReason.SeedAccountCannotBuy, "SeedAccountCannotBuy"],
    [QuoteReason.EntryWindowClosed, "EntryWindowClosed"],
    [QuoteReason.PriceStale, "PriceStale"],
    [QuoteReason.ArithmeticOverflow, "ArithmeticOverflow"],
  ];
  for (const [reason, name] of reasons) {
    const outcome = entryFromQuote(quoted({reason}), request);
    assert.equal(outcome.ok, false, name);
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "QuoteRejected");
    if (outcome.kind === "QuoteRejected") {
      assert.equal(outcome.reason, reason);
      assert.equal(outcome.reasonName, name);
    }
  }
});

test("a quote is bound to the round, the buyer and the asset it was read for", () => {
  // The successor race of SPEC §9.5: the quote was read for round 1, the app now shows round 2. Same pool,
  // same asset, same cutoff, so the deadline and the guard would both pass on chain; only the binding stops
  // an irrevocable entry whose disclosures belong to round 1.
  const successor = entryFromQuote(quoted(), {...request, roundId: 2n});
  assert.ok(!successor.ok);
  assert.equal(successor.kind, "QuoteContextMismatch");
  if (successor.kind === "QuoteContextMismatch") {
    assert.equal(successor.field, "roundId");
    assert.equal(successor.quotedFor.roundId, 1n);
  }

  // A wallet account switch: the quote answered for BUYER's balance and share, another account will sign.
  const switched = entryFromQuote(quoted(), {...request, user: OTHER});
  assert.ok(!switched.ok);
  assert.equal(switched.kind, "QuoteContextMismatch");
  if (switched.kind === "QuoteContextMismatch") assert.equal(switched.field, "user");

  // The summary would name an asset the quoted round does not use.
  const wrongAsset = entryFromQuote(quoted(), {...request, asset: TOKEN});
  assert.ok(!wrongAsset.ok);
  assert.equal(wrongAsset.kind, "QuoteContextMismatch");
  if (wrongAsset.kind === "QuoteContextMismatch") assert.equal(wrongAsset.field, "asset");

  // Case never separates two spellings of one address, and the plan carries the quoted (lowercase) values.
  const checksummed = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address;
  const plan = entryFromQuote(quoted({}, {asset: TOKEN}), {...request, user: checksummed, asset: TOKEN});
  assert.ok(plan.ok);
  assert.equal(plan.params.asset, TOKEN);
  assert.equal(plan.params.roundId, 1n);
});

test("the fallback-seed disclosure comes from the quote, not from the caller", () => {
  const SEED = 50_000_000_000_000_000n;
  // quoteBuy on an unseeded round whose seed would enter: the pot delta is gross + seed.
  const modelled = quoted({shareDenominatorBefore: 0n, shareDenominatorAfter: GROSS + SEED}, {seeded: false});
  const withSeed = entryFromQuote(modelled, request);
  assert.ok(withSeed.ok);
  assert.equal(withSeed.disclosures.paysFallbackSeed, true, "the quote modelled a seed entering first");
  assert.equal(withSeed.disclosures.fallbackSeedGross, SEED);

  // quoteBuy on an unseeded round whose seed is unconfigured, unauthorized or unfunded: no seed enters,
  // whatever the round's `seeded` flag says, so the confirmation must not warn about one.
  const skipped = quoted({shareDenominatorBefore: 0n, shareDenominatorAfter: GROSS}, {seeded: false});
  const withoutSeed = entryFromQuote(skipped, request);
  assert.ok(withoutSeed.ok);
  assert.equal(withoutSeed.disclosures.paysFallbackSeed, false);
  assert.equal(withoutSeed.disclosures.fallbackSeedGross, 0n);

  // A seeded round never models a seed: such a quote belongs to another round or another block.
  const contradiction = entryFromQuote(
    quoted({shareDenominatorBefore: 0n, shareDenominatorAfter: GROSS + SEED}, {seeded: true}),
    request,
  );
  assert.ok(!contradiction.ok);
  assert.equal(contradiction.kind, "QuoteContextMismatch");
  if (contradiction.kind === "QuoteContextMismatch") assert.equal(contradiction.field, "seeded");
});

test("the disclosures carry the target warning of SPEC §5.3 and §9.5 and the quoted figures", () => {
  const plain = entryFromQuote(quoted(), request);
  assert.ok(plain.ok);
  assert.equal(plain.disclosures.reachesTarget, false);
  assert.equal(plain.disclosures.paysFallbackSeed, false, "an already seeded round pays no fallback seed");
  assert.equal(plain.disclosures.feeDelta, 300_000_000_000_000n);
  assert.equal(plain.disclosures.netDelta, 9_700_000_000_000_000n);
  assert.equal(plain.disclosures.minGross, 1_666_666_666_666_667n);
  assert.equal(plain.disclosures.shareDenominatorAfter, 30_000_000_000_000_000n);
  assert.equal(plain.disclosures.closesAt, CLOSES_AT);

  const closing = entryFromQuote(quoted({reachesTarget: true}), request);
  assert.ok(closing.ok);
  assert.equal(closing.disclosures.reachesTarget, true, "closes the round and opens its successor");
});

test("a quote taken for another amount is refused, so calldata and disclosures cannot diverge", () => {
  // The quote describes 0.01 BNB; asking for 10 BNB with it would ship a guard three orders of magnitude
  // below the real net and disclosures for the wrong purchase.
  const tenBnb = entryFromQuote(quoted(), {...request, gross: 10_000_000_000_000_000_000n});
  assert.ok(!tenBnb.ok);
  assert.equal(tenBnb.kind, "QuoteAmountMismatch");
  if (tenBnb.kind === "QuoteAmountMismatch") {
    assert.equal(tenBnb.quotedGross, GROSS);
    assert.equal(tenBnb.requestedGross, 10_000_000_000_000_000_000n);
  }
  // A quote whose share delta disagrees with its fee split is refused too.
  const skewed = entryFromQuote(quoted({shareNumeratorAfter: GROSS + 1n}), request);
  assert.ok(!skewed.ok);
  assert.equal(skewed.kind, "QuoteAmountMismatch");
  // A pot delta below the gross describes no purchase of this size at all.
  const shortPot = entryFromQuote(
    quoted({shareDenominatorAfter: 20_000_000_000_000_000n + GROSS - 1n}),
    request,
  );
  assert.ok(!shortPot.ok);
  assert.equal(shortPot.kind, "QuoteAmountMismatch");
  // The accepted plan carries the asset into the summary.
  const plan = entryFromQuote(quoted(), request);
  assert.ok(plan.ok);
  assert.equal(plan.params.asset, ZERO_ADDRESS);
});
