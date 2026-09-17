// The cycle's reads, grouped so Multicall3 is worth having (SPEC §10.1).
//
// The client's typed adapters each resolve a block and send their own `readBatch` of exactly one call, which
// is right for a UI panel and wrong for this loop: one `aggregate3` carrying one item is one `eth_call`, so a
// cycle built from adapters sends the same number of requests with Multicall3 as without it - and one extra
// header re-read per adapter on top, because a head-pinned `readBatch` proves the block did not move. The
// keeper's reads are not independent panels; they are one snapshot of one chain state, and they are known in
// advance in three stages:
//
//   1. the pool page and the seed account (nothing else can be named until the pools are known);
//   2. per pool, the seed cap and balance for its asset and `getCurrent` for all seven kinds;
//   3. `getRound` for every round the cycle tracks (which stage 2 is what determines).
//
// Each stage is one `readBatch`, so with Multicall3 a cycle is three `eth_call`s and three header re-reads
// instead of one of each per adapter. Without Multicall3 the same three batches are the same individual
// `eth_call`s the adapters would have sent, minus two thirds of the header re-reads: grouping is never worse.
//
// Everything here is encoding and decoding the client already owns - `luckyDrawAbi`, `luckyVaultAbi`,
// `readBatch`, and the `internalType`-driven normalizers - so the values are the same objects the adapters
// would have returned, bigints and lowercase addresses included. What is *not* duplicated is any judgement
// about what those values mean; that stays in `keeper.ts` and `decide.ts`.

import {Interface} from "ethers";
import {
  type AbiEntryLike,
  type AbiParamLike,
  type Address,
  asHex,
  type CallOutcome,
  decodeRevert,
  type Hex,
  indexFunctionOutputs,
  type Kind,
  luckyDrawAbi,
  luckyVaultAbi,
  normalizeAbiStruct,
  normalizeAbiValue,
  type PoolView,
  type ReadCall,
  ReadError,
  type ReadProvider,
  type RoundView,
  readBatch,
  type SnapshotBlock,
  type VerifiedDeployment,
} from "./client.ts";

/** One snapshot's worth of read context: the block is already resolved, so no stage can drift off it. */
export type BatchContext = {
  provider: ReadProvider;
  deployment: VerifiedDeployment;
  block: SnapshotBlock;
  /** Verified at start-up (`startup.ts` gate 6). Absent means one `eth_call` per item, as before. */
  multicall3?: Address | undefined;
};

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const drawOutputs = indexFunctionOutputs(luckyDrawAbi as readonly AbiEntryLike[]);
const vaultOutputs = indexFunctionOutputs(luckyVaultAbi as readonly AbiEntryLike[]);

type Binding = {
  target: "draw" | "vault";
  iface: Interface;
  outputs: Map<string, readonly AbiParamLike[]>;
};

const DRAW: Binding = {target: "draw", iface: drawInterface, outputs: drawOutputs};
const VAULT: Binding = {target: "vault", iface: vaultInterface, outputs: vaultOutputs};

