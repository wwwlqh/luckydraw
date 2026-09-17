// Typed reads over a verified deployment (SPEC §8.1 views, §10.1 snapshots, §15 pre-sign validation).
//
// Every adapter takes a `VerifiedDeployment`, so nothing here can read a manifest whose chain id or code
// hashes were never checked against the connected node; that is the same gate the writes use, and it is what
// "validate manifest chain/address agreement before any UI signs" buys when reads and writes share a type.
//
// Every adapter returns `Snapshot<T>`: one block, its hash, its timestamp and the confidence tag that chose
// it. Composite adapters resolve the block once and pass it down, so a panel built from four calls is one
// consistent state even when it needs two round trips to learn which asset to ask about.
//
// Decoding is `Interface.decodeFunctionResult` over the generated ABI followed by `src/abi/normalize.ts`:
// every integer becomes a bigint, every Solidity enum a numeric literal union member, every address a
// lowercase string. Nothing in this file converts a chain integer with `Number()` except at the two documented
// boundaries into `src/math`, whose `ObservationInput` takes decimal counts as `number`.

import {Interface} from "ethers";
import {aggregatorV3Abi} from "../abi/generated/aggregatorV3.ts";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {
  type AbiEntryLike,
  type AbiParamLike,
  indexFunctionOutputs,
  normalizeAbiStruct,
  normalizeAbiValue,
} from "../abi/normalize.ts";
import type {VerifiedDeployment} from "../deployments/verify.ts";
import {decodeRevert} from "../errors/decode.ts";
import type {ObservationInput} from "../math/price.ts";
import {type Address, asAddress, asHex, type Hex, MAX_UINT256, ZERO_ADDRESS} from "../types/common.ts";
import type {
  AssetRecord,
  Escrow,
  Kind,
  Observation,
  PoolView,
  Quote,
  Range,
  RoundView,
} from "../types/generated.ts";
import type {QuoteContext, QuotedBuy} from "../types/quoted.ts";
import type {Snapshot} from "../types/snapshot.ts";
import type {ReadProvider} from "./provider.ts";
import {ReadError, type ReadTarget} from "./readError.ts";
import {
  type CallOutcome,
  type ReadCall,
  readBatch,
  resolveSnapshotBlock,
  type SnapshotBlock,
  type SnapshotPolicy,
  snapshotOf,
} from "./snapshot.ts";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ReadContext = {
  provider: ReadProvider;
  /** Only `verifyDeployment` produces this (SPEC §15). */
  deployment: VerifiedDeployment;
  /**
   * Multicall3 for this chain when the operator verified one. The deployment manifest has no field for it
   * yet (`config/chains/<id>.json` carries `networkIdentity.multicall3`), so the consumer passes it.
   */
  multicall3?: Address | undefined;
  /** Fixed depth behind `latest` for the last-resort confidence tag; defaults to 200 (SPEC §10.1). */
  depth?: bigint | undefined;
  /** Pins the snapshot to one tag instead of walking `finalized` -> `safe` -> depth. */
  tag?: SnapshotPolicy["tag"];
  /** An already resolved block, so several adapters share one snapshot. */
  block?: SnapshotBlock | undefined;
};

/** Page size ceiling of SPEC §8.1 ("Limit 1-100"). */
export const MAX_PAGE_LIMIT = 100n;

/** `readAllRanges` pages at the contract maximum. */
export const RANGE_PAGE_LIMIT = 100n;

/** Default ceiling for `readAllRanges`; above it the caller must opt in, because the read is unbounded work. */
export const DEFAULT_MAX_RANGES = 100_000n;

// ---------------------------------------------------------------------------
// Interfaces and output parameter indexes
// ---------------------------------------------------------------------------

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const feedInterface = new Interface(aggregatorV3Abi);

// Function name to its ABI output parameters (`src/abi/normalize.ts`), so `normalizeAbiValue` is driven by
// the same `internalType` information the event decoder uses. None of the four ABIs overloads a name.
const drawOutputs = indexFunctionOutputs(luckyDrawAbi as readonly AbiEntryLike[]);
const vaultOutputs = indexFunctionOutputs(luckyVaultAbi as readonly AbiEntryLike[]);
const feedOutputs = indexFunctionOutputs(aggregatorV3Abi as readonly AbiEntryLike[]);

