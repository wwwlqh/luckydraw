// One whole cycle against a fake node: what the loop reads, in what order it acts, and what it stops
// tracking. The fake is the client's own recording `ReadProvider`, so every answer here is real ABI-encoded
// data rather than a stubbed adapter.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {
  drawInterface,
  type FakeProvider,
  fakeProvider,
  MULTICALL3,
  vaultInterface,
  verifiedFrom,
} from "../../packages/client/src/reads/testing/fake.ts";
import {poolFixture, roundFixture, SEED_ACCOUNT} from "../../packages/client/src/reads/testing/views.ts";
import {
  type Address,
  Kind,
  type PoolView,
  type PreparedWrite,
  parseManifest,
  type RawLog,
  type ReadProvider,
  type RoundView,
  State,
  type VerifiedDeployment,
  ZERO_ADDRESS,
} from "./client.ts";
import {type KeeperConfig, loadConfig, REPO_ROOT} from "./config.ts";
import type {CostMeter} from "./costs.ts";
import type {ActionKind} from "./decide.ts";
import {createKeeper, IN_FLIGHT_MS, SUBSCRIPTION_CHECK_MS} from "./keeper.ts";
import {createLogger} from "./log.ts";
import type {AlertCause, Notifier} from "./notify.ts";
import type {LogQuery} from "./refunds.ts";
import {createDispatcher, type Dispatcher, type SendProvider, unlockedSender} from "./sender.ts";
import {coordinatorInterface, encodeGetSubscription} from "./vrf.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const MANIFEST_JSON = readFileSync(join(REPO_ROOT, "config", "deployments", "31337", `${DRAW}.json`), "utf8");

const NOW = 1_790_000_500;
const CLOSES_AT = 1_790_035_200n;

/// Every `Kind`, in Types.sol order; the keeper services one sequence per kind per pool (ADR 036).
const ALL_KINDS = [
  Kind.Day100,
  Kind.Day1k,
  Kind.Day10k,
  Kind.Week1k,
  Kind.Week10k,
  Kind.Week100k,
  Kind.Month100k,
] as const;

/// Round ids for the inert filler rounds `nodeWith` opens for the kinds a test does not name.
const INERT_BASE = 900_000n;

/// The tracked rounds a test named, with `nodeWith`'s inert filler rounds dropped.
function named(tracked: readonly bigint[]): bigint[] {
  return tracked.filter((id) => id < INERT_BASE);
}

function deployment(): VerifiedDeployment {
  return verifiedFrom(parseManifest(JSON.parse(MANIFEST_JSON) as unknown));
}

function config(): KeeperConfig {
  return loadConfig({
    KEEPER_RPC_URL: "http://127.0.0.1:8545",
    KEEPER_CHAIN_ID: "31337",
    KEEPER_DRAW_ADDRESS: DRAW,
    KEEPER_UNLOCKED_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  });
}

function recordingDispatcher(): {dispatcher: Dispatcher; sent: PreparedWrite[]} {
  const sent: PreparedWrite[] = [];
  return {
    sent,
    dispatcher: {
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      async dispatch(write) {
        sent.push(write);
        return {status: "sent", hash: `0x${"11".repeat(32)}`, gasLimit: 100_000n};
      },
    },
  };
}

const noLogs: LogQuery = async () => [];

let logIndex = 0n;

