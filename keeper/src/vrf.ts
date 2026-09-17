// The two things the keeper reads from the VRF coordinator itself (SPEC §7.1, §10.3).
//
// Neither belongs in `@luckydraw/client`: the client's generated ABIs are the Draw, the Vault, the price
// feed and Multicall3, and the coordinator is somebody else's contract that this process only observes.
// Both fragments below are copied from the pinned `chainlink-brownie-contracts` v1.3.0 sources that
// `contracts/src/interfaces/IVRFCoordinatorV2_5Views.sol` already cites:
//
//   * `VRFCoordinatorV2_5.sol:68` - `RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed,
//     uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium)`. `payment`
//     is what the subscription was actually charged for the draw, which is the VRF half of the cost meter.
//   * `IVRFSubscriptionV2Plus.sol:67` - `getSubscription`, whose second value is the native balance the Draw
//     bills against, compared here with the manifest's `vrf.lowFundingThresholdNative`.
//
// The labeled local mock (`contracts/test/mocks/MockVRFCoordinatorV2Plus.sol`) implements `getSubscription`
// with the same signature but emits a *different*, shorter `RandomWordsFulfilled`, so an anvil run reports a
// subscription balance and no VRF payment. That is correct rather than unfortunate: there is no real payment
// on a mock, and the cost meter says so in its `note` instead of inventing a number.

import {Interface} from "ethers";
import type {Address, Hex, Hex32, RawLog} from "./client.ts";

export const coordinatorInterface = new Interface([
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium)",
]);

function topicOf(name: string): Hex32 {
  const fragment = coordinatorInterface.getEvent(name);
  if (fragment === null) throw new Error(`the coordinator interface has no event ${name}`);
  return fragment.topicHash as Hex32;
}

/** `topics[0]` of the v2.5 fulfilment event. */
export const RANDOM_WORDS_FULFILLED_TOPIC: Hex32 = topicOf("RandomWordsFulfilled");

/** A uint256 as the 32-byte topic an indexed argument is matched by. */
export function uint256Topic(value: bigint): Hex32 {
  if (value < 0n) throw new RangeError(`a topic value must not be negative: ${value}`);
  return `0x${value.toString(16).padStart(64, "0")}` as Hex32;
}

export type Subscription = {
  /** LINK juels. The Draw bills natively, so this is reported and not compared. */
  linkBalance: bigint;
  /** Wei. The balance SPEC §7.1 bills against and §10.3 alerts on. */
  nativeBalance: bigint;
  requestCount: bigint;
  owner: Address;
  consumers: readonly Address[];
};

/** `getSubscription(subId)` calldata, for an `eth_call` pinned to the cycle's snapshot block. */
export function encodeGetSubscription(subscriptionId: bigint): Hex {
  return coordinatorInterface.encodeFunctionData("getSubscription", [subscriptionId]) as Hex;
}

export function decodeGetSubscription(data: Hex): Subscription {
  const result = coordinatorInterface.decodeFunctionResult("getSubscription", data);
  return {
    linkBalance: BigInt(result[0] as bigint),
    nativeBalance: BigInt(result[1] as bigint),
    requestCount: BigInt(result[2] as bigint),
    owner: String(result[3]).toLowerCase() as Address,
    consumers: (result[4] as readonly string[]).map((value) => value.toLowerCase() as Address),
  };
}

/**
 * The `payment` of a `RandomWordsFulfilled` log, or null when the log is not one.
 *
 * Null covers both a different event and the mock's shorter same-named event, whose topic hash differs, so
 * no caller has to know which coordinator it is talking to.
 */
export function decodeFulfilmentPayment(log: RawLog): {requestId: bigint; payment: bigint} | null {
  if ((log.topics[0] ?? "").toLowerCase() !== RANDOM_WORDS_FULFILLED_TOPIC) return null;
  try {
    const decoded = coordinatorInterface.decodeEventLog("RandomWordsFulfilled", log.data, [...log.topics]);
    return {requestId: BigInt(decoded[0] as bigint), payment: BigInt(decoded[3] as bigint)};
  } catch {
    return null;
  }
}