type Binding = {
  target: ReadTarget;
  iface: Interface;
  outputs: Map<string, readonly AbiParamLike[]>;
};

const DRAW: Binding = {target: "draw", iface: drawInterface, outputs: drawOutputs};
const VAULT: Binding = {target: "vault", iface: vaultInterface, outputs: vaultOutputs};
const FEED: Binding = {target: "feed", iface: feedInterface, outputs: feedOutputs};

function call(binding: Binding, to: Address, method: string, args: readonly unknown[]): ReadCall {
  return {to, data: asHex(binding.iface.encodeFunctionData(method, args as unknown[]))};
}

function revertError(binding: Binding, method: string, revertData: Hex): ReadError {
  const emitter = binding.target === "vault" || binding.target === "draw" ? binding.target : undefined;
  const revert = decodeRevert(revertData, emitter === undefined ? undefined : {emitter});
  const named = revert.kind === "custom" ? revert.name : revert.kind;
  return new ReadError("CallReverted", `${binding.target}.${method} reverted (${named})`, {
    target: binding.target,
    method,
    revertData,
    revert,
  });
}

function outputsOf(binding: Binding, method: string): readonly AbiParamLike[] {
  const params = binding.outputs.get(method);
  if (params === undefined) {
    throw new ReadError("DecodeFailed", `${binding.target} has no function ${method}`, {
      target: binding.target,
      method,
    });
  }
  return params;
}

