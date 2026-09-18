// Finding the rounds one account has entered, without an indexer (SPEC §9.4 `/entries`, §10.1).
//
// The indexer's `/accounts/:address/positions` endpoint is the intended source and is not built yet, so this
// wave discovers positions the only other honest way: scan the Draw's `EntryBought` logs for the connected
// buyer. The rules of §10.1 are the ones that matter here and every one of them is implemented below:
//
//   - the emitter filter. `decodeLog` returns null for any log whose address is not the manifest Vault or
//     Draw, so a look-alike contract that emits the same topic contributes nothing;
//   - the scan starts at the manifest's `chain.startBlock`, which §12 documents as a lower bound;
//   - "The initial getLogs chunk is 2,000 blocks, halving on a range error and retried with bounded backoff
//     on a rate limit". Public BSC RPCs cap the range of `eth_getLogs`, so the window is configurable and
//     halves on a range refusal down to a floor. A rate limit is a different failure and halving is the
//     wrong answer to it: a narrower range is still one more request per second. The same range is retried
//     after an exponential, jittered wait instead, a bounded number of times. Telling the two apart is what
//     `classifyProviderError` does. BSC's `data-seed-prebsc-*` endpoints answer every `eth_getLogs` with
//     JSON-RPC -32005 "limit exceeded" whatever the range, which halving turned into six pointless requests
//     and then a raw ethers string on screen. A third refusal is neither: a node that has *pruned* the blocks
//     will never serve them, whatever the window and however long the scan waits, so that window is recorded
//     as unavailable, the cursor moves past it and the newest history is still read (SPEC §10.1: partial
//     history is labelled, never served as complete);
//   - "a response whose block range or result set was silently reduced is treated as an error and re-fetched
//     with overlap". Several public nodes answer an over-large query with HTTP 200 and a truncated array
//     instead of an error, so a full page is treated exactly like a thrown error: the cursor does not move,
//     the window halves and the same start is read again. A scan that cannot fit one block into a page says
//     so instead of returning a short list as if it were the whole history;
//   - "do not rescan genesis or every historical round on each page load": the caller caches the result per
//     account epoch (`usePositions`).
//
// What this file deliberately does NOT do is treat a log as the answer. A log says an entry happened once; it
// does not say what the position is now. Every candidate round id is confirmed with `getPosition` and
// `getRound` at one snapshot block before anything is shown (`resolvePositions`).

import {
  type Address,
  classifyProviderError,
  type DeploymentManifest,
  decodeLog,
  drawEventTopics,
  type Hex32,
  providerErrorText,
  prunedEvidence,
  type RawLog,
  rateLimitDelayMs,
} from "@luckydraw/client";

/** SPEC §10.1: "The initial getLogs chunk is 2,000 blocks, halving on provider errors". */
export const DEFAULT_LOG_WINDOW = 2_000n;

/** The window never halves below this: a smaller one turns a slow RPC into thousands of requests. */
export const MIN_LOG_WINDOW = 64n;

/** How many times one range may be retried with a halved window before the scan gives up. */
export const MAX_WINDOW_HALVINGS = 6;

/** How many times one range may be retried after a rate limit before the scan gives up. */
export const MAX_RATE_LIMIT_RETRIES = 6;

// The classifier and the backoff schedule are the client's (`packages/client/src/reads/providerError.ts`),
// shared with the keeper's buyer scan so both agree on what a node said; re-exported here for the tests and
// the page.
export {
  classifyProviderError,
  type ProviderErrorKind,
  prunedEvidence,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RATE_LIMIT_BACKOFF_MS,
  rateLimitDelayMs,
} from "@luckydraw/client";

/**
 * The result count at which a response is assumed to have been silently truncated (SPEC §10.1).
 *
 * This is the limit the common public nodes enforce, and most of them answer an over-large query with a
 * 200 and a short array rather than an error. A response at or above this size therefore proves nothing
 * about how many logs the range really holds, so it is never read as data.
 */
export const LOG_RESULT_CAP = 10_000;

export type LogFilter = {
  address: string;
  topics: readonly (string | null)[];
  fromBlock: string;
  toBlock: string;
};

