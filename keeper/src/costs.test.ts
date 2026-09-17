// What `event=draw_cost` says, and what it says when it cannot say a number.
//
// The receipts and the coordinator's logs are faked, but the encoding is not: the `DrawRequested` log the
// meter mines the `requestId` out of is produced by the Draw's own ABI, and the fulfilment log by the
// coordinator's, so an offset that drifted would fail here rather than produce a wrong figure on mainnet.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {drawInterface, verifiedFrom} from "../../packages/client/src/reads/testing/fake.ts";
import type {Address, Hex, RawLog, VerifiedDeployment} from "./client.ts";
import {parseManifest} from "./client.ts";
import {REPO_ROOT} from "./config.ts";
import {
  COST_TTL_MS,
  type CoordinatorLogQuery,
  createCostMeter,
  type MinedReceipt,
  parseReceipt,
  RECEIPT_WAIT_MS,
} from "./costs.ts";
import {createLogger} from "./log.ts";
import {coordinatorInterface} from "./vrf.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const MANIFEST_JSON = readFileSync(join(REPO_ROOT, "config", "deployments", "31337", `${DRAW}.json`), "utf8");
const REQUEST_TX: Hex = `0x${"a1".repeat(32)}`;
const SETTLE_TX: Hex = `0x${"b2".repeat(32)}`;
const SEED_TX: Hex = `0x${"c3".repeat(32)}`;
const REQUEST_ID = 777n;
const PAYMENT = 1_250_000_000_000_000n;

function deployment(): VerifiedDeployment {
  return verifiedFrom(parseManifest(JSON.parse(MANIFEST_JSON) as unknown));
}

function bareLog(address: Address, topics: readonly string[], data: string, blockNumber: bigint): RawLog {
  return {
    address,
    topics,
    data,
    blockNumber,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: REQUEST_TX,
    index: 0n,
  };
}

/** The `DrawRequested` the Draw emits inside the keeper's own `requestDraw` transaction. */
function drawRequestedLog(emitter: Address, roundId: bigint, blockNumber: bigint): RawLog {
  const encoded = drawInterface.encodeEventLog("DrawRequested", [roundId, REQUEST_ID, 1_790_000_000n]);
  return bareLog(emitter, encoded.topics, encoded.data, blockNumber);
}

function fulfilmentLog(coordinator: Address, payment: bigint, blockNumber: bigint): RawLog {
  const encoded = coordinatorInterface.encodeEventLog("RandomWordsFulfilled", [
    REQUEST_ID,
    1n,
    1n,
    payment,
    true,
    true,
    false,
  ]);
  return bareLog(coordinator, encoded.topics, encoded.data, blockNumber);
}

function receipt(overrides: Partial<MinedReceipt> = {}): MinedReceipt {
  return {
    blockNumber: 100n,
    gasUsed: 100_000n,
    effectiveGasPrice: 3_000_000_000n,
    status: 1n,
    logs: [],
    ...overrides,
  };
}

type Harness = ReturnType<typeof harness>;

function harness(options: {receipts: Map<Hex, MinedReceipt | null>; logs?: CoordinatorLogQuery}) {
  const verified = deployment();
  const lines: string[] = [];
  let clock = 1_000;
  const meter = createCostMeter({
    deployment: verified,
    logger: createLogger({write: (line) => void lines.push(line)}),
    receipt: async (hash) => options.receipts.get(hash) ?? null,
    ...(options.logs === undefined ? {} : {logs: options.logs}),
    window: 500n,
    now: () => clock,
  });
  return {
    meter,
    lines,
    verified,
    advance(ms: number): void {
      clock += ms;
    },
    cost(): string {
      const line = lines.find((entry) => entry.includes("event=draw_cost "));
      assert.ok(line !== undefined, `no draw_cost line: ${lines.join("|")}`);
      return line;
    },
  };
}

function noLines(h: Harness, event: string): void {
  assert.ok(!h.lines.some((line) => line.includes(`event=${event}`)), `unexpected ${event}`);
}

