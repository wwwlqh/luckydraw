// LuckyDraw feed observation (SPEC sections 3.1 and 15, wave 7 item 3).
//
// Reads a Chainlink AggregatorV3 proxy's round history over a window of days and reports the update-interval
// distribution an asset price record has to carry: `observedP999IntervalSeconds` and the
// `observationWindow` that measurement was taken in. It also prints `maxAge = max(2H, 3600)` for a supplied
// heartbeat H and says whether the observed p99.9 fits inside it (ADR 020), which is the number the operator
// needs before admitting a feed on mainnet.
//
// Read-only in two senses: it sends only `eth_call`, `eth_blockNumber` and `eth_getBlockByNumber`, and it
// writes no file. `node:fs` is deliberately not imported, so the script cannot touch `config/` even by
// accident - the operator pastes the printed fragment in by hand.
//
// No dependency. The workspace pins ethers 6.17.0, but only inside `packages/client` and `keeper`; the
// repository root has no ethers and adding one is a `package.json` edit this script does not own. The reads
// here are six constant selectors and five static words of return data, so raw JSON-RPC over `fetch` with
// hand-encoded calldata costs less than the dependency would. Selectors below were checked with
// `cast sig` against the EACAggregatorProxy ABI.
//
// Runs under plain `node scripts/observe_feed.ts` on Node 24 (LTS, pinned in .nvmrc) and Node 25: both strip
// types natively, so this file stays inside the erasable TypeScript subset - no enums, no namespaces, no
// parameter properties, no runtime-visible type syntax.
//
// Usage:
//   node scripts/observe_feed.ts --rpc-url <url> --feed <proxy> [--days 30] [--heartbeat <seconds>]
//                                [--concurrency 8] [--max-samples 50000]
//   LUCKYDRAW_OPS_RPC_URL=<url> node scripts/observe_feed.ts --feed <proxy> --days 30 --heartbeat 60
//
// The RPC URL is usually itself a credential. Prefer the environment variable so it never reaches shell
// history, and note that every line this script prints passes through `redact()` first.

import {pathToFileURL} from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Function selectors on an EACAggregatorProxy. Verified with `cast sig` (Foundry). */
const SELECTOR = {
  decimals: "0x313ce567", // decimals()
  description: "0x7284e416", // description()
  latestRoundData: "0xfeaf968c", // latestRoundData()
  getRoundData: "0x9a6fc8f5", // getRoundData(uint80)
  phaseId: "0x58303b10", // phaseId()
  phaseAggregators: "0xc1597304", // phaseAggregators(uint16)
  latestRound: "0x668a0f02", // latestRound() - on the phase aggregator, not the proxy
};

const MAX_UINT64: bigint = (1n << 64n) - 1n;
const TWO_POW_255: bigint = 1n << 255n;
const TWO_POW_256: bigint = 1n << 256n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** SPEC section 3.1 / ADR 020: maxPriceAge floor and the Types.sol bounds it must stay inside. */
const MAX_AGE_FLOOR = 3600;
const MIN_PRICE_AGE = 60;
const MAX_PRICE_AGE = 172800;

/**
 * Consecutive reverting round ids that end a phase walk.
 *
 * A phase's aggregator round ids are contiguous from 1, so one revert is a hole and a run of them is the
 * bottom of the phase. The tolerance is generous because an RPC that answers a historical `eth_call` from a
 * pruned state root can report a missing round for a round that does exist; a real bottom produces an
 * unbounded run, so a wrong guess here costs a few calls, never a wrong statistic.
 */
const MISS_TOLERANCE = 32;

const DEFAULT_DAYS = 30;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_SAMPLES = 50000;
const DEFAULT_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Any absolute http(s) URL, including a surrounding quote a provider error often wraps it in.
 *
 * Mirrors `keeper/src/log.ts`: an operational RPC endpoint frequently *is* the credential (a key in the path
 * or the query), and a transport error quotes the request URL verbatim, so no printed line may carry one.
 */
