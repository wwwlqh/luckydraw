// One loop, one snapshot block per cycle, one transaction per round per cycle.
//
// Per cycle the keeper resolves the head block once and reads everything at it (SPEC §10.1: "related direct
// reads use one blockTag"), so every decision in a cycle is taken against one consistent state and the chain
// timestamp that drives `decide` is the block's, never the host clock's (SPEC §10.2).
//
// What it tracks: the current round of every enabled pool and kind, plus every round it has already seen that
// has not reached a terminal state. The second half is necessary, not extra: `closeRound` advances `current`
// to the successor in the same transaction, so a round the keeper must still request, settle or refund stops
// being current the moment it closes.
//
// That alone only holds for a round this process watched while it was still current. A round closed before
// the process started - by the operator, by the app, or by the keeper itself before a restart - is named by
// no pool pointer and appeared in no cycle, so it would sit in AwaitingRequest until its 24-hour deadline and
// expire into refunds while a keeper was running (observed on chain 97, round 1, 2026-09-18). So the first
// cycle, and every `DISCOVERY_EVERY_CYCLES` after it, walks `1..roundCount()` in pages and tracks every round
// that is not terminal. The walk is bounded twice: by the page size, and by `highestExamined` - a round that
// was Settled, Void or fully refunded when it was examined can never become unresolved again (SPEC §6.2:
// "Settled/Void never transition"), so the periodic pass only looks at ids created since the last one. This
// is the in-memory version of the persisted "round IDs seen in RoundOpened that have not reached Settled or
// Void" of SPEC §10.2, rebuilt from `getRound` rather than from a store, which is what SPEC §10.2 means by
// "keeper state is fully reconstructible from chain".
//
// What it also tracks, for the same reason, is what it has already sent. A cycle is 15 seconds and inclusion
// is not instant, so without an in-flight set every action would be re-derived from unchanged chain state and
// re-sent each cycle until the first one was mined, and every duplicate would revert (`AlreadySeeded`,
// `RoundNotOpen`, `AlreadyClaimed`) at full gas cost. `inFlightSends` suppresses the repeat for
// `IN_FLIGHT_MS`, and drops the suppression as soon as the chain shows the precondition changed. It is
// memory, not a persisted in-flight set with nonce reconciliation: that is SPEC §10.2 production work.

import {
  type Address,
  blockTagOf,
  type Hex,
  Kind,
  MAX_PAGE_LIMIT,
  type PreparedWrite,
  prepareClaimRefund,
  prepareCloseRound,
  prepareEnsureCurrent,
  prepareExpireUnrequested,
  prepareRequestDraw,
  prepareSeedRound,
  prepareSettle,
  type ReadContext,
  type ReadProvider,
  type RoundView,
  readPosition,
  resolveSnapshotBlock,
  stateName,
  type VerifiedDeployment,
  ZERO_ADDRESS,
} from "./client.ts";
import type {KeeperConfig} from "./config.ts";
import type {CostMeter} from "./costs.ts";
import {type ActionKind, decide, type SeedFacts} from "./decide.ts";
import type {Logger} from "./log.ts";
import {createNotifier, type Notifier} from "./notify.ts";
import {
  type BatchContext,
  decodeRound,
  type PoolFacts,
  readCycleHead,
  readPoolFacts,
  readRoundCount,
  readRounds,
} from "./reads.ts";
import {discoverBuyers, type LogQuery, RefundTracker} from "./refunds.ts";
import {type Dispatcher, type DispatchResult, recoverSentHash, sendFailureReason} from "./sender.ts";
import {decodeGetSubscription, encodeGetSubscription} from "./vrf.ts";

// Every `Kind` a pool runs a sequence for, in Types.sol order (SPEC §6.1, ADR 036): three daily tiers,
// three weekly tiers and one monthly tier. Seven sequences per pool.
const KINDS = [
  Kind.Day100,
  Kind.Day1k,
  Kind.Day10k,
  Kind.Week1k,
  Kind.Week10k,
  Kind.Week100k,
  Kind.Month100k,
] as const;