/** Decodes a multi-output function into a named record. Throws `ReadError` on a revert. */
function decodeRecord(binding: Binding, method: string, outcome: CallOutcome): Record<string, unknown> {
  if (!outcome.ok) throw revertError(binding, method, outcome.revertData);
  const params = outputsOf(binding, method);
  try {
    return normalizeAbiStruct(params, binding.iface.decodeFunctionResult(method, outcome.data));
  } catch (error) {
    if (error instanceof ReadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadError("DecodeFailed", `${binding.target}.${method} did not decode: ${message}`, {
      target: binding.target,
      method,
    });
  }
}

/** Decodes a single-output function (a struct, an address, a uint256). Throws `ReadError` on a revert. */
function decodeOne(binding: Binding, method: string, outcome: CallOutcome): unknown {
  if (!outcome.ok) throw revertError(binding, method, outcome.revertData);
  const params = outputsOf(binding, method);
  const param = params[0];
  if (params.length !== 1 || param === undefined) {
    throw new ReadError("DecodeFailed", `${binding.target}.${method} does not have one output`, {
      target: binding.target,
      method,
    });
  }
  try {
    return normalizeAbiValue(param, binding.iface.decodeFunctionResult(method, outcome.data)[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadError("DecodeFailed", `${binding.target}.${method} did not decode: ${message}`, {
      target: binding.target,
      method,
    });
  }
}

function outcomeAt(outcomes: readonly CallOutcome[], index: number): CallOutcome {
  const outcome = outcomes[index];
  if (outcome === undefined) {
    throw new ReadError("BatchMismatch", `the batch returned no result at position ${index}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Batch plumbing
// ---------------------------------------------------------------------------

async function blockOf(ctx: ReadContext): Promise<SnapshotBlock> {
  if (ctx.block !== undefined) return ctx.block;
  return resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag});
}

/**
 * The block for a view that acts on state rather than displaying it: the head unless the caller pins a
 * block or a tag. SPEC §9.6 says buy, withdraw and claim act on the latest on-chain state and §10.1 scopes
 * the `finalized` policy to display confirmation and cache keys, so a quote and the deadline derived from
 * it must not come from a block already behind the head.
 */
async function actionBlockOf(ctx: ReadContext): Promise<SnapshotBlock> {
  if (ctx.block !== undefined) return ctx.block;
  return resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag ?? "latest"});
}

async function run(
  ctx: ReadContext,
  block: SnapshotBlock,
  calls: readonly ReadCall[],
): Promise<readonly CallOutcome[]> {
  return readBatch(ctx.provider, block, calls, {multicall3: ctx.multicall3});
}

/** The same context pinned to one block, so a composite read cannot drift across two of them. */
function pinned(ctx: ReadContext, block: SnapshotBlock): ReadContext {
  return {...ctx, block};
}

function requirePage(cursor: bigint, limit: bigint): void {
  if (limit < 1n || limit > MAX_PAGE_LIMIT) {
    throw new ReadError("InvalidLimit", `limit must be 1-${MAX_PAGE_LIMIT}, received ${limit}`);
  }
  if (cursor < 0n || cursor > MAX_UINT256) {
    throw new ReadError("InvalidCursor", `cursor must be a uint256, received ${cursor}`);
  }
}

function requireId(value: bigint, label: string): void {
  if (value < 0n || value > MAX_UINT256) {
    throw new ReadError("InvalidCursor", `${label} must be a uint256, received ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Result shapes the generated types do not already name
// ---------------------------------------------------------------------------

/** `getPosition` (SPEC §8.1: gross, refunded flag, share numerator and denominator). */
export type Position = {
  gross: bigint;
  refunded: boolean;
  shareNumerator: bigint;
  shareDenominator: bigint;
};

export type PoolPage = {page: readonly PoolView[]; nextCursor: bigint};
export type RangePage = {page: readonly Range[]; nextCursor: bigint};

/**
 * One feed reading, shaped so it maps onto `PriceReader.read` exactly (SPEC §3.2).
 *
 * `available` is false when the feed address has no code or `latestRoundData()` reverted; `decimals` is null
 * when `decimals()` reverted. `PriceReader` reports `PriceUnavailable` for all three of those *before* it
 * compares decimals, so a feed whose `decimals()` answered a changed value but whose `latestRoundData()`
 * reverted is `PriceUnavailable`, not `PriceDecimalsChanged`. The two sub-calls fail independently inside a
 * Multicall3 batch, which is why they are two fields rather than one union.
 */
export type FeedReading = {
  available: boolean;
  decimals: bigint | null;
  observation: Observation | null;
};

const UNAVAILABLE_FEED: FeedReading = {available: false, decimals: null, observation: null};

/** Everything the entry panel needs about one round, one buyer and one amount, from one block (SPEC §9.5). */
export type EntryPanel = {
  round: RoundView;
  pool: PoolView;
  /** The Draw's global `buysPaused`; the pool's own flag is `pool.buysPaused`. */
  buysPaused: boolean;
  position: Position;
  /** The buyer's available Vault balance in the round's asset. */
  balance: bigint;
  /**
   * `Vault.seedMaxPerRound(user, round.asset)`; nonzero means this account is a seed Safe *in this round's
   * asset* and cannot buy here (SPEC §5.4). The rule is per asset: the same account with no cap in another
   * asset is an ordinary player in that asset's pools.
   */
  seedMaxPerRound: bigint;
  /** The authoritative on-chain quote. */
  quote: Quote;
  /** What `quote` was read for, from the same block; `writes/entry.ts` binds the calldata to it. */
  quotedFor: QuoteContext;
  feed: FeedReading;
  /** The operator seed, or null when the Draw points at no seed account. */
  seed: EntryPanelSeed | null;
};

/** The seed configuration and consent behind the SPEC §9.5 disclosure, and behind `previewEntry`'s model. */
export type EntryPanelSeed = {
  account: Address;
  /** The pool's per-round `seedAmount` in raw units; zero disables seeding. */
  amount: bigint;
  /**
   * The cap the account authorized itself with `Vault.authorizeSeed` for this round's asset (SPEC §5.4:
   * pointing is not consent, and consent is per asset).
   */
  maxPerRound: bigint;
  availableBalance: bigint;
  /** The seed account's gross in this round, which decides whether it adds a distinct address. */
  grossByUser: bigint;
};

// ---------------------------------------------------------------------------
// Single-value adapters
// ---------------------------------------------------------------------------

/** `getPool(poolId)`. Reverts `InvalidId` for an unknown pool, which surfaces as `ReadError("CallReverted")`. */
export async function readPool(ctx: ReadContext, poolId: bigint): Promise<Snapshot<PoolView>> {
  requireId(poolId, "poolId");
  const block = await blockOf(ctx);
  const draw = ctx.deployment.draw;
  const outcomes = await run(ctx, block, [call(DRAW, draw, "getPool", [poolId])]);
  return snapshotOf(ctx.deployment, block, decodeOne(DRAW, "getPool", outcomeAt(outcomes, 0)) as PoolView);
}

/** `getRound(roundId)`: frozen terms plus evolving state and `rangeCount` (SPEC §8.1). */
export async function readRound(ctx: ReadContext, roundId: bigint): Promise<Snapshot<RoundView>> {
  requireId(roundId, "roundId");
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getRound", [roundId])]);
  return snapshotOf(ctx.deployment, block, decodeOne(DRAW, "getRound", outcomeAt(outcomes, 0)) as RoundView);
}

/** `getPosition(roundId, user)`. */
export async function readPosition(
  ctx: ReadContext,
  roundId: bigint,
  user: Address,
): Promise<Snapshot<Position>> {
  requireId(roundId, "roundId");
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getPosition", [roundId, user])]);
  const record = decodeRecord(DRAW, "getPosition", outcomeAt(outcomes, 0));
  return snapshotOf(ctx.deployment, block, record as unknown as Position);
}

/** `getCurrent(poolId, kind)`: the pool's open round of that kind, or zero. */
export async function readCurrent(ctx: ReadContext, poolId: bigint, kind: Kind): Promise<Snapshot<bigint>> {
  requireId(poolId, "poolId");
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getCurrent", [poolId, kind])]);
  return snapshotOf(ctx.deployment, block, decodeOne(DRAW, "getCurrent", outcomeAt(outcomes, 0)) as bigint);
}

/** `getRequest(requestId)`: the round an accepted coordinator request belongs to, or zero. */
export async function readRequest(ctx: ReadContext, requestId: bigint): Promise<Snapshot<bigint>> {
  requireId(requestId, "requestId");
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getRequest", [requestId])]);
  return snapshotOf(ctx.deployment, block, decodeOne(DRAW, "getRequest", outcomeAt(outcomes, 0)) as bigint);
}

/** `getSeedAccount()`: the seed pointer, or the zero address when unset (SPEC §5.4). */
export async function readSeedAccount(ctx: ReadContext): Promise<Snapshot<Address>> {
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getSeedAccount", [])]);
  const account = decodeOne(DRAW, "getSeedAccount", outcomeAt(outcomes, 0)) as Address;
  return snapshotOf(ctx.deployment, block, account);
}

/** The Draw's global new-entry stop. */
export async function readBuysPaused(ctx: ReadContext): Promise<Snapshot<boolean>> {
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "buysPaused", [])]);
  return snapshotOf(ctx.deployment, block, decodeOne(DRAW, "buysPaused", outcomeAt(outcomes, 0)) as boolean);
}

/** The context a quote answers for (`types/quoted.ts`), from the round read in the same batch. */
function quoteContextOf(user: Address, round: RoundView): QuoteContext {
  return {roundId: round.id, user, asset: round.asset, seeded: round.seeded};
}

/**
 * `quoteBuy(roundId, user, gross)` together with the context it answers for (`types/quoted.ts`): the round
 * is read in the same batch, so the quote is stamped with its id, asset and `seeded` flag from the same
 * block and `writes/entry.ts` can refuse a request for anything else. The contract's `quoteBuy` never
 * reverts for inadmissible input (SPEC §8.1); a round id that does not exist reverts `getRound` instead and
 * surfaces here as `ReadError("CallReverted")`, exactly as it does in `readRound`.
 */
export async function quoteBuy(
  ctx: ReadContext,
  roundId: bigint,
  user: Address,
  gross: bigint,
): Promise<Snapshot<QuotedBuy>> {
  requireId(roundId, "roundId");
  requireId(gross, "gross");
  const buyer = asAddress(user);
  const block = await actionBlockOf(ctx);
  const draw = ctx.deployment.draw;
  const outcomes = await run(ctx, block, [
    call(DRAW, draw, "getRound", [roundId]),
    call(DRAW, draw, "quoteBuy", [roundId, buyer, gross]),
  ]);
  const round = decodeOne(DRAW, "getRound", outcomeAt(outcomes, 0)) as RoundView;
  const quote = decodeOne(DRAW, "quoteBuy", outcomeAt(outcomes, 1)) as Quote;
  return snapshotOf(ctx.deployment, block, {quote, quotedFor: quoteContextOf(buyer, round)});
}

/** `Vault.balanceOf(user, asset)`: available balance, escrow excluded. */
export async function readBalance(
  ctx: ReadContext,
  user: Address,
  asset: Address,
): Promise<Snapshot<bigint>> {
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(VAULT, ctx.deployment.vault, "balanceOf", [user, asset])]);
  return snapshotOf(ctx.deployment, block, decodeOne(VAULT, "balanceOf", outcomeAt(outcomes, 0)) as bigint);
}

/** One user's available balance in several assets, from one block. */
export async function readBalances(
  ctx: ReadContext,
  user: Address,
  assets: readonly Address[],
): Promise<Snapshot<readonly bigint[]>> {
  const block = await blockOf(ctx);
  const calls = assets.map((asset) => call(VAULT, ctx.deployment.vault, "balanceOf", [user, asset]));
  const outcomes = await run(ctx, block, calls);
  const balances = assets.map(
    (_asset, index) => decodeOne(VAULT, "balanceOf", outcomeAt(outcomes, index)) as bigint,
  );
  return snapshotOf(ctx.deployment, block, balances);
}

/** `Vault.getAsset(asset)`: listed flag, token decimals and the deposit switch. */
export async function readAssetRecord(ctx: ReadContext, asset: Address): Promise<Snapshot<AssetRecord>> {
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(VAULT, ctx.deployment.vault, "getAsset", [asset])]);
  const record = decodeOne(VAULT, "getAsset", outcomeAt(outcomes, 0)) as AssetRecord;
  return snapshotOf(ctx.deployment, block, record);
}