function encode(binding: Binding, to: Address, method: string, args: readonly unknown[]): ReadCall {
  return {to, data: asHex(binding.iface.encodeFunctionData(method, args as unknown[]))};
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

/** The outcome at `index`, or the `BatchMismatch` that says the node answered a different batch. */
function outcomeAt(outcomes: readonly CallOutcome[], index: number): CallOutcome {
  const outcome = outcomes[index];
  if (outcome === undefined) {
    throw new ReadError("BatchMismatch", `the batch returned no result at position ${index}`);
  }
  return outcome;
}

/** A reverted item, decoded under its own contract's errors so the log names the condition, not a selector. */
function reverted(binding: Binding, method: string, revertData: Hex): ReadError {
  const revert = decodeRevert(revertData, {emitter: binding.target});
  const named = revert.kind === "custom" ? revert.name : revert.kind;
  return new ReadError("CallReverted", `${binding.target}.${method} reverted (${named})`, {
    target: binding.target,
    method,
    revertData,
    revert,
  });
}

/** A single-output function (a struct, an address, a uint256). Throws `ReadError` on a revert. */
function decodeOne(binding: Binding, method: string, outcome: CallOutcome): unknown {
  if (!outcome.ok) throw reverted(binding, method, outcome.revertData);
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

/** A multi-output function, as a named record. Throws `ReadError` on a revert. */
function decodeRecord(binding: Binding, method: string, outcome: CallOutcome): Record<string, unknown> {
  if (!outcome.ok) throw reverted(binding, method, outcome.revertData);
  try {
    return normalizeAbiStruct(
      outputsOf(binding, method),
      binding.iface.decodeFunctionResult(method, outcome.data),
    );
  } catch (error) {
    if (error instanceof ReadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReadError("DecodeFailed", `${binding.target}.${method} did not decode: ${message}`, {
      target: binding.target,
      method,
    });
  }
}

function run(ctx: BatchContext, calls: readonly ReadCall[]): Promise<readonly CallOutcome[]> {
  return readBatch(ctx.provider, ctx.block, calls, {multicall3: ctx.multicall3});
}

/** Stage 1: the enabled and disabled pools of the first page, and the Draw's seed account pointer. */
export async function readCycleHead(
  ctx: BatchContext,
  cursor: bigint,
  limit: bigint,
): Promise<{pools: readonly PoolView[]; seedAccount: Address}> {
  const draw = ctx.deployment.draw;
  const outcomes = await run(ctx, [
    encode(DRAW, draw, "getPools", [cursor, limit]),
    encode(DRAW, draw, "getSeedAccount", []),
  ]);
  const page = decodeRecord(DRAW, "getPools", outcomeAt(outcomes, 0)) as unknown as {
    page: readonly PoolView[];
  };
  const seedAccount = decodeOne(DRAW, "getSeedAccount", outcomeAt(outcomes, 1)) as Address;
  return {pools: page.page, seedAccount};
}

/** One pool's stage-2 facts. `seed` is null for a pool the caller did not ask a seed question about. */
export type PoolFacts = {
  seed: {cap: bigint; balance: bigint} | null;
  /** `getCurrent(poolId, kind)` in the order of the `kinds` argument. */
  current: readonly bigint[];
};

/**
 * Stage 2: every pool's seed capacity and current-round pointers, in one batch.
 *
 * The cap and the balance are read together, where the per-pool adapter path read the balance only when the
 * cap cleared. That is one more item in a batch that costs one request either way, and it removes a round
 * trip that depended on the answer to the previous one.
 */
export async function readPoolFacts(
  ctx: BatchContext,
  options: {
    pools: readonly PoolView[];
    kinds: readonly Kind[];
    seedAccount: Address;
    /** Whether this pool's seed cap and balance are worth asking about at all (SPEC §5.4). */
    wantsSeed: (pool: PoolView) => boolean;
  },
): Promise<Map<string, PoolFacts>> {
  const {pools, kinds, seedAccount} = options;
  const draw = ctx.deployment.draw;
  const vault = ctx.deployment.vault;
  const calls: ReadCall[] = [];
  const seeded: boolean[] = [];
  for (const pool of pools) {
    const wants = options.wantsSeed(pool);
    seeded.push(wants);
    if (wants) {
      calls.push(encode(VAULT, vault, "seedMaxPerRound", [seedAccount, pool.asset]));
      calls.push(encode(VAULT, vault, "balanceOf", [seedAccount, pool.asset]));
    }
    for (const kind of kinds) calls.push(encode(DRAW, draw, "getCurrent", [pool.id, kind]));
  }
  const outcomes = await run(ctx, calls);

  const facts = new Map<string, PoolFacts>();
  let at = 0;
  pools.forEach((pool, index) => {
    let seed: {cap: bigint; balance: bigint} | null = null;
    if (seeded[index] === true) {
      const cap = decodeOne(VAULT, "seedMaxPerRound", outcomeAt(outcomes, at)) as bigint;
      const balance = decodeOne(VAULT, "balanceOf", outcomeAt(outcomes, at + 1)) as bigint;
      seed = {cap, balance};
      at += 2;
    }
    const current = kinds.map((_kind, offset) => {
      return decodeOne(DRAW, "getCurrent", outcomeAt(outcomes, at + offset)) as bigint;
    });
    at += kinds.length;
    facts.set(pool.id.toString(), {seed, current});
  });
  return facts;
}

/**
 * Stage 3: `getRound` for every tracked round, in one batch.
 *
 * The outcomes are returned undecoded on purpose. The caller decodes each round immediately before it acts
 * on it, so a round that reverts costs that round its turn and no more - the same containment the per-round
 * adapter call had, which a decode-everything-first helper would quietly give up.
 */
export function readRounds(ctx: BatchContext, roundIds: readonly bigint[]): Promise<readonly CallOutcome[]> {
  const draw = ctx.deployment.draw;
  return run(
    ctx,
    roundIds.map((roundId) => encode(DRAW, draw, "getRound", [roundId])),
  );
}

/** One round of the stage-3 batch. Throws `ReadError` if that item reverted or did not decode. */
export function decodeRound(outcomes: readonly CallOutcome[], index: number): RoundView {
  return decodeOne(DRAW, "getRound", outcomeAt(outcomes, index)) as RoundView;
}