test("parseReceipt takes a node's hex quantities, and null for an unmined transaction", () => {
  assert.strictEqual(parseReceipt(null), null);
  assert.strictEqual(parseReceipt(undefined), null);
  const parsed = parseReceipt({
    blockNumber: "0x64",
    gasUsed: "0x186a0",
    effectiveGasPrice: "0xb2d05e00",
    status: "0x1",
    logs: [],
  });
  assert.deepStrictEqual(parsed, {
    blockNumber: 100n,
    gasUsed: 100_000n,
    effectiveGasPrice: 3_000_000_000n,
    status: 1n,
    logs: [],
  });
  // A pre-1559 node answers with `gasPrice` and no effective price.
  assert.strictEqual(
    parseReceipt({blockNumber: "0x1", gasUsed: "0x2", gasPrice: "0x3", status: "0x1"})?.effectiveGasPrice,
    3n,
  );
});

test("a settled draw reports the keeper's gas and the VRF payment, both in wei", async () => {
  const verified = deployment();
  const coordinator = verified.manifest.vrf.coordinator;
  const receipts = new Map<Hex, MinedReceipt | null>([
    [SEED_TX, receipt({gasUsed: 90_000n, effectiveGasPrice: 1_000_000_000n})],
    [
      REQUEST_TX,
      receipt({
        blockNumber: 200n,
        gasUsed: 200_000n,
        effectiveGasPrice: 1_000_000_000n,
        logs: [drawRequestedLog(verified.draw, 11n, 200n)],
      }),
    ],
    [SETTLE_TX, receipt({blockNumber: 210n, gasUsed: 300_000n, effectiveGasPrice: 1_000_000_000n})],
  ]);
  const queried: {address: Address; fromBlock: bigint; toBlock: bigint}[] = [];
  const h = harness({
    receipts,
    logs: async (filter) => {
      queried.push({address: filter.address, fromBlock: filter.fromBlock, toBlock: filter.toBlock});
      return [fulfilmentLog(coordinator, PAYMENT, 205n)];
    },
  });

  h.meter.recordSend(11n, "seedRound", SEED_TX);
  h.meter.recordSend(11n, "requestDraw", REQUEST_TX);
  h.meter.recordSend(11n, "settle", SETTLE_TX);
  await h.meter.collect(300n);

  const line = h.cost();
  // 90,000 + 200,000 + 300,000 gas at 1 gwei.
  assert.match(line, /keeperGasWei=590000000000000\b/);
  assert.match(line, new RegExp(`vrfPaymentWei=${PAYMENT}\\b`));
  assert.match(line, /requestId=777\b/);
  assert.ok(!line.includes("note="), `a complete report carries no note: ${line}`);
  // The fulfilment search starts at the block the request landed in, against the coordinator.
  assert.deepStrictEqual(queried[0], {address: coordinator, fromBlock: 200n, toBlock: 300n});
  assert.strictEqual(h.meter.size, 0, "a reported round is forgotten");
});