/** `Vault.getEscrow(roundId)`: the per-round escrow record behind the conservation invariants (SPEC §4.3). */
export async function readEscrow(ctx: ReadContext, roundId: bigint): Promise<Snapshot<Escrow>> {
  requireId(roundId, "roundId");
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(VAULT, ctx.deployment.vault, "getEscrow", [roundId])]);
  return snapshotOf(ctx.deployment, block, decodeOne(VAULT, "getEscrow", outcomeAt(outcomes, 0)) as Escrow);
}

/**
 * `Vault.seedMaxPerRound(account, asset)`: the cap that account authorized for itself in one asset; zero
 * means none (SPEC §5.4).
 *
 * Consent is per asset, so the asset is part of the question, not a detail of it: an account with a cap in
 * BNB is an ordinary player in every token pool, and reading one asset's cap says nothing about another's.
 */
export async function readSeedMaxPerRound(
  ctx: ReadContext,
  account: Address,
  asset: Address,
): Promise<Snapshot<bigint>> {
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [
    call(VAULT, ctx.deployment.vault, "seedMaxPerRound", [account, asset]),
  ]);
  const cap = decodeOne(VAULT, "seedMaxPerRound", outcomeAt(outcomes, 0)) as bigint;
  return snapshotOf(ctx.deployment, block, cap);
}

