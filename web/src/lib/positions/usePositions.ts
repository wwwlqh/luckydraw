// `usePositions()`: the connected account's positions, discovered from logs and confirmed against the chain.
//
// Two phases, deliberately separated because they have different costs and different lifetimes:
//
//   1. the log scan (`discovery.ts`) is expensive and historical. It runs once per (deployment, account,
//      account epoch) and its result is memoized in a module-level cache, so moving between `/wallet` and
//      `/entries` does not rescan. SPEC §10.1: "do not rescan genesis or every historical round on each page
//      load";
//   2. the confirmation reads (`classify.ts`) are cheap and current. They run through `useSnapshot`, so they
//      refresh once per block and re-render only when the block hash changes (SPEC §9.3, §10.1).
//
// The cache is keyed on `accountEpoch`, the counter the wallet layer advances on every connect, disconnect
// and account change, and every entry for another key is dropped when the key changes. SPEC §9.2: an account
// change "clears account-scoped caches"; §9.6: "Disconnect clears account-sensitive caches and queries".
//
// A cached scan is a cursor, not a final answer: it records the last block it read, so a later mount — or a
// `refresh()` after a claim — reads only from that block to the current head and merges what it finds. The
// alternative a cache of finished results invites is worse in both directions: serving it unchanged hides
// every entry made since (an entry would not appear on `/entries` until the wallet reconnected), and wiping
// it rescans the whole deployment from `startBlock`, which SPEC §10.1 forbids ("do not rescan genesis or
// every historical round on each page load").
//
// One thing the cursor carries is not recoverable by extending it: `historyUnavailableBelow`, the height an
// endpoint said it had pruned below. Every later run may only raise it, because a resume never reads those
// blocks again to find out otherwise — so a single bad endpoint would pin "no history below N" on the
// account for the rest of the session even after the operator switched the app to an archive RPC. That is
// what `rescan()` is for, and it is the only thing in this file that starts over at `startBlock`: it drops
// the account's entry outright. It runs when a reader presses the retry, never on a mount or a claim.

import type {Address, Snapshot} from "@luckydraw/client";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useSnapshot} from "../data/useSnapshot.ts";
import {useDeployment} from "../deployment/DeploymentProvider.tsx";
import {useWallet} from "../wallet/WalletProvider.tsx";
import {type PositionRow, resolvePositions} from "./classify.ts";
import {DEFAULT_LOG_WINDOW, type LogProvider, scanEntryRounds} from "./discovery.ts";

export type ScanState = {
  /** Inclusive first block of the scan: the manifest's `chain.startBlock` (SPEC §12: a lower bound). */
  fromBlock: bigint;
  /** Inclusive last block of the scan: the head when the scan started. */
  toBlock: bigint;
  /** The last block read so far. Equal to `toBlock` once the scan finished. */
  scannedTo: bigint;
  complete: boolean;
  roundIds: readonly bigint[];
  /**
   * The lowest block this RPC still serves logs for, or null when it served everything it was asked.
   *
   * It survives across runs in the cache: a resumed scan reads only the tail, so it would otherwise forget
   * that the head of the span was never readable and the page would quietly stop saying so.
   */
  historyUnavailableBelow: bigint | null;
};

type CacheEntry = ScanState;

/** Module-level so a route change reuses the scan; keyed per deployment, account and account epoch. */
const scanCache = new Map<string, CacheEntry>();

function cacheKey(deploymentId: string, account: Address, accountEpoch: number): string {
  return `${deploymentId}|${account}|${accountEpoch}`;
}

/** Test seam: drops every memoized scan. The hook itself drops stale keys as the epoch moves. */
export function clearPositionScanCache(): void {
  scanCache.clear();
}

/**
 * The cached round ids plus the ones a later window found: ascending, without duplicates.
 *
 * A round can legitimately appear in both — one account can enter the same round twice, in two blocks that
 * fall in two different scans — so the union is taken by value and never by concatenation, and the order is
 * the same ascending order `scanEntryRounds` produces, because it is the key the confirmation read is
 * memoized on.
 */
function mergeRoundIds(cached: readonly bigint[] | undefined, found: readonly bigint[]): readonly bigint[] {
  if (cached === undefined || cached.length === 0) return found;
  if (found.length === 0) return cached;
  const seen = new Set(cached.map((id) => id.toString()));
  const merged = [...cached];
  for (const id of found) {
    if (seen.has(id.toString())) continue;
    seen.add(id.toString());
    merged.push(id);
  }
  merged.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return merged;
}

export type PositionsHandle = {
  status: "disconnected" | "scanning" | "loading" | "ready" | "error";
  /** The confirmed rows, or null before the first confirmation read returns. */
  rows: readonly PositionRow[] | null;
  snapshot: Snapshot<readonly PositionRow[]> | null;
  /** True while the log scan is still running: the list is correct but incomplete (SPEC §9.6). */
  partial: boolean;
  /**
   * Non-null when the RPC has pruned the logs below this block, so no entry older than it can be listed.
   *
   * Distinct from `partial`: that one clears when the scan finishes, this one does not, because the history
   * is missing for good on this endpoint. SPEC §10.1 requires it to be labelled rather than papered over.
   */
  historyUnavailableBelow: bigint | null;
  scan: ScanState | null;
  error: Error | null;
  /** Extend the scan from its cursor and re-read the confirmations: a claim, a route change, a poll. */
  refresh: () => void;
  /**
   * Throw the memoized scan away and read the whole span again from `startBlock`.
   *
   * The retry a reader presses. Only this clears `historyUnavailableBelow`, which is otherwise monotonic
   * for the life of the account epoch.
   */
  rescan: () => void;
};

