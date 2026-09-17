// What one draw actually cost, in wei, from the chain rather than from an estimate.
//
// The mainnet shakedown (brief item 5, §14) has to fill `release.shakedown.costPerDrawNativeWei`, and there
// are two halves to it:
//
//   * the keeper's own gas, `gasUsed x effectiveGasPrice` summed over every transaction this process sent
//     for the round - seed, close, request and settle - taken from each receipt, never from the gas limit
//     it padded (`estimate x 1.3`), which is an upper bound and not a cost;
//   * the VRF `payment` charged to the subscription, which is the fourth argument of the coordinator's
//     `RandomWordsFulfilled` (SPEC §7.1). It is *not* in the request event and not in any Draw event, so it
//     is read from the fulfilment log, found by the `requestId` the keeper's own `requestDraw` receipt
//     carries in `DrawRequested`.
//
// Both are best effort and say so. This keeper keeps everything in memory (README "Deferred": no persisted
// cursor), so a restart loses the sends it has not yet collected receipts for and the affected round reports
// no cost rather than a wrong one. A round whose `requestDraw` was sent by somebody else - the web app may
// call it, every lifecycle method is public - has no observed `requestId` and reports `vrfPaymentWei=null`
// with the reason. A number that is missing is recoverable from the explorer; a number that is quietly wrong
// is what would put a bad figure in the manifest.
//
// Nothing here may fail a cycle: `collect` catches everything and turns it into a log line, exactly as the
// refund scan does, because a metric is not worth a missed `settle`.

import {
  type Address,
  decodeLog,
  drawEventTopics,
  type Hex,
  type Hex32,
  type RawLog,
  type VerifiedDeployment,
} from "./client.ts";
import type {ActionKind} from "./decide.ts";
import type {Logger} from "./log.ts";
import {decodeFulfilmentPayment, RANDOM_WORDS_FULFILLED_TOPIC, uint256Topic} from "./vrf.ts";

/** How long a sent transaction is waited on before its receipt is written off (and its gas with it). */
export const RECEIPT_WAIT_MS = 600_000;

/** How long a round with no settle is kept before its partial total is dropped, so memory stays bounded. */
export const COST_TTL_MS = 3_600_000;

/** Pages of `KEEPER_LOG_WINDOW` blocks searched for the fulfilment before giving up. */
export const MAX_FULFILMENT_PAGES = 5;

/** The parts of a receipt this needs. A raw `eth_getTransactionReceipt` result parses into it. */
export type MinedReceipt = {
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** 1 for success. A reverted transaction still cost its gas, so it is still counted. */
  status: bigint;
  logs: readonly RawLog[];
};

/** Null while the transaction is unmined or unknown to the node. */
export type ReceiptReader = (hash: Hex) => Promise<MinedReceipt | null>;

/** One `eth_getLogs` page against an emitter that is not the Draw, with positional topics. */
export type CoordinatorLogQuery = (filter: {
  address: Address;
  fromBlock: bigint;
  toBlock: bigint;
  topics: readonly (Hex32 | null)[];
}) => Promise<readonly RawLog[]>;

export type CostMeter = {
  /** Remember a transaction this keeper sent for a round, so its receipt is collected next cycle. */
  recordSend(roundId: bigint, action: ActionKind, hash: Hex): void;
  /** Poll outstanding receipts and report every round whose settle has landed. Never throws. */
  collect(head: bigint): Promise<void>;
  /** Rounds still being accounted for. Only tests read it. */
  readonly size: number;
};

export type CostMeterOptions = {
  deployment: VerifiedDeployment;
  logger: Logger;
  receipt: ReceiptReader;
  /** Absent means no fulfilment search: every report then carries `vrfPaymentWei=null`. */
  logs?: CoordinatorLogQuery;
  /** Blocks per fulfilment-search page; `KEEPER_LOG_WINDOW`. */
  window: bigint;
  now?: () => number;
};

type PendingSend = {action: ActionKind; at: number};

type RoundCost = {
  keeperGasWei: bigint;
  /** Transactions sent whose receipt has not been read yet, by hash. */
  pending: Map<Hex, PendingSend>;
  requestId: bigint | null;
  /** The block the keeper's `requestDraw` landed in; the lower bound of the fulfilment search. */
  requestBlock: bigint | null;
  settled: boolean;
  /** Transactions whose receipt the node never produced, so their gas is missing from the total. */
  lostReceipts: number;
  touchedAt: number;
};

const DRAW_REQUESTED_TOPIC = drawEventTopics.DrawRequested as Hex32;

/** A raw JSON-RPC receipt as `MinedReceipt`, or null when the node answered null (unmined or unknown). */
export function parseReceipt(raw: unknown): MinedReceipt | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const quantity = (key: string): bigint => {
    const value = record[key];
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && value !== "") return BigInt(value);
    return 0n;
  };
  const logs = Array.isArray(record.logs) ? (record.logs as readonly RawLog[]) : [];
  return {
    blockNumber: quantity("blockNumber"),
    gasUsed: quantity("gasUsed"),
    // Pre-1559 nodes answer with `gasPrice` only; a missing effective price makes the gas free, which is
    // wrong in the safe direction (a reported zero is visibly wrong, an invented price is not).
    effectiveGasPrice:
      record.effectiveGasPrice === undefined ? quantity("gasPrice") : quantity("effectiveGasPrice"),
    status: quantity("status"),
    logs,
  };
}