// ---------------------------------------------------------------------------
// Paged adapters
// ---------------------------------------------------------------------------

/** `getPools(cursor, limit)`. Limit 1-100; a cursor at or past the end returns an empty page (SPEC §8.1). */
export async function readPools(
  ctx: ReadContext,
  cursor: bigint,
  limit: bigint,
): Promise<Snapshot<PoolPage>> {
  requirePage(cursor, limit);
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [call(DRAW, ctx.deployment.draw, "getPools", [cursor, limit])]);
  const record = decodeRecord(DRAW, "getPools", outcomeAt(outcomes, 0));
  return snapshotOf(ctx.deployment, block, record as unknown as PoolPage);
}

/** `getRanges(roundId, cursor, limit)`. Same paging rules as `getPools`. */
export async function readRanges(
  ctx: ReadContext,
  roundId: bigint,
  cursor: bigint,
  limit: bigint,
): Promise<Snapshot<RangePage>> {
  requireId(roundId, "roundId");
  requirePage(cursor, limit);
  const block = await blockOf(ctx);
  const outcomes = await run(ctx, block, [
    call(DRAW, ctx.deployment.draw, "getRanges", [roundId, cursor, limit]),
  ]);
  const record = decodeRecord(DRAW, "getRanges", outcomeAt(outcomes, 0));
  return snapshotOf(ctx.deployment, block, record as unknown as RangePage);
}