test("a round whose requestDraw this keeper did not send reports no payment, and says why", async () => {
  const receipts = new Map<Hex, MinedReceipt | null>([[SETTLE_TX, receipt()]]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(12n, "settle", SETTLE_TX);
  await h.meter.collect(300n);
  const line = h.cost();
  assert.match(line, /keeperGasWei=300000000000000\b/);
  assert.match(line, /vrfPaymentWei=null\b/);
  assert.match(line, /note=RequestNotObserved\b/);
});

test("a fulfilment that cannot be found is null with a reason, never a guess", async () => {
  const verified = deployment();
  const receipts = new Map<Hex, MinedReceipt | null>([
    [REQUEST_TX, receipt({blockNumber: 200n, logs: [drawRequestedLog(verified.draw, 13n, 200n)]})],
    [SETTLE_TX, receipt({blockNumber: 210n})],
  ]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(13n, "requestDraw", REQUEST_TX);
  h.meter.recordSend(13n, "settle", SETTLE_TX);
  await h.meter.collect(300n);
  assert.match(h.cost(), /note=FulfilmentNotFound\b/);
});

test("a failing log search is a note on the report, not a failed cycle", async () => {
  const verified = deployment();
  const receipts = new Map<Hex, MinedReceipt | null>([
    [REQUEST_TX, receipt({blockNumber: 200n, logs: [drawRequestedLog(verified.draw, 14n, 200n)]})],
    [SETTLE_TX, receipt({blockNumber: 210n})],
  ]);
  const h = harness({
    receipts,
    logs: async () => {
      throw new Error("query returned more than 10000 results");
    },
  });
  h.meter.recordSend(14n, "requestDraw", REQUEST_TX);
  h.meter.recordSend(14n, "settle", SETTLE_TX);
  await assert.doesNotReject(() => h.meter.collect(300n));
  assert.match(h.cost(), /note="FulfilmentSearchFailed:query returned more than 10000 results"/);
});

test("nothing is reported until the settle receipt exists", async () => {
  const receipts = new Map<Hex, MinedReceipt | null>([[SEED_TX, receipt()]]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(15n, "seedRound", SEED_TX);
  h.meter.recordSend(15n, "settle", SETTLE_TX); // still unmined: the map answers null
  await h.meter.collect(300n);
  noLines(h, "draw_cost");
  assert.strictEqual(h.meter.size, 1, "the round is still being accounted for");

  receipts.set(SETTLE_TX, receipt({gasUsed: 10n, effectiveGasPrice: 1n}));
  await h.meter.collect(300n);
  assert.match(h.cost(), /keeperGasWei=300000000000010\b/);
});

test("a receipt the node never produces is written off, and the report says the total is short", async () => {
  const receipts = new Map<Hex, MinedReceipt | null>([
    [SETTLE_TX, receipt({gasUsed: 1n, effectiveGasPrice: 1n})],
  ]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(16n, "closeRound", SEED_TX); // dropped by the node, no receipt ever
  h.meter.recordSend(16n, "settle", SETTLE_TX);
  await h.meter.collect(300n);
  noLines(h, "draw_cost");

  h.advance(RECEIPT_WAIT_MS);
  await h.meter.collect(300n);
  assert.ok(
    h.lines.some(
      (line) => line.includes("event=draw_cost_receipt_lost") && line.includes("action=closeRound"),
    ),
    `the write-off was not logged: ${h.lines.join("|")}`,
  );
  assert.match(h.cost(), /lostReceipts=1\b/);
});

test("a round that never settles is dropped, so the meter cannot grow without bound", async () => {
  const receipts = new Map<Hex, MinedReceipt | null>([[SEED_TX, receipt()]]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(17n, "seedRound", SEED_TX);
  await h.meter.collect(300n);
  assert.strictEqual(h.meter.size, 1);
  h.advance(COST_TTL_MS);
  await h.meter.collect(300n);
  assert.strictEqual(h.meter.size, 0);
  noLines(h, "draw_cost");
});

test("a DrawRequested from a look-alike emitter is ignored (SPEC 10.1)", async () => {
  const impostor = "0x00000000000000000000000000000000000000ff" as Address;
  const receipts = new Map<Hex, MinedReceipt | null>([
    [REQUEST_TX, receipt({blockNumber: 200n, logs: [drawRequestedLog(impostor, 18n, 200n)]})],
    [SETTLE_TX, receipt({blockNumber: 210n})],
  ]);
  const h = harness({receipts, logs: async () => []});
  h.meter.recordSend(18n, "requestDraw", REQUEST_TX);
  h.meter.recordSend(18n, "settle", SETTLE_TX);
  await h.meter.collect(300n);
  assert.match(h.cost(), /note=RequestNotObserved\b/);
});

test("with no log query configured the gas is still reported", async () => {
  const receipts = new Map<Hex, MinedReceipt | null>([[SETTLE_TX, receipt()]]);
  const h = harness({receipts});
  h.meter.recordSend(19n, "settle", SETTLE_TX);
  await h.meter.collect(300n);
  assert.match(h.cost(), /note=FulfilmentSearchDisabled\b/);
  assert.match(h.cost(), /keeperGasWei=300000000000000\b/);
});
