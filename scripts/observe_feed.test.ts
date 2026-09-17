// Tests for scripts/observe_feed.ts, run with Node's built-in runner:
//     node --test scripts/observe_feed.test.ts
//
// Every case drives the script against a synthetic, labeled aggregator transcript built in this file: a fake
// `RpcCall` over an in-memory phase table whose round ids, timestamps, answers and block clock are all chosen
// here. No recorded mainnet response is checked in, so nothing in this suite depends on a network, a
// provider's quirks or a feed's real history - a test that failed would be a bug in the walk, not a stale
// fixture. The transcript records every call it served, which is how the phase-id packing is asserted: the
// test checks the exact calldata the proxy would have received.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {
  createBlockClock,
  decodeString,
  encodeCall,
  formatReport,
  jsonFragment,
  maxAgeForHeartbeat,
  nearestRank,
  observeFeed,
  packRoundId,
  parseArgs,
  percentiles,
  type RpcCall,
  RpcError,
  redact,
  toSigned256,
  unpackRoundId,
} from "./observe_feed.ts";

// ---------------------------------------------------------------------------
// The synthetic aggregator transcript
// ---------------------------------------------------------------------------

const FEED = "0xfeed000000000000000000000000000000000001";
const GENESIS_TIME = 1700000000;
const BLOCK_SECONDS = 3;
const HEAD_BLOCK = 1000000;
const HEAD_TIME = GENESIS_TIME + HEAD_BLOCK * BLOCK_SECONDS; // 1703000000

type FakeRound = {answer: bigint; updatedAt: number};

type FakePhase = {
  aggregator: string;
  /** aggregator round id -> round, contiguous unless a case deliberately deletes one. */
  rounds: Map<string, FakeRound>;
  /** Some deployments access-control `latestRound()`; false makes the fake revert it. */
  latestRoundReadable: boolean;
};

type FakeFeed = {
  decimals: number;
  description: string;
  phaseId: number;
  phases: Map<number, FakePhase>;
  /** The proxy's `latestRoundData()` round id, already packed. */
  latestPacked: bigint;
  /** Round ids (packed) whose call must fail with a non-revert error, e.g. a rate limit. */
  rateLimited: Set<string>;
};

type Transcript = {rpc: RpcCall; calls: {method: string; to?: string; data?: string}[]};

function hexWord(value: bigint): string {
  const unsigned = value < 0n ? (1n << 256n) + value : value;
  return unsigned.toString(16).padStart(64, "0");
}

function encodeRound(roundId: bigint, round: FakeRound): string {
  return `0x${[hexWord(roundId), hexWord(round.answer), hexWord(BigInt(round.updatedAt)), hexWord(BigInt(round.updatedAt)), hexWord(roundId)].join("")}`;
}