export type AllRangesOptions = {
  /** Refuse rather than page a round bigger than this. Defaults to 100,000 (the §11.2 scale suite size). */
  maxRanges?: bigint | undefined;
};

/**
 * Every range of a round, paged 100 at a time at one block, for the winner verification of SPEC §10.1.
 *
 * The round is read first so the caller's cap is checked against `rangeCount` *before* any paging happens: a
 * round above the cap costs one call, not a thousand. Paging stops when `nextCursor` reaches `rangeCount`.
 */
export async function readAllRanges(
  ctx: ReadContext,
  roundId: bigint,
  options?: AllRangesOptions,
): Promise<Snapshot<readonly Range[]>> {
  requireId(roundId, "roundId");
  const maxRanges = options?.maxRanges ?? DEFAULT_MAX_RANGES;
  if (maxRanges < 0n)
    throw new ReadError("RangeLimitExceeded", `maxRanges must not be negative: ${maxRanges}`);

  const block = await blockOf(ctx);
  const inner = pinned(ctx, block);
  const total = (await readRound(inner, roundId)).value.rangeCount;
  if (total > maxRanges) {
    throw new ReadError(
      "RangeLimitExceeded",
      `round ${roundId} has ${total} ranges, above the ${maxRanges} this read was allowed to page`,
    );
  }

  const ranges: Range[] = [];
  let cursor = 0n;
  while (cursor < total) {
    const page = (await readRanges(inner, roundId, cursor, RANGE_PAGE_LIMIT)).value;
    if (page.page.length === 0 || page.nextCursor <= cursor) {
      throw new ReadError(
        "BatchMismatch",
        `getRanges(${roundId}, ${cursor}) made no progress; the round reports ${total} ranges`,
        {target: "draw", method: "getRanges"},
      );
    }
    ranges.push(...page.page);
    cursor = page.nextCursor;
  }
  return snapshotOf(ctx.deployment, block, ranges);
}

// ---------------------------------------------------------------------------
// Price feed
// ---------------------------------------------------------------------------

const UINT80_MAX = (1n << 80n) - 1n;