/** SPEC §6.2 forbids a second accepted request, and the pre-checks are chain state: back off, do not hammer. */
export const REQUEST_RETRY_MS = 60_000;

/**
 * How often one round's buyer list may be thrown away and rediscovered after it proved incomplete.
 *
 * A rescan re-reads every block from the manifest's `chain.startBlock`, so it is the most expensive thing
 * this keeper does; the condition that triggers it can also be a log node that is merely behind, which will
 * catch up on its own. Once a minute is often enough that a refund is credited promptly and rare enough that
 * a permanently broken log endpoint cannot turn a 15-second cycle into a full history scan.
 */
export const REFUND_RESCAN_MS = 60_000;

/**
 * How long a sent transaction suppresses an identical one.
 *
 * A cycle is 15 seconds and this keeper has no persisted in-flight set (SPEC §10.2's is deferred, see the
 * README), so without this every unmined action would be re-derived and re-sent every cycle and every
 * duplicate would revert on chain - `AlreadySeeded`, `RoundNotOpen`, `AlreadyClaimed` - burning gas for
 * nothing. Two minutes is well past inclusion on BSC and is only an upper bound: the suppression is dropped
 * the moment the chain shows the precondition changed, so a dropped transaction is retried as soon as the
 * round is observably still in the state that asked for it.
 */
export const IN_FLIGHT_MS = 120_000;

/** Consecutive whole-cycle RPC failures after which the process exits non-zero. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Round ids per `getRound` batch during the historical discovery scan.
 *
 * With Multicall3 one page is one `eth_call`; without it, one page is this many. A deployment with thousands
 * of settled rounds is therefore walked in bounded steps rather than in one request a public BSC endpoint
 * would refuse - and only once, because `highestExamined` never looks at a terminal id twice.
 */
export const DISCOVERY_PAGE_SIZE = 50;

/**
 * Cycles between historical discovery passes. The first pass is the first cycle.
 *
 * Every round the keeper itself opens, closes or sees as current is tracked without any of this, so the
 * periodic pass exists for the rounds somebody else moved - the app, or the operator - while this process was
 * between cycles. Twenty cycles is five minutes at the default interval, well inside the 24-hour request
 * deadline the scan protects and inside SPEC §10.3's 10-minute "keeper action overdue" warning for a round
 * that was closed by somebody else and is already past its cutoff.
 */
export const DISCOVERY_EVERY_CYCLES = 20;

/**
 * How often the VRF subscription's native balance is read (SPEC §10.3 "subscription balance" signal).
 *
 * Not every cycle: at the default interval that would be four extra `eth_call`s a minute for a number that
 * moves once per draw, and the alert it feeds is rate-limited to one an hour anyway. Five minutes is far
 * inside the time it takes a funded subscription to run dry, and the alert is a warning to top up, not a
 * safety mechanism - SPEC §6.2's own pre-check already refuses to request a draw the subscription cannot pay
 * for.
 */
export const SUBSCRIPTION_CHECK_MS = 300_000;

const NO_SEED: SeedFacts = {configured: false, authorized: false, funded: false};

/**
 * One pool's seed capacity for this cycle.
 *
 * The cap and the balance are read once per pool per cycle, but `funded` cannot be: one pool has seven kinds,
 * so a balance that covers exactly one seed must fund exactly one of them. `issued` counts the seeds already
 * committed this cycle, and each further seed demands `seedAmount x (issued + 1)`. The per-asset cap check is
 * a separate, unchanged question: `Vault.lockSeed` enforces `seedMaxPerRound` per round, not per cycle.
 */
type SeedBudget = {
  configured: boolean;
  authorized: boolean;
  balance: bigint;
  seedAmount: bigint;
  issued: number;
};

/** What `decide` may assume about the seed for the next round of this pool. */
function seedFactsOf(budget: SeedBudget | undefined): SeedFacts {
  if (budget === undefined || !budget.configured) return NO_SEED;
  if (!budget.authorized) return {configured: true, authorized: false, funded: false};
  return {
    configured: true,
    authorized: true,
    funded: budget.balance >= budget.seedAmount * BigInt(budget.issued + 1),
  };
}