/** One ABI-encoded `EntryBought` log, as a node would return it. */
function entryLog(emitter: Address, roundId: bigint, buyer: Address, blockNumber: bigint): RawLog {
  const encoded = drawInterface.encodeEventLog("EntryBought", [
    roundId,
    buyer,
    50n,
    1n,
    49n,
    50n,
    1n,
    60_000_000_000n,
    1n,
  ]);
  logIndex += 1n;
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${logIndex.toString(16).padStart(64, "0")}`,
    index: logIndex,
    transactionIndex: 0n,
  };
}

function nodeWith(options: {
  pools: readonly PoolView[];
  seedAccount: Address;
  caps: ReadonlyMap<string, bigint>;
  balances: ReadonlyMap<string, bigint>;
  current: ReadonlyMap<string, bigint>;
  rounds: readonly RoundView[];
}): FakeProvider {
  const verified = deployment();
  const head = {number: 4_242, hash: `0x${"cd".repeat(32)}`, timestamp: NOW};
  const provider = fakeProvider({
    chainId: 31337n,
    blocks: {latest: head},
    // `readBatch` re-reads the pinned block by number to prove the head did not move during a snapshot.
    byNumber: {"0x1092": head},
  });
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getPools", [0n, 100n]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPools", [options.pools, BigInt(options.pools.length)]),
  });
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getSeedAccount", []), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getSeedAccount", [options.seedAccount]),
  });
  for (const [key, value] of options.caps) {
    const [account, asset] = key.split("|") as [Address, Address];
    provider.answer(verified.vault, vaultInterface.encodeFunctionData("seedMaxPerRound", [account, asset]), {
      ok: true,
      data: vaultInterface.encodeFunctionResult("seedMaxPerRound", [value]),
    });
  }
  for (const [key, value] of options.balances) {
    const [account, asset] = key.split("|") as [Address, Address];
    provider.answer(verified.vault, vaultInterface.encodeFunctionData("balanceOf", [account, asset]), {
      ok: true,
      data: vaultInterface.encodeFunctionResult("balanceOf", [value]),
    });
  }
  // A pool now runs seven sequences (ADR 036). A test names only the kinds its scenario is about; every
  // other kind gets an inert Open round that is seeded and far from its cutoff, so it produces no action
  // and the assertions below stay about the kinds the test named.
  const inertRounds: RoundView[] = [];
  for (const pool of options.pools) {
    for (const kind of ALL_KINDS) {
      const key = `${pool.id}|${kind}`;
      let value = options.current.get(key);
      if (value === undefined) {
        value = INERT_BASE + pool.id * 10n + BigInt(kind);
        inertRounds.push(
          roundFixture({
            id: value,
            poolId: pool.id,
            kind,
            asset: pool.asset,
            state: State.Open,
            seeded: true,
            closesAt: BigInt(NOW) + 86_400n,
          }),
        );
      }
      provider.answer(verified.draw, drawInterface.encodeFunctionData("getCurrent", [pool.id, kind]), {
        ok: true,
        data: drawInterface.encodeFunctionResult("getCurrent", [value]),
      });
    }
  }
  for (const round of [...options.rounds, ...inertRounds]) {
    provider.answer(verified.draw, drawInterface.encodeFunctionData("getRound", [round.id]), {
      ok: true,
      data: drawInterface.encodeFunctionResult("getRound", [round]),
    });
  }
  return provider;
}

test("one cycle seeds, settles, opens a missing current round and forgets a settled one", async () => {
  const pool = poolFixture({id: 1n, enabled: true});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, 1_000_000_000_000_000_000n]]),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 12n],
      [`1|${Kind.Month100k}`, 0n],
    ]),
    rounds: [
      roundFixture({id: 11n, poolId: 1n, state: State.Open, seeded: false, closesAt: CLOSES_AT}),
      roundFixture({id: 12n, poolId: 1n, kind: Kind.Week1k, state: State.Ready}),
    ],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(
    sent.map((write) => write.function),
    ["ensureCurrent", "seedRound", "settle"],
  );
  assert.deepStrictEqual(sent[1]?.summary.roundId, 11n);
  assert.deepStrictEqual(sent[2]?.summary.roundId, 12n);
  assert.deepStrictEqual(named(keeper.tracked), [11n, 12n]);
  // Every read of the cycle was pinned to the one snapshot block (SPEC §10.1).
  const tags = new Set(provider.calls.map((call) => call.blockTag));
  assert.deepStrictEqual([...tags], ["0x1092"], "every call used the same block tag");
  assert.ok(
    lines.some((line) => line.includes("event=cycle") && line.includes("block=4242")),
    "the cycle summary names the snapshot block",
  );
});

test("a settled round is dropped from tracking and a disabled pool with no round is left alone", async () => {
  const enabled = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const disabled = poolFixture({id: 2n, enabled: false});
  const provider = nodeWith({
    pools: [enabled, disabled],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 12n],
      [`1|${Kind.Month100k}`, 13n],
      // SPEC §6.1: a disabled pool's round finishes and then current is zero. Nothing to open, nothing to do.
      [`2|${Kind.Day100}`, 0n],
      [`2|${Kind.Week1k}`, 0n],
      [`2|${Kind.Month100k}`, 0n],
    ]),
    rounds: [
      roundFixture({id: 11n, poolId: 1n, state: State.Settled}),
      roundFixture({id: 12n, poolId: 1n, state: State.Drawing}),
      roundFixture({id: 13n, poolId: 1n, state: State.Open, seeded: false, closesAt: CLOSES_AT}),
    ],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(sent, [], "nothing to do: no seed configured, no Ready round, no missing current");
  assert.deepStrictEqual(named(keeper.tracked), [12n, 13n], "the Settled round is forgotten");
  assert.ok(
    lines.some((line) => line.includes("round=13") && line.includes("skip=SeedNotConfigured")),
    "an unconfigured seed is a quiet, named skip",
  );
  const disabledCurrent = [Kind.Day100, Kind.Week1k, Kind.Month100k].map((kind) =>
    drawInterface.encodeFunctionData("getCurrent", [2n, kind]),
  );
  assert.strictEqual(
    provider.calls.filter((call) => disabledCurrent.includes(call.data)).length,
    3,
    "a disabled pool is still asked for its current rounds (F2); it may have one that must finish",
  );
});

test("a disabled pool's existing round is still closed and tracked (F2)", async () => {
  const enabled = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const disabled = poolFixture({id: 2n, enabled: false});
  const provider = nodeWith({
    pools: [enabled, disabled],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 0n],
      [`1|${Kind.Week1k}`, 0n],
      [`1|${Kind.Month100k}`, 0n],
      // SPEC §6.1: "a disabled pool's existing round finishes normally and then has zero current".
      [`2|${Kind.Day100}`, 31n],
      [`2|${Kind.Week1k}`, 0n],
      [`2|${Kind.Month100k}`, 0n],
    ]),
    rounds: [
      roundFixture({
        id: 31n,
        poolId: 2n,
        state: State.Open,
        seeded: false,
        closesAt: BigInt(NOW) - 1n,
      }),
    ],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(
    sent.map((write) => write.function),
    ["ensureCurrent", "ensureCurrent", "ensureCurrent", "closeRound"],
    "the enabled pool's three zero pointers are opened; the disabled pool's round is closed",
  );
  assert.strictEqual(sent[3]?.summary.roundId, 31n, "the closed round is the disabled pool's");
  assert.deepStrictEqual(
    named(keeper.tracked),
    [31n],
    "a disabled pool's round is tracked until it resolves",
  );
  const disabledEnsure = [Kind.Day100, Kind.Week1k, Kind.Month100k].map((kind) =>
    drawInterface.encodeFunctionData("ensureCurrent", [2n, kind]),
  );
  assert.ok(
    !sent.some((write) => disabledEnsure.includes(write.data)),
    "the disabled pool's two zero pointers are its end state, not a gap: ensureCurrent rejects them anyway",
  );
});

test("a Refunding round claims for one unrefunded buyer per cycle and stops when fully refunded", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const buyerA: Address = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
  const buyerB: Address = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
  const refunding = roundFixture({
    id: 21n,
    poolId: 1n,
    state: State.Refunding,
    grossTotal: 100n,
    refundedGross: 0n,
  });
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 21n],
      [`1|${Kind.Week1k}`, 21n],
      [`1|${Kind.Month100k}`, 21n],
    ]),
    rounds: [refunding],
  });
  const verified = deployment();
  // Buyer A is already refunded on chain; buyer B is not.
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getPosition", [21n, buyerA]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [50n, true, 50n, 100n]),
  });
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getPosition", [21n, buyerB]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [50n, false, 50n, 100n]),
  });

  const {dispatcher, sent} = recordingDispatcher();
  let queries = 0;
  const logQuery: LogQuery = async (range) => {
    queries += 1;
    assert.ok(range.toBlock >= range.fromBlock, "a page is a forward range");
    return range.fromBlock <= 30n && range.toBlock >= 30n
      ? [entryLog(verified.draw, 21n, buyerA, 30n), entryLog(verified.draw, 21n, buyerB, 30n)]
      : [];
  };
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: verified,
    provider,
    dispatcher,
    logQuery,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();
  assert.strictEqual(queries > 0, true, "the log scan ran");
  assert.deepStrictEqual(
    sent.map((write) => [write.function, write.summary.account]),
    [["claimRefund", buyerB]],
    "one claim, for the buyer the chain says is unrefunded",
  );

  // The second cycle re-uses the discovered buyer list and asks the chain again before claiming.
  const queriesAfterFirst = queries;
  await keeper.runCycle();
  assert.strictEqual(queries, queriesAfterFirst, "a Refunding round takes no new entries: scan once");
  assert.strictEqual(sent.length, 1, "the first claim is still in flight, so it is not sent a second time");
  assert.ok(
    lines.some((line) => line.includes("event=action_deferred") && line.includes("skip=InFlight")),
    "the repeat is a named deferral, not a silent drop",
  );
  assert.deepStrictEqual(named(keeper.tracked), [21n], "the round stays tracked until it is fully refunded");
});

test("a failing log scan is contained to the round being refunded (F5)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 21n],
      [`1|${Kind.Week1k}`, 22n],
      [`1|${Kind.Month100k}`, 22n],
    ]),
    rounds: [
      roundFixture({id: 21n, poolId: 1n, state: State.Refunding, grossTotal: 100n, refundedGross: 0n}),
      roundFixture({id: 22n, poolId: 1n, kind: Kind.Week1k, state: State.Ready}),
    ],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const failing: LogQuery = async () => {
    throw new Error("eth_getLogs: query returned more than 10000 results");
  };
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: failing,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(
    sent.map((write) => [write.function, write.summary.roundId]),
    [["settle", 22n]],
    "the Ready round after the broken one still gets its turn",
  );
  assert.ok(
    lines.some(
      (line) =>
        line.includes("event=refund_scan_failed") &&
        line.includes("round=21") &&
        line.includes("eth_getLogs"),
    ),
    "the failure is logged with the provider's own message",
  );
});

test("an unmined action is not re-sent every cycle, and is retried once it ages out (F6)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 12n],
      [`1|${Kind.Week1k}`, 12n],
      // A re-enabled pool kind: the pointer stays zero until the `ensureCurrent` send is mined.
      [`1|${Kind.Month100k}`, 0n],
    ]),
    rounds: [roundFixture({id: 12n, poolId: 1n, state: State.Ready})],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  let clock = 1_000;
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
    monotonicNow: () => clock,
  });

  await keeper.runCycle();
  await keeper.runCycle();
  await keeper.runCycle();
  assert.deepStrictEqual(
    sent.map((write) => write.function),
    ["ensureCurrent", "settle"],
    "three cycles against an unchanged chain send each action once",
  );
  for (const action of ["settle", "ensureCurrent"]) {
    assert.ok(
      lines.some(
        (line) =>
          line.includes("event=action_deferred") &&
          line.includes(`action=${action}`) &&
          line.includes("skip=InFlight"),
      ),
      `the suppressed ${action} repeats are logged`,
    );
  }

  clock += IN_FLIGHT_MS;
  await keeper.runCycle();
  assert.deepStrictEqual(
    sent.map((write) => write.function),
    ["ensureCurrent", "settle", "ensureCurrent", "settle"],
    "past IN_FLIGHT_MS a dropped transaction is sent again",
  );
});

test("a claim in flight for one buyer does not block another buyer's (F6)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const buyerA: Address = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
  const buyerB: Address = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 21n],
      [`1|${Kind.Week1k}`, 21n],
      [`1|${Kind.Month100k}`, 21n],
    ]),
    rounds: [
      roundFixture({id: 21n, poolId: 1n, state: State.Refunding, grossTotal: 100n, refundedGross: 0n}),
    ],
  });
  const verified = deployment();
  // Neither buyer is refunded on chain, and neither claim is mined between the cycles.
  for (const buyer of [buyerA, buyerB]) {
    provider.answer(verified.draw, drawInterface.encodeFunctionData("getPosition", [21n, buyer]), {
      ok: true,
      data: drawInterface.encodeFunctionResult("getPosition", [50n, false, 50n, 100n]),
    });
  }
  const logQuery: LogQuery = async (range) =>
    range.fromBlock <= 30n && range.toBlock >= 30n
      ? [entryLog(verified.draw, 21n, buyerA, 30n), entryLog(verified.draw, 21n, buyerB, 30n)]
      : [];
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: verified,
    provider,
    dispatcher,
    logQuery,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();
  await keeper.runCycle();
  assert.deepStrictEqual(
    sent.map((write) => write.summary.account),
    [buyerA, buyerB],
    "buyer A's unmined claim defers only buyer A",
  );

  await keeper.runCycle();
  assert.strictEqual(sent.length, 2, "with both claims in flight the round takes no action");
  assert.ok(
    lines.some((line) => line.includes("event=refund_idle") && line.includes("skip=ClaimsInFlight")),
    "and says why it is idle",
  );
});

test("a buyer list that is short of the round's own gross is rescanned, not cached forever (F3)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const buyerA: Address = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
  const buyerB: Address = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 21n],
      [`1|${Kind.Week1k}`, 21n],
      [`1|${Kind.Month100k}`, 21n],
    ]),
    // Half the gross is refunded: buyer A's claim landed, and somebody else's has not.
    rounds: [
      roundFixture({id: 21n, poolId: 1n, state: State.Refunding, grossTotal: 100n, refundedGross: 50n}),
    ],
  });
  const verified = deployment();
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getPosition", [21n, buyerA]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [50n, true, 50n, 100n]),
  });
  provider.answer(verified.draw, drawInterface.encodeFunctionData("getPosition", [21n, buyerB]), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getPosition", [50n, false, 50n, 100n]),
  });

  // The first scan is served by a lagging log node: 200 OK, and buyer B's block is simply not in it yet.
  let scans = 0;
  const logQuery: LogQuery = async (range) => {
    const complete = scans > 0;
    if (range.toBlock >= 30n && range.fromBlock <= 30n) {
      scans += 1;
      return complete
        ? [entryLog(verified.draw, 21n, buyerA, 30n), entryLog(verified.draw, 21n, buyerB, 30n)]
        : [entryLog(verified.draw, 21n, buyerA, 30n)];
    }
    return [];
  };
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: verified,
    provider,
    dispatcher,
    logQuery,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();
  assert.strictEqual(sent.length, 0, "every buyer the short list names is refunded, so nothing is sent");
  const warned = lines.filter((line) => line.includes("event=refund_buyers_incomplete"));
  assert.strictEqual(warned.length, 1, "the impossible state is one warning, not a silent refund_idle");
  assert.ok(
    warned[0]?.includes("level=warn") &&
      warned[0].includes("buyers=1") &&
      warned[0].includes("refundedGross=50") &&
      warned[0].includes("grossTotal=100"),
    `the warning carries the numbers that prove it: ${warned[0]}`,
  );
  assert.ok(
    !lines.some((line) => line.includes("skip=NoUnrefundedBuyer")),
    "and it replaces the reassuring line that hid this for the life of the round",
  );

  await keeper.runCycle();
  assert.strictEqual(scans, 2, "the next cycle rescans instead of trusting the cached list");
  assert.deepStrictEqual(
    sent.map((write) => [write.function, write.summary.account]),
    [["claimRefund", buyerB]],
    "the buyer the first scan missed is refunded",
  );
});

test("a send that throws costs its own round a turn, not the cycle (F5)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 12n],
      [`1|${Kind.Month100k}`, 12n],
    ]),
    rounds: [
      roundFixture({id: 11n, poolId: 1n, state: State.Open, seeded: true, closesAt: BigInt(NOW) - 1n}),
      roundFixture({id: 12n, poolId: 1n, kind: Kind.Week1k, state: State.Ready}),
    ],
  });
  const sent: PreparedWrite[] = [];
  const dispatcher: Dispatcher = {
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    async dispatch(write) {
      // Simulation passed; the node rejected the transaction itself.
      if (write.function === "closeRound") throw new Error("nonce has already been used");
      sent.push(write);
      return {status: "sent", hash: `0x${"11".repeat(32)}`, gasLimit: 100_000n};
    },
  };
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(
    sent.map((write) => [write.function, write.summary.roundId]),
    [["settle", 12n]],
    "the round after the failed send still gets its turn",
  );
  assert.strictEqual(keeper.consecutiveFailures, 0, "a failed send is not a failed cycle");
  assert.ok(
    lines.some(
      (line) =>
        line.includes("event=action_skipped") &&
        line.includes("round=11") &&
        line.includes("SendFailed") &&
        line.includes("nonce has already been used"),
    ),
    `the skip names the node's own message: ${lines.join("\n")}`,
  );
});