function encodeStringReturn(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const padded = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${hexWord(32n)}${hexWord(BigInt(bytes.length))}${padded}`;
}

function reverted(): RpcError {
  return new RpcError("execution reverted: No data present", 3);
}

/** A phase of `count` rounds ending at `topRound`, one every `stepSeconds`, ending at `endTime`. */
function makePhase(options: {
  aggregator: string;
  topRound: number;
  count: number;
  endTime: number;
  stepSeconds: number;
  answer?: (index: number) => bigint;
  latestRoundReadable?: boolean;
}): FakePhase {
  const rounds = new Map<string, FakeRound>();
  for (let i = 0; i < options.count; i++) {
    const round = BigInt(options.topRound - i);
    rounds.set(round.toString(), {
      answer: options.answer ? options.answer(i) : 60000000000n + BigInt(i) * 1000000n,
      updatedAt: options.endTime - i * options.stepSeconds,
    });
  }
  return {
    aggregator: options.aggregator,
    rounds,
    latestRoundReadable: options.latestRoundReadable ?? true,
  };
}

/** A JSON-RPC caller over the fake feed. Only the three read methods the script is allowed to send exist. */
function makeTranscript(feed: FakeFeed): Transcript {
  const calls: {method: string; to?: string; data?: string}[] = [];
  const rpc: RpcCall = async (method, params) => {
    if (method === "eth_blockNumber") {
      calls.push({method});
      return `0x${HEAD_BLOCK.toString(16)}`;
    }
    if (method === "eth_getBlockByNumber") {
      const number = Number(BigInt(String(params[0])));
      calls.push({method});
      return {
        number: String(params[0]),
        timestamp: `0x${(GENESIS_TIME + number * BLOCK_SECONDS).toString(16)}`,
      };
    }
    if (method !== "eth_call") throw new Error(`the script must not send ${method}`);
    const request: any = params[0];
    const to = String(request.to).toLowerCase();
    const data = String(request.data);
    calls.push({method, to, data});
    const selector = data.slice(0, 10);

    if (to === FEED) {
      if (selector === "0x313ce567") return `0x${hexWord(BigInt(feed.decimals))}`;
      if (selector === "0x7284e416") return encodeStringReturn(feed.description);
      if (selector === "0x58303b10") return `0x${hexWord(BigInt(feed.phaseId))}`;
      if (selector === "0xfeaf968c") {
        const {phase, aggregatorRound} = unpackRoundId(feed.latestPacked);
        const round = feed.phases.get(phase)?.rounds.get(aggregatorRound.toString());
        if (!round) throw reverted();
        return encodeRound(feed.latestPacked, round);
      }
      if (selector === "0xc1597304") {
        const phase = Number(BigInt(`0x${data.slice(10)}`));
        const aggregator = feed.phases.get(phase)?.aggregator;
        return `0x${hexWord(BigInt(aggregator ?? "0x0"))}`;
      }
      if (selector === "0x9a6fc8f5") {
        const packed = BigInt(`0x${data.slice(10)}`);
        if (feed.rateLimited.has(packed.toString())) throw new RpcError("limit exceeded", -32005);
        const {phase, aggregatorRound} = unpackRoundId(packed);
        const round = feed.phases.get(phase)?.rounds.get(aggregatorRound.toString());
        if (!round) throw reverted();
        return encodeRound(packed, round);
      }
      throw new Error(`unexpected selector ${selector} on the proxy`);
    }

    for (const [phase, entry] of feed.phases) {
      if (entry.aggregator.toLowerCase() !== to) continue;
      if (selector === "0x668a0f02") {
        if (!entry.latestRoundReadable) throw reverted();
        let top = 0n;
        for (const key of entry.rounds.keys()) top = BigInt(key) > top ? BigInt(key) : top;
        return `0x${hexWord(top)}`;
      }
      throw new Error(`unexpected selector ${selector} on phase ${phase}'s aggregator`);
    }
    throw reverted();
  };
  return {rpc, calls};
}

/**
 * One phase of 200 rounds (ids 1..200), 60 seconds apart, the newest 10 minutes before the head block.
 *
 * The ids start at 1 on purpose: a Chainlink phase numbers its aggregator rounds from 1, so a walk that
 * reaches round 1 has reached the phase boundary and must roll over rather than keep probing downwards.
 */
function singlePhaseFeed(overrides?: Partial<FakeFeed>): FakeFeed {
  const phase = makePhase({
    aggregator: "0xa66700000000000000000000000000000000000c",
    topRound: 200,
    count: 200,
    endTime: HEAD_TIME - 600,
    stepSeconds: 60,
  });
  return {
    decimals: 8,
    description: "BNB / USD",
    phaseId: 6,
    phases: new Map([[6, phase]]),
    latestPacked: packRoundId(6, 200n),
    rateLimited: new Set(),
    ...overrides,
  };
}

/** Phase 6 with 5 rounds sitting on top of phase 5 with 40 rounds: a real aggregator migration. */
function twoPhaseFeed(options?: {latestRoundReadable?: boolean}): FakeFeed {
  const newest = HEAD_TIME - 300;
  const phase6 = makePhase({
    aggregator: "0xa66700000000000000000000000000000000000c",
    topRound: 5,
    count: 5,
    endTime: newest,
    stepSeconds: 120,
  });
  const phase5 = makePhase({
    aggregator: "0xa55500000000000000000000000000000000000b",
    topRound: 40,
    count: 40,
    endTime: newest - 5 * 120,
    stepSeconds: 300,
    answer: (i) => 59000000000n - BigInt(i) * 2000000n,
    latestRoundReadable: options?.latestRoundReadable ?? true,
  });
  return {
    decimals: 8,
    description: "BNB / USD",
    phaseId: 6,
    phases: new Map([
      [6, phase6],
      [5, phase5],
    ]),
    latestPacked: packRoundId(6, 5n),
    rateLimited: new Set(),
  };
}