/** The one provider method this scan needs. An ethers `JsonRpcProvider` satisfies it. */
export type LogProvider = {
  getLogs(filter: LogFilter): Promise<readonly RawLog[]>;
};

export type ScanProgress = {
  /** The last block this scan has finished reading, inclusive. */
  scannedTo: bigint;
  /** Round ids found so far, ascending, without duplicates. */
  roundIds: readonly bigint[];
  /**
   * The lowest block this RPC still serves logs for, or null when it served every window it was asked.
   *
   * Non-null means the node refused a *prefix* of the span as pruned, so no entry below this block can be
   * seen through this endpoint — not that no entry exists there. It is the height the surface labels; it is
   * never a reason to call the list complete. Only an unbroken run of refusals from `fromBlock` raises it:
   * once a window has been served, a refusal above it is a failure and stops the scan instead.
   */
  historyUnavailableBelow: bigint | null;
};

/**
 * What a finished scan returns.
 *
 * "Is this the whole history?" is answered by `complete` *and* `historyUnavailableBelow` together, never by
 * either alone. `complete` is false whenever the scan stopped before `toBlock`: a cancellation, a provider
 * that keeps failing, or a range the node will not answer in full. `historyUnavailableBelow` is non-null
 * whenever the node refused part of the span as pruned, which the scan walks past rather than stalls on.
 * SPEC §10.1: "Never serve silently partial aggregates as complete." The round ids found are still returned
 * in both cases, because they are true; only the claim of completeness is withheld.
 */
export type ScanResult = ScanProgress & {
  /**
   * True when the scan walked its whole requested span without stopping early.
   *
   * It is a statement about the *cursor*, not about the data: a scan can walk every block of the span and
   * still have been refused part of it as pruned, in which case `complete` is true and
   * `historyUnavailableBelow` is non-null. Anything that tells a reader "this is your full history" must
   * check both, which is what `/entries` does.
   */
  complete: boolean;
  /** Why the scan stopped short, or null when it finished or was cancelled. */
  error: Error | null;
};

/**
 * A node that kept rate-limiting one range until the retry budget ran out.
 *
 * It is its own type because the surface has its own sentence for it: this is not "your entries are broken",
 * it is "LuckyDraw cannot reach the network right now" (the §9.6 `RpcUnavailable` row), and §9.7 forbids
 * putting the node's own words in the alert. The provider error stays on `cause` for the labelled detail
 * line.
 */
export class LogScanRateLimitError extends Error {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly attempts: number;

  constructor(fromBlock: bigint, toBlock: bigint, attempts: number, cause: unknown) {
    super(
      `the RPC rate-limited the read of blocks ${fromBlock}-${toBlock} ${attempts} times in a row, so the ` +
        "scan stopped there",
      {cause},
    );
    this.name = "LogScanRateLimitError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
    this.attempts = attempts;
  }
}

/** A range the node would not answer in full, at the smallest window there is. */
export class LogScanError extends Error {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;

  constructor(fromBlock: bigint, toBlock: bigint, cap: number) {
    super(
      `the RPC returned a full page of ${cap} logs for blocks ${fromBlock}-${toBlock}, so its response was ` +
        "truncated and some entries in that range cannot be read",
    );
    this.name = "LogScanError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
  }
}

/** True when a scan stopped because the node was throttling or unreachable, not because the data is bad. */
export function isRpcUnreachableScanError(error: unknown): boolean {
  if (error instanceof LogScanRateLimitError) return true;
  // A truncated page is a real, specific answer about the data; it is not an unreachable network.
  if (error instanceof LogScanError) return false;
  return classifyProviderError(error) === "rateLimit";
}

/**
 * The node's own words about a failed scan, for a labelled secondary line only.
 *
 * SPEC §9.7 keeps third-party text out of the app's own sentences, so this is never the alert body: it is
 * the evidence line under it, the same shape the "Wallet said:" line has for wallet-authored text. When the
 * scan wrapped the failure (`LogScanRateLimitError`) the node's text is on `cause`, not on the message.
 */