test("a send that threw after broadcasting is remembered in flight, not re-sent (F5)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 12n],
      [`1|${Kind.Week1k}`, 12n],
      [`1|${Kind.Month100k}`, 12n],
    ]),
    rounds: [roundFixture({id: 12n, poolId: 1n, state: State.Ready})],
  });
  const hash = `0x${"77".repeat(32)}`;
  let attempts = 0;
  const dispatcher: Dispatcher = {
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    async dispatch() {
      attempts += 1;
      // ethers broadcasts, then compares the node's hash with the signed transaction's: the raw transaction
      // is already on the wire when this throws, and `value` is the hash the node gave back.
      throw Object.assign(new Error("returned hash did not match"), {code: "BAD_DATA", value: hash});
    },
  };
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();
  await keeper.runCycle();

  assert.strictEqual(attempts, 1, "the recovered hash suppresses the duplicate, as a clean send would");
  assert.ok(
    lines.some((line) => line.includes("event=action_skipped") && line.includes(`tx=${hash}`)),
    "and the hash that is out is logged, so an operator can look it up",
  );
});

test("one seed balance funds one seed per cycle, not one per kind (F9)", async () => {
  const pool = poolFixture({id: 1n, enabled: true});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    // Exactly one seed, and a full pool — all seven kinds Open and unseeded — each wanting one. This is the
    // real fan-out since ADR 036, and it is what the SeedBudget doc comment in keeper.ts claims to handle.
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    current: new Map(ALL_KINDS.map((kind, index) => [`1|${kind}`, BigInt(11 + index)])),
    rounds: ALL_KINDS.map((kind, index) =>
      roundFixture({
        id: BigInt(11 + index),
        poolId: 1n,
        kind,
        state: State.Open,
        seeded: false,
        closesAt: CLOSES_AT,
      }),
    ),
  });
  const {dispatcher, sent} = recordingDispatcher();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
  });

  await keeper.runCycle();

  assert.deepStrictEqual(
    sent.map((write) => [write.function, write.summary.roundId]),
    [["seedRound", 11n]],
    "the balance covers one seed, so exactly one round is seeded",
  );
  const starved = lines.filter((line) => line.includes("skip=InsufficientSeedBalance"));
  assert.strictEqual(
    starved.length,
    ALL_KINDS.length - 1,
    "the other six kinds are named skips, not silent ones",
  );
});

