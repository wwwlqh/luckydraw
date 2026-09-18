// Buyer discovery from decoded logs, its paging, and the refunded set.
//
// The logs are encoded with the generated Draw ABI, so the decoder under test is fed the same bytes a node
// would produce; nothing here hand-writes a topic.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {Interface} from "ethers";
import {verifiedFrom} from "../../packages/client/src/reads/testing/fake.ts";
import {
  type Address,
  asAddress,
  type Hex32,
  luckyDrawAbi,
  parseManifest,
  type RawLog,
  type VerifiedDeployment,
} from "./client.ts";
import {REPO_ROOT} from "./config.ts";
import {
  discoverBuyers,
  ENTRY_TOPICS,
  type LogQuery,
  LogScanError,
  LogScanRateLimitError,
  MAX_LOGS_PER_PAGE,
  RefundTracker,
} from "./refunds.ts";

const drawInterface = new Interface(luckyDrawAbi);

const MANIFEST_PATH = join(
  REPO_ROOT,
  "config",
  "deployments",
  "31337",
  "0x610178da211fef7d417bc0e6fed39f05609ad788.json",
);

function deployment(): VerifiedDeployment {
  return verifiedFrom(parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown));
}

const PLAYER_A = asAddress("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc");
const PLAYER_B = asAddress("0x976ea74026e726554db657fa54763abd0c3a0aa9");
const SEED = asAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const IMPOSTOR = asAddress("0x000000000000000000000000000000000000dead");

let nextLogIndex = 0n;