const URL_LIKE = /\bhttps?:\/\/[^\s"'\\]*/gi;

/** A line with every absolute URL replaced by `<rpc>`. Every output of this script passes through it. */
export function redact(value: string): string {
  return value.replace(URL_LIKE, "<rpc>");
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

/** One JSON-RPC call. Tests supply a synthetic transcript in place of the HTTP version. */
export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** A JSON-RPC error carrying the node's numeric code, so a revert can be told from a rate limit. */
export class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(redact(message));
    this.name = "RpcError";
    this.code = code;
  }
}

/**
 * True when an `eth_call` failure means "this round does not exist" rather than "the endpoint is unhappy".
 *
 * EIP-1474 gives reverts code 3; several nodes use -32000 with a revert message instead. A 429, a timeout or
 * a pruned-state error must never be silently counted as a missing round, because that would shorten the
 * observed history and understate the p99.9 interval.
 */
export function isRevert(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  if (error.code === 3) return true;
  return /revert|no data present|nonexistent|invalid round/i.test(error.message);
}

/** A JSON-RPC caller over HTTP. The URL never leaves this closure except through `redact()`. */
export function createHttpRpc(url: string, timeoutMs?: number): RpcCall {
  let nextId = 1;
  return async (method, params) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: nextId++, method, params}),
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new RpcError(`${method} transport failure: ${String(cause)}`, -1);
    }
    if (!response.ok) {
      throw new RpcError(`${method} http ${response.status}`, -response.status);
    }
    const body: any = await response.json();
    if (body?.error) {
      const code = typeof body.error.code === "number" ? body.error.code : -32603;
      throw new RpcError(`${method}: ${String(body.error.message ?? "unknown error")}`, code);
    }
    return body?.result;
  };
}

// ---------------------------------------------------------------------------
// ABI encoding and decoding, by hand
// ---------------------------------------------------------------------------

/** A uint as one 32-byte big-endian word, without the `0x`. */
function word(value: bigint): string {
  if (value < 0n) throw new Error("cannot encode a negative word");
  return value.toString(16).padStart(64, "0");
}

/** `selector + word(arg)*`. */
export function encodeCall(selector: string, args?: readonly bigint[]): string {
  return selector + (args ?? []).map(word).join("");
}

/** Return data split into 32-byte words as unsigned bigints. */
export function decodeWords(data: string): bigint[] {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length % 64 !== 0)
    throw new Error(`return data is not a whole number of words (${body.length} hex)`);
  const words: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return words;
}

/** A word read as int256 (Chainlink answers are signed and a clamped feed can report a negative one). */
export function toSigned256(value: bigint): bigint {
  return value >= TWO_POW_255 ? value - TWO_POW_256 : value;
}

/** A word read as a checksum-free lowercase address. */
function toAddress(value: bigint): string {
  return `0x${value.toString(16).padStart(40, "0").slice(-40)}`;
}

