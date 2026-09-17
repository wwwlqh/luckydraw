// Who is owed a refund, and who has already been paid (SPEC §6.2 Refunding row, §10.2).
//
// `claimRefund(roundId, account)` names the account, so the keeper has to enumerate a Refunding round's
// buyers. It does that from the round's own `EntryBought` and `SeedEntered` logs, decoded by the client's
// `decodeLog`, which drops any log whose emitter is not the manifest Draw (SPEC §10.1: "ignore look-alike
// emitters"). The scan starts at the manifest's `chain.startBlock`, which SPEC §12 defines as a lower bound
// on deployment history, and is paged in windows because BSC public RPCs cap `eth_getLogs` ranges - both the
// block range and, silently, the number of logs returned, so a full page is treated as an error and re-read
// with a halved window (SPEC §10.1).
//
// A throttled node is a different failure and gets a different answer. Halving does not make a rate limit go
// away - a narrower window is still one more request per second - so a refusal the shared
// `classifyProviderError` calls a rate limit is retried on the *same* range after an exponential, jittered
// wait, a bounded number of times, and only a range cap moves the window. The operational endpoint
// (`KEEPER_RPC_URL`, the chain record's `LUCKYDRAW_OPS_RPC_URL`) is the one this matters for: BSC's public
// seeds answer every `eth_getLogs` with JSON-RPC -32005 "limit exceeded" whatever the range, which halving
// turned into a handful of pointless requests and then a refund scan that gave up.
//
// The refunded set is in memory only, and it is an optimisation, never an authority: `readPosition` is
// consulted before every claim, so a keeper restarted mid-refund re-reads the truth from the chain instead
// of re-sending claims the chain would revert as `AlreadyClaimed`.

import {
  type Address,
  classifyProviderError,
  decodeLog,
  drawEventTopics,
  type Hex32,
  type RawLog,
  rateLimitDelayMs,
  type VerifiedDeployment,
} from "./client.ts";

/** The two events that create an entry in a round (SPEC §8.2). */
export const ENTRY_TOPICS: readonly Hex32[] = [
  drawEventTopics.EntryBought as Hex32,
  drawEventTopics.SeedEntered as Hex32,
];

/**
 * The result-count at which an `eth_getLogs` page is assumed to have been silently truncated.
 *
 * SPEC §10.1: "a response whose block range or result set was silently reduced is treated as an error and
 * re-fetched". Public RPCs cap a response at 10,000 logs and answer 200 OK with the first page of them, so a
 * page that comes back exactly full is indistinguishable from a truncated one and must be treated as the
 * dangerous case: a buyer discovered too late is a refund never credited.
 */
export const MAX_LOGS_PER_PAGE = 10_000;

/** The window never halves below one block; one block that still fails or still fills a page is fatal. */
export const MIN_LOG_WINDOW = 1n;

/** How many times one range may be retried after a rate limit before the scan gives up. */
export const MAX_RATE_LIMIT_RETRIES = 6;

/** A scan that could not be completed honestly. `keeper.ts` contains it to the one round being refunded. */
export class LogScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogScanError";
  }
}

/**
 * A node that kept throttling one range until the retry budget ran out.
 *
 * Its message names the endpoint and the blocks, never the node's own words: `keeper.ts` logs
 * `error=<message>` on `refund_scan_failed`, and a provider string there is both meaningless to an operator
 * ("limit exceeded" says nothing about which round stalled) and the one place an RPC URL - often the
 * credential itself - reaches a log line. The provider error stays on `cause` for a debugger.
 */
export class LogScanRateLimitError extends LogScanError {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly attempts: number;