function logOf(
  emitter: Address,
  name: "EntryBought" | "SeedEntered",
  values: readonly unknown[],
  blockNumber: bigint,
): RawLog {
  const encoded = drawInterface.encodeEventLog(name, values as unknown[]);
  nextLogIndex += 1n;
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(nextLogIndex + 1000n).toString(16).padStart(64, "0")}`,
    index: nextLogIndex,
    transactionIndex: 0n,
  };
}

function entryBought(emitter: Address, roundId: bigint, buyer: Address, blockNumber: bigint): RawLog {
  return logOf(
    emitter,
    "EntryBought",
    [roundId, buyer, 10n, 1n, 9n, 10n, 1n, 60_000_000_000n, 1n],
    blockNumber,
  );
}

function seedEntered(emitter: Address, roundId: bigint, account: Address, blockNumber: bigint): RawLog {
  return logOf(emitter, "SeedEntered", [roundId, account, 10n, 1n, 9n, 10n], blockNumber);
}

type Recorded = {fromBlock: bigint; toBlock: bigint; topics: readonly Hex32[]};

function recordingQuery(logs: readonly RawLog[]): {query: LogQuery; ranges: Recorded[]} {
  const ranges: Recorded[] = [];
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock, topics: range.topics});
    return logs.filter((log) => {
      const block = BigInt(log.blockNumber);
      return block >= range.fromBlock && block <= range.toBlock;
    });
  };
  return {query, ranges};
}

test("discoverBuyers collects every distinct account of one round, seed included", async () => {
  const verified = deployment();
  const draw = verified.draw;
  const logs = [
    seedEntered(draw, 7n, SEED, 100n),
    entryBought(draw, 7n, PLAYER_A, 101n),
    entryBought(draw, 7n, PLAYER_B, 102n),
    entryBought(draw, 7n, PLAYER_A, 103n), // a second purchase by the same buyer
  ];
  const {query} = recordingQuery(logs);
  const buyers = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 200n,
    window: 2_000n,
    query,
  });
  assert.deepStrictEqual(buyers, [SEED, PLAYER_A, PLAYER_B]);
});

test("discoverBuyers ignores other rounds and look-alike emitters", async () => {
  const verified = deployment();
  const logs = [
    entryBought(verified.draw, 7n, PLAYER_A, 100n),
    entryBought(verified.draw, 8n, PLAYER_B, 101n),
    entryBought(IMPOSTOR, 7n, IMPOSTOR, 102n),
    entryBought(verified.vault, 7n, PLAYER_B, 103n), // right round, wrong contract
  ];
  const {query} = recordingQuery(logs);
  const buyers = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 200n,
    window: 2_000n,
    query,
  });
  assert.deepStrictEqual(buyers, [PLAYER_A]);
});

test("discoverBuyers pages the scan and never asks for more than the window", async () => {
  const verified = deployment();
  const logs = [entryBought(verified.draw, 7n, PLAYER_A, 6_500n)];
  const {query, ranges} = recordingQuery(logs);
  const buyers = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 7_009n,
    window: 2_000n,
    query,
  });
  assert.deepStrictEqual(buyers, [PLAYER_A]);
  assert.deepStrictEqual(
    ranges.map((range) => [range.fromBlock, range.toBlock]),
    [
      [10n, 2_009n],
      [2_010n, 4_009n],
      [4_010n, 6_009n],
      [6_010n, 7_009n],
    ],
  );
  for (const range of ranges) {
    assert.ok(range.toBlock - range.fromBlock + 1n <= 2_000n, "a page never exceeds the window");
    assert.deepStrictEqual(range.topics, ENTRY_TOPICS);
  }
});

test("discoverBuyers makes exactly one query when the window covers the range", async () => {
  const verified = deployment();
  const {query, ranges} = recordingQuery([]);
  await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 1_000n,
    window: 2_000n,
    query,
  });
  assert.strictEqual(ranges.length, 1);
  assert.deepStrictEqual(ranges[0]?.toBlock, 1_000n);
});

test("discoverBuyers refuses a non-positive window", async () => {
  const verified = deployment();
  const {query} = recordingQuery([]);
  await assert.rejects(
    () => discoverBuyers({deployment: verified, roundId: 1n, fromBlock: 0n, toBlock: 1n, window: 0n, query}),
    RangeError,
  );
});

test("a page at the provider's result cap is truncated, so the window halves until it is not (F4)", async () => {
  const verified = deployment();
  // Ten buyers, one per block, and a provider that answers with at most four logs and no warning.
  const buyers = Array.from({length: 10}, (_, index) =>
    asAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
  );
  const logs = buyers.map((buyer, index) => entryBought(verified.draw, 7n, buyer, BigInt(index)));
  const ranges: {fromBlock: bigint; toBlock: bigint}[] = [];
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
    return logs
      .filter((log) => BigInt(log.blockNumber) >= range.fromBlock && BigInt(log.blockNumber) <= range.toBlock)
      .slice(0, 4);
  };

  const found = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 0n,
    toBlock: 15n,
    window: 16n,
    query,
    pageCap: 4,
  });

  assert.deepStrictEqual(found, buyers, "every buyer is discovered once the window is small enough");
  assert.deepStrictEqual(
    ranges.slice(0, 3).map((range) => [range.fromBlock, range.toBlock]),
    [
      [0n, 15n],
      [0n, 7n],
      [0n, 3n],
    ],
    "a full page halves the window and re-reads the same start",
  );
  assert.ok(
    ranges.every((range) => range.toBlock - range.fromBlock + 1n <= 16n),
    "the window never grows",
  );
});

test("a thrown page halves the window and re-reads the same start (F4)", async () => {
  const verified = deployment();
  const logs = [entryBought(verified.draw, 7n, PLAYER_A, 500n)];
  const ranges: {fromBlock: bigint; toBlock: bigint}[] = [];
  let calls = 0;
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
    calls += 1;
    if (calls === 1) throw new Error("query returned more than 10000 results");
    return logs.filter(
      (log) => BigInt(log.blockNumber) >= range.fromBlock && BigInt(log.blockNumber) <= range.toBlock,
    );
  };

  const found = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 4_009n,
    window: 2_000n,
    query,
  });

  assert.deepStrictEqual(found, [PLAYER_A], "the re-read finds the entry the failed page would have held");
  assert.deepStrictEqual(
    ranges.map((range) => [range.fromBlock, range.toBlock]),
    [
      [10n, 2_009n],
      [10n, 1_009n],
      [1_010n, 2_009n],
      [2_010n, 3_009n],
      [3_010n, 4_009n],
    ],
    "the start never moves past a failure, and the narrowed window is kept",
  );
});

test("a page that still fails, or still fills, at one block is a named scan failure (F4)", async () => {
  const verified = deployment();
  const always: LogQuery = async () => {
    throw new Error("query timed out");
  };
  await assert.rejects(
    () =>
      discoverBuyers({
        deployment: verified,
        roundId: 7n,
        fromBlock: 0n,
        toBlock: 3n,
        window: 4n,
        query: always,
      }),
    LogScanError,
    "an RPC that fails at a single block cannot produce an honest buyer list",
  );

  const full: LogQuery = async () => [entryBought(verified.draw, 7n, PLAYER_A, 0n)];
  await assert.rejects(
    () =>
      discoverBuyers({
        deployment: verified,
        roundId: 7n,
        fromBlock: 0n,
        toBlock: 3n,
        window: 4n,
        query: full,
        pageCap: 1,
      }),
    LogScanError,
    "a single block that still returns a full page may be hiding entries",
  );
  assert.strictEqual(MAX_LOGS_PER_PAGE, 10_000, "the documented public-RPC result cap");
});

// The shared classifier grew a `pruned` kind for the web app on 2026-09-18. The keeper does not act on it
// yet: a partial buyer list would credit some refunds and silently skip others, so a pruned range must stay
// the loud failure `unknown` already was, and only an archive RPC or the indexer fixes it.
test("a pruned range is treated exactly like an unknown failure: halve, then fail loudly", async () => {
  const windows: bigint[] = [];
  const query: LogQuery = async (range) => {
    windows.push(range.toBlock - range.fromBlock + 1n);
    throw Object.assign(new Error("could not coalesce error"), {
      info: {error: {code: -32701, message: "requested block is before the earliest available block"}},
    });
  };
  await assert.rejects(
    () =>
      discoverBuyers({
        deployment: deployment(),
        roundId: 7n,
        fromBlock: 10n,
        toBlock: 4_009n,
        window: 2_000n,
        query,
      }),
    LogScanError,
    "the keeper never advances past a range it could not read",
  );
  // It halved rather than waited, which is the `unknown` path and not the `rateLimit` one.
  assert.ok(windows.length > 1 && windows[1] === 1_000n, `halved the window: ${windows.join(",")}`);
});

test("the refunded set is per round and forgettable", () => {
  const tracker = new RefundTracker();
  assert.strictEqual(tracker.isRefunded(1n, PLAYER_A), false);
  tracker.markRefunded(1n, PLAYER_A);
  assert.strictEqual(tracker.isRefunded(1n, PLAYER_A), true);
  assert.strictEqual(tracker.isRefunded(2n, PLAYER_A), false, "another round is unaffected");
  assert.deepStrictEqual(tracker.pending(1n, [SEED, PLAYER_A, PLAYER_B]), [SEED, PLAYER_B]);
  tracker.markRefunded(1n, SEED);
  tracker.markRefunded(1n, PLAYER_B);
  assert.deepStrictEqual(tracker.pending(1n, [SEED, PLAYER_A, PLAYER_B]), []);
  assert.strictEqual(tracker.size, 1);
  tracker.forget(1n);
  assert.strictEqual(tracker.size, 0);
  assert.strictEqual(tracker.isRefunded(1n, PLAYER_A), false, "forgetting drops the whole round");
});

test("a rate-limited page waits and re-reads the same range, without halving the window (F4)", async () => {
  const verified = deployment();
  const logs = [entryBought(verified.draw, 7n, PLAYER_A, 2_500n)];
  const ranges: {fromBlock: bigint; toBlock: bigint}[] = [];
  const waits: number[] = [];
  let calls = 0;
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
    calls += 1;
    // What BSC's public data seeds answer with, wrapped the way ethers wraps it.
    if (calls <= 2) {
      throw Object.assign(new Error("could not coalesce error"), {
        info: {error: {code: -32005, message: "limit exceeded"}},
      });
    }
    return logs.filter(
      (log) => BigInt(log.blockNumber) >= range.fromBlock && BigInt(log.blockNumber) <= range.toBlock,
    );
  };

  const found = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 4_009n,
    window: 2_000n,
    query,
    sleep: async (ms) => void waits.push(ms),
    random: () => 1,
  });

  assert.deepStrictEqual(found, [PLAYER_A], "the retried range is read in full once the throttling stops");
  assert.deepStrictEqual(
    ranges.map((range) => [range.fromBlock, range.toBlock]),
    [
      [10n, 2_009n],
      [10n, 2_009n],
      [10n, 2_009n],
      [2_010n, 4_009n],
    ],
    "the same 2,000-block range is re-read: a throttled node is not a node that found the range too wide",
  );
  assert.deepStrictEqual(waits, [1_000, 2_000], "the wait doubles between retries of the same range");
});

test("a range cap still halves, and never waits (F4)", async () => {
  const verified = deployment();
  const logs = [entryBought(verified.draw, 7n, PLAYER_A, 1_500n)];
  const ranges: {fromBlock: bigint; toBlock: bigint}[] = [];
  const waits: number[] = [];
  let calls = 0;
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("exceed maximum block range: 1000"), {code: -32000});
    return logs.filter(
      (log) => BigInt(log.blockNumber) >= range.fromBlock && BigInt(log.blockNumber) <= range.toBlock,
    );
  };

  const found = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 2_009n,
    window: 2_000n,
    query,
    sleep: async (ms) => void waits.push(ms),
    random: () => 1,
  });

  assert.deepStrictEqual(found, [PLAYER_A]);
  assert.deepStrictEqual(
    ranges.map((range) => [range.fromBlock, range.toBlock]),
    [
      [10n, 2_009n],
      [10n, 1_009n],
      [1_010n, 2_009n],
    ],
    "the window halves and the same start is re-read",
  );
  assert.deepStrictEqual(waits, [], "a range cap is fixed by a smaller query, not by waiting");
});

test("a node that never stops throttling gives up after a bounded number of retries (F4)", async () => {
  const verified = deployment();
  const ranges: {fromBlock: bigint; toBlock: bigint}[] = [];
  const waits: number[] = [];
  const query: LogQuery = async (range) => {
    ranges.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
    throw Object.assign(new Error("server response 429 Too Many Requests"), {status: 429});
  };

  const error = await discoverBuyers({
    deployment: verified,
    roundId: 7n,
    fromBlock: 10n,
    toBlock: 4_009n,
    window: 2_000n,
    query,
    maxRateLimitRetries: 3,
    sleep: async (ms) => void waits.push(ms),
    random: () => 1,
  }).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof LogScanRateLimitError, "a throttled scan is its own failure, not a short list");
  assert.ok(error instanceof LogScanError, "and keeper.ts still contains it to the one round being refunded");
  assert.strictEqual(error.attempts, 4, "the first try plus the whole retry budget");
  assert.deepStrictEqual(waits, [1_000, 2_000, 4_000], "three retries, each waiting twice as long");
  assert.deepStrictEqual(
    ranges.map((range) => [range.fromBlock, range.toBlock]),
    [
      [10n, 2_009n],
      [10n, 2_009n],
      [10n, 2_009n],
      [10n, 2_009n],
    ],
    "the cursor never moves, so giving up skips no block: the next scan starts where this one did",
  );
  assert.match(error.message, /the RPC rate-limited eth_getLogs for round 7 at blocks 10-2009/);
  assert.doesNotMatch(
    error.message,
    /429|Too Many Requests/,
    "the operator is told which endpoint and which blocks, not what the node wrote",
  );
  assert.ok(error.cause instanceof Error, "the provider error is kept on `cause` for a debugger");
});
