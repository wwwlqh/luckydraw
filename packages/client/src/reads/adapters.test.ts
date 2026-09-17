import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {Interface} from "ethers";
import {aggregatorV3Abi} from "../abi/generated/aggregatorV3.ts";
import {parseManifest} from "../deployments/manifest.ts";
import {classifyObservation} from "../math/price.ts";
import {type EntryPreviewInput, previewEntry} from "../math/quote.ts";
import {type Address, asAddress, asHex} from "../types/common.ts";
import {Kind, QuoteReason, State} from "../types/generated.ts";
import {
  type EntryPanel,
  quoteBuy,
  type ReadContext,
  readAllRanges,
  readBalance,
  readBalances,
  readCurrent,
  readEntryPanel,
  readFeed,
  readPool,
  readPools,
  readPosition,
  readRanges,
  readRound,
  readSeedAccount,
  readSeedMaxPerRound,
  toObservationInput,
} from "./adapters.ts";
import {blockTagOf} from "./provider.ts";
import {ReadError} from "./readError.ts";
import {drawInterface, fakeProvider, MULTICALL3, vaultInterface, verifiedFrom} from "./testing/fake.ts";
import {
  BUYER,
  FEED,
  NATIVE,
  poolFixture,
  quoteFixture,
  rangesFixture,
  roundFixture,
  SEED_ACCOUNT,
} from "./testing/views.ts";

const feedInterface = new Interface(aggregatorV3Abi);

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "config",
  "deployments",
  "31337",
  "0x610178da211fef7d417bc0e6fed39f05609ad788.json",
);

const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown);
const deployment = verifiedFrom(manifest);
const DRAW: Address = deployment.draw;
const VAULT: Address = deployment.vault;

/** The deployment's second asset (TEST2), used only as an asset this round is *not* denominated in. */
const TOKEN: Address = asAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");

const BLOCK = {number: 400, hash: `0x${"11".repeat(32)}`, timestamp: 1_790_000_100};
const INVALID_ID = drawInterface.encodeErrorResult("InvalidId", []);

type Fake = ReturnType<typeof fakeProvider>;

function draw(method: string, args: readonly unknown[]): string {
  return drawInterface.encodeFunctionData(method, args as unknown[]);
}

function vault(method: string, args: readonly unknown[]): string {
  return vaultInterface.encodeFunctionData(method, args as unknown[]);
}