const RUN = {days: 365, concurrency: 4};

// ---------------------------------------------------------------------------
// Percentile math
// ---------------------------------------------------------------------------

describe("percentile math", () => {
  it("nearest-rank over 1..1000 gives the textbook p50, p99 and p99.9", () => {
    const sample = Array.from({length: 1000}, (_, i) => i + 1);
    assert.equal(nearestRank(sample, 500), 500);
    assert.equal(nearestRank(sample, 990), 990);
    // The float trap: 0.999 * 1000 is 999.0000000000001 in IEEE 754, so a ceil() over doubles would
    // return rank 1000 and report 1000 here. Integer ranks keep it at 999.
    assert.equal(nearestRank(sample, 999), 999);
  });

  it("percentiles sort the input and handle a tiny sample", () => {
    assert.deepEqual(percentiles([30, 10, 20]), {p50: 20, p99: 30, p999: 30});
    assert.deepEqual(percentiles([7]), {p50: 7, p99: 7, p999: 7});
  });

  it("p99.9 is the worst intervals, not the average", () => {
    // 990 quiet 30-second intervals and 10 stale 7,200-second ones: the mean would hide the stall.
    const intervals = [...Array.from({length: 990}, () => 30), ...Array.from({length: 10}, () => 7200)];
    const p = percentiles(intervals);
    assert.equal(p.p50, 30);
    assert.equal(p.p99, 30);
    assert.equal(p.p999, 7200);
  });

  it("nearestRank refuses an empty sample instead of returning undefined", () => {
    assert.throws(() => nearestRank([], 999), /empty sample/);
  });

  it("maxAge is max(2H, 3600)", () => {
    assert.equal(maxAgeForHeartbeat(60), 3600); // the floor wins
    assert.equal(maxAgeForHeartbeat(1800), 3600); // exactly at the crossover
    assert.equal(maxAgeForHeartbeat(1801), 3602);
    assert.equal(maxAgeForHeartbeat(86400), 172800); // the ADR 020 ceiling, still legal
  });
});

// ---------------------------------------------------------------------------
// Encoding and packing
// ---------------------------------------------------------------------------

describe("round id packing", () => {
  it("packs and unpacks (phaseId << 64) | aggregatorRoundId", () => {
    const packed = packRoundId(6, 1200n);
    assert.equal(packed, (6n << 64n) | 1200n);
    assert.equal(packed.toString(), "110680464442257310896");
    assert.deepEqual(unpackRoundId(packed), {phase: 6, aggregatorRound: 1200n});
  });

  it("treats a round id with empty high bits as a raw aggregator round", () => {
    assert.deepEqual(unpackRoundId(42n), {phase: 0, aggregatorRound: 42n});
  });

  it("encodes getRoundData(uint80) as the selector plus one word", () => {
    assert.equal(
      encodeCall("0x9a6fc8f5", [packRoundId(5, 40n)]),
      "0x9a6fc8f50000000000000000000000000000000000000000000000050000000000000028",
    );
  });

  it("decodes a negative int256 answer and a dynamic string", () => {
    assert.equal(toSigned256((1n << 256n) - 5n), -5n);
    assert.equal(decodeString(encodeStringReturn("BNB / USD")), "BNB / USD");
  });
});

// ---------------------------------------------------------------------------
// Walking one phase
// ---------------------------------------------------------------------------