// ---------------------------------------------------------------------------
// Durability: batching, the heartbeat, the alerts and the cost meter.
// ---------------------------------------------------------------------------

type RecordedAlert = {cause: AlertCause; fields: Record<string, unknown> | undefined};

function recordingNotifier(): {notify: Notifier; readonly beats: number; alerts: RecordedAlert[]} {
  const alerts: RecordedAlert[] = [];
  const state = {beats: 0};
  return {
    alerts,
    get beats(): number {
      return state.beats;
    },
    notify: {
      heartbeat: () => {
        state.beats += 1;
      },
      alert: (cause, fields) =>
        void alerts.push({cause, fields: fields as Record<string, unknown> | undefined}),
      drain: async () => undefined,
    },
  };
}

function recordingCostMeter(): {
  meter: CostMeter;
  sends: {round: bigint; action: ActionKind}[];
  collected: bigint[];
} {
  const sends: {round: bigint; action: ActionKind}[] = [];
  const collected: bigint[] = [];
  return {
    sends,
    collected,
    meter: {
      recordSend: (round, action) => void sends.push({round, action}),
      collect: async (head) => void collected.push(head),
      size: 0,
    },
  };
}

/** Registers the coordinator's `getSubscription` answer on the fake node. */
function answerSubscription(provider: FakeProvider, nativeBalance: bigint): void {
  const {vrf} = deployment().manifest;
  provider.answer(vrf.coordinator, encodeGetSubscription(vrf.subscriptionId), {
    ok: true,
    data: coordinatorInterface.encodeFunctionResult("getSubscription", [
      0n,
      nativeBalance,
      0n,
      SEED_ACCOUNT,
      [],
    ]),
  });
}