export function providerDetail(error: unknown): string | null {
  const source = error instanceof LogScanRateLimitError ? (error.cause ?? error) : error;
  const text = providerErrorText(source).replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

export type ScanOptions = {
  provider: LogProvider;
  manifest: DeploymentManifest;
  account: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** Initial `eth_getLogs` range. Defaults to 2,000 blocks (SPEC §10.1). */
  windowBlocks?: bigint;
  /** Result count treated as a truncated response. Defaults to `LOG_RESULT_CAP`; tests lower it. */
  resultCap?: number;
  /** Called after every window, so the page can show partial history while the scan runs (SPEC §9.6). */
  onProgress?: (progress: ScanProgress) => void;
  /** Returns true to abandon the scan (an unmount, or an account change). */
  cancelled?: () => boolean;
  /** How many rate-limited retries one range gets. Defaults to `MAX_RATE_LIMIT_RETRIES`. */
  maxRateLimitRetries?: number;
  /** Test seam for the backoff wait; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the backoff jitter; defaults to `Math.random`. */
  random?: () => number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A 32-byte topic for an address, for the indexed `buyer` of `EntryBought`. */
export function addressTopic(address: Address): Hex32 {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function blockTag(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * Every round id in which `account` bought at least one entry, between two blocks.
 *
 * `EntryBought(uint256 indexed roundId, address indexed buyer, ...)` puts the buyer in `topics[2]`, so the
 * node does the filtering and the response carries only this account's entries. A seed entry is a
 * `SeedEntered`, not an `EntryBought` (SPEC §9.8 keeps them apart), so the operator seed never appears here
 * even when the connected account is the seed Safe.
 */
export async function scanEntryRounds(options: ScanOptions): Promise<ScanResult> {
  const {provider, manifest, account, fromBlock, toBlock} = options;
  const draw = manifest.contracts.draw.address;
  const topics = [drawEventTopics.EntryBought, null, addressTopic(account)] as const;
  const cap = options.resultCap ?? LOG_RESULT_CAP;
  const rateLimitBudget = options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const found = new Set<string>();
  const ordered: bigint[] = [];
  let window = options.windowBlocks ?? DEFAULT_LOG_WINDOW;
  if (window < 1n) window = 1n;
  let cursor = fromBlock;
  let scannedTo = fromBlock > 0n ? fromBlock - 1n : 0n;
  // The highest "everything below here is gone" the node has told us. Monotonic: windows are read in
  // ascending order, so a later refusal always names a higher boundary than an earlier one.
  let historyUnavailableBelow: bigint | null = null;
  // Has any window actually been answered yet? Pruning is a *prefix* of the span: a node drops the oldest
  // blocks, so the windows it refuses are the ones before the first it serves. Once a window has come back,
  // a later "pruned"-looking refusal cannot be pruning — the node is serving blocks above it — so it is
  // handled as an unknown failure and made loud rather than recorded as a boundary under served history.
  let served = false;

  const stop = (error: Error | null): ScanResult => ({
    scannedTo,
    roundIds: ordered,
    historyUnavailableBelow,
    complete: false,
    error,
  });

  while (cursor <= toBlock) {
    if (options.cancelled?.() === true) return stop(null);
    let end = cursor + window - 1n > toBlock ? toBlock : cursor + window - 1n;
    // The window this range started at. A wording-only pruning verdict is only believed after halving down
    // to the floor, and that halving is evidence about *this* range, not a lasting property of the node, so
    // the next range starts wide again instead of crawling the rest of the span 64 blocks at a time.
    const windowAtRangeStart = window;

    let logs: readonly RawLog[] | null = null;
    let halvings = 0;
    let rateLimited = 0;
    while (logs === null) {
      let page: readonly RawLog[];
      try {
        page = await provider.getLogs({
          address: draw,
          topics: [...topics],
          fromBlock: blockTag(cursor),
          toBlock: blockTag(end),
        });
      } catch (error) {
        // SPEC §10.1: halve on a range error, back off on a rate limit. Either way the start never moves, so
        // the retry re-reads the same blocks and skips nothing. Pruned history is the one case where the
        // start *must* move: the node has dropped these blocks, so neither a narrower window nor a wait can
        // produce them, and both would only spend budget that the rest of the span needs.
        const kind = classifyProviderError(error);
        // `pruned` is the only verdict that moves the cursor over blocks nobody read, so it is the only one
        // that can lose entries while still reporting `complete`. It is therefore believed under two
        // conditions, both necessary:
        //
        //   - nothing has been served yet. Pruning is a prefix; a refusal above a window the node answered is
        //     something else wearing the same words, and is handled below as an unknown failure;
        //   - the node either named a pruning code, or the wording survived halving to `MIN_LOG_WINDOW`. A
        //     range cap does not: it is answered by a narrower window, and a scan that took the first
        //     "older than" sentence at face value stepped over ranges the node would have served.
        if (kind === "pruned" && !served && (prunedEvidence(error) === "code" || window <= MIN_LOG_WINDOW)) {
          // Everything up to and including `end` is unreachable through this RPC, so the first block it can
          // still serve is `end + 1`. Only what was actually refused is claimed: if this verdict took a
          // halving to reach, `end` is the narrowed end, not the one the range started with.
          const boundary = end + 1n;
          if (historyUnavailableBelow === null || boundary > historyUnavailableBelow) {
            historyUnavailableBelow = boundary;
          }
          // The pruning boundary is a height, not a property of this query, so the next range is a normal
          // read at the width this one started with.
          window = windowAtRangeStart;
          // An empty page, not a failure: the loop below adds no round ids, advances the cursor past `end`
          // and reports progress, so the newest history is still read.
          logs = [];
          continue;
        }
        if (kind === "rateLimit") {
          if (rateLimited >= rateLimitBudget) {
            return stop(new LogScanRateLimitError(cursor, end, rateLimited + 1, error));
          }
          rateLimited += 1;
          await sleep(rateLimitDelayMs(rateLimited, random));
          if (options.cancelled?.() === true) return stop(null);
          // The window is untouched: a throttled node is not a node that found this range too wide.
          continue;
        }
        if (halvings >= MAX_WINDOW_HALVINGS || window <= MIN_LOG_WINDOW) {
          return stop(error instanceof Error ? error : new Error(String(error)));
        }
        window = window / 2n < MIN_LOG_WINDOW ? MIN_LOG_WINDOW : window / 2n;
        halvings += 1;
        end = cursor + window - 1n > toBlock ? toBlock : cursor + window - 1n;
        continue;
      }
      if (page.length >= cap) {
        // A full page is a truncated answer, whatever the status code said. It is treated as the error it
        // is: the cursor stays put so the retry overlaps the same start, and the window halves — here down
        // to a single block, past `MIN_LOG_WINDOW`, because that floor guards against error thrash and this
        // is the one case where a narrower range is the only way to see the data at all.
        if (window <= 1n) return stop(new LogScanError(cursor, end, cap));
        window = window / 2n;
        end = cursor + window - 1n > toBlock ? toBlock : cursor + window - 1n;
        continue;
      }
      // The node answered this range in full. From here on nothing below `end` can be pruned, because the
      // node is serving blocks above it; `served` is what makes a later pruning verdict loud instead of
      // silent.
      served = true;
      logs = page;
    }

    for (const log of logs) {
      // A pruned window yields no logs by construction; the loop is skipped rather than special-cased.
      const decoded = decodeLog(manifest, log);
      // The emitter filter and the topic filter are both `decodeLog`'s, not ours (SPEC §10.1).
      if (decoded === null || decoded.emitter !== "draw" || decoded.name !== "EntryBought") continue;
      if (decoded.args.buyer !== account) continue;
      const key = decoded.args.roundId.toString();
      if (found.has(key)) continue;
      found.add(key);
      ordered.push(decoded.args.roundId);
    }

    scannedTo = end;
    cursor = end + 1n;
    ordered.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    options.onProgress?.({scannedTo, roundIds: [...ordered], historyUnavailableBelow});
  }

  // `complete` reports that the cursor reached `toBlock`; `historyUnavailableBelow` reports what the node
  // would not serve on the way. The caller must read both before calling a list whole (SPEC §10.1).
  return {scannedTo, roundIds: ordered, historyUnavailableBelow, complete: true, error: null};
}