describe("single-phase walk", () => {
  it("reads every round in the window and reports the interval distribution", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.equal(observation.samples.length, 200);
    assert.equal(observation.intervals.length, 199);
    assert.equal(observation.missing, 0);
    assert.deepEqual(observation.percentiles, {p50: 60, p99: 60, p999: 60});
    assert.equal(observation.decimals, 8);
    assert.equal(observation.description, "BNB / USD");
    assert.equal(observation.proxyPhaseId, 6);
    assert.equal(observation.packed, true);
    assert.deepEqual(
      observation.phases.map((p) => p.phase),
      [6],
    );
    assert.equal(observation.phases[0].samples, 200);
  });

  it("reports the observed min and max answer over the window", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    // answer(i) = 600.00000000 + i * 0.01000000 over 200 rounds.
    assert.equal(observation.minAnswer, 60000000000n);
    assert.equal(observation.maxAnswer, 60000000000n + 199n * 1000000n);
  });

  it("stops at the cutoff, keeping the round that straddles the window start", async () => {
    // 200 rounds 60 s apart span 199 minutes; a 1-hour window reaches 60 of them plus the straddling one.
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, days: 1 / 24, concurrency: 4});
    assert.equal(observation.reachedCutoff, true);
    assert.ok(observation.samples[0].updatedAt <= observation.cutoff, "oldest sample straddles the cutoff");
    assert.ok(observation.samples[1].updatedAt > observation.cutoff, "only one sample is outside the window");
    assert.ok(observation.samples.length < 200, "the walk stopped early");
  });

  it("flags a window that ran out of history before the cutoff", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    assert.equal(observation.reachedCutoff, false);
    const lines = formatReport(observation, {heartbeatSeconds: 60});
    assert.ok(
      lines.some((l) => l.includes("history ended before the cutoff")),
      lines.join("\n"),
    );
  });

  it("stops at --max-samples and says the window is short", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, days: 365, concurrency: 4, maxSamples: 20});
    assert.equal(observation.truncated, true);
    assert.equal(observation.samples.length, 20);
    const lines = formatReport(observation, {heartbeatSeconds: 60});
    assert.ok(
      lines.some((l) => l.includes("--max-samples before the cutoff")),
      lines.join("\n"),
    );
  });

  it("does not look for a previous phase on a raw, unpacked aggregator", async () => {
    const raw = singlePhaseFeed({phaseId: 0, phases: new Map(), latestPacked: 0n});
    raw.phases.set(
      0,
      makePhase({
        aggregator: "0xa00000000000000000000000000000000000000a",
        topRound: 30,
        count: 30,
        endTime: HEAD_TIME - 60,
        stepSeconds: 45,
      }),
    );
    raw.latestPacked = 30n;
    const {rpc, calls} = makeTranscript(raw);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    assert.equal(observation.packed, false);
    assert.equal(observation.samples.length, 30);
    assert.ok(!calls.some((c) => c.data?.startsWith("0xc1597304")), "phaseAggregators must not be called");
  });
});

// ---------------------------------------------------------------------------
// Phase rollover
// ---------------------------------------------------------------------------

