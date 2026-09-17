// The two coordinator fragments, checked against data the coordinator's own ABI encodes.
//
// The point of these tests is that the signatures copied into `vrf.ts` are the v2.5 ones: a wrong `payment`
// offset or a wrong topic hash would not throw, it would quietly report a different number or no number at
// all, which is exactly the failure a cost meter must not have.

import assert from "node:assert/strict";
import test from "node:test";
import {Interface} from "ethers";
import type {RawLog} from "./client.ts";
import {
  coordinatorInterface,
  decodeFulfilmentPayment,
  decodeGetSubscription,
  encodeGetSubscription,
  RANDOM_WORDS_FULFILLED_TOPIC,
  uint256Topic,
} from "./vrf.ts";

const SUB_ID = 42_000_000_000_000_000_000n;
const OWNER = "0x00000000000000000000000000000000000000aa";
const CONSUMER = "0x00000000000000000000000000000000000000bb";

function log(topics: readonly string[], data: string): RawLog {
  return {
    address: "0x00000000000000000000000000000000000000cc",
    topics,
    data,
    blockNumber: 100n,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${"cd".repeat(32)}`,
    index: 0n,
  };
}

test("getSubscription round-trips the five-value v2.5 tuple", () => {
  const data = encodeGetSubscription(SUB_ID);
  assert.deepStrictEqual(coordinatorInterface.decodeFunctionData("getSubscription", data)[0], SUB_ID);

  const encoded = coordinatorInterface.encodeFunctionResult("getSubscription", [
    7n,
    3_500_000_000_000_000_000n,
    12n,
    OWNER,
    [CONSUMER],
  ]);
  const subscription = decodeGetSubscription(encoded as `0x${string}`);
  assert.deepStrictEqual(subscription, {
    linkBalance: 7n,
    // The second value, not the first: the Draw bills natively (SPEC §7.1).
    nativeBalance: 3_500_000_000_000_000_000n,
    requestCount: 12n,
    owner: OWNER,
    consumers: [CONSUMER],
  });
});

test("the payment is the fourth argument of RandomWordsFulfilled", () => {
  const encoded = coordinatorInterface.encodeEventLog("RandomWordsFulfilled", [
    99n, // requestId (indexed)
    123n, // outputSeed
    SUB_ID, // subId (indexed)
    250_000_000_000_000n, // payment
    true, // nativePayment
    true, // success
    false, // onlyPremium
  ]);
  assert.strictEqual(encoded.topics[0], RANDOM_WORDS_FULFILLED_TOPIC);
  assert.deepStrictEqual(decodeFulfilmentPayment(log(encoded.topics, encoded.data)), {
    requestId: 99n,
    payment: 250_000_000_000_000n,
  });
});

test("the labeled mock's same-named event is not mistaken for a payment", () => {
  // `contracts/test/mocks/MockVRFCoordinatorV2Plus.sol` emits
  // `RandomWordsFulfilled(uint256 indexed, address indexed, bool, uint256)`, a different signature and so a
  // different topic hash. Reporting its fourth argument (a gas figure) as a VRF payment would be a
  // plausible-looking wrong number in the shakedown record.
  const mock = new Interface([
    "event RandomWordsFulfilled(uint256 indexed requestId, address indexed consumer, bool success, uint256 gasUsed)",
  ]);
  const encoded = mock.encodeEventLog("RandomWordsFulfilled", [99n, CONSUMER, true, 120_000n]);
  assert.notStrictEqual(encoded.topics[0], RANDOM_WORDS_FULFILLED_TOPIC);
  assert.strictEqual(decodeFulfilmentPayment(log(encoded.topics, encoded.data)), null);
});

test("an unrelated or undecodable log is null, never a throw", () => {
  assert.strictEqual(decodeFulfilmentPayment(log([`0x${"00".repeat(32)}`], "0x")), null);
  assert.strictEqual(decodeFulfilmentPayment(log([], "0x")), null);
  // The right topic with a truncated body: a look-alike emitter, not a fulfilment.
  assert.strictEqual(
    decodeFulfilmentPayment(log([RANDOM_WORDS_FULFILLED_TOPIC, uint256Topic(1n)], "0xdead")),
    null,
  );
});

test("a uint256 topic is 32 lowercase bytes", () => {
  assert.strictEqual(uint256Topic(0n), `0x${"00".repeat(32)}`);
  assert.strictEqual(uint256Topic(255n), `0x${"00".repeat(31)}ff`);
  assert.throws(() => uint256Topic(-1n), RangeError);
});