/** The `index`-th 32-byte word of return data, or null when the data is too short to hold it. */
function wordAt(data: Hex, index: number): bigint | null {
  const start = 2 + index * 64;
  if (data.length < start + 64) return null;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

function malformedFeed(method: string, detail: string): ReadError {
  return new ReadError(
    "DecodeFailed",
    `feed.${method} returned ${detail}; PriceReader.read reverts on it, so quoteBuy and buy revert too`,
    {target: "feed", method},
  );
}

/**
 * A feed reading from the two raw outcomes, with the contract's decoding rules rather than ethers' own.
 *
 * Empty return data is the no-code case: the contract answers `PriceUnavailable` for a feed address without
 * code, and an `eth_call` to such an address returns `0x` (SPEC §3.2). Non-empty data must be what
 * Solidity's ABI decoder accepts, because `PriceReader.read` decodes it in the caller's frame, outside the
 * `try`: a `decimals()` word above uint8 or a `roundId` above uint80 makes `read`, and with it `quoteBuy`
 * and `buy`, revert outright with empty data. ethers masks such a word down to its declared width instead,
 * which would let a preview say "ok" for a round no purchase can enter, so those words fail the read here.
 * (A contract with code that returns empty data also reverts on chain; without a code check the client
 * reports it as unavailable, which is the conservative reading.)
 */
function feedReadingOf(decimalsOutcome: CallOutcome, dataOutcome: CallOutcome): FeedReading {
  let decimals: bigint | null = null;
  if (decimalsOutcome.ok && decimalsOutcome.data !== "0x") {
    const value = wordAt(decimalsOutcome.data, 0);
    if (value === null) throw malformedFeed("decimals", "fewer than 32 bytes");
    if (value > 255n) throw malformedFeed("decimals", `a word above uint8 (${value})`);
    decimals = value;
  }

  if (!dataOutcome.ok || dataOutcome.data === "0x") return {available: false, decimals, observation: null};
  const roundId = wordAt(dataOutcome.data, 0);
  const answeredInRound = wordAt(dataOutcome.data, 4);
  if (roundId === null || answeredInRound === null) {
    throw malformedFeed("latestRoundData", "fewer than five words");
  }
  if (roundId > UINT80_MAX || answeredInRound > UINT80_MAX) {
    throw malformedFeed("latestRoundData", "a round id above uint80");
  }
  const record = decodeRecord(FEED, "latestRoundData", dataOutcome);
  const observation: Observation = {
    roundId: record.roundId as bigint,
    answer: record.answer as bigint,
    updatedAt: record.updatedAt as bigint,
  };
  return {available: true, decimals, observation};
}

/**
 * `decimals()` and `latestRoundData()` from one AggregatorV3 feed, at the snapshot block.
 *
 * A feed that reverts or has no code is `{available: false}`, which is the `PriceUnavailable` the contract
 * reports, not an error the app should show as a failed read (SPEC §3.2). A feed whose return data the
 * contract's decoder would reject throws `ReadError("DecodeFailed")` instead, because every quote and every
 * purchase on that round reverts until the feed or the pricing is fixed (see `feedReadingOf`).
 */
export async function readFeed(ctx: ReadContext, feed: Address): Promise<Snapshot<FeedReading>> {
  const block = await blockOf(ctx);
  if (feed === ZERO_ADDRESS) return snapshotOf(ctx.deployment, block, UNAVAILABLE_FEED);
  const outcomes = await run(ctx, block, [
    call(FEED, feed, "decimals", []),
    call(FEED, feed, "latestRoundData", []),
  ]);
  const reading = feedReadingOf(outcomeAt(outcomes, 0), outcomeAt(outcomes, 1));
  return snapshotOf(ctx.deployment, block, reading);
}

/**
 * The `src/math` observation input for a round, from a feed reading and the snapshot timestamp.
 *
 * This is the one boundary where a chain integer becomes a JS `number`: `ObservationInput` takes decimal
 * counts that way because `PriceReader._scale` bounds them at 0-18. The values themselves stay bigint.
 */
export function toObservationInput(round: RoundView, feed: FeedReading, now: bigint): ObservationInput {
  return {
    available: feed.available,
    decimals: feed.decimals === null ? undefined : Number(feed.decimals),
    expectedDecimals: Number(round.pricing.feedDecimals),
    roundId: feed.observation?.roundId ?? 0n,
    answer: feed.observation?.answer ?? 0n,
    updatedAt: feed.observation?.updatedAt ?? 0n,
    now,
    maxPriceAge: round.pricing.maxPriceAge,
    minAnswer: round.pricing.minAnswer,
    maxAnswer: round.pricing.maxAnswer,
  };
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/**
 * Everything the entry panel of SPEC §9.5 shows before a purchase, from one block.
 *
 * Two round trips, one block: the round and the seed pointer have to be read before the panel knows which
 * asset the balance is in, which pool holds the buys flag, which feed prices it and whose consent to read.
 * Every call is pinned to the block chosen once at the start, so the panel is still one consistent state.
 * With Multicall3 configured that is two `eth_call`s in total.
 *
 * The `feed`, `pool`, `buysPaused` and `seed` fields are what `previewEntry` in `src/math` needs to reproduce
 * `quote` locally; SPEC §9.5 also needs `seed` for the "the operator seed of {amount} is in this round"
 * disclosure, and §5.3 needs `quote.reachesTarget` for the higher-network-fee warning.
 */
export async function readEntryPanel(
  ctx: ReadContext,
  roundId: bigint,
  buyer: Address,
  gross: bigint,
): Promise<Snapshot<EntryPanel>> {
  requireId(roundId, "roundId");
  requireId(gross, "gross");
  const user = asAddress(buyer);
  const block = await actionBlockOf(ctx);
  const inner = pinned(ctx, block);
  const draw = ctx.deployment.draw;
  const vault = ctx.deployment.vault;

  const first = await run(inner, block, [
    call(DRAW, draw, "getRound", [roundId]),
    call(DRAW, draw, "getSeedAccount", []),
    call(DRAW, draw, "buysPaused", []),
  ]);
  const round = decodeOne(DRAW, "getRound", outcomeAt(first, 0)) as RoundView;
  const seedAccount = decodeOne(DRAW, "getSeedAccount", outcomeAt(first, 1)) as Address;
  const buysPaused = decodeOne(DRAW, "buysPaused", outcomeAt(first, 2)) as boolean;

  const asset = round.asset;
  const feed = round.pricing.feed;
  const hasSeed = seedAccount !== ZERO_ADDRESS;
  const calls: ReadCall[] = [
    call(DRAW, draw, "getPool", [round.poolId]),
    call(DRAW, draw, "getPosition", [roundId, user]),
    call(VAULT, vault, "balanceOf", [user, asset]),
    // Per asset (SPEC §5.4): the cap that decides `SeedAccountCannotBuy` is the one for this round's asset,
    // which is why it is read here, after the round, rather than as a property of the account alone.
    call(VAULT, vault, "seedMaxPerRound", [user, asset]),
    call(DRAW, draw, "quoteBuy", [roundId, user, gross]),
    call(FEED, feed, "decimals", []),
    call(FEED, feed, "latestRoundData", []),
  ];
  if (hasSeed) {
    calls.push(
      call(VAULT, vault, "balanceOf", [seedAccount, asset]),
      call(VAULT, vault, "seedMaxPerRound", [seedAccount, asset]),
      call(DRAW, draw, "getPosition", [roundId, seedAccount]),
    );
  }
  const second = await run(inner, block, calls);

  const pool = decodeOne(DRAW, "getPool", outcomeAt(second, 0)) as PoolView;
  const position = decodeRecord(DRAW, "getPosition", outcomeAt(second, 1)) as unknown as Position;
  const balance = decodeOne(VAULT, "balanceOf", outcomeAt(second, 2)) as bigint;
  const seedMaxPerRound = decodeOne(VAULT, "seedMaxPerRound", outcomeAt(second, 3)) as bigint;
  const quote = decodeOne(DRAW, "quoteBuy", outcomeAt(second, 4)) as Quote;
  const reading = feedReadingOf(outcomeAt(second, 5), outcomeAt(second, 6));

  let seed: EntryPanelSeed | null = null;
  if (hasSeed) {
    const seedBalance = decodeOne(VAULT, "balanceOf", outcomeAt(second, 7)) as bigint;
    const seedCap = decodeOne(VAULT, "seedMaxPerRound", outcomeAt(second, 8)) as bigint;
    const seedPosition = decodeRecord(DRAW, "getPosition", outcomeAt(second, 9)) as unknown as Position;
    seed = {
      account: seedAccount,
      amount: pool.seedAmount,
      maxPerRound: seedCap,
      availableBalance: seedBalance,
      grossByUser: seedPosition.gross,
    };
  }

  const panel: EntryPanel = {
    round,
    pool,
    buysPaused,
    position,
    balance,
    seedMaxPerRound,
    quote,
    quotedFor: quoteContextOf(user, round),
    feed: reading,
    seed,
  };
  return snapshotOf(ctx.deployment, block, panel);
}