describe("phase rollover", () => {
  it("crosses the phase boundary through phaseAggregators and keeps walking", async () => {
    const {rpc, calls} = makeTranscript(twoPhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.equal(observation.samples.length, 45, "5 rounds in phase 6 plus 40 in phase 5");
    assert.deepEqual(
      observation.phases.map((p) => p.phase),
      [6, 5],
    );
    assert.equal(observation.phases[0].samples, 5);
    assert.equal(observation.phases[1].samples, 40);
    assert.equal(observation.phases[1].topRound, 40n);
    assert.ok(
      calls.some((c) => c.data?.startsWith("0xc1597304")),
      "phaseAggregators(uint16) was asked",
    );
  });

  it("asks the proxy for previous-phase rounds with the correct (phase << 64) | round packing", async () => {
    const {rpc, calls} = makeTranscript(twoPhaseFeed());
    await observeFeed(rpc, {feed: FEED, ...RUN});
    const expected = encodeCall("0x9a6fc8f5", [packRoundId(5, 40n)]);
    assert.ok(
      calls.some((c) => c.data === expected),
      `no call carried the packed phase-5 top round ${expected}`,
    );
    // Nothing may be requested as a bare round id once the proxy reports a nonzero phase: an unpacked 40
    // would read phase 0 and silently return the wrong aggregator's history.
    const unpacked = encodeCall("0x9a6fc8f5", [40n]);
    assert.ok(!calls.some((c) => c.data === unpacked), "an unpacked round id was sent to the proxy");
  });

  it("falls back to probing the proxy when the phase aggregator's latestRound() is access-controlled", async () => {
    const {rpc, calls} = makeTranscript(twoPhaseFeed({latestRoundReadable: false}));
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    assert.equal(observation.samples.length, 45, "the fallback found the same phase-5 top round");
    assert.equal(observation.phases[1].topRound, 40n);
    assert.equal(observation.phases[1].topFromFallback, true);
    assert.equal(observation.phases[0].topFromFallback, false, "the head phase is never probed for");
    assert.ok(
      calls.some((c) => c.data === "0x668a0f02"),
      "latestRound() was tried first",
    );
    // A probed top is this script's guess, not the aggregator's own answer, so the report has to say which
    // phase was entered that way before an operator copies the p99.9 into a price record.
    const lines = formatReport(observation, {heartbeatSeconds: 600});
    assert.ok(
      lines.some((l) => l.startsWith("WARNING") && l.includes("phase 5") && l.includes("latestRound()")),
      lines.join("\n"),
    );
  });

  it("does not take a hole at a probe point for the top of the previous phase", async () => {
    // Phase 5 has 40 rounds and its `latestRound()` is access-controlled, so the top is probed. Round 32 is
    // deleted, and 32 is both a power of two the doubling lands on and a midpoint the bisection lands on: a
    // fallback that reads one missing round as "past the top" settles on 31 and silently drops rounds
    // 33..40. That is the dangerous shape of this bug - nothing is reported as missing, no warning is
    // printed, and the p99.9 changes (2820 s instead of 600 s) because the phase-6/phase-5 boundary interval
    // is measured across an eight-round hole that the feed never had.
    const feed = twoPhaseFeed({latestRoundReadable: false});
    const phase5 = feed.phases.get(5);
    assert.ok(phase5);
    phase5.rounds.delete("32");

    const {rpc, calls} = makeTranscript(feed);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.equal(observation.phases[1].topRound, 40n, "the real top, above the hole");
    assert.equal(observation.samples.length, 44, "5 rounds in phase 6 plus 39 of phase 5's 40");
    assert.equal(observation.missing, 1, "exactly the one deleted round, counted by the walk");
    assert.equal(observation.percentiles.p999, 600, "one doubled 300 s step, not a truncated history");
    assert.ok(!observation.samples.some((s) => s.phase === 5 && s.aggregatorRound === 32n));
    assert.equal(observation.samples.filter((s) => s.phase === 5 && s.aggregatorRound > 32n).length, 8);
    // Tolerance is not a licence to scan: each doubling or bisection step that lands on empty space costs at
    // most MISS_TOLERANCE reads, so the whole run stays a few hundred calls rather than one per round id.
    assert.ok(calls.length < 400, `the fallback probed ${calls.length} times`);
  });

  it("steps down to a present round when the probed top is itself a hole", async () => {
    // The search can settle on a round that is missing but has present rounds under it - phase 5's very top
    // pruned, say. Entering the phase there would start the walk at a round the proxy reverts for, so the
    // fallback steps down to the last round that actually answers.
    const feed = twoPhaseFeed({latestRoundReadable: false});
    const phase5 = feed.phases.get(5);
    assert.ok(phase5);
    phase5.rounds.delete("40");

    const {rpc} = makeTranscript(feed);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.equal(observation.phases[1].topRound, 39n);
    assert.equal(observation.samples.length, 44);
    assert.equal(observation.phases[1].samples, 39);
  });

  it("measures the interval that spans the phase boundary", async () => {
    const {rpc} = makeTranscript(twoPhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    // phase 6 steps 120 s, phase 5 steps 300 s, and the boundary gap is one 120 s step by construction.
    assert.equal(observation.intervals.filter((i) => i === 300).length, 39);
    assert.equal(observation.intervals.filter((i) => i === 120).length, 5);
    assert.deepEqual(observation.percentiles, {p50: 300, p99: 300, p999: 300});
  });
});

// ---------------------------------------------------------------------------
// Missing rounds
// ---------------------------------------------------------------------------

describe("missing rounds", () => {
  it("counts a hole in the middle of a phase as a gap and keeps walking through it", async () => {
    const feed = singlePhaseFeed();
    const phase = feed.phases.get(6);
    assert.ok(phase);
    const before = phase.rounds.get("101");
    const after = phase.rounds.get("99");
    assert.ok(before && after);
    phase.rounds.delete("100");

    const {rpc} = makeTranscript(feed);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.equal(observation.missing, 1);
    assert.equal(observation.samples.length, 199, "one round short of the 200 that exist");
    assert.ok(!observation.samples.some((s) => s.aggregatorRound === 100n));
    // The two surviving neighbours are 120 s apart, and that longer interval is what the feed really did.
    assert.equal(before.updatedAt - after.updatedAt, 120);
    assert.equal(observation.intervals.filter((i) => i === 120).length, 1);
    assert.equal(observation.percentiles.p999, 120);
  });

  it("treats a long run of missing rounds as the bottom of the phase and rolls over", async () => {
    // Phase 6's aggregator answers only for rounds 496..500: everything below reverts even though the ids
    // run down to 1, which is how a pruned or partially indexed history looks from an RPC. The walk may not
    // give up on the whole observation there - it has to conclude the phase is exhausted and cross over.
    const feed = twoPhaseFeed();
    const phase6 = feed.phases.get(6);
    assert.ok(phase6);
    feed.phases.set(
      6,
      makePhase({
        aggregator: phase6.aggregator,
        topRound: 500,
        count: 5,
        endTime: HEAD_TIME - 300,
        stepSeconds: 120,
      }),
    );
    feed.latestPacked = packRoundId(6, 500n);

    const {rpc} = makeTranscript(feed);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});

    assert.deepEqual(
      observation.phases.map((p) => p.phase),
      [6, 5],
    );
    assert.ok(observation.phases[0].missing >= 32, "the miss tolerance was reached before rolling over");
    assert.equal(observation.phases[1].samples, 40, "phase 5 was still walked in full");
    assert.equal(observation.samples.length, 45);
  });

  it("does not mistake a rate limit for a missing round", async () => {
    const feed = singlePhaseFeed();
    feed.rateLimited.add(packRoundId(6, 150n).toString());
    const {rpc} = makeTranscript(feed);
    await assert.rejects(
      () => observeFeed(rpc, {feed: FEED, ...RUN}),
      /limit exceeded/,
      "a -32005 must abort the run, never shorten the observed history",
    );
  });

  it("refuses a window with fewer than two rounds instead of inventing a percentile", async () => {
    const feed = singlePhaseFeed({
      phases: new Map([
        [
          6,
          makePhase({
            aggregator: "0xa66700000000000000000000000000000000000c",
            topRound: 1,
            count: 1,
            endTime: HEAD_TIME - 60,
            stepSeconds: 60,
          }),
        ],
      ]),
      latestPacked: packRoundId(6, 1n),
    });
    const {rpc} = makeTranscript(feed);
    await assert.rejects(() => observeFeed(rpc, {feed: FEED, ...RUN}), /only 1 round\(s\) found/);
  });

  it("refuses an address that is not an AggregatorV3 feed", async () => {
    const rpc: RpcCall = async (method, _params) => {
      if (method === "eth_blockNumber") return `0x${HEAD_BLOCK.toString(16)}`;
      if (method === "eth_getBlockByNumber") return {timestamp: `0x${HEAD_TIME.toString(16)}`};
      throw new RpcError("execution reverted", 3);
    };
    await assert.rejects(() => observeFeed(rpc, {feed: FEED, ...RUN}), /not an AggregatorV3 feed/);
  });
});

