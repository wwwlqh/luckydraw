// Simulate-before-send: the gas policy, the dry run and the decoded skip reason.

import assert from "node:assert/strict";
import test from "node:test";
import {Interface} from "ethers";
import {type Address, asAddress, asHex, type Hex, luckyDrawAbi, type PreparedWrite} from "./client.ts";
import {
  createDispatcher,
  GAS_LIMIT_CAP,
  gasLimitFor,
  recoverSentHash,
  type Sender,
  type SendProvider,
  sendFailureReason,
  skipReason,
  unlockedSender,
} from "./sender.ts";

const drawInterface = new Interface(luckyDrawAbi);
const DRAW: Address = asAddress("0x610178da211fef7d417bc0e6fed39f05609ad788");
const KEEPER: Address = asAddress("0x14dc79964da2c08b23698b3d3cc7ca32193d9955");

function write(method: "settle" | "seedRound" = "settle"): PreparedWrite {
  return {
    contract: "draw",
    to: DRAW,
    data: asHex(drawInterface.encodeFunctionData(method, [1n])),
    value: 0n,
    function: method,
    args: [1n],
    summary: {
      action: method === "settle" ? "settle" : "seedRound",
      contract: "draw",
      function: method,
      roundId: 1n,
      asset: null,
      amount: null,
      spender: null,
      account: null,
    },
  };
}

/** An error shaped like the one ethers raises for a reverting `eth_estimateGas`. */
class RevertError extends Error {
  readonly data: string;
  constructor(data: string) {
    super("execution reverted");
    this.data = data;
  }
}

type FakeSend = {
  provider: SendProvider;
  estimates: {from: string; to: string}[];
  sent: {method: string; params: readonly unknown[]}[];
};

function fakeSendProvider(estimate: bigint | Error): FakeSend {
  const estimates: {from: string; to: string}[] = [];
  const sent: {method: string; params: readonly unknown[]}[] = [];
  return {
    estimates,
    sent,
    provider: {
      async estimateGas(tx) {
        estimates.push({from: tx.from, to: tx.to});
        if (estimate instanceof Error) throw estimate;
        return estimate;
      },
      async send(method, params) {
        sent.push({method, params});
        return `0x${"ab".repeat(32)}`;
      },
    },
  };
}

test("gasLimitFor pads by 30 percent and caps at 600,000 (SPEC 10.2)", () => {
  assert.strictEqual(gasLimitFor(100_000n), 130_000n);
  assert.strictEqual(gasLimitFor(290_000n), 377_000n);
  assert.strictEqual(gasLimitFor(500_000n), GAS_LIMIT_CAP);
  assert.strictEqual(gasLimitFor(1_000_000n), GAS_LIMIT_CAP);
});

test("a successful estimate is followed by one send from the keeper account", async () => {
  const fake = fakeSendProvider(200_000n);
  const sender = unlockedSender(fake.provider, KEEPER);
  const dispatcher = createDispatcher(fake.provider, sender, {dryRun: false});
  const result = await dispatcher.dispatch(write());
  assert.strictEqual(result.status, "sent");
  assert.strictEqual(result.status === "sent" ? result.gasLimit : 0n, 260_000n);
  assert.deepStrictEqual(fake.estimates, [{from: KEEPER, to: DRAW}]);
  assert.strictEqual(fake.sent.length, 1);
  assert.strictEqual(fake.sent[0]?.method, "eth_sendTransaction");
  const params = fake.sent[0]?.params[0] as {from: string; to: string; gas: string};
  assert.strictEqual(params.from, KEEPER);
  assert.strictEqual(params.gas, "0x3f7a0");
});

test("KEEPER_DRY_RUN simulates and sends nothing", async () => {
  const fake = fakeSendProvider(200_000n);
  const sender = unlockedSender(fake.provider, KEEPER);
  const dispatcher = createDispatcher(fake.provider, sender, {dryRun: true});
  const result = await dispatcher.dispatch(write());
  assert.strictEqual(result.status, "dryRun");
  assert.strictEqual(fake.estimates.length, 1, "the call is still simulated");
  assert.deepStrictEqual(fake.sent, [], "and nothing is sent");
});