/** A provider that answers every call the adapters make for round 1 of the native pool. */
function scenario(
  overrides: {
    seedAccount?: Address;
    feedBroken?: "decimals" | "data" | "both";
    /** The buyer's `authorizeSeed` cap in the native asset, which is the round's asset. */
    buyerNativeCap?: bigint;
    /** The buyer's cap in the *other* asset of the deployment. */
    buyerTokenCap?: bigint;
  } = {},
): Fake {
  // `byNumber` answers the post-read head re-check of a `latest`-pinned snapshot (reads/snapshot.ts).
  const provider = fakeProvider({
    blocks: {finalized: BLOCK, latest: BLOCK},
    byNumber: {[blockTagOf(400n)]: BLOCK},
  });
  const round = roundFixture();
  const pool = poolFixture();
  const quote = quoteFixture();
  const seedAccount = overrides.seedAccount ?? SEED_ACCOUNT;

  provider.answer(DRAW, draw("getRound", [1n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getRound", [round]),
  });
  provider.answer(DRAW, draw("getRound", [0n]), {ok: false, revertData: INVALID_ID});
  provider.answer(DRAW, draw("getPool", [1n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPool", [pool]),
  });
  provider.answer(DRAW, draw("getPools", [0n, 100n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPools", [[pool], 1n]),
  });
  provider.answer(DRAW, draw("getPools", [1n, 100n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPools", [[], 1n]),
  });
  provider.answer(DRAW, draw("getRanges", [1n, 0n, 100n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getRanges", [rangesFixture(), 2n]),
  });
  provider.answer(DRAW, draw("getPosition", [1n, BUYER]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [0n, false, 0n, round.grossTotal]),
  });
  provider.answer(DRAW, draw("getPosition", [1n, seedAccount]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [
      round.seedGross,
      false,
      round.seedGross,
      round.grossTotal,
    ]),
  });
  provider.answer(DRAW, draw("getCurrent", [1n, Kind.Day100]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getCurrent", [1n]),
  });
  provider.answer(DRAW, draw("getRequest", [77n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getRequest", [1n]),
  });
  provider.answer(DRAW, draw("getSeedAccount", []), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getSeedAccount", [seedAccount]),
  });
  provider.answer(DRAW, draw("buysPaused", []), {
    ok: true,
    data: drawInterface.encodeFunctionResult("buysPaused", [false]),
  });
  provider.answer(DRAW, draw("quoteBuy", [1n, BUYER, 10_000_000_000_000_000n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("quoteBuy", [quote]),
  });
  provider.answer(VAULT, vault("balanceOf", [BUYER, NATIVE]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("balanceOf", [1_000_000_000_000_000_000n]),
  });
  provider.answer(VAULT, vault("balanceOf", [seedAccount, NATIVE]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("balanceOf", [50_000_000_000_000_000n]),
  });
  // Seed consent is per asset (SPEC §5.4). The buyer has no cap in the round's asset; `overrides.buyerCapIn`
  // gives it one in *another* asset, which must not make it a seed Safe here.
  provider.answer(VAULT, vault("seedMaxPerRound", [BUYER, NATIVE]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("seedMaxPerRound", [overrides.buyerNativeCap ?? 0n]),
  });
  provider.answer(VAULT, vault("seedMaxPerRound", [BUYER, TOKEN]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("seedMaxPerRound", [overrides.buyerTokenCap ?? 0n]),
  });
  provider.answer(VAULT, vault("seedMaxPerRound", [seedAccount, NATIVE]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("seedMaxPerRound", [10_000_000_000_000_000n]),
  });
  provider.answer(VAULT, vault("seedMaxPerRound", [seedAccount, TOKEN]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("seedMaxPerRound", [500n]),
  });
  provider.answer(VAULT, vault("getAsset", [NATIVE]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("getAsset", [[true, 18n, true]]),
  });
  provider.answer(VAULT, vault("getEscrow", [1n]), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("getEscrow", [
      [NATIVE, round.grossTotal, round.closesAt, true, false, false],
    ]),
  });

  const decimalsBroken = overrides.feedBroken === "decimals" || overrides.feedBroken === "both";
  const dataBroken = overrides.feedBroken === "data" || overrides.feedBroken === "both";
  provider.answer(
    FEED,
    feedInterface.encodeFunctionData("decimals", []),
    decimalsBroken
      ? {ok: false, revertData: "0x"}
      : {ok: true, data: feedInterface.encodeFunctionResult("decimals", [8])},
  );
  provider.answer(
    FEED,
    feedInterface.encodeFunctionData("latestRoundData", []),
    dataBroken
      ? {ok: false, revertData: "0x"}
      : {
          ok: true,
          data: feedInterface.encodeFunctionResult("latestRoundData", [
            1n,
            60_000_000_000n,
            1_790_000_000n,
            1_790_000_050n,
            1n,
          ]),
        },
  );
  return provider;
}

function contextFor(provider: Fake, multicall3?: Address): ReadContext {
  return {provider, deployment, multicall3};
}

/** The panel in the shape `previewEntry` reads, so a read test can ask what the entry panel would say. */
function previewInputFor(panel: EntryPanel, now: bigint, gross: bigint): EntryPreviewInput {
  const round = panel.round;
  return {
    now,
    round: {
      id: round.id,
      state: round.state,
      opensAt: round.opensAt,
      closesAt: round.closesAt,
      tokenDecimals: Number(round.tokenDecimals),
      feedDecimals: Number(round.pricing.feedDecimals),
      targetUsd: round.targetUsd,
      grossTotal: round.grossTotal,
      feeReserved: round.feeReserved,
      playerCount: round.playerCount,
      seeded: round.seeded,
    },
    grossAmount: gross,
    observation: toObservationInput(round, panel.feed, now),
    buyer: {
      grossByUser: panel.position.gross,
      availableBalance: panel.balance,
      seedMaxPerRound: panel.seedMaxPerRound,
    },
    buysPaused: panel.buysPaused,
    poolBuysPaused: panel.pool.buysPaused,
    seed: panel.seed === null ? undefined : {...panel.seed},
  };
}

test("readRound round-trips a RoundView through the generated ABI and normalize", async () => {
  const provider = scenario();
  const snapshot = await readRound(contextFor(provider), 1n);
  assert.deepStrictEqual(snapshot.value, roundFixture(), "every field decodes back to the fixture");
  assert.equal(typeof snapshot.value.grossTotal, "bigint");
  assert.equal(typeof snapshot.value.tokenDecimals, "bigint", "uint8 is still a bigint");
  assert.equal(snapshot.value.state, State.Open);
  assert.equal(typeof snapshot.value.state, "number", "a Solidity enum is a numeric literal union");
  assert.equal(snapshot.value.asset, snapshot.value.asset.toLowerCase(), "addresses are lowercase");
  assert.equal(snapshot.value.pricing.feed, FEED.toLowerCase());
  assert.equal(snapshot.chainId, 31337n);
  assert.equal(snapshot.blockNumber, 400n);
});

test("quoteBuy round-trips a Quote, enum reason included, stamped with what it was read for", async () => {
  const provider = scenario();
  const snapshot = await quoteBuy(contextFor(provider), 1n, BUYER, 10_000_000_000_000_000n);
  assert.deepStrictEqual(snapshot.value.quote, quoteFixture());
  assert.equal(snapshot.value.quote.reason, QuoteReason.None);
  assert.equal(typeof snapshot.value.quote.netDelta, "bigint");
  assert.equal(typeof snapshot.value.quote.observation.answer, "bigint");
  assert.equal(snapshot.value.quote.reachesTarget, false);
  // The context comes from the round read in the same batch, at the same block (types/quoted.ts).
  const round = roundFixture();
  assert.deepStrictEqual(snapshot.value.quotedFor, {
    roundId: round.id,
    user: BUYER,
    asset: round.asset,
    seeded: round.seeded,
  });
  assert.equal(provider.calls.length, 2, "getRound and quoteBuy, one block");
  assert.equal(provider.calls[0]?.blockTag, provider.calls[1]?.blockTag);

  // A checksummed buyer is stamped lowercase, so the binding in writes/entry.ts compares one spelling.
  const checksummed = await quoteBuy(
    contextFor(scenario()),
    1n,
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address,
    10_000_000_000_000_000n,
  );
  assert.equal(checksummed.value.quotedFor.user, BUYER);
});

test("readPool, readPools, readRanges, readPosition and the Vault getters decode", async () => {
  const ctx = contextFor(scenario());
  assert.deepStrictEqual((await readPool(ctx, 1n)).value, poolFixture());
  assert.deepStrictEqual((await readPools(ctx, 0n, 100n)).value, {page: [poolFixture()], nextCursor: 1n});
  assert.deepStrictEqual((await readPools(ctx, 1n, 100n)).value, {page: [], nextCursor: 1n});
  assert.deepStrictEqual((await readRanges(ctx, 1n, 0n, 100n)).value, {
    page: rangesFixture(),
    nextCursor: 2n,
  });
  assert.deepStrictEqual((await readPosition(ctx, 1n, BUYER)).value, {
    gross: 0n,
    refunded: false,
    shareNumerator: 0n,
    shareDenominator: 20_000_000_000_000_000n,
  });
  assert.equal((await readCurrent(ctx, 1n, Kind.Day100)).value, 1n);
  assert.equal((await readSeedAccount(ctx)).value, SEED_ACCOUNT.toLowerCase());
  assert.equal((await readBalance(ctx, BUYER, NATIVE)).value, 1_000_000_000_000_000_000n);
  assert.deepStrictEqual((await readBalances(ctx, BUYER, [NATIVE])).value, [1_000_000_000_000_000_000n]);
  assert.equal((await readSeedMaxPerRound(ctx, BUYER, NATIVE)).value, 0n);
  assert.equal((await readSeedMaxPerRound(ctx, SEED_ACCOUNT, NATIVE)).value, 10_000_000_000_000_000n);
  // The same account, the other asset: a different consent entirely (SPEC §5.4).
  assert.equal((await readSeedMaxPerRound(ctx, SEED_ACCOUNT, TOKEN)).value, 500n);
});

test("readAllRanges pages to the round's rangeCount and honours its cap", async () => {
  const ctx = contextFor(scenario());
  assert.deepStrictEqual((await readAllRanges(ctx, 1n)).value, rangesFixture());
  await assert.rejects(
    () => readAllRanges(ctx, 1n, {maxRanges: 1n}),
    (error: unknown) => error instanceof ReadError && error.code === "RangeLimitExceeded",
  );
});

test("paging inputs are validated before any call is made", async () => {
  const provider = scenario();
  const ctx = contextFor(provider);
  for (const limit of [0n, 101n, -1n]) {
    await assert.rejects(
      () => readPools(ctx, 0n, limit),
      (error: unknown) => error instanceof ReadError && error.code === "InvalidLimit",
      `limit ${limit}`,
    );
    await assert.rejects(
      () => readRanges(ctx, 1n, 0n, limit),
      (error: unknown) => error instanceof ReadError && error.code === "InvalidLimit",
    );
  }
  await assert.rejects(
    () => readPools(ctx, -1n, 100n),
    (error: unknown) => error instanceof ReadError && error.code === "InvalidCursor",
  );
  assert.equal(provider.calls.length, 0, "validation happens before the RPC, not after it");
});

test("a reverting view surfaces as ReadError with the decoded custom error", async () => {
  const ctx = contextFor(scenario());
  await assert.rejects(
    () => readRound(ctx, 0n),
    (error: unknown) => {
      assert.ok(error instanceof ReadError);
      assert.equal(error.code, "CallReverted");
      assert.equal(error.target, "draw");
      assert.equal(error.method, "getRound");
      assert.equal(error.revert?.kind, "custom");
      assert.equal(error.revert?.kind === "custom" ? error.revert.name : "", "InvalidId");
      return true;
    },
  );
});

test("readFeed maps a reverting decimals() and a reverting latestRoundData() independently", async () => {
  const healthy = await readFeed(contextFor(scenario()), FEED);
  assert.deepStrictEqual(healthy.value, {
    available: true,
    decimals: 8n,
    observation: {roundId: 1n, answer: 60_000_000_000n, updatedAt: 1_790_000_050n},
  });

  const noDecimals = await readFeed(contextFor(scenario({feedBroken: "decimals"})), FEED);
  assert.equal(noDecimals.value.decimals, null, "a reverting decimals() is null, not a guess");
  assert.equal(noDecimals.value.available, true, "latestRoundData still answered");

  const noData = await readFeed(contextFor(scenario({feedBroken: "data"})), FEED);
  assert.equal(noData.value.available, false);
  assert.equal(noData.value.observation, null);
  assert.equal(noData.value.decimals, 8n, "decimals() answered even though the feed is unusable");

  const zero = await readFeed(contextFor(scenario()), NATIVE);
  assert.deepStrictEqual(zero.value, {available: false, decimals: null, observation: null});
});

test("toObservationInput reproduces PriceReader.read's precedence", async () => {
  const round = roundFixture();
  const ctx = contextFor(scenario());

  const healthy = toObservationInput(round, (await readFeed(ctx, FEED)).value, 1_790_000_100n);
  assert.equal(classifyObservation(healthy), "ok");

  // A feed whose decimals() reverted is PriceUnavailable, whatever the observation says.
  const noDecimals = toObservationInput(
    round,
    (await readFeed(contextFor(scenario({feedBroken: "decimals"})), FEED)).value,
    1_790_000_100n,
  );
  assert.equal(noDecimals.decimals, undefined);
  assert.equal(classifyObservation(noDecimals), "PriceUnavailable");

  // A feed whose decimals() changed but whose latestRoundData() reverted is PriceUnavailable, not
  // PriceDecimalsChanged: PriceReader.read returns before it compares decimals.
  const changedAndBroken = toObservationInput(
    {...round, pricing: {...round.pricing, feedDecimals: 18n}},
    (await readFeed(contextFor(scenario({feedBroken: "data"})), FEED)).value,
    1_790_000_100n,
  );
  assert.equal(classifyObservation(changedAndBroken), "PriceUnavailable");

  // Only a live, readable feed with a different decimals() is PriceDecimalsChanged.
  const changed = toObservationInput(
    {...round, pricing: {...round.pricing, feedDecimals: 18n}},
    (await readFeed(ctx, FEED)).value,
    1_790_000_100n,
  );
  assert.equal(classifyObservation(changed), "PriceDecimalsChanged");
});

test("readEntryPanel reads everything at one block, and the same values with or without Multicall3", async () => {
  const direct = scenario();
  const plain = await readEntryPanel(contextFor(direct), 1n, BUYER, 10_000_000_000_000_000n);

  const tag = blockTagOf(400n);
  assert.ok(direct.calls.length > 1, "the panel is more than one call");
  for (const recorded of direct.calls) {
    assert.equal(recorded.blockTag, tag, "every call of the panel carries the same block");
  }

  const batched = scenario();
  const viaMulticall = await readEntryPanel(
    contextFor(batched, MULTICALL3),
    1n,
    BUYER,
    10_000_000_000_000_000n,
  );
  assert.deepStrictEqual(viaMulticall, plain, "Multicall3 changes the transport, never the values");
  assert.equal(batched.calls.length, 2, "two aggregate3 calls: the round is needed before its asset");
  for (const recorded of batched.calls) {
    assert.equal(recorded.to, MULTICALL3);
    assert.equal(recorded.blockTag, tag);
  }

  assert.deepStrictEqual(plain.value.round, roundFixture());
  assert.deepStrictEqual(plain.value.pool, poolFixture());
  assert.equal(plain.value.buysPaused, false);
  assert.equal(plain.value.balance, 1_000_000_000_000_000_000n);
  assert.equal(plain.value.seedMaxPerRound, 0n, "the buyer is not a seed Safe");
  assert.deepStrictEqual(plain.value.quote, quoteFixture());
  assert.deepStrictEqual(plain.value.quotedFor, {
    roundId: 1n,
    user: BUYER,
    asset: roundFixture().asset,
    seeded: roundFixture().seeded,
  });
  assert.deepStrictEqual(plain.value.seed, {
    account: SEED_ACCOUNT.toLowerCase(),
    amount: 10_000_000_000_000_000n,
    maxPerRound: 10_000_000_000_000_000n,
    availableBalance: 50_000_000_000_000_000n,
    grossByUser: 10_000_000_000_000_000n,
  });
});

test("readEntryPanel reads the seed cap for the round's asset, so a cap in another asset does not block", async () => {
  const gross = 10_000_000_000_000_000n;

  // The buyer authorized a seed cap in the deployment's token, and nothing in BNB. Round 1 is the native
  // pool's, so the buyer is an ordinary player here (SPEC §5.4: consent, and the SeedAccountCannotBuy rule
  // with it, is per asset).
  const other = scenario({buyerTokenCap: 500n});
  const panel = await readEntryPanel(contextFor(other), 1n, BUYER, gross);
  assert.equal(panel.value.seedMaxPerRound, 0n, "a cap in another asset is not this round's cap");
  assert.equal(
    previewEntry(previewInputFor(panel.value, panel.timestamp, gross)).reason,
    QuoteReason.None,
    "the entry panel does not report SeedAccountCannotBuy for an asset-B cap",
  );
  // The asset is really in the calldata, not implied: without Multicall3 each recorded call is the call
  // itself, so the panel's two seed-cap questions can be read off directly.
  const asked = other.calls.map((recorded) => recorded.data.toLowerCase());
  assert.ok(
    asked.includes(vault("seedMaxPerRound", [BUYER, NATIVE]).toLowerCase()),
    "the panel asked for the buyer's cap in the round's asset",
  );
  assert.ok(
    asked.includes(vault("seedMaxPerRound", [SEED_ACCOUNT, NATIVE]).toLowerCase()),
    "and for the seed account's cap in the round's asset",
  );
  assert.ok(
    !asked.includes(vault("seedMaxPerRound", [BUYER, TOKEN]).toLowerCase()),
    "and never for a cap in an asset this round is not in",
  );

  // The same account with a cap in *this* round's asset is the seed Safe and is rejected, as before.
  const here = scenario({buyerNativeCap: 500n});
  const blocked = await readEntryPanel(contextFor(here), 1n, BUYER, gross);
  assert.equal(blocked.value.seedMaxPerRound, 500n, "a cap in the round's asset is reported");
  assert.equal(
    previewEntry(previewInputFor(blocked.value, blocked.timestamp, gross)).reason,
    QuoteReason.SeedAccountCannotBuy,
    "a cap in the round's asset still rejects the entry",
  );
});

test("readEntryPanel reports no seed when the Draw points at none", async () => {
  const provider = scenario({seedAccount: NATIVE});
  const panel = await readEntryPanel(contextFor(provider), 1n, BUYER, 10_000_000_000_000_000n);
  assert.equal(panel.value.seed, null);
});

test("readFeed fails the read for feed words the contract's ABI decoder would reject", async () => {
  // PriceReader.read decodes `decimals()` and `latestRoundData()` outside its try/catch, so a word above the
  // declared width reverts quoteBuy and buy outright; ethers would mask it and the preview would say "ok".
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
  const dirtyDecimals = scenario();
  dirtyDecimals.answer(FEED, feedInterface.encodeFunctionData("decimals", []), {ok: true, data: word(264n)});
  await assert.rejects(
    readFeed(contextFor(dirtyDecimals), FEED),
    (error: unknown) =>
      error instanceof ReadError && error.code === "DecodeFailed" && error.target === "feed",
    "decimals() above uint8",
  );

  const dirtyRoundId = scenario();
  const words = [(1n << 80n) + 5n, 60_000_000_000n, 1_790_000_000n, 1_790_000_050n, 5n];
  dirtyRoundId.answer(FEED, feedInterface.encodeFunctionData("latestRoundData", []), {
    ok: true,
    data: `0x${words.map((value) => value.toString(16).padStart(64, "0")).join("")}`,
  });
  await assert.rejects(
    readFeed(contextFor(dirtyRoundId), FEED),
    (error: unknown) => error instanceof ReadError && error.code === "DecodeFailed",
    "roundId above uint80",
  );

  const short = scenario();
  short.answer(FEED, feedInterface.encodeFunctionData("latestRoundData", []), {ok: true, data: word(1n)});
  await assert.rejects(
    readFeed(contextFor(short), FEED),
    (error: unknown) => error instanceof ReadError && error.code === "DecodeFailed",
    "fewer than five words",
  );

  // Empty return data is what an address without code answers: PriceUnavailable, not a failed read.
  const noCode = scenario();
  noCode.answer(FEED, feedInterface.encodeFunctionData("decimals", []), {ok: true, data: "0x"});
  noCode.answer(FEED, feedInterface.encodeFunctionData("latestRoundData", []), {ok: true, data: "0x"});
  assert.deepStrictEqual((await readFeed(contextFor(noCode), FEED)).value, {
    available: false,
    decimals: null,
    observation: null,
  });
});

test("asHex keeps the batch return data lowercase", async () => {
  // Guards the assumption every comparison in these tests makes about the decoded data.
  assert.equal(asHex("0xAB"), "0xab");
});