// ---------------------------------------------------------------------------
// Block window
// ---------------------------------------------------------------------------

describe("observation window blocks", () => {
  it("bisects block timestamps to the block at or before a sample", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const clock = createBlockClock(rpc);
    const target = GENESIS_TIME + 12345 * BLOCK_SECONDS + 1; // one second after block 12345
    assert.equal(await clock.atOrBefore(target, HEAD_BLOCK), 12345);
    assert.equal(await clock.atOrBefore(GENESIS_TIME + 777 * BLOCK_SECONDS, HEAD_BLOCK), 777);
    assert.equal(await clock.atOrBefore(HEAD_TIME + 99, HEAD_BLOCK), HEAD_BLOCK, "clamped to the head");
  });

  it("derives fromBlock and toBlock from the oldest and newest samples", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const oldest = observation.samples[0].updatedAt;
    const newest = observation.samples[observation.samples.length - 1].updatedAt;
    assert.equal(observation.fromBlock, Math.floor((oldest - GENESIS_TIME) / BLOCK_SECONDS));
    assert.equal(observation.toBlock, Math.floor((newest - GENESIS_TIME) / BLOCK_SECONDS));
    assert.ok(observation.fromBlock < observation.toBlock);
    assert.ok(observation.toBlock <= observation.headBlock);
  });
});