const EMPTY_IDS: readonly bigint[] = [];

export type UsePositionsOptions = {
  /** `eth_getLogs` range. Defaults to the 2,000 blocks of SPEC §10.1. */
  windowBlocks?: bigint;
};

export function usePositions(options?: UsePositionsOptions): PositionsHandle {
  const {manifest, provider} = useDeployment();
  const {account, accountEpoch} = useWallet();
  const windowBlocks = options?.windowBlocks ?? DEFAULT_LOG_WINDOW;

  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanError, setScanError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Set by `rescan()` only, and consumed by the next run of the effect. A ref rather than state because it
  // is an instruction to that one run, not a value anything renders.
  const restartRef = useRef(false);

  // One narrow adapter rather than passing the ethers provider straight through: an ethers signature change
  // is then a compile error here instead of a silent behaviour change in the scan.
  const logProvider = useMemo<LogProvider>(
    () => ({
      getLogs: (filter) =>
        provider.getLogs({
          address: filter.address,
          topics: [...filter.topics],
          fromBlock: filter.fromBlock,
          toBlock: filter.toBlock,
        }),
    }),
    [provider],
  );

  const key = account === null ? null : cacheKey(manifest.deploymentId, account, accountEpoch);

  // The account's scan state is dropped during the render that changes the key, not in the effect that runs
  // after it. An effect resets nothing until React has already committed a render, and the new scan does not
  // touch state until its first `await` returns, so the previous account's completed scan would otherwise be
  // served — with `partial: false` — against the new account, and the confirmation read would fire for the
  // new account over the old account's round ids (SPEC §9.2: an account change clears account-scoped caches).
  const [scanKey, setScanKey] = useState<string | null>(key);
  if (scanKey !== key) {
    setScanKey(key);
    setScan(null);
    setScanError(null);
  }

  // The scan. `attempt` is the retry trigger; `key` carries the account and its epoch, so a disconnect or an
  // account change both start a new one and both drop every cached entry that is not the new key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the re-run trigger, not a value.
  useEffect(() => {
    if (key === null || account === null) {
      setScan(null);
      setScanError(null);
      return;
    }
    for (const existing of [...scanCache.keys()]) {
      if (existing !== key) scanCache.delete(existing);
    }
    // A cached scan is the base every later run extends, complete or not. The invariant that makes resuming
    // from `scannedTo` safe is narrow and worth stating exactly: `scanEntryRounds` moves its cursor past a
    // window either because the node answered it in full, or because the node refused an unbroken prefix of
    // the span as pruned — so the only hole below the cursor is that recorded prefix, everything below
    // `historyUnavailableBelow`, and the boundary is carried across runs precisely so the page keeps saying
    // so. Above it the range is contiguous and read. A run that stopped for any other reason left a *tail*
    // it never reached, which the next run picks up. Only `complete` is not inherited: this run recomputes
    // it. An explicit rescan does not come here at all — it drops the entry first, so `base` is null and the
    // span starts at `startBlock` again (SPEC §10.1: "do not rescan genesis ... on each page load" governs
    // page loads, not a retry the reader asked for).
    if (restartRef.current) {
      restartRef.current = false;
      scanCache.delete(key);
    }
    const cached = scanCache.get(key);
    const base = cached ?? null;
    if (base !== null) setScan(base);

    let live = true;
    const startBlock = manifest.chain.startBlock;
    const fromBlock = base === null ? startBlock : base.scannedTo + 1n;
    setScanError(null);

    const run = async (): Promise<void> => {
      const head = BigInt(await provider.getBlockNumber());
      const toBlock = head < fromBlock ? fromBlock : head;
      if (!live) return;
      // Nothing has been mined since the cached scan: no `getLogs` at all, and the cached ids stand.
      if (base !== null && head < fromBlock) {
        setScan({...base, toBlock: head < base.toBlock ? base.toBlock : head});
        return;
      }
      // The window the progress line measures is the whole history, not the tail this run reads, so an
      // incremental scan does not report "3 of 12 blocks" over a deployment of thousands.
      const spanFrom = base?.fromBlock ?? fromBlock;
      const merge = (found: readonly bigint[]): readonly bigint[] => mergeRoundIds(base?.roundIds, found);
      // A boundary an earlier run learned is kept, and a later run may only raise it: the blocks below it
      // did not come back.
      const mergeBoundary = (found: bigint | null): bigint | null => {
        const previous = base?.historyUnavailableBelow ?? null;
        if (found === null) return previous;
        if (previous === null) return found;
        return found > previous ? found : previous;
      };
      const initial: ScanState = {
        fromBlock: spanFrom,
        toBlock,
        scannedTo: base === null ? fromBlock : base.scannedTo,
        complete: false,
        roundIds: base?.roundIds ?? [],
        historyUnavailableBelow: base?.historyUnavailableBelow ?? null,
      };
      setScan(initial);
      const result = await scanEntryRounds({
        provider: logProvider,
        manifest,
        account,
        fromBlock,
        toBlock,
        windowBlocks,
        cancelled: () => !live,
        onProgress: (progress) => {
          if (!live) return;
          setScan({
            fromBlock: spanFrom,
            toBlock,
            scannedTo: progress.scannedTo,
            roundIds: merge(progress.roundIds),
            complete: false,
            historyUnavailableBelow: mergeBoundary(progress.historyUnavailableBelow),
          });
        },
      });
      if (!live) return;
      const done: ScanState = {
        fromBlock: spanFrom,
        toBlock,
        // A scan that read nothing reports the block before its own start; the cursor never goes backwards.
        scannedTo: base !== null && result.scannedTo < base.scannedTo ? base.scannedTo : result.scannedTo,
        roundIds: merge(result.roundIds),
        complete: result.complete,
        historyUnavailableBelow: mergeBoundary(result.historyUnavailableBelow),
      };
      // Partial progress is memoized too, so a scan that a rate limit stopped after n blocks resumes at
      // block n+1 on the next mount or on "Scan again" instead of starting over at `startBlock`. The entry
      // carries `complete: false`, so nothing downstream reads it as the whole history.
      scanCache.set(key, done);
      setScan(done);
      // A scan that stopped short keeps the rows it did find and says why, rather than presenting a short
      // list as the whole history (SPEC §10.1: never serve a partial aggregate as complete).
      if (result.error !== null) setScanError(result.error);
    };

    void run().catch((caught: unknown) => {
      if (!live) return;
      setScanError(caught instanceof Error ? caught : new Error(String(caught)));
    });

    return () => {
      live = false;
    };
  }, [key, account, manifest, provider, logProvider, windowBlocks, attempt]);

  const roundIds = scan?.roundIds ?? EMPTY_IDS;
  const idsKey = roundIds.join(",");

  const confirmed = useSnapshot<readonly PositionRow[]>(
    `positions:${key ?? "none"}`,
    (ctx) =>
      account === null
        ? Promise.reject(new Error("no account is connected"))
        : resolvePositions(ctx, roundIds, account),
    {deps: [idsKey], enabled: account !== null && roundIds.length > 0},
  );

  const confirmedRefresh = confirmed.refresh;
  // The cache is kept, not dropped: a refresh after a claim re-reads the positions and extends the scan from
  // its cursor. Rescanning the deployment from `startBlock` to learn that one round's refund was credited is
  // exactly the page-load rescan SPEC §10.1 rules out.
  const refresh = useCallback(() => {
    setAttempt((value) => value + 1);
    confirmedRefresh();
  }, [confirmedRefresh]);

  // The reader's own "Scan again", which is a different request from the one above: start over at
  // `startBlock` with nothing inherited. It exists because everything the cached cursor carries is
  // monotonic, `historyUnavailableBelow` above all — it may only rise, so one endpoint that refused the
  // early history pins that claim on the account for the rest of the session even after the operator points
  // the app at an archive RPC. A resume can never unlearn it; only a scan that starts from `startBlock`
  // again can, so the entry is dropped rather than extended. This is not the page-load rescan SPEC §10.1
  // rules out: it happens when a reader asks, never on a mount, a route change or a claim.
  const rescan = useCallback(() => {
    restartRef.current = true;
    setAttempt((value) => value + 1);
    confirmedRefresh();
  }, [confirmedRefresh]);

  return useMemo<PositionsHandle>(() => {
    if (account === null) {
      return {
        status: "disconnected",
        rows: null,
        snapshot: null,
        partial: false,
        historyUnavailableBelow: null,
        scan: null,
        error: null,
        refresh,
        rescan,
      };
    }
    const partial = scan !== null && !scan.complete;
    const error = scanError ?? confirmed.error;
    let status: PositionsHandle["status"];
    // A failed confirmation read with nothing to fall back on is an error, not a load that never ends: the
    // page must be able to say what went wrong and offer the retry (SPEC §9.6, X4).
    if (scanError !== null) status = "error";
    else if (confirmed.status === "error" && confirmed.value === null) status = "error";
    else if (partial) status = "scanning";
    else if (scan === null || (roundIds.length > 0 && confirmed.value === null)) status = "loading";
    else status = "ready";
    return {
      status,
      // No scan, no rows: the previous account's confirmed list is never shown under a new key.
      rows: scan === null ? null : roundIds.length === 0 ? [] : confirmed.value,
      snapshot: confirmed.snapshot,
      partial,
      historyUnavailableBelow: scan?.historyUnavailableBelow ?? null,
      scan,
      error,
      refresh,
      rescan,
    };
  }, [account, scan, scanError, confirmed, roundIds.length, refresh, rescan]);
}