/** One Open, unseeded, pre-cutoff round whose seed preconditions the caller chooses. */
function seedlessNode(options: {cap: bigint; balance: bigint}): FakeProvider {
  const pool = poolFixture({id: 1n, enabled: true});
  return nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, options.cap]]),
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, options.balance]]),
    // All three kinds point at the one round, so the cycle has exactly one decision to take and no zero
    // pointer to open: what is under test is the decision, not the pool walk.
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 11n],
      [`1|${Kind.Month100k}`, 11n],
    ]),
    rounds: [roundFixture({id: 11n, poolId: 1n, state: State.Open, seeded: false, closesAt: CLOSES_AT})],
  });
}

test("with Multicall3 set the cycle's reads arrive as aggregate3", async () => {
  const pool = poolFixture({id: 1n, enabled: true});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, 1_000_000_000_000_000_000n]]),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 0n],
      [`1|${Kind.Month100k}`, 0n],
    ]),
    rounds: [roundFixture({id: 11n, poolId: 1n, state: State.Ready})],
  });
  const {dispatcher} = recordingDispatcher();
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: () => undefined}),
    multicall3: MULTICALL3,
  });

  await keeper.runCycle();

  const targets = new Set(provider.calls.map((call) => call.to));
  assert.ok(targets.has(MULTICALL3), "the reads went through Multicall3");
  // Every adapter read is inside the batch: nothing reached the Draw or the Vault as its own eth_call.
  assert.ok(!targets.has(deployment().draw), "no unbatched Draw call");
  assert.ok(!targets.has(deployment().vault), "no unbatched Vault call");
});