// ---------------------------------------------------------------------------
// Report, maxAge flag and the pasteable fragment
// ---------------------------------------------------------------------------

describe("report", () => {
  it("prints the exact price-record fragment and it parses as the schema shape", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const fragment = JSON.parse(jsonFragment(observation));
    assert.deepEqual(Object.keys(fragment), ["observedP999IntervalSeconds", "observationWindow"]);
    assert.equal(fragment.observedP999IntervalSeconds, observation.percentiles.p999);
    assert.deepEqual(Object.keys(fragment.observationWindow), ["fromBlock", "toBlock", "samples"]);
    assert.equal(fragment.observationWindow.fromBlock, observation.fromBlock);
    assert.equal(fragment.observationWindow.toBlock, observation.toBlock);
    assert.equal(fragment.observationWindow.samples, observation.samples.length);
    assert.ok(formatReport(observation).join("\n").includes(jsonFragment(observation)));
  });

  it("prints maxAge = max(2H, 3600) and passes a feed inside it", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const lines = formatReport(observation, {heartbeatSeconds: 60});
    assert.ok(lines.some((l) => l.includes("maxAge = max(2H, 3600) with H=60 -> maxPriceAge=3600")));
    assert.ok(lines.some((l) => l.startsWith("ok observed p99.9 interval 60s is within maxPriceAge 3600s")));
    assert.ok(!lines.some((l) => l.startsWith("FAIL")));
  });

  it("fails the feed when the observed p99.9 exceeds maxAge", async () => {
    const feed = singlePhaseFeed();
    const phase = feed.phases.get(6);
    assert.ok(phase);
    // One 4-hour stall in an otherwise 60-second feed: exactly the case maxPriceAge has to survive.
    for (let r = 150; r >= 1; r--) {
      const round = phase.rounds.get(String(r));
      if (round) round.updatedAt -= 14400;
    }
    const {rpc} = makeTranscript(feed);
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    assert.equal(observation.percentiles.p999, 14460);
    const lines = formatReport(observation, {heartbeatSeconds: 60});
    assert.ok(
      lines.some((l) => l.startsWith("FAIL observed p99.9 interval 14460s exceeds maxPriceAge 3600s")),
      lines.join("\n"),
    );
  });

  it("says so when no heartbeat was supplied instead of guessing one", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const lines = formatReport(observation);
    assert.ok(lines.some((l) => l.includes("pass --heartbeat")));
    assert.ok(!lines.some((l) => l.includes("maxPriceAge=")));
  });

  it("rejects a heartbeat whose maxAge leaves the ADR 020 bounds", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const lines = formatReport(observation, {heartbeatSeconds: 90000});
    assert.ok(lines.some((l) => l.includes("FAIL maxPriceAge=180000 is outside the 60..172800 bounds")));
  });

  it("refuses to print a fragment whose observationWindow is inverted", async () => {
    // `validate_config.ts` requires fromBlock <= toBlock, so a fragment that breaks it is a paste the
    // operator would only discover was wrong two commands later. Timestamps that went backwards, or a
    // reorged head, can produce one; say so on the spot instead.
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    const inverted = {...observation, fromBlock: observation.toBlock + 1};
    const lines = formatReport(inverted, {heartbeatSeconds: 60});
    assert.ok(
      lines.some((l) => l.startsWith("FAIL") && l.includes("fromBlock") && l.includes("observationWindow")),
      lines.join("\n"),
    );
    assert.ok(!lines.some((l) => l.includes("observedP999IntervalSeconds")), "the fragment is withheld");
    // The healthy observation is untouched by the new check.
    const healthy = formatReport(observation, {heartbeatSeconds: 60});
    assert.ok(!healthy.some((l) => l.startsWith("FAIL")));
    assert.ok(healthy.join("\n").includes(jsonFragment(observation)));
  });

  it("never prints the RPC URL", async () => {
    const {rpc} = makeTranscript(singlePhaseFeed());
    const observation = await observeFeed(rpc, {feed: FEED, ...RUN});
    for (const line of formatReport(observation, {heartbeatSeconds: 60})) {
      assert.equal(redact(line), line, `a report line would need redacting: ${line}`);
      assert.ok(!/https?:\/\//.test(line), `a report line carried a URL: ${line}`);
    }
    assert.equal(
      redact('server response 500 requestUrl="https://ops.example/v1/SECRET?key=SECRET" code=SERVER_ERROR'),
      'server response 500 requestUrl="<rpc>" code=SERVER_ERROR',
    );
    assert.equal(
      new RpcError("eth_call to https://ops.example/v1/SECRET failed", -1).message.includes("SECRET"),
      false,
    );
    assert.equal(redact("no url here"), "no url here");
  });
});