/** An action already sent, with the chain facts its precondition rested on. */
type InFlightSend = {
  at: number;
  state: RoundView["state"];
  seeded: boolean;
};

export type KeeperDeps = {
  config: KeeperConfig;
  deployment: VerifiedDeployment;
  provider: ReadProvider;
  dispatcher: Dispatcher;
  logQuery: LogQuery;
  logger: Logger;
  /** Multicall3 for this chain (`config/chains/<id>.json`); absent means one `eth_call` per read. */
  multicall3?: Address | undefined;
  /** Wall clock, only for the request back-off; every on-chain decision uses the block timestamp. */
  monotonicNow?: () => number;
  /** Heartbeat and alerts. Absent means a notifier with both URLs unset: nothing is ever sent. */
  notify?: Notifier;
  /** Per-draw cost accounting. Absent means no receipts are polled and no `draw_cost` is logged. */
  costMeter?: CostMeter;
  /** Called after `MAX_CONSECUTIVE_FAILURES` failed cycles. `main.ts` exits non-zero. */
  onFatal?: (error: unknown) => void;
  /**
   * Retry budget and waiting seams for the buyer scan's rate-limit backoff (SPEC §10.1).
   *
   * Production leaves this unset and gets six retries of real, jittered waits. Tests set it so a scan
   * against a permanently throttled node finishes in milliseconds instead of half a minute.
   */
  logScanRetry?: {
    maxRateLimitRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  };
};