/** An ABI-encoded dynamic `string` return value, or null when the data is not one. */
export function decodeString(data: string): string | null {
  try {
    const words = decodeWords(data);
    if (words.length < 3) return null;
    const length = Number(words[1]);
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const body = (data.startsWith("0x") ? data.slice(2) : data).slice(128, 128 + length * 2);
    if (body.length < length * 2) return null;
    return Buffer.from(body, "hex").toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy round id packing
// ---------------------------------------------------------------------------

/** `roundId = (phaseId << 64) | aggregatorRoundId`, the EACAggregatorProxy packing. */
export function packRoundId(phase: number, aggregatorRound: bigint): bigint {
  if (phase < 0 || !Number.isInteger(phase)) throw new Error(`phase ${phase} is not a non-negative integer`);
  if (aggregatorRound < 0n || aggregatorRound > MAX_UINT64) throw new Error("aggregator round out of uint64");
  return (BigInt(phase) << 64n) | aggregatorRound;
}

/** The inverse of `packRoundId`. A packed id whose high bits are 0 is a raw aggregator round id. */
export function unpackRoundId(packed: bigint): {phase: number; aggregatorRound: bigint} {
  return {phase: Number(packed >> 64n), aggregatorRound: packed & MAX_UINT64};
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile: the smallest value whose rank is at least `permille/1000` of the sample.
 *
 * `permille` is an integer (500, 990, 999) and the rank is computed with integer arithmetic on purpose:
 * `Math.ceil(0.999 * 1000)` is 1000 in IEEE 754 where the exact answer is 999, and an off-by-one in the p99.9
 * rank is exactly the kind of error that would put a feed's `maxPriceAge` one round too low.
 */
export function nearestRank(sortedAscending: readonly number[], permille: number): number {
  const n = sortedAscending.length;
  if (n === 0) throw new Error("nearestRank of an empty sample");
  const rank = Math.floor((n * permille + 999) / 1000);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAscending[index];
}

export type Percentiles = {p50: number; p99: number; p999: number};

/** p50, p99 and p99.9 of update intervals. The input need not be sorted. */
export function percentiles(intervals: readonly number[]): Percentiles {
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 500),
    p99: nearestRank(sorted, 990),
    p999: nearestRank(sorted, 999),
  };
}

/** SPEC section 3.1: `maxPriceAge = max(2H, 3600)`. */
export function maxAgeForHeartbeat(heartbeatSeconds: number): number {
  return Math.max(2 * heartbeatSeconds, MAX_AGE_FLOOR);
}

// ---------------------------------------------------------------------------
// Typed reads
// ---------------------------------------------------------------------------

export type RoundData = {
  roundId: bigint;
  answer: bigint;
  startedAt: number;
  updatedAt: number;
  answeredInRound: bigint;
};

/** `eth_call` against a pinned block. Returns null when the call reverts or yields no data. */
async function ethCall(rpc: RpcCall, to: string, data: string, blockTag: string): Promise<string | null> {
  let result: unknown;
  try {
    result = await rpc("eth_call", [{to, data}, blockTag]);
  } catch (error) {
    if (isRevert(error)) return null;
    throw error;
  }
  if (typeof result !== "string" || result === "0x" || result === "") return null;
  return result;
}

/** One five-word AggregatorV3 tuple, or null when the round is missing. */
async function readRound(
  rpc: RpcCall,
  to: string,
  data: string,
  blockTag: string,
): Promise<RoundData | null> {
  const raw = await ethCall(rpc, to, data, blockTag);
  if (raw === null) return null;
  const words = decodeWords(raw);
  if (words.length < 5) return null;
  const updatedAt = Number(words[3]);
  // A proxy that answers instead of reverting reports a never-updated round as updatedAt == 0.
  if (updatedAt === 0) return null;
  return {
    roundId: words[0],
    answer: toSigned256(words[1]),
    startedAt: Number(words[2]),
    updatedAt,
    answeredInRound: words[4],
  };
}

/** The proxy's view of one round id, missing rounds included. */
export async function getRoundData(
  rpc: RpcCall,
  feed: string,
  packed: bigint,
  blockTag: string,
): Promise<RoundData | null> {
  return readRound(rpc, feed, encodeCall(SELECTOR.getRoundData, [packed]), blockTag);
}

/** A phase's top round and how it was learned: `fromFallback` means probed, not read from the aggregator. */
export type PhaseTop = {round: bigint; fromFallback: boolean};

/**
 * True when `round` looks like it is *past* the top of `phase` rather than sitting in a hole.
 *
 * One missing round proves nothing. A phase's ids are contiguous from 1 in principle, but an RPC answering a
 * historical `eth_call` from a pruned state root reports holes, which is exactly why the walk itself only
 * ends a phase after `MISS_TOLERANCE` consecutive misses. The top has to be read with the same rule: a
 * candidate counts as past the top only when it and the next `MISS_TOLERANCE - 1` ids are *all* missing.
 * Checking upwards is what separates the two cases - above a real top every id is absent, while above a hole
 * the ids come back within a round or two, so this returns false on its very first call.
 *
 * Cost is bounded: a present candidate costs one call, and only a genuinely empty stretch costs the full
 * `MISS_TOLERANCE`, which at most `log2(top)` times over the doubling and the bisection is a few hundred
 * calls on a feed with tens of thousands of rounds.
 */
async function isPastTop(
  rpc: RpcCall,
  feed: string,
  phase: number,
  round: bigint,
  blockTag: string,
): Promise<boolean> {
  for (let i = 0n; i < BigInt(MISS_TOLERANCE); i++) {
    const id = round + i;
    if (id > MAX_UINT64) break;
    if ((await getRoundData(rpc, feed, packRoundId(phase, id), blockTag)) !== null) return false;
  }
  return true;
}

/**
 * The highest aggregator round id in `phase`, used to enter a phase from the top when the walk rolls over.
 *
 * First ask `phaseAggregators(phase)` for that phase's aggregator and read its own `latestRound()`. That call
 * is access-controlled on modern Chainlink aggregators; an `eth_call` from the zero address satisfies the
 * usual `msg.sender == tx.origin` reader check, but not every deployment, so the fallback probes the proxy
 * itself: double a candidate round until it is past the top, then bisect. The answer then carries
 * `fromFallback: true`, because a probed top is this function's inference and the report has to say so.
 */
export async function phaseTopRound(
  rpc: RpcCall,
  feed: string,
  phase: number,
  blockTag: string,
): Promise<PhaseTop | null> {
  const aggregatorWord = await ethCall(
    rpc,
    feed,
    encodeCall(SELECTOR.phaseAggregators, [BigInt(phase)]),
    blockTag,
  );
  if (aggregatorWord !== null) {
    const aggregator = toAddress(decodeWords(aggregatorWord)[0]);
    if (aggregator === ZERO_ADDRESS) return null;
    const latest = await ethCall(rpc, aggregator, SELECTOR.latestRound, blockTag);
    if (latest !== null) {
      const round = decodeWords(latest)[0];
      if (round > 0n && round <= MAX_UINT64) return {round, fromFallback: false};
    }
  }
  // Fallback: probe the proxy, treating a hole as a hole (see isPastTop) rather than as the end of the phase.
  if (await isPastTop(rpc, feed, phase, 1n, blockTag)) return null;
  let low = 1n; // not past the top
  let high = 2n;
  while (high <= MAX_UINT64 && !(await isPastTop(rpc, feed, phase, high, blockTag))) {
    low = high;
    high *= 2n;
  }
  while (low + 1n < high) {
    const mid = (low + high) / 2n;
    if (await isPastTop(rpc, feed, phase, mid, blockTag)) high = mid;
    else low = mid;
  }
  // `low` brackets the top but need not *be* a present round, so step down to the last id that answers: the
  // walk has to enter the phase at a real round, otherwise its first reads are misses against a round the
  // proxy will never serve. A stretch of `MISS_TOLERANCE` misses below `low` is the same "phase is over"
  // signal the walk uses, so give up rather than guess further down.
  for (let i = 0n; i < BigInt(MISS_TOLERANCE) && low - i >= 1n; i++) {
    const round = low - i;
    if ((await getRoundData(rpc, feed, packRoundId(phase, round), blockTag)) !== null) {
      return {round, fromFallback: true};
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block window
// ---------------------------------------------------------------------------

/** Block number and timestamp, cached so the two boundary searches share their probes. */
export type BlockClock = {
  timestampOf(blockNumber: number): Promise<number>;
  atOrBefore(timestamp: number, head: number): Promise<number>;
};

export function createBlockClock(rpc: RpcCall): BlockClock {
  const cache = new Map<number, number>();
  const timestampOf = async (blockNumber: number): Promise<number> => {
    const hit = cache.get(blockNumber);
    if (hit !== undefined) return hit;
    const block: any = await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
    if (!block || typeof block.timestamp !== "string")
      throw new Error(`block ${blockNumber} has no timestamp`);
    const timestamp = Number(BigInt(block.timestamp));
    cache.set(blockNumber, timestamp);
    return timestamp;
  };
  return {
    timestampOf,
    /**
     * The highest block whose timestamp is at or before `timestamp`.
     *
     * `getRoundData` returns no block number, so the observation window's block bounds are derived from the
     * sample timestamps by bisection over block timestamps, which are monotonic on BSC.
     */
    async atOrBefore(timestamp, head) {
      if ((await timestampOf(head)) <= timestamp) return head;
      let low = 0;
      let high = head;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if ((await timestampOf(mid)) <= timestamp) low = mid;
        else high = mid - 1;
      }
      return low;
    },
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export type Sample = {phase: number; aggregatorRound: bigint; answer: bigint; updatedAt: number};

export type PhaseWalk = {
  phase: number;
  topRound: bigint;
  bottomRound: bigint;
  samples: number;
  missing: number;
  /**
   * True when `topRound` was probed for rather than read from the phase aggregator's `latestRound()`.
   *
   * A probed top is an inference from which round ids answer, so it can be one hole away from the truth in a
   * way an operator cannot see in the numbers. `formatReport` names such a phase in a WARNING line.
   */
  topFromFallback: boolean;
};

export type Observation = {
  feed: string;
  description: string | null;
  decimals: number;
  proxyPhaseId: number | null;
  packed: boolean;
  headBlock: number;
  headTimestamp: number;
  cutoff: number;
  days: number;
  samples: Sample[];
  phases: PhaseWalk[];
  missing: number;
  nonMonotonic: number;
  intervals: number[];
  percentiles: Percentiles;
  minAnswer: bigint;
  maxAnswer: bigint;
  fromBlock: number;
  toBlock: number;
  reachedCutoff: boolean;
  truncated: boolean;
};

export type ObserveOptions = {
  feed: string;
  days: number;
  concurrency?: number;
  maxSamples?: number;
};

/** Resolve `fn` over `items` with at most `limit` in flight, preserving input order in the result. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) {
    workers.push(
      (async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          out[index] = await fn(items[index]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

/**
 * Walk the proxy's round history back `days` from the head block and summarise it.
 *
 * The walk starts at `latestRoundData()`, splits its round id into (phase, aggregator round), and steps down
 * the aggregator round ids of that phase. At aggregator round 1 - or after `MISS_TOLERANCE` consecutive
 * missing rounds, which is the same boundary seen from an RPC that reverts rather than answering - it moves
 * to `phase - 1`, finds that phase's top round through `phaseAggregators(uint16)` and continues there. It
 * stops at the first round at or before the cutoff and *keeps* that round, so the interval straddling the
 * start of the window is measured rather than dropped.
 */
export async function observeFeed(rpc: RpcCall, options: ObserveOptions): Promise<Observation> {
  const feed = options.feed.toLowerCase();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxSamples = Math.max(2, options.maxSamples ?? DEFAULT_MAX_SAMPLES);

  const headHex = await rpc("eth_blockNumber", []);
  if (typeof headHex !== "string") throw new Error("eth_blockNumber did not return a quantity");
  const headBlock = Number(BigInt(headHex));
  const blockTag = `0x${headBlock.toString(16)}`;
  const clock = createBlockClock(rpc);
  const headTimestamp = await clock.timestampOf(headBlock);

  const decimalsRaw = await ethCall(rpc, feed, SELECTOR.decimals, blockTag);
  if (decimalsRaw === null) throw new Error("decimals() reverted: this address is not an AggregatorV3 feed");
  const decimals = Number(decodeWords(decimalsRaw)[0]);
  const descriptionRaw = await ethCall(rpc, feed, SELECTOR.description, blockTag);
  const description = descriptionRaw === null ? null : decodeString(descriptionRaw);
  const phaseIdRaw = await ethCall(rpc, feed, SELECTOR.phaseId, blockTag);
  const proxyPhaseId = phaseIdRaw === null ? null : Number(decodeWords(phaseIdRaw)[0]);

  const latest = await readRound(rpc, feed, SELECTOR.latestRoundData, blockTag);
  if (latest === null) throw new Error("latestRoundData() returned no round: the feed has never updated");

  const head = unpackRoundId(latest.roundId);
  // A raw (unpacked) aggregator reports phase 0; there is then no previous phase to roll over into.
  const packed = head.phase > 0;
  const cutoff = headTimestamp - Math.round(options.days * 86400);

  const samples: Sample[] = [];
  const phases: PhaseWalk[] = [];
  let phase = head.phase;
  let round = head.aggregatorRound;
  let phaseSamples = 0;
  let phaseMissing = 0;
  let phaseTop = round;
  let phaseBottom = round;
  // The head phase is entered at `latestRoundData()`, which is the proxy's own answer, never a probe.
  let phaseTopProbed = false;
  let missing = 0;
  let consecutiveMisses = 0;
  let reachedCutoff = false;
  let truncated = false;

  const closePhase = (): void => {
    phases.push({
      phase,
      topRound: phaseTop,
      bottomRound: phaseBottom,
      samples: phaseSamples,
      missing: phaseMissing,
      topFromFallback: phaseTopProbed,
    });
  };

  walk: while (true) {
    const batch: bigint[] = [];
    for (let i = 0n; i < BigInt(concurrency) && round - i >= 1n; i++) batch.push(round - i);
    if (batch.length === 0) {
      closePhase();
      if (!packed || phase <= 1) break;
      const previous = phase - 1;
      const top = await phaseTopRound(rpc, feed, previous, blockTag);
      if (top === null) break;
      phase = previous;
      round = top.round;
      phaseTop = top.round;
      phaseBottom = top.round;
      phaseTopProbed = top.fromFallback;
      phaseSamples = 0;
      phaseMissing = 0;
      consecutiveMisses = 0;
      continue;
    }

    const results = await mapConcurrent(batch, concurrency, (r) =>
      getRoundData(rpc, feed, packRoundId(phase, r), blockTag),
    );

    for (let i = 0; i < batch.length; i++) {
      const data = results[i];
      if (data === null) {
        missing += 1;
        phaseMissing += 1;
        consecutiveMisses += 1;
        phaseBottom = batch[i];
        if (consecutiveMisses >= MISS_TOLERANCE) {
          round = 0n; // force the phase-boundary branch above
          continue walk;
        }
        continue;
      }
      consecutiveMisses = 0;
      phaseBottom = batch[i];
      phaseSamples += 1;
      samples.push({phase, aggregatorRound: batch[i], answer: data.answer, updatedAt: data.updatedAt});
      if (data.updatedAt <= cutoff) {
        reachedCutoff = true;
        closePhase();
        break walk;
      }
      if (samples.length >= maxSamples) {
        truncated = true;
        closePhase();
        break walk;
      }
    }
    round = batch[batch.length - 1] - 1n;
  }

  if (samples.length < 2) {
    throw new Error(`only ${samples.length} round(s) found in the window: widen --days or check the feed`);
  }

  // Walked newest first; put the sample in chronological order before differencing.
  const ordered = [...samples].reverse();
  const intervals: number[] = [];
  let nonMonotonic = 0;
  for (let i = 1; i < ordered.length; i++) {
    const delta = ordered[i].updatedAt - ordered[i - 1].updatedAt;
    if (delta < 0) nonMonotonic += 1;
    else intervals.push(delta);
  }
  if (intervals.length === 0) throw new Error("no usable intervals: every timestamp went backwards");

  let minAnswer = ordered[0].answer;
  let maxAnswer = ordered[0].answer;
  for (const sample of ordered) {
    if (sample.answer < minAnswer) minAnswer = sample.answer;
    if (sample.answer > maxAnswer) maxAnswer = sample.answer;
  }

  const fromBlock = await clock.atOrBefore(ordered[0].updatedAt, headBlock);
  const toBlock = await clock.atOrBefore(ordered[ordered.length - 1].updatedAt, headBlock);

  return {
    feed,
    description,
    decimals,
    proxyPhaseId,
    packed,
    headBlock,
    headTimestamp,
    cutoff,
    days: options.days,
    samples: ordered,
    phases,
    missing,
    nonMonotonic,
    intervals,
    percentiles: percentiles(intervals),
    minAnswer,
    maxAnswer,
    fromBlock,
    toBlock,
    reachedCutoff,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** A fixed-point answer as a decimal string, so an operator can read the price without counting zeroes. */
export function formatFixed(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** The exact fragment to paste into the asset price record's `price` object. */
export function jsonFragment(observation: Observation): string {
  // Spaced inside the braces to match the hand-maintained style of the records under `config/`, where the
  // JSON formatter is off and `"source": { "url": null, "date": null }` is the house form.
  const window =
    `{ "fromBlock": ${observation.fromBlock}, "toBlock": ${observation.toBlock}, ` +
    `"samples": ${observation.samples.length} }`;
  return [
    "{",
    `  "observedP999IntervalSeconds": ${observation.percentiles.p999},`,
    `  "observationWindow": ${window}`,
    "}",
  ].join("\n");
}

export type ReportOptions = {heartbeatSeconds?: number | null};

/** The whole human report as lines. Pure, so the tests assert on it without touching stdout. */
export function formatReport(observation: Observation, options?: ReportOptions): string[] {
  const p = observation.percentiles;
  const lines: string[] = [];
  lines.push(
    `feed=${observation.feed} description=${JSON.stringify(observation.description ?? "")} decimals=${observation.decimals}`,
  );
  lines.push(
    `head block=${observation.headBlock} time=${new Date(observation.headTimestamp * 1000).toISOString()} rpc=<rpc>`,
  );
  lines.push(
    `window days=${observation.days} cutoff=${new Date(observation.cutoff * 1000).toISOString()} ` +
      `phaseId=${observation.proxyPhaseId ?? "-"} packed=${observation.packed}`,
  );
  for (const walk of observation.phases) {
    lines.push(
      `phase ${walk.phase}: rounds ${walk.bottomRound}..${walk.topRound} samples=${walk.samples} missing=${walk.missing}`,
    );
  }
  lines.push(
    `samples=${observation.samples.length} intervals=${observation.intervals.length} ` +
      `missingRounds=${observation.missing} nonMonotonic=${observation.nonMonotonic}`,
  );
  // Reduced rather than spread: `Math.min(...)` on 50,000 arguments is a stack overflow, not a minimum.
  const shortest = observation.intervals.reduce((a, b) => (b < a ? b : a), observation.intervals[0]);
  const longest = observation.intervals.reduce((a, b) => (b > a ? b : a), observation.intervals[0]);
  lines.push(`interval seconds: p50=${p.p50} p99=${p.p99} p99.9=${p.p999} min=${shortest} max=${longest}`);
  lines.push(
    `answer: min=${formatFixed(observation.minAnswer, observation.decimals)} ` +
      `max=${formatFixed(observation.maxAnswer, observation.decimals)}`,
  );
  lines.push(
    `blocks: fromBlock=${observation.fromBlock} toBlock=${observation.toBlock} samples=${observation.samples.length}`,
  );
  if (!observation.reachedCutoff) {
    lines.push(
      observation.truncated
        ? `WARNING the walk stopped at --max-samples before the cutoff: the window is shorter than ${observation.days} days`
        : `WARNING the feed's history ended before the cutoff: the window is shorter than ${observation.days} days`,
    );
  }
  if (observation.nonMonotonic > 0) {
    lines.push(
      `WARNING ${observation.nonMonotonic} round(s) reported a timestamp older than the round before it`,
    );
  }
  // A phase entered through the fallback was entered at a round this script inferred from which ids answer,
  // not at one the aggregator reported. It is hole-tolerant, but it is still a guess, and an operator
  // comparing this p99.9 against a feed's documented behaviour deserves to know which phases it rests on.
  const probed = observation.phases.filter((walk) => walk.topFromFallback);
  if (probed.length > 0) {
    lines.push(
      `WARNING the top round of phase ${probed.map((walk) => walk.phase).join(", ")} was probed for, not ` +
        "read: latestRound() was unreadable on that phase's aggregator, so that top is an inference",
    );
  }
  // The config schema requires fromBlock <= toBlock, so an inverted window is a paste the operator would
  // only find out was wrong two commands later, in `validate_config.ts`. Say it here and withhold it.
  const invertedWindow = observation.fromBlock > observation.toBlock;
  if (invertedWindow) {
    lines.push(
      `FAIL the observationWindow would be inverted: fromBlock=${observation.fromBlock} is above ` +
        `toBlock=${observation.toBlock}. The bounds are bisected from the oldest and newest sample ` +
        "timestamps, so this means those timestamps did not increase - re-run and check the feed's clock",
    );
  }

  const heartbeat = options?.heartbeatSeconds ?? null;
  if (heartbeat === null) {
    lines.push(
      "maxAge: unknown - pass --heartbeat <seconds> (the feed's documented heartbeat H) to check it",
    );
  } else {
    const maxAge = maxAgeForHeartbeat(heartbeat);
    lines.push(`maxAge = max(2H, 3600) with H=${heartbeat} -> maxPriceAge=${maxAge}`);
    if (maxAge < MIN_PRICE_AGE || maxAge > MAX_PRICE_AGE) {
      lines.push(
        `FAIL maxPriceAge=${maxAge} is outside the ${MIN_PRICE_AGE}..${MAX_PRICE_AGE} bounds (ADR 020): ` +
          "this feed's heartbeat cannot fit the policy and the feed is ineligible for v1",
      );
    }
    if (p.p999 > maxAge) {
      lines.push(
        `FAIL observed p99.9 interval ${p.p999}s exceeds maxPriceAge ${maxAge}s: ` +
          "entries would revert with PriceStale in the worst percentile - do not admit this feed on these terms",
      );
    } else {
      lines.push(`ok observed p99.9 interval ${p.p999}s is within maxPriceAge ${maxAge}s`);
    }
  }

  lines.push("");
  if (invertedWindow) {
    lines.push("no fragment: the observationWindow above is inverted and the validator would refuse it.");
  } else {
    lines.push(
      'paste into the asset price record\'s "price" object (config/assets/<chainId>/<symbol>.json):',
    );
    lines.push(jsonFragment(observation));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type Args = {
  rpcUrl: string;
  feed: string;
  days: number;
  heartbeatSeconds: number | null;
  concurrency: number;
  maxSamples: number;
};

const USAGE =
  "usage: node scripts/observe_feed.ts --rpc-url <url> --feed <proxy> [--days 30] [--heartbeat <seconds>]\n" +
  "                                   [--concurrency 8] [--max-samples 50000]\n" +
  "       LUCKYDRAW_OPS_RPC_URL may supply --rpc-url so the endpoint stays out of shell history.";

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

/** Parse argv (without `node` and the script path). `env` supplies the RPC URL fallback. */
export function parseArgs(argv: readonly string[], env?: Record<string, string | undefined>): Args {
  let rpcUrl = env?.LUCKYDRAW_OPS_RPC_URL ?? "";
  let feed = "";
  let days = DEFAULT_DAYS;
  let heartbeatSeconds: number | null = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let maxSamples = DEFAULT_MAX_SAMPLES;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--rpc-url") rpcUrl = requireValue(flag, argv[++i]);
    else if (flag === "--feed") feed = requireValue(flag, argv[++i]);
    else if (flag === "--days") days = Number(requireValue(flag, argv[++i]));
    else if (flag === "--heartbeat") heartbeatSeconds = Number(requireValue(flag, argv[++i]));
    else if (flag === "--concurrency") concurrency = Number(requireValue(flag, argv[++i]));
    else if (flag === "--max-samples") maxSamples = Number(requireValue(flag, argv[++i]));
    else throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
  }

  if (rpcUrl === "") throw new Error(`--rpc-url or LUCKYDRAW_OPS_RPC_URL is required\n${USAGE}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(feed))
    throw new Error(`--feed must be a 0x address, got ${JSON.stringify(feed)}`);
  if (!(days > 0)) throw new Error("--days must be a positive number");
  if (heartbeatSeconds !== null && !(Number.isInteger(heartbeatSeconds) && heartbeatSeconds > 0)) {
    throw new Error("--heartbeat must be a positive whole number of seconds");
  }
  if (!(Number.isInteger(concurrency) && concurrency > 0))
    throw new Error("--concurrency must be a positive integer");
  if (!(Number.isInteger(maxSamples) && maxSamples >= 2))
    throw new Error("--max-samples must be an integer >= 2");

  return {rpcUrl, feed: feed.toLowerCase(), days, heartbeatSeconds, concurrency, maxSamples};
}

async function main(): Promise<void> {
  const emit = (line: string): void => void process.stdout.write(`${redact(line)}\n`);
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const rpc = createHttpRpc(args.rpcUrl);
    const observation = await observeFeed(rpc, {
      feed: args.feed,
      days: args.days,
      concurrency: args.concurrency,
      maxSamples: args.maxSamples,
    });
    const lines = formatReport(observation, {heartbeatSeconds: args.heartbeatSeconds});
    for (const line of lines) emit(line);
    process.exitCode = lines.some((line) => line.startsWith("FAIL")) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