// ---------------------------------------------------------------------------
// CLI surface and the read-only promise
// ---------------------------------------------------------------------------

describe("command line", () => {
  it("takes the RPC URL from the environment so it stays out of shell history", () => {
    const args = parseArgs(["--feed", FEED, "--days", "30", "--heartbeat", "60"], {
      LUCKYDRAW_OPS_RPC_URL: "https://ops.example/v1/SECRET",
    });
    assert.equal(args.rpcUrl, "https://ops.example/v1/SECRET");
    assert.equal(args.feed, FEED);
    assert.equal(args.days, 30);
    assert.equal(args.heartbeatSeconds, 60);
    assert.equal(args.concurrency, 8);
    assert.equal(args.maxSamples, 50000);
  });

  it("lets --rpc-url override the environment and lowercases the feed", () => {
    const args = parseArgs(
      ["--rpc-url", "https://a.example", "--feed", FEED.toUpperCase().replace("0X", "0x")],
      {
        LUCKYDRAW_OPS_RPC_URL: "https://b.example",
      },
    );
    assert.equal(args.rpcUrl, "https://a.example");
    assert.equal(args.feed, FEED);
    assert.equal(args.heartbeatSeconds, null);
  });

  it("refuses a missing endpoint, a bad feed, a bad window and an unknown flag", () => {
    assert.throws(() => parseArgs(["--feed", FEED], {}), /--rpc-url or LUCKYDRAW_OPS_RPC_URL is required/);
    assert.throws(() => parseArgs(["--rpc-url", "u", "--feed", "0x123"], {}), /--feed must be a 0x address/);
    assert.throws(
      () => parseArgs(["--rpc-url", "u", "--feed", FEED, "--days", "0"], {}),
      /--days must be a positive/,
    );
    assert.throws(() => parseArgs(["--rpc-url", "u", "--feed", FEED, "--heartbeat", "x"], {}), /--heartbeat/);
    assert.throws(() => parseArgs(["--rpc-url", "u", "--feed", FEED, "--nope"], {}), /unknown argument/);
    assert.throws(() => parseArgs(["--rpc-url"], {}), /--rpc-url needs a value/);
  });

  it("is read-only: the script cannot touch the filesystem", () => {
    const source = readFileSync(new URL("./observe_feed.ts", import.meta.url), "utf8");
    assert.ok(!/from "node:fs/.test(source), "observe_feed.ts must not import a filesystem module");
    assert.ok(!/writeFileSync|createWriteStream|appendFile/.test(source));
    assert.ok(!source.includes("\r\n"), "the file must use LF endings");
  });

  it("sends only the three read methods it needs", async () => {
    const {rpc, calls} = makeTranscript(singlePhaseFeed());
    await observeFeed(rpc, {feed: FEED, ...RUN});
    const methods = new Set(calls.map((c) => c.method));
    assert.deepEqual([...methods].sort(), ["eth_blockNumber", "eth_call", "eth_getBlockByNumber"]);
  });
});