export type Keeper = {
  /** One full pass. Throws on an RPC failure, which `start` counts and logs. */
  runCycle(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  readonly tracked: readonly bigint[];
  readonly consecutiveFailures: number;
};

export function createKeeper(deps: KeeperDeps): Keeper {
  const {config, deployment, provider, dispatcher, logQuery, logger} = deps;
  const monotonicNow = deps.monotonicNow ?? ((): number => Date.now());
  const startBlock = deployment.manifest.chain.startBlock;
  // A notifier with both URLs null is a working object that opens no socket, so every call site below is
  // unconditional and the "nothing is sent unless the operator set the variable" rule lives in one place.
  const notify = deps.notify ?? createNotifier({heartbeat: null, alertWebhook: null, logger});
  const costMeter = deps.costMeter;

  const tracked = new Set<bigint>();
  const refunds = new RefundTracker();
  /** A Refunding round takes no new entries, so its buyer list is discovered once and reused. */
  const buyersByRound = new Map<string, readonly Address[]>();
  /** When each round's buyer list was last thrown away as incomplete; the rescan budget of `handleRefunds`. */
  const buyerRescanAt = new Map<string, number>();
  const requestBackoff = new Map<string, number>();
  /** `${roundId}:${action}[:${account}]` of every send whose effect the chain has not shown yet. */
  const inFlightSends = new Map<string, InFlightSend>();
  /** The same, for the one action that names a pool and a kind rather than a round. */
  const ensureCurrentSends = new Map<string, number>();

  /** The highest round id every id below which has been examined by a discovery pass and judged. */
  let highestExamined = 0n;
  /** Cycles left before the next discovery pass; zero on the first cycle, so start-up always scans. */
  let cyclesUntilDiscovery = 0;

  let lastSubscriptionCheckAt: number | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let consecutiveFailures = 0;

  function inFlightKey(roundId: bigint, action: ActionKind, account?: Address): string {
    return account === undefined ? `${roundId}:${action}` : `${roundId}:${action}:${account}`;
  }

  /**
   * Is an identical send still expected to be mined?
   *
   * Two things end the suppression, whichever comes first: the chain showing that the precondition the send
   * rested on has changed (the round advanced, or it is now seeded - the transaction landed, or somebody
   * else's did), or `IN_FLIGHT_MS` elapsing, which covers a transaction that was dropped rather than mined.
   */
  function stillInFlight(key: string, round: RoundView): boolean {
    const entry = inFlightSends.get(key);
    if (entry === undefined) return false;
    if (entry.state !== round.state || entry.seeded !== round.seeded) {
      inFlightSends.delete(key);
      return false;
    }
    if (monotonicNow() - entry.at >= IN_FLIGHT_MS) {
      inFlightSends.delete(key);
      return false;
    }
    return true;
  }

  function forgetInFlight(roundId: bigint): void {
    const prefix = `${roundId}:`;
    for (const key of inFlightSends.keys()) if (key.startsWith(prefix)) inFlightSends.delete(key);
  }

  async function act(
    round: RoundView,
    action: ActionKind,
    write: PreparedWrite,
    account?: Address,
  ): Promise<DispatchResult> {
    let result: DispatchResult;
    let sendFailed = false;
    /** Set only when the raw transaction is provably already on the wire despite the throw. */
    let broadcast: Hex | undefined;
    try {
      result = await dispatcher.dispatch(write);
    } catch (error) {
      // The dispatcher contains a failed *simulation*; a failed *send* - a nonce gap, an underpriced
      // replacement, a socket timeout, a keeper account out of gas - is a throw. Unattended it propagates
      // through the round loop, costing every later round in this cycle its turn and counting towards the
      // ten consecutive failures that exit the process. One round's bad send is one round's bad send.
      sendFailed = true;
      broadcast = recoverSentHash(error);
      result = {status: "skipped", reason: sendFailureReason(error)};
    }
    const base = {round: round.id, state: stateName(round.state), action, account};
    if (result.status === "sent")
      logger.info("action_sent", {...base, tx: result.hash, gas: result.gasLimit});
    else if (result.status === "dryRun") logger.info("action_dry_run", {...base, gas: result.gasLimit});
    else logger.warn("action_skipped", {...base, skip: result.reason, tx: broadcast});
    // Only a real send is suppressed: a dry run changes nothing on chain, and a skipped simulation was never
    // sent, so neither may hide the same decision from the next cycle. A send that threw *after* broadcasting
    // is a send: its hash is out, so the next cycle must not race it with a duplicate.
    if (result.status === "sent" || broadcast !== undefined) {
      inFlightSends.set(inFlightKey(round.id, action, account), {
        at: monotonicNow(),
        state: round.state,
        seeded: round.seeded,
      });
      // The same condition, for the same reason: a transaction that is on the wire will be mined and will
      // cost gas, whether or not the call that broadcast it also returned a hash.
      const hash = result.status === "sent" ? result.hash : broadcast;
      if (hash !== undefined) costMeter?.recordSend(round.id, action, hash);
    }
    // A send failure is not a pre-check failure: it says nothing about the key hash or the subscription, so
    // it must not be reported as one, and a nonce error must not silence `requestDraw` for a minute.
    if (action === "requestDraw" && result.status === "skipped" && !sendFailed) {
      requestBackoff.set(round.id.toString(), monotonicNow());
      logger.warn("request_precheck_failed", {
        round: round.id,
        skip: result.reason,
        note: "SPEC 6.2 requestDraw pre-checks: key hash registered and subscription funded",
      });
      // Chain state a retry cannot change: an operator has to re-register the key hash or fund the
      // subscription, so this is the one skip in the table that is worth waking somebody for.
      notify.alert("request_precheck_failed", {round: round.id, skip: result.reason});
    }
    return result;
  }

  /** `act`, unless the identical action is still in flight. `null` means it was deferred, not attempted. */
  async function attempt(
    round: RoundView,
    action: ActionKind,
    write: PreparedWrite,
  ): Promise<DispatchResult | null> {
    if (stillInFlight(inFlightKey(round.id, action), round)) {
      logger.info("action_deferred", {
        round: round.id,
        state: stateName(round.state),
        action,
        skip: "InFlight",
      });
      return null;
    }
    return act(round, action, write);
  }

  /**
   * One pool's seed budget from its already-read cap and balance.
   *
   * `seed` is null when the batch was never asked: no seed account, no seed amount, or a disabled pool. That
   * is the same "not configured" answer the per-pool read produced by returning early (SPEC §5.4).
   */
  function seedBudgetOf(seed: PoolFacts["seed"], seedAmount: bigint): SeedBudget {
    const empty = {configured: false, authorized: false, balance: 0n, seedAmount, issued: 0};
    if (seed === null) return empty;
    // The cap is per round, so it is compared with one `seedAmount` exactly as `Vault.lockSeed` does.
    if (seed.cap < seedAmount) return {...empty, configured: true};
    return {configured: true, authorized: true, balance: seed.balance, seedAmount, issued: 0};
  }

  async function handleRefunds(ctx: ReadContext, round: RoundView, toBlock: bigint): Promise<void> {
    const key = round.id.toString();
    let buyers = buyersByRound.get(key);
    if (buyers === undefined) {
      buyers = await discoverBuyers({
        deployment,
        roundId: round.id,
        fromBlock: startBlock,
        toBlock,
        window: config.logWindow,
        query: logQuery,
        ...deps.logScanRetry,
      });
      buyersByRound.set(key, buyers);
      logger.info("refund_buyers_discovered", {
        round: round.id,
        buyers: buyers.length,
        fromBlock: startBlock,
        toBlock,
        window: config.logWindow,
      });
    }
    let deferred = 0;
    for (const account of refunds.pending(round.id, buyers)) {
      // The in-memory set is an optimisation; the chain is the authority before every claim.
      const position = (await readPosition(ctx, round.id, account)).value;
      const claimKey = inFlightKey(round.id, "claimRefunds", account);
      if (position.refunded) {
        refunds.markRefunded(round.id, account);
        inFlightSends.delete(claimKey); // The claim landed: the precondition changed on chain.
        continue;
      }
      if (position.gross === 0n) {
        // `claimRefund` reverts `InvalidAmount` for an account with no entry (SPEC §6.2).
        refunds.markRefunded(round.id, account);
        inFlightSends.delete(claimKey);
        continue;
      }
      if (stillInFlight(claimKey, round)) {
        deferred += 1;
        // Per account, not per round: one buyer's unmined claim must not hold up the next buyer's.
        logger.info("action_deferred", {
          round: round.id,
          state: stateName(round.state),
          action: "claimRefunds",
          account,
          skip: "InFlight",
        });
        continue;
      }
      await act(round, "claimRefunds", prepareClaimRefund(deployment, round.id, account), account);
      return; // One transaction per round per cycle.
    }
    if (deferred === 0 && round.refundedGross < round.grossTotal) {
      // Every buyer this process knows of is refunded, and the round's own accounting still says gross is
      // outstanding. The list is therefore short: `discoverBuyers` is honest about a *thrown* or *full* page,
      // but a lagging archive node that answers 200 OK with part of the range is indistinguishable from a
      // quiet round, and the list is cached for the life of the round. Cached, that is permanent - every
      // later cycle would log `refund_idle NoUnrefundedBuyer` while somebody's refund is never credited. So
      // the cache is dropped and the next cycle rescans, at most once a minute per round, because a rescan
      // walks the whole history from `chain.startBlock` and the condition can also be an honest lag.
      const last = buyerRescanAt.get(key);
      const rescan = last === undefined || monotonicNow() - last >= REFUND_RESCAN_MS;
      if (rescan) {
        buyersByRound.delete(key);
        buyerRescanAt.set(key, monotonicNow());
      }
      logger.warn("refund_buyers_incomplete", {
        round: round.id,
        state: stateName(round.state),
        buyers: buyers.length,
        refundedGross: round.refundedGross,
        grossTotal: round.grossTotal,
        rescan,
      });
      return;
    }
    logger.info("refund_idle", {
      round: round.id,
      state: stateName(round.state),
      skip: deferred > 0 ? "ClaimsInFlight" : "NoUnrefundedBuyer",
    });
  }

  /**
   * The VRF subscription's native balance against the manifest's `lowFundingThresholdNative` (SPEC §10.3).
   *
   * Contained like the refund scan: a coordinator that does not answer `getSubscription` - or a node that
   * fails the call - is a warning, never a failed cycle. The keeper does not need this number to act; SPEC
   * §6.2's own `requestDraw` pre-check is what actually stops an unfundable request.
   */
  async function checkSubscription(blockNumber: bigint): Promise<void> {
    const {vrf} = deployment.manifest;
    if (lastSubscriptionCheckAt !== null && monotonicNow() - lastSubscriptionCheckAt < SUBSCRIPTION_CHECK_MS)
      return;
    lastSubscriptionCheckAt = monotonicNow();
    try {
      const raw = await provider.call({
        to: vrf.coordinator,
        data: encodeGetSubscription(vrf.subscriptionId),
        blockTag: blockTagOf(blockNumber),
      });
      const subscription = decodeGetSubscription(raw as Hex);
      const low = subscription.nativeBalance < vrf.lowFundingThresholdNative;
      const fields = {
        subscription: vrf.subscriptionId,
        nativeBalanceWei: subscription.nativeBalance,
        thresholdWei: vrf.lowFundingThresholdNative,
      };
      logger.log(low ? "warn" : "info", "subscription", {...fields, low});
      if (low) notify.alert("subscription_below_threshold", fields);
    } catch (error) {
      logger.warn("subscription_check_failed", {
        coordinator: vrf.coordinator,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Every round of `1..roundCount()` that is not terminal, added to the tracked set (SPEC §10.2).
   *
   * Terminality is not a second state table: it is `decide` itself returning `done`, so a round is dropped
   * here on exactly the condition the cycle drops it on - Settled, Void, or Refunding with nothing
   * outstanding - and the §6.2 table stays in one file. The seed facts handed to `decide` are the empty ones
   * because this asks a yes/no question about the round, never what to do with it; what to do is decided in
   * the cycle below, against that pool's real budget.
   *
   * Contained like the refund scan: a node that fails a page is a warning and an unchanged `highestExamined`,
   * never a failed cycle. The pass is an addition to the tracked set, so losing one costs nothing that the
   * next one does not recover, and a round already tracked would be acted on anyway.
   */
  async function discoverHistorical(batch: BatchContext, now: bigint): Promise<void> {
    if (cyclesUntilDiscovery > 0) {
      cyclesUntilDiscovery -= 1;
      return;
    }
    cyclesUntilDiscovery = DISCOVERY_EVERY_CYCLES - 1;
    let total: bigint;
    try {
      total = await readRoundCount(batch);
    } catch (error) {
      logger.warn("discovery_failed", {
        from: highestExamined + 1n,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const from = highestExamined + 1n;
    if (total < from) return; // Nothing has been created since the last pass.
    let examined = 0;
    let added = 0;
    const page = BigInt(DISCOVERY_PAGE_SIZE);
    for (let start = from; start <= total; start += page) {
      const end = start + page - 1n < total ? start + page - 1n : total;
      const ids: bigint[] = [];
      for (let id = start; id <= end; id += 1n) ids.push(id);
      let outcomes: Awaited<ReturnType<typeof readRounds>>;
      try {
        outcomes = await readRounds(batch, ids);
      } catch (error) {
        // `highestExamined` is left where the last complete page put it, so the next pass resumes here
        // rather than skipping the ids this page would have judged.
        logger.warn("discovery_failed", {
          from: start,
          to: end,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      let completed = true;
      for (const [index, id] of ids.entries()) {
        let round: RoundView;
        try {
          round = decodeRound(outcomes, index);
        } catch (error) {
          // Ids `1..roundCount` all exist, so this is a node fault rather than a missing round: do not
          // record it as examined, and stop the pass so the next one asks again from here.
          logger.warn("discovery_round_failed", {
            round: id,
            error: error instanceof Error ? error.message : String(error),
          });
          completed = false;
          break;
        }
        examined += 1;
        highestExamined = id;
        if (decide({round, now, seed: NO_SEED}).kind === "done") continue;
        if (tracked.has(id)) continue;
        added += 1;
        tracked.add(id);
        logger.info("discovered_round", {round: id, state: stateName(round.state)});
      }
      if (!completed) break;
    }
    logger.info("discovery", {from, to: total, examined, added, highestExamined});
  }

  async function runCycle(): Promise<void> {
    const block = await resolveSnapshotBlock(provider, {tag: "latest"});
    // One snapshot for the whole cycle, in two shapes: `ctx` for the refund path's per-account `getPosition`,
    // and `batch` for the three grouped stages of `reads.ts`. Both carry the same block and the same
    // Multicall3, so every read of the cycle is one blockTag and - with Multicall3 - three `aggregate3`
    // calls rather than one `eth_call` per adapter (SPEC §10.1).
    const ctx: ReadContext = {provider, deployment, block, multicall3: deps.multicall3};
    const batch: BatchContext = {provider, deployment, block, multicall3: deps.multicall3};
    const now = block.timestamp;

    // Receipts of last cycle's sends, before this cycle sends anything new.
    await costMeter?.collect(block.blockNumber);
    await checkSubscription(block.blockNumber);

    const {pools, seedAccount} = await readCycleHead(batch, 0n, MAX_PAGE_LIMIT);
    const facts = await readPoolFacts(batch, {
      pools,
      kinds: KINDS,
      seedAccount,
      // Exactly the question the per-pool read answered by returning early: a disabled pool gets no seed
      // budget, so `seedFactsOf(undefined)` names every one of its Open rounds `SeedNotConfigured` and no
      // seed is ever attempted for it (SPEC §5.4, §6.1).
      wantsSeed: (pool) => pool.enabled && seedAccount !== ZERO_ADDRESS && pool.seedAmount > 0n,
    });
    const seedByPool = new Map<string, SeedBudget>();

    for (const pool of pools) {
      const poolFacts = facts.get(pool.id.toString());
      // The map is built from this same page, so this is unreachable; it is here because a silent `continue`
      // would turn a batch that came back short into a pool the keeper quietly stopped running.
      if (poolFacts === undefined) throw new Error(`the batch returned no reads for pool ${pool.id}`);
      if (pool.enabled) {
        seedByPool.set(pool.id.toString(), seedBudgetOf(poolFacts.seed, pool.seedAmount));
      }
      for (const [index, kind] of KINDS.entries()) {
        const current = poolFacts.current[index] ?? 0n;
        const ensureKey = `pool${pool.id}:${kind}:ensureCurrent`;
        if (current === 0n) {
          // SPEC §6.1: a disabled pool's existing round "finishes normally and then has zero current", and
          // `ensureCurrent` rejects a disabled pool outright. Zero here is the settled end state, not a gap.
          if (!pool.enabled) continue;
          // The contracts open a successor themselves in every closing branch (SPEC §6.1); a zero pointer
          // means a re-enabled pool, which SPEC §6.1 says needs an explicit `ensureCurrent`.
          // The pointer stays zero until the send is mined, so the same suppression applies here: without it
          // every cycle in between would send another one.
          const sentAt = ensureCurrentSends.get(ensureKey);
          if (sentAt !== undefined && monotonicNow() - sentAt < IN_FLIGHT_MS) {
            logger.info("action_deferred", {pool: pool.id, kind, action: "ensureCurrent", skip: "InFlight"});
            continue;
          }
          const write = prepareEnsureCurrent(deployment, pool.id, kind);
          let result: DispatchResult;
          let broadcast: Hex | undefined;
          try {
            result = await dispatcher.dispatch(write);
          } catch (error) {
            // Contained for the same reason as a round action's send (see `act`): one pool's failed send
            // must not cost every later pool and every tracked round its turn in this cycle.
            broadcast = recoverSentHash(error);
            result = {status: "skipped", reason: sendFailureReason(error)};
          }
          const hash = result.status === "sent" ? result.hash : broadcast;
          if (hash !== undefined) ensureCurrentSends.set(ensureKey, monotonicNow());
          logger.info("ensure_current", {
            pool: pool.id,
            kind,
            status: result.status,
            tx: hash,
            skip: result.status === "skipped" ? result.reason : undefined,
          });
          continue;
        }
        ensureCurrentSends.delete(ensureKey); // A nonzero pointer is the precondition having changed.
        // Tracked whether or not the pool is enabled: SPEC §6.1 lets a disabled pool's existing round finish
        // normally, and nothing else in this process would ever close, request or settle it.
        tracked.add(current);
      }
    }

    // Before stage 3, so a round discovered now is acted on in this same cycle rather than in the next one.
    await discoverHistorical(batch, now);

    // Stage 3: every tracked round in one batch, decoded one at a time. Decoding here rather than in
    // `readRounds` is what keeps a single reverting round from costing every later round its turn.
    const roundIds = [...tracked];
    const roundOutcomes = await readRounds(batch, roundIds);
    for (const [index, roundId] of roundIds.entries()) {
      const round = decodeRound(roundOutcomes, index);
      const budget = seedByPool.get(round.poolId.toString());
      const decision = decide({round, now, seed: seedFactsOf(budget)});
      const base = {round: roundId, state: stateName(round.state)};
      switch (decision.kind) {
        case "seedRound": {
          const result = await attempt(round, "seedRound", prepareSeedRound(deployment, roundId));
          // A seed that was sent, or is still in flight from an earlier cycle, will debit the seed account:
          // charge it against this pool's balance so one balance read cannot fund seven kinds (F9).
          if (budget !== undefined && result?.status !== "skipped") budget.issued += 1;
          break;
        }
        case "closeRound":
          await attempt(round, "closeRound", prepareCloseRound(deployment, roundId));
          break;
        case "requestDraw": {
          const last = requestBackoff.get(roundId.toString());
          if (last !== undefined && monotonicNow() - last < REQUEST_RETRY_MS) {
            logger.info("action_deferred", {...base, action: "requestDraw", skip: "RequestBackoff"});
            break;
          }
          await attempt(round, "requestDraw", prepareRequestDraw(deployment, roundId));
          break;
        }
        case "expireUnrequested":
          await attempt(round, "expireUnrequested", prepareExpireUnrequested(deployment, roundId));
          break;
        case "settle":
          await attempt(round, "settle", prepareSettle(deployment, roundId));
          break;
        case "claimRefunds":
          try {
            await handleRefunds(ctx, round, block.blockNumber);
          } catch (error) {
            // One round's log scan (or claim) must not cost every later round its turn, and must not count
            // towards the fatal cycle-failure total: the other rounds in this cycle are unaffected by it.
            logger.warn("refund_scan_failed", {
              ...base,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        case "done":
          logger.info("round_resolved", {...base, reason: decision.reason});
          tracked.delete(roundId);
          refunds.forget(roundId);
          buyersByRound.delete(roundId.toString());
          buyerRescanAt.delete(roundId.toString());
          requestBackoff.delete(roundId.toString());
          forgetInFlight(roundId);
          break;
        case "none":
          logger.info("round_idle", {...base, skip: decision.reason});
          // Two of the quiet skips are operator faults, not states: the seed account has not authorized this
          // asset, or its Vault balance no longer covers a seed. Both mean rounds are running unseeded, and
          // SPEC §5.4's promise that a lone player still gets a draw quietly stops holding.
          if (decision.reason === "SeedNotAuthorized" || decision.reason === "InsufficientSeedBalance") {
            notify.alert(decision.reason, {round: roundId, pool: round.poolId});
          }
          break;
      }
    }

    logger.info("cycle", {
      block: block.blockNumber,
      timestamp: now,
      pools: pools.length,
      tracked: tracked.size,
      dryRun: config.dryRun,
    });
    // A healthy cycle is one that completed: every skip above is a decision, and only a throw - which never
    // reaches here - means the keeper could not see the chain. The request is started and not awaited, so a
    // slow or unreachable monitor cannot delay the next cycle.
    notify.heartbeat({block: block.blockNumber, tracked: tracked.size, pools: pools.length});
  }

  async function tick(): Promise<void> {
    try {
      await runCycle();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.error("cycle_failed", {
        failures: consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        notify.alert("consecutive_cycle_failures", {
          failures: consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        });
        // `main.ts` drains the notifier before it exits, so the alert is on the wire before the process is.
        deps.onFatal?.(error);
        return;
      }
    }
    if (!stopped) timer = setTimeout(schedule, config.intervalMs);
  }

  function schedule(): void {
    timer = null;
    inFlight = tick();
  }

  return {
    runCycle,
    start(): void {
      if (inFlight !== null || timer !== null) return;
      schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight?.catch(() => undefined);
    },
    get tracked(): readonly bigint[] {
      return [...tracked];
    },
    get consecutiveFailures(): number {
      return consecutiveFailures;
    },
  };
}
