// The log scan of SPEC §10.1: the block window, the halving on a provider error, and the emitter filter.

import {type Address, luckyDrawAbi} from "@luckydraw/client";
import {Interface} from "ethers";
import {describe, expect, it} from "vitest";
import {testManifest} from "../../test/harness.tsx";
import {
  addressTopic,
  classifyProviderError,
  isRpcUnreachableScanError,
  LOG_RESULT_CAP,
  type LogFilter,
  type LogProvider,
  LogScanError,
  LogScanRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_BACKOFF_MAX_MS,
  rateLimitDelayMs,
  scanEntryRounds,
} from "./discovery.ts";

const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const drawInterface = new Interface(luckyDrawAbi);

function entryLog(emitter: string, roundId: bigint, buyer: Address, blockNumber: number, index: number) {
  const encoded = drawInterface.encodeEventLog("EntryBought", [
    roundId,
    buyer,
    1_000n,
    30n,
    970n,
    1_000n,
    1n,
    50_000_000_000n,
    1_760_000_000n,
  ]);
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: `0x${"22".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
    index,
  };
}

describe("scanEntryRounds", () => {
  it("pages the requested block window and filters by the indexed buyer topic", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const windows: LogFilter[] = [];
    const provider: LogProvider = {
      getLogs: (filter) => {
        windows.push(filter);
        const from = BigInt(filter.fromBlock);
        // One entry in the second window only.
        return Promise.resolve(from === 110n ? [entryLog(draw, 7n, ME, 115, 0)] : []);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 129n,
      windowBlocks: 10n,
    });

    expect(windows.map((entry) => [entry.fromBlock, entry.toBlock])).toEqual([
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
      ["0x78", "0x81"],
    ]);
    expect(windows[0]?.topics[2]).toBe(addressTopic(ME));
    expect(windows[0]?.address).toBe(draw);
    expect(result.roundIds).toEqual([7n]);
    expect(result.scannedTo).toBe(129n);
  });

  it("ignores a look-alike emitter with the same topics", async () => {
    const manifest = testManifest();
    const impostor = "0x00000000000000000000000000000000deadbeef";
    const provider: LogProvider = {
      getLogs: () => Promise.resolve([entryLog(impostor, 9n, ME, 101, 0)]),
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 109n,
      windowBlocks: 10n,
    });

    expect(result.roundIds).toEqual([]);
  });

  it("halves the window on a provider error and re-reads the same start, skipping nothing", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const seen: [string, string][] = [];
    let failures = 0;
    const provider: LogProvider = {
      getLogs: (filter) => {
        seen.push([filter.fromBlock, filter.toBlock]);
        if (failures === 0 && filter.fromBlock === "0x64") {
          failures += 1;
          return Promise.reject(new Error("query returned more than 10000 results"));
        }
        return Promise.resolve(filter.fromBlock === "0x64" ? [entryLog(draw, 3n, ME, 100, 0)] : []);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 1_099n,
      windowBlocks: 1_000n,
    });

    // 1,000 blocks from 100, then the same start again with the window halved to 500.
    expect(seen[0]).toEqual(["0x64", "0x44b"]);
    expect(seen[1]).toEqual(["0x64", "0x257"]);
    expect(result.roundIds).toEqual([3n]);
    expect(result.scannedTo).toBe(1_099n);
  });

  it("treats a full page as a truncated response and narrows until every log fits", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const cap = 4;
    // Ten entries, one per block from 100 to 109, in ten different rounds. The node answers with a 200 and
    // the first `cap` matches of the range, which is exactly how a silently reduced response looks.
    const all = [...Array(10).keys()].map((offset) =>
      entryLog(draw, BigInt(offset + 1), ME, 100 + offset, 0),
    );
    const pages: number[] = [];
    const provider: LogProvider = {
      getLogs: (filter) => {
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        const matching = all.filter((log) => log.blockNumber >= from && log.blockNumber <= to);
        pages.push(matching.length);
        return Promise.resolve(matching.slice(0, cap));
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 109n,
      windowBlocks: 10n,
      resultCap: cap,
    });

    expect(result.complete).toBe(true);
    expect(result.error).toBeNull();
    expect(result.roundIds).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
    expect(result.scannedTo).toBe(109n);
    // 10 blocks (10 matches, truncated), then 5 (5 matches, still truncated), then five windows of 2 that
    // fit. The two truncated answers were discarded and re-read from the same start, so nothing was skipped.
    expect(pages).toEqual([10, 5, 2, 2, 2, 2, 2]);
  });

  it("reports complete: false with an error when even one block fills a page", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const cap = 3;
    const provider: LogProvider = {
      // Every range, however narrow, comes back full: the node can never answer this account in full.
      getLogs: () =>
        Promise.resolve([...Array(cap).keys()].map((n) => entryLog(draw, BigInt(n + 1), ME, 100, n))),
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 199n,
      windowBlocks: 8n,
      resultCap: cap,
    });

    expect(result.complete).toBe(false);
    expect(result.error).toBeInstanceOf(LogScanError);
    expect((result.error as LogScanError).fromBlock).toBe(100n);
    expect((result.error as LogScanError).toBlock).toBe(100n);
    // Nothing was accepted, so nothing is claimed: the scan advanced no further than its own start.
    expect(result.roundIds).toEqual([]);
    expect(result.scannedTo).toBe(99n);
  });

  it("caps a response at 10,000 logs by default (SPEC §10.1)", () => {
    expect(LOG_RESULT_CAP).toBe(10_000);
  });

  it("reports progress after every window so a page can show partial history", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const provider: LogProvider = {
      getLogs: (filter) =>
        Promise.resolve(filter.fromBlock === "0x64" ? [entryLog(draw, 1n, ME, 100, 0)] : []),
    };
    const progress: {scannedTo: bigint; count: number}[] = [];

    await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
      onProgress: (entry) => progress.push({scannedTo: entry.scannedTo, count: entry.roundIds.length}),
    });

    expect(progress).toEqual([
      {scannedTo: 109n, count: 1},
      {scannedTo: 119n, count: 1},
    ]);
  });

  // publicnode prunes logs below a rolling height and answers -32701. Halving or waiting on that window is
  // wasted budget: the blocks are gone from that node. The scan must step over it and keep reading forward,
  // and say which block it could not read below (SPEC §10.1: partial history is labelled).
  it("steps past a pruned window, records the boundary and keeps reading the newest history", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const windows: LogFilter[] = [];
    const provider: LogProvider = {
      getLogs: (filter) => {
        windows.push(filter);
        const from = BigInt(filter.fromBlock);
        if (from < 120n) {
          return Promise.reject({code: -32701, message: "requested block is before the earliest available"});
        }
        return Promise.resolve(from === 120n ? [entryLog(draw, 9n, ME, 125, 0)] : []);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 129n,
      windowBlocks: 10n,
    });

    // Three requests, one per window: no halving retry and no repeat of a refused range.
    expect(windows.map((entry) => [entry.fromBlock, entry.toBlock])).toEqual([
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
      ["0x78", "0x81"],
    ]);
    // Two windows were refused, so the highest boundary wins: nothing below block 120 is readable here.
    expect(result.historyUnavailableBelow).toBe(120n);
    expect(result.roundIds).toEqual([9n]);
    expect(result.scannedTo).toBe(129n);
    expect(result.error).toBeNull();
  });

  it("never halves the window or waits on a pruned answer", async () => {
    const manifest = testManifest();
    const windows: LogFilter[] = [];
    let slept = 0;
    const provider: LogProvider = {
      getLogs: (filter) => {
        windows.push(filter);
        return BigInt(filter.fromBlock) === 100n
          ? Promise.reject(new Error("logs have been pruned for this range"))
          : Promise.resolve([]);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });

    expect(slept).toBe(0);
    // The second window is a full 10 blocks: the refusal was about the height, not about the range.
    expect(windows.map((entry) => [entry.fromBlock, entry.toBlock])).toEqual([
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
    ]);
    expect(result.historyUnavailableBelow).toBe(110n);
  });

  it("reports the pruning boundary to onProgress, so the page can label it while the scan runs", async () => {
    const manifest = testManifest();
    const seen: (bigint | null)[] = [];
    const provider: LogProvider = {
      getLogs: (filter) =>
        BigInt(filter.fromBlock) === 100n
          ? Promise.reject({code: -32701, message: "pruned"})
          : Promise.resolve([]),
    };

    await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
      onProgress: (progress) => seen.push(progress.historyUnavailableBelow),
    });

    expect(seen).toEqual([110n, 110n]);
  });

  it("leaves the boundary null when every window is served", async () => {
    const manifest = testManifest();
    const result = await scanEntryRounds({
      provider: {getLogs: () => Promise.resolve([])},
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
    });
    expect(result.historyUnavailableBelow).toBeNull();
    expect(result.complete).toBe(true);
  });
});

// SPEC §10.1 splits one rule in two: "Auto-reduce log chunk size on RPC limits, bounded retries with
// backoff". A range cap is answered by reducing the chunk; a rate limit is answered by waiting, because a
// narrower range is the same number of requests per second. BSC's `data-seed-prebsc-*` endpoints refuse
// every `eth_getLogs` with JSON-RPC -32005 "limit exceeded", which is what made the difference matter.
describe("classifyProviderError", () => {
  it("reads a raw JSON-RPC -32005 as a rate limit", () => {
    expect(classifyProviderError({code: -32005, message: "limit exceeded"})).toBe("rateLimit");
  });

  it("reads the ethers-wrapped -32005 the browser actually sees as a rate limit", () => {
    // Verbatim shape of the failure on the live chain 97 build: ethers folds the node's JSON body into its
    // own message and reports `code: "UNKNOWN_ERROR"`, so only the embedded text carries the -32005.
    const wrapped = Object.assign(
      new Error(
        'could not coalesce error (error={ "code": -32005, "message": "limit exceeded" }, payload={ ' +
          '"method": "eth_getLogs" }, code=UNKNOWN_ERROR, version=6.17.0)',
      ),
      {code: "UNKNOWN_ERROR", error: {code: -32005, message: "limit exceeded"}},
    );
    expect(classifyProviderError(wrapped)).toBe("rateLimit");
    expect(isRpcUnreachableScanError(wrapped)).toBe(true);
  });

  it("reads an HTTP 429 as a rate limit", () => {
    expect(classifyProviderError({info: {responseStatus: 429}, message: "server response 429"})).toBe(
      "rateLimit",
    );
    expect(classifyProviderError(new Error("Too Many Requests"))).toBe("rateLimit");
    // api.zan.top, observed 2026-09-17: HTTP 429 with a compute-unit message.
    expect(classifyProviderError({code: -32012, message: "cu limit exceeded"})).toBe("rateLimit");
  });

  it("reads a block-range refusal as a range cap even when it says limit exceeded", () => {
    for (const message of [
      "exceed maximum block range: 5000",
      "query returned more than 10000 results",
      "eth_getLogs block range too large, limit exceeded",
      // drpc's free plan, observed 2026-09-17 against chain 97.
      "ranges over 10000 blocks are not supported on free plan",
    ]) {
      expect(classifyProviderError({code: -32000, message})).toBe("rangeCap");
    }
  });

  it("reads publicnode's -32701 as pruned history, not as a range cap or a rate limit", () => {
    // Measured 2026-09-18 against https://bsc-testnet-rpc.publicnode.com for ranges below ~131,577,900.
    expect(classifyProviderError({code: -32701, message: "block range is before the pruned height"})).toBe(
      "pruned",
    );
    expect(classifyProviderError(new Error("history is not available before block 131577900"))).toBe(
      "pruned",
    );
    // A pruned range is a real answer about the data, not an unreachable node, so it is not the
    // RpcUnavailable sentence.
    expect(isRpcUnreachableScanError({code: -32701, message: "pruned"})).toBe(false);
  });

  it("leaves anything else unknown, so the existing halving is unchanged", () => {
    expect(classifyProviderError(new Error("socket hang up"))).toBe("unknown");
    expect(isRpcUnreachableScanError(new Error("socket hang up"))).toBe(false);
    expect(isRpcUnreachableScanError(new LogScanError(1n, 2n, 3))).toBe(false);
  });
});

describe("rateLimitDelayMs", () => {
  it("doubles from 1 s to the 15 s ceiling and never waits zero", () => {
    expect(rateLimitDelayMs(1, () => 0)).toBe(500);
    expect(rateLimitDelayMs(1, () => 1)).toBe(1_000);
    expect(rateLimitDelayMs(2, () => 1)).toBe(2_000);
    expect(rateLimitDelayMs(20, () => 1)).toBe(RATE_LIMIT_BACKOFF_MAX_MS);
    expect(rateLimitDelayMs(20, () => 0)).toBe(RATE_LIMIT_BACKOFF_MAX_MS / 2);
  });
});

describe("scanEntryRounds under a rate limit", () => {
  function rateLimited(): Error {
    return Object.assign(new Error("could not coalesce error"), {
      error: {code: -32005, message: "limit exceeded"},
    });
  }

  it("waits and retries the same range without halving the window, then succeeds", async () => {
    const manifest = testManifest();
    const draw = manifest.contracts.draw.address;
    const windows: LogFilter[] = [];
    const waits: number[] = [];
    let refusals = 2;
    const provider: LogProvider = {
      getLogs: (filter) => {
        windows.push(filter);
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(rateLimited());
        }
        return Promise.resolve(BigInt(filter.fromBlock) === 100n ? [entryLog(draw, 4n, ME, 103, 0)] : []);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 119n,
      windowBlocks: 10n,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    });

    expect(result.complete).toBe(true);
    expect(result.error).toBeNull();
    expect(result.roundIds).toEqual([4n]);
    // Two refusals, then the same 10-block range answered: the window never narrowed and the start never
    // moved, so no block was read twice under a different width and none was skipped.
    expect(windows.map((entry) => [entry.fromBlock, entry.toBlock])).toEqual([
      ["0x64", "0x6d"],
      ["0x64", "0x6d"],
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
    ]);
    // 1 s then 2 s, exponential (jitter pinned to its maximum by `random`).
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("still halves the window on a range-cap refusal", async () => {
    const manifest = testManifest();
    const windows: LogFilter[] = [];
    const provider: LogProvider = {
      getLogs: (filter) => {
        windows.push(filter);
        const width = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
        if (width > 250n) {
          return Promise.reject(Object.assign(new Error("exceed maximum block range: 250"), {code: -32000}));
        }
        return Promise.resolve([]);
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 1_000n,
      toBlock: 1_999n,
      windowBlocks: 1_000n,
      sleep: () => Promise.reject(new Error("a range cap must never wait")),
    });

    expect(result.complete).toBe(true);
    // 1,000 refused, 500 refused, 250 answered: the window halved and the start did not move, so the same
    // blocks were re-read and none was skipped. The scan then runs on at the narrowed width.
    expect(windows.slice(0, 3).map((entry) => BigInt(entry.toBlock) - BigInt(entry.fromBlock) + 1n)).toEqual([
      1_000n,
      500n,
      250n,
    ]);
    expect(windows.slice(0, 3).every((entry) => entry.fromBlock === "0x3e8")).toBe(true);
  });

  it("gives up after a bounded number of rate-limited retries and names the network, not the data", async () => {
    const manifest = testManifest();
    let calls = 0;
    const waits: number[] = [];
    const provider: LogProvider = {
      getLogs: () => {
        calls += 1;
        return Promise.reject(rateLimited());
      },
    };

    const result = await scanEntryRounds({
      provider,
      manifest,
      account: ME,
      fromBlock: 100n,
      toBlock: 10_000n,
      windowBlocks: 2_000n,
      maxRateLimitRetries: 3,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    });

    expect(calls).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(result.complete).toBe(false);
    expect(result.error).toBeInstanceOf(LogScanRateLimitError);
    expect((result.error as LogScanRateLimitError).attempts).toBe(4);
    expect(isRpcUnreachableScanError(result.error)).toBe(true);
    // The cursor never moved, so a later run resumes at the same block rather than past a hole.
    expect(result.scannedTo).toBe(99n);
    expect(result.roundIds).toEqual([]);
  });

  it("defaults to six retries", () => {
    expect(MAX_RATE_LIMIT_RETRIES).toBe(6);
  });
});