/** Every JSON-RPC request a cycle makes: `eth_call` plus the block reads a snapshot costs. */
function countingProvider(inner: FakeProvider): {provider: ReadProvider; requests: () => number} {
  let requests = 0;
  return {
    requests: () => requests,
    provider: {
      call(tx) {
        requests += 1;
        return inner.call(tx);
      },
      getBlock(tag) {
        requests += 1;
        return inner.getBlock(tag);
      },
      getBlockNumber() {
        requests += 1;
        return inner.getBlockNumber();
      },
      getNetwork() {
        return inner.getNetwork();
      },
    },
  };
}

test("Multicall3 makes a cycle strictly cheaper in requests, not merely batched (F3)", async () => {
  // Two pools, three kinds each, six tracked rounds: the shape whose per-adapter reads used to cost the
  // same number of requests with Multicall3 as without, because every adapter sent its own one-item
  // `aggregate3` plus its own head re-read.
  const pools = [poolFixture({id: 1n, enabled: true}), poolFixture({id: 2n, enabled: true})];
  const rounds = [11n, 12n, 13n, 21n, 22n, 23n];
  const cycle = async (multicall3?: Address): Promise<{requests: number; sent: PreparedWrite[]}> => {
    const node = nodeWith({
      pools,
      seedAccount: SEED_ACCOUNT,
      caps: new Map(pools.map((pool) => [`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount])),
      balances: new Map(pools.map((pool) => [`${SEED_ACCOUNT}|${pool.asset}`, 10n ** 18n])),
      current: new Map([
        [`1|${Kind.Day100}`, 11n],
        [`1|${Kind.Week1k}`, 12n],
        [`1|${Kind.Month100k}`, 13n],
        [`2|${Kind.Day100}`, 21n],
        [`2|${Kind.Week1k}`, 22n],
        [`2|${Kind.Month100k}`, 23n],
      ]),
      // Drawing: the coordinator owns the next transition, so the cycle reads everything and sends nothing.
      rounds: rounds.map((id) => roundFixture({id, poolId: id < 20n ? 1n : 2n, state: State.Drawing})),
    });
    answerSubscription(node, 10n ** 18n);
    const counted = countingProvider(node);
    const {dispatcher, sent} = recordingDispatcher();
    const keeper = createKeeper({
      config: config(),
      deployment: deployment(),
      provider: counted.provider,
      dispatcher,
      logQuery: noLogs,
      logger: createLogger({write: () => undefined}),
      multicall3,
    });
    await keeper.runCycle();
    assert.deepStrictEqual(sent, [], "this fixture is a pure read cycle");
    assert.deepStrictEqual(named(keeper.tracked), rounds);
    return {requests: counted.requests(), sent};
  };

  const direct = await cycle(undefined);
  const batched = await cycle(MULTICALL3);
  assert.ok(
    batched.requests < direct.requests,
    `Multicall3 bought nothing: ${batched.requests} requests batched vs ${direct.requests} direct`,
  );
  // Measured: 8 requests batched against 23 direct. The eighteen reads collapse into three aggregate3 calls.
  assert.ok(
    batched.requests * 2 < direct.requests,
    `expected far fewer requests with Multicall3: ${batched.requests} vs ${direct.requests}`,
  );
});

test("a healthy cycle beats once; nothing else does", async () => {
  const provider = seedlessNode({cap: 0n, balance: 0n});
  const {dispatcher} = recordingDispatcher();
  const recorded = recordingNotifier();
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: () => undefined}),
    notify: recorded.notify,
  });
  await keeper.runCycle();
  assert.strictEqual(recorded.beats, 1);
  await keeper.runCycle();
  assert.strictEqual(recorded.beats, 2);
});

test("an unauthorized or unfunded seed account raises its own alert", async () => {
  for (const [cause, options] of [
    ["SeedNotAuthorized", {cap: 0n, balance: 1_000_000_000_000_000_000n}],
    ["InsufficientSeedBalance", {cap: 10_000_000_000_000_000n, balance: 0n}],
  ] as const) {
    const provider = seedlessNode(options);
    const {dispatcher, sent} = recordingDispatcher();
    const {notify, alerts} = recordingNotifier();
    const keeper = createKeeper({
      config: config(),
      deployment: deployment(),
      provider,
      dispatcher,
      logQuery: noLogs,
      logger: createLogger({write: () => undefined}),
      notify,
    });
    await keeper.runCycle();
    assert.deepStrictEqual(sent, [], "an unseedable round sends nothing");
    assert.deepStrictEqual(
      alerts.map((entry) => entry.cause),
      [cause],
    );
    assert.deepStrictEqual(alerts[0]?.fields, {round: 11n, pool: 1n});
  }
});

test("a failed requestDraw pre-check alerts; a failed send does not", async () => {
  const build = (
    dispatch: Dispatcher["dispatch"],
  ): {alerts: RecordedAlert[]; keeper: ReturnType<typeof createKeeper>} => {
    const pool = poolFixture({id: 1n, enabled: true});
    const provider = nodeWith({
      pools: [pool],
      seedAccount: SEED_ACCOUNT,
      caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
      balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, 1_000_000_000_000_000_000n]]),
      current: new Map([
        [`1|${Kind.Day100}`, 11n],
        [`1|${Kind.Week1k}`, 11n],
        [`1|${Kind.Month100k}`, 11n],
      ]),
      rounds: [
        roundFixture({
          id: 11n,
          poolId: 1n,
          state: State.AwaitingRequest,
          // Before the deadline, so the row is requestDraw rather than expireUnrequested (SPEC 6.2).
          requestDeadline: CLOSES_AT,
        }),
      ],
    });
    const {notify, alerts} = recordingNotifier();
    return {
      alerts,
      keeper: createKeeper({
        config: config(),
        deployment: deployment(),
        provider,
        dispatcher: {address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", dispatch},
        logQuery: noLogs,
        logger: createLogger({write: () => undefined}),
        notify,
      }),
    };
  };

  const precheck = build(async () => ({status: "skipped", reason: "InsufficientBalance"}));
  await precheck.keeper.runCycle();
  assert.deepStrictEqual(
    precheck.alerts.map((entry) => entry.cause),
    ["request_precheck_failed"],
  );

  // A nonce gap says nothing about the key hash or the subscription, so it must not page anybody.
  const sendFailed = build(async () => {
    throw new Error("nonce has already been used");
  });
  await sendFailed.keeper.runCycle();
  assert.deepStrictEqual(sendFailed.alerts, []);
});

test("an eth_estimateGas transport failure is a send failure, not a requestDraw pre-check failure (F2)", async () => {
  const pool = poolFixture({id: 1n, enabled: true});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, 1_000_000_000_000_000_000n]]),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 11n],
      [`1|${Kind.Month100k}`, 11n],
    ]),
    rounds: [roundFixture({id: 11n, poolId: 1n, state: State.AwaitingRequest, requestDeadline: CLOSES_AT})],
  });
  // The real dispatcher, over a node whose `eth_estimateGas` cannot be reached at all. This is the whole
  // point of the regression: a skip invented from a socket error used to page the operator about SPEC 6.2
  // pre-checks the node was never asked about, and silence the round for REQUEST_RETRY_MS.
  const estimates: number[] = [];
  const sendProvider: SendProvider = {
    async estimateGas() {
      estimates.push(1);
      throw new Error("ECONNRESET");
    },
    async send() {
      throw new Error("the keeper must not send a transaction it could not simulate");
    },
  };
  const keeperAccount: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const dispatcher = createDispatcher(sendProvider, unlockedSender(sendProvider, keeperAccount), {
    dryRun: false,
  });
  const {notify, alerts} = recordingNotifier();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
    notify,
  });

  await keeper.runCycle();
  assert.deepStrictEqual(alerts, [], "an unreachable node pages nobody about a key hash");
  assert.ok(
    !lines.some((line) => line.includes("event=request_precheck_failed")),
    `a transport failure was filed as a pre-check failure: ${lines.join("|")}`,
  );
  assert.ok(
    lines.some((line) => line.includes("event=action_skipped") && line.includes("SendFailed:ECONNRESET")),
    `the failure was not reported as a send failure: ${lines.join("|")}`,
  );

  // No 60-second back-off: the next cycle tries again, because nothing about the round changed.
  await keeper.runCycle();
  assert.strictEqual(estimates.length, 2, "the request was silenced by a back-off it never earned");
});

test("the subscription balance is read at most every five minutes and alerts under the threshold", async () => {
  const threshold = deployment().manifest.vrf.lowFundingThresholdNative;
  assert.ok(threshold > 0n, "the fixture has a funding threshold to compare against");
  const coordinator = deployment().manifest.vrf.coordinator;
  const provider = seedlessNode({cap: 0n, balance: 0n});
  answerSubscription(provider, threshold - 1n);
  const {dispatcher} = recordingDispatcher();
  const {notify, alerts} = recordingNotifier();
  const lines: string[] = [];
  let clock = 0;
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
    notify,
    monotonicNow: () => clock,
  });
  const reads = (): number => provider.calls.filter((call) => call.to === coordinator).length;

  await keeper.runCycle();
  assert.strictEqual(reads(), 1);
  assert.ok(
    lines.some((line) => line.includes("event=subscription ") && line.includes("low=true")),
    `the low balance was not logged: ${lines.join("|")}`,
  );
  assert.strictEqual(alerts.filter((entry) => entry.cause === "subscription_below_threshold").length, 1);

  clock += SUBSCRIPTION_CHECK_MS - 1;
  await keeper.runCycle();
  assert.strictEqual(reads(), 1, "the balance is not re-read every cycle");
  clock += 1;
  await keeper.runCycle();
  assert.strictEqual(reads(), 2, "and is re-read once the interval has passed");
});

test("a coordinator that does not answer is a warning, never a failed cycle", async () => {
  const provider = seedlessNode({cap: 0n, balance: 0n}); // no getSubscription answer registered
  const {dispatcher} = recordingDispatcher();
  const {notify, alerts} = recordingNotifier();
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: (line) => void lines.push(line)}),
    notify,
  });
  await assert.doesNotReject(() => keeper.runCycle());
  assert.ok(
    lines.some((line) => line.includes("event=subscription_check_failed")),
    `the failure was not logged: ${lines.join("|")}`,
  );
  assert.ok(
    lines.some((line) => line.includes("event=cycle ")),
    "the cycle still completed",
  );
  assert.deepStrictEqual(
    alerts.filter((entry) => entry.cause === "subscription_below_threshold"),
    [],
    "an unreadable balance is not a low balance",
  );
});

test("every transaction the keeper sends is handed to the cost meter, once per cycle", async () => {
  const pool = poolFixture({id: 1n, enabled: true});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: SEED_ACCOUNT,
    caps: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, pool.seedAmount]]),
    balances: new Map([[`${SEED_ACCOUNT}|${pool.asset}`, 1_000_000_000_000_000_000n]]),
    current: new Map([
      [`1|${Kind.Day100}`, 11n],
      [`1|${Kind.Week1k}`, 12n],
      [`1|${Kind.Month100k}`, 0n],
    ]),
    rounds: [
      roundFixture({id: 11n, poolId: 1n, state: State.Open, seeded: false, closesAt: CLOSES_AT}),
      roundFixture({id: 12n, poolId: 1n, kind: Kind.Week1k, state: State.Ready}),
    ],
  });
  const {dispatcher} = recordingDispatcher();
  const {meter, sends, collected} = recordingCostMeter();
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: noLogs,
    logger: createLogger({write: () => undefined}),
    costMeter: meter,
  });

  await keeper.runCycle();

  assert.deepStrictEqual(sends, [
    {round: 11n, action: "seedRound"},
    {round: 12n, action: "settle"},
  ]);
  // Receipts are polled once per cycle, at the snapshot block, before anything new is sent.
  assert.deepStrictEqual(collected, [4242n]);
});

test("a throttled log scan retries the same range and then fails by naming the RPC (F5)", async () => {
  const pool = poolFixture({id: 1n, enabled: true, seedAmount: 0n});
  const provider = nodeWith({
    pools: [pool],
    seedAccount: ZERO_ADDRESS,
    caps: new Map(),
    balances: new Map(),
    current: new Map([
      [`1|${Kind.Day100}`, 21n],
      [`1|${Kind.Week1k}`, 21n],
      [`1|${Kind.Month100k}`, 21n],
    ]),
    rounds: [
      roundFixture({id: 21n, poolId: 1n, state: State.Refunding, grossTotal: 100n, refundedGross: 0n}),
    ],
  });
  const {dispatcher, sent} = recordingDispatcher();
  const ranges: [bigint, bigint][] = [];
  const throttled: LogQuery = async (range) => {
    ranges.push([range.fromBlock, range.toBlock]);
    // A data seed that answers every getLogs the same way, whatever the range.
    throw Object.assign(new Error("could not coalesce error"), {
      info: {error: {code: -32005, message: "limit exceeded"}},
    });
  };
  const lines: string[] = [];
  const keeper = createKeeper({
    config: config(),
    deployment: deployment(),
    provider,
    dispatcher,
    logQuery: throttled,
    logger: createLogger({write: (line) => void lines.push(line)}),
    logScanRetry: {maxRateLimitRetries: 2, sleep: async () => {}, random: () => 1},
  });

  await keeper.runCycle();

  assert.strictEqual(ranges.length, 3, "the first try plus two retries");
  assert.ok(
    ranges.every(([from, to]) => from === ranges[0]?.[0] && to === ranges[0]?.[1]),
    "every retry re-reads the same blocks: a throttled scan skips nothing",
  );
  assert.strictEqual(sent.length, 0, "no claim is sent from a buyer list that was never completed");
  const failure = lines.find((line) => line.includes("event=refund_scan_failed"));
  assert.ok(failure !== undefined, "the give-up is a named keeper log line, not a silent stall");
  assert.ok(failure.includes("round=21"), "which round stalled");
  assert.ok(failure.includes("rate-limited"), "and why: the RPC is throttling this keeper");
  assert.ok(
    !failure.includes("limit exceeded") && !failure.includes("coalesce"),
    "the node's own words are not the operator's error message (SPEC §9.7)",
  );
});