test("a failed estimate is a skip with the decoded custom error, and sends nothing", async () => {
  const revert = drawInterface.encodeErrorResult("AlreadySeeded", []);
  const fake = fakeSendProvider(new RevertError(revert));
  const sender = unlockedSender(fake.provider, KEEPER);
  const dispatcher = createDispatcher(fake.provider, sender, {dryRun: false});
  const result = await dispatcher.dispatch(write("seedRound"));
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.status === "skipped" ? result.reason : "", "AlreadySeeded");
  assert.deepStrictEqual(fake.sent, [], "a call that would revert is never sent");
});

test("skipReason falls back to the error message when there are no revert bytes", () => {
  assert.strictEqual(skipReason(write(), new Error("connection reset")), "connection reset");
});

test("an estimate that failed without revert bytes is rethrown, not reported as a revert (F2)", async () => {
  // A socket reset from `eth_estimateGas` says nothing about the call: the node never executed it. Returned
  // as a skip it became a `requestDraw` pre-check failure, which pages the operator about a key hash and a
  // subscription the node was never asked about and silences the round for 60 seconds.
  const fake = fakeSendProvider(new Error("ECONNRESET"));
  const sender = unlockedSender(fake.provider, KEEPER);
  const dispatcher = createDispatcher(fake.provider, sender, {dryRun: false});
  await assert.rejects(() => dispatcher.dispatch(write()), /ECONNRESET/);
  assert.deepStrictEqual(fake.sent, [], "nothing is sent when the simulation could not be made");
});

test("a revert that carried no data is still a skip, not a transport failure (F2)", async () => {
  // Out of gas, invalid opcode: the node executed the call and it failed. `0x` decodes as an unknown
  // revert, not as `none`, so this stays on the skip side of the line.
  const fake = fakeSendProvider(new RevertError("0x"));
  const sender = unlockedSender(fake.provider, KEEPER);
  const dispatcher = createDispatcher(fake.provider, sender, {dryRun: false});
  const result = await dispatcher.dispatch(write());
  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.status === "skipped" ? result.reason : "", "UndecodedRevert:0x");
});

test("a dry run never reaches the sender even if the sender would throw", async () => {
  const fake = fakeSendProvider(120_000n);
  const refusing: Sender = {
    kind: "unlocked",
    address: KEEPER,
    sendTransaction(): Promise<Hex> {
      throw new Error("the dispatcher must not send in dry-run mode");
    },
  };
  const dispatcher = createDispatcher(fake.provider, refusing, {dryRun: true});
  assert.strictEqual((await dispatcher.dispatch(write())).status, "dryRun");
});

test("a post-broadcast throw gives up its transaction hash, a pre-broadcast one has none (F5)", () => {
  const hash = `0x${"77".repeat(32)}`;
  // What ethers raises after the raw transaction is already on the wire.
  assert.strictEqual(
    recoverSentHash(Object.assign(new Error("returned hash did not match"), {code: "BAD_DATA", value: hash})),
    hash,
  );
  assert.strictEqual(recoverSentHash({transaction: {hash}}), hash);
  assert.strictEqual(recoverSentHash({receipt: {hash}}), hash);
  assert.strictEqual(recoverSentHash({transactionHash: hash}), hash);
  // A nonce or underpriced rejection carries no hash: nothing was broadcast, so nothing may be suppressed.
  assert.strictEqual(recoverSentHash(new Error("nonce too low")), undefined);
  assert.strictEqual(recoverSentHash({value: "0x77"}), undefined, "a short hex value is not a hash");
  assert.strictEqual(recoverSentHash(null), undefined);
  assert.strictEqual(sendFailureReason(new Error("nonce too low")), "SendFailed:nonce too low");
  assert.strictEqual(sendFailureReason("plain"), "SendFailed:plain");
});