export function createCostMeter(options: CostMeterOptions): CostMeter {
  const {deployment, logger, receipt} = options;
  const now = options.now ?? ((): number => Date.now());
  const rounds = new Map<string, RoundCost>();

  function entry(roundId: bigint): RoundCost {
    const key = roundId.toString();
    const found = rounds.get(key);
    if (found !== undefined) {
      found.touchedAt = now();
      return found;
    }
    const created: RoundCost = {
      keeperGasWei: 0n,
      pending: new Map(),
      requestId: null,
      requestBlock: null,
      settled: false,
      lostReceipts: 0,
      touchedAt: now(),
    };
    rounds.set(key, created);
    return created;
  }

  /** The `requestId` the Draw logged in this receipt, ignoring look-alike emitters (SPEC §10.1). */
  function requestIdIn(mined: MinedReceipt): bigint | null {
    for (const log of mined.logs) {
      if ((log.topics[0] ?? "").toLowerCase() !== DRAW_REQUESTED_TOPIC) continue;
      const event = decodeLog(deployment, log);
      if (event === null || event.emitter !== "draw" || event.name !== "DrawRequested") continue;
      return event.args.requestId;
    }
    return null;
  }

  /** The subscription charge for one request, or the reason it could not be read. */
  async function findPayment(
    cost: RoundCost,
    head: bigint,
  ): Promise<{payment: bigint | null; note: string | null}> {
    const query = options.logs;
    if (query === undefined) return {payment: null, note: "FulfilmentSearchDisabled"};
    if (cost.requestId === null || cost.requestBlock === null) {
      return {payment: null, note: "RequestNotObserved"};
    }
    const topics: readonly (Hex32 | null)[] = [RANDOM_WORDS_FULFILLED_TOPIC, uint256Topic(cost.requestId)];
    let start = cost.requestBlock;
    for (let page = 0; page < MAX_FULFILMENT_PAGES && start <= head; page += 1) {
      const end = start + options.window - 1n > head ? head : start + options.window - 1n;
      const logs = await query({
        address: deployment.manifest.vrf.coordinator,
        fromBlock: start,
        toBlock: end,
        topics,
      });
      for (const log of logs) {
        const decoded = decodeFulfilmentPayment(log);
        if (decoded !== null && decoded.requestId === cost.requestId) {
          return {payment: decoded.payment, note: null};
        }
      }
      start = end + 1n;
    }
    // Reached on a mock coordinator, whose same-named event has a different signature and so a different
    // topic hash, and on a fulfilment further from the request than `MAX_FULFILMENT_PAGES` windows.
    return {payment: null, note: "FulfilmentNotFound"};
  }

  async function report(roundId: bigint, cost: RoundCost, head: bigint): Promise<void> {
    let payment: bigint | null = null;
    let note: string | null = null;
    try {
      ({payment, note} = await findPayment(cost, head));
    } catch (error) {
      note = `FulfilmentSearchFailed:${error instanceof Error ? error.message : String(error)}`;
    }
    logger.info("draw_cost", {
      round: roundId,
      keeperGasWei: cost.keeperGasWei,
      vrfPaymentWei: payment,
      requestId: cost.requestId,
      lostReceipts: cost.lostReceipts === 0 ? undefined : cost.lostReceipts,
      note: note ?? undefined,
    });
  }

  return {
    recordSend(roundId: bigint, action: ActionKind, hash: Hex): void {
      entry(roundId).pending.set(hash, {action, at: now()});
    },

    async collect(head: bigint): Promise<void> {
      for (const [key, cost] of [...rounds]) {
        try {
          for (const [hash, send] of [...cost.pending]) {
            const mined = await receipt(hash);
            if (mined === null) {
              if (now() - send.at < RECEIPT_WAIT_MS) continue;
              cost.pending.delete(hash);
              cost.lostReceipts += 1;
              logger.warn("draw_cost_receipt_lost", {round: key, action: send.action, tx: hash});
              continue;
            }
            cost.pending.delete(hash);
            cost.keeperGasWei += mined.gasUsed * mined.effectiveGasPrice;
            cost.touchedAt = now();
            if (send.action === "requestDraw" && cost.requestId === null) {
              const requestId = requestIdIn(mined);
              if (requestId !== null) {
                cost.requestId = requestId;
                cost.requestBlock = mined.blockNumber;
              }
            }
            if (send.action === "settle" && mined.status === 1n) cost.settled = true;
          }
          if (cost.settled && cost.pending.size === 0) {
            rounds.delete(key);
            await report(BigInt(key), cost, head);
            continue;
          }
          // A round that never settles - Void, or fully refunded - would otherwise keep its partial total
          // for the life of the process. The keeper's own tracking already dropped it long before this.
          if (!cost.settled && cost.pending.size === 0 && now() - cost.touchedAt >= COST_TTL_MS) {
            rounds.delete(key);
          }
        } catch (error) {
          logger.warn("draw_cost_failed", {
            round: key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    get size(): number {
      return rounds.size;
    },
  };
}