  constructor(roundId: bigint, fromBlock: bigint, toBlock: bigint, attempts: number, cause: unknown) {
    super(
      `the RPC rate-limited eth_getLogs for round ${roundId} at blocks ${fromBlock}-${toBlock} ${attempts} ` +
        "times in a row, so the buyer scan stopped there",
    );
    this.name = "LogScanRateLimitError";
    this.cause = cause;
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
    this.attempts = attempts;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** One `eth_getLogs` page. The implementation in `main.ts` adds the Draw address to the filter. */
export type LogQuery = (range: {
  fromBlock: bigint;
  toBlock: bigint;
  topics: readonly Hex32[];
}) => Promise<readonly RawLog[]>;

export type DiscoverBuyersOptions = {
  deployment: VerifiedDeployment;
  roundId: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks per query; the range is inclusive at both ends, so a window of 2,000 asks for 2,000 blocks. */
  window: bigint;
  query: LogQuery;
  /** The truncation threshold. Only tests lower it; production uses `MAX_LOGS_PER_PAGE`. */
  pageCap?: number;
  /** How many rate-limited retries one range gets. Defaults to `MAX_RATE_LIMIT_RETRIES`. */
  maxRateLimitRetries?: number;
  /** Test seam for the backoff wait; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the backoff jitter; defaults to `Math.random`. */
  random?: () => number;
};

/**
 * Every distinct account with an entry in `roundId`, in the order their first entry was mined.
 *
 * Order matters only for reproducibility of the logs; correctness does not depend on it, because each claim
 * is independent and idempotent on chain.
 *
 * Paging follows SPEC §10.1, the same rules the web scanner implements: the window starts at
 * `KEEPER_LOG_WINDOW`, halves on a thrown provider error and re-reads the *same* start so no block is
 * skipped, and treats a page that comes back at the provider's result cap as truncated rather than complete,
 * halving and re-reading that too. Once narrowed the window stays narrow for the rest of the scan; a
 * provider that still fails, or still fills a page, at a single block throws `LogScanError`, because the
 * alternative - returning a short buyer list - would silently drop somebody's refund.
 *
 * A rate limit is the one refusal that does not halve: the same range is re-read after `rateLimitDelayMs`,
 * up to `maxRateLimitRetries` times, and then throws `LogScanRateLimitError`. In every case - halving,
 * waiting or throwing - the cursor stays where it was, so a retried range is re-read in full and no block is
 * ever stepped over.
 */
export async function discoverBuyers(options: DiscoverBuyersOptions): Promise<readonly Address[]> {
  const {deployment, roundId, fromBlock, toBlock, query} = options;
  const pageCap = options.pageCap ?? MAX_LOGS_PER_PAGE;
  const rateLimitBudget = options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let window = options.window;
  if (window <= 0n) throw new RangeError(`the log window must be positive: ${window}`);
  const buyers: Address[] = [];
  const seen = new Set<Address>();
  let start = fromBlock;
  // Per range, not per scan: a range that had to wait does not shorten the budget of the next one.
  let rateLimited = 0;
  while (start <= toBlock) {
    const end = start + window - 1n > toBlock ? toBlock : start + window - 1n;
    let logs: readonly RawLog[];
    try {
      logs = await query({fromBlock: start, toBlock: end, topics: ENTRY_TOPICS});
    } catch (error) {
      if (classifyProviderError(error) === "rateLimit") {
        if (rateLimited >= rateLimitBudget) {
          throw new LogScanRateLimitError(roundId, start, end, rateLimited + 1, error);
        }
        rateLimited += 1;
        await sleep(rateLimitDelayMs(rateLimited, random));
        continue; // Same start and the same window: a throttled node did not find this range too wide.
      }
      if (window <= MIN_LOG_WINDOW) {
        const message = error instanceof Error ? error.message : String(error);
        throw new LogScanError(
          `eth_getLogs failed for round ${roundId} at block ${start} with a window of one block: ${message}`,
        );
      }
      window = window / 2n < MIN_LOG_WINDOW ? MIN_LOG_WINDOW : window / 2n;
      continue; // Same start: a halving re-reads the range, it never advances past it.
    }
    if (logs.length >= pageCap) {
      if (window <= MIN_LOG_WINDOW) {
        throw new LogScanError(
          `eth_getLogs returned ${logs.length} logs for round ${roundId} at block ${start} with a window of ` +
            "one block, so the response may be truncated and the buyer list cannot be trusted",
        );
      }
      window = window / 2n < MIN_LOG_WINDOW ? MIN_LOG_WINDOW : window / 2n;
      continue;
    }
    for (const log of logs) {
      const event = decodeLog(deployment, log);
      if (event === null || event.emitter !== "draw") continue;
      let account: Address;
      if (event.name === "EntryBought") {
        if (event.args.roundId !== roundId) continue;
        account = event.args.buyer;
      } else if (event.name === "SeedEntered") {
        if (event.args.roundId !== roundId) continue;
        account = event.args.seedAccount;
      } else {
        continue;
      }
      if (seen.has(account)) continue;
      seen.add(account);
      buyers.push(account);
    }
    start = end + 1n;
    rateLimited = 0;
  }
  return buyers;
}

/**
 * Which accounts of which rounds this process has already seen refunded.
 *
 * Bounded by forgetting a round as soon as it is fully refunded, which is also when `decide` stops tracking
 * it; a keeper that never restarted would otherwise hold every settled round's buyers for its lifetime.
 */
export class RefundTracker {
  readonly #refunded = new Map<string, Set<Address>>();

  #key(roundId: bigint): string {
    return roundId.toString();
  }

  markRefunded(roundId: bigint, account: Address): void {
    const key = this.#key(roundId);
    const set = this.#refunded.get(key) ?? new Set<Address>();
    set.add(account);
    this.#refunded.set(key, set);
  }

  isRefunded(roundId: bigint, account: Address): boolean {
    return this.#refunded.get(this.#key(roundId))?.has(account) === true;
  }

  /** The accounts of `buyers` this process has not yet recorded as refunded, in the given order. */
  pending(roundId: bigint, buyers: readonly Address[]): readonly Address[] {
    return buyers.filter((account) => !this.isRefunded(roundId, account));
  }

  forget(roundId: bigint): void {
    this.#refunded.delete(this.#key(roundId));
  }

  get size(): number {
    return this.#refunded.size;
  }
}
