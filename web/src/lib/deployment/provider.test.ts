// The chain-id assertion has to reach the node (SPEC §12: "every service asserts eth_chainId equals the
// manifest chainId at start-up and after any RPC failover, halting on mismatch").
//
// The provider is built with `staticNetwork`, which makes `provider.getNetwork()` answer out of the pinned
// `Network` object without a request. An adapter that forwarded that would hand `verifyDeployment` the chain
// id the manifest already claims, and the assertion would compare the manifest with itself: a page pointed at
// a node on the wrong chain would verify happily and then sign there. These tests drive both adapters through
// a provider whose `eth_chainId` is the only source of truth.

import {assertSameChain, verifyDeployment} from "@luckydraw/client";
import type {JsonRpcProvider} from "ethers";
import {describe, expect, it} from "vitest";
import {fakeNode, testManifest} from "../../test/harness.tsx";
import {toReadProvider, toVerifyProvider} from "./provider.ts";

/** The synthetic node, with `eth_chainId` answering whatever the test says and nothing else changed. */
function nodeAnswering(chainIdHex: string) {
  const manifest = testManifest();
  const node = fakeNode(manifest);
  const wired = {
    ...node,
    send: (method: string) => {
      if (method === "eth_chainId") return Promise.resolve(chainIdHex);
      return Promise.reject(new Error(`unexpected send ${method}`));
    },
  };
  return {manifest, provider: wired as unknown as JsonRpcProvider};
}

describe("toVerifyProvider", () => {
  it("asks the node for its chain id instead of repeating the pinned network", async () => {
    const {manifest, provider} = nodeAnswering("0x1");

    const result = await verifyDeployment(toVerifyProvider(provider), manifest);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure).toEqual({
      kind: "ChainMismatch",
      expected: 31_337n,
      actual: 1n,
    });
  });

  it("verifies when the node agrees with the manifest", async () => {
    const {manifest, provider} = nodeAnswering("0x7a69");

    const result = await verifyDeployment(toVerifyProvider(provider), manifest);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.verified.chainId : null).toBe(31_337n);
  });

  it("halts assertSameChain on a node that moved to another chain", async () => {
    const agreeing = nodeAnswering("0x7a69");
    const result = await verifyDeployment(toVerifyProvider(agreeing.provider), agreeing.manifest);
    if (!result.ok) throw new Error("fixture did not verify");

    const failedOver = nodeAnswering("0x1");

    await expect(
      assertSameChain(toVerifyProvider(failedOver.provider), result.verified),
    ).rejects.toMatchObject({
      failure: {kind: "ChainMismatch", expected: 31_337n, actual: 1n},
    });
  });

  it("refuses an eth_chainId answer that is not a hex quantity", async () => {
    const {provider} = nodeAnswering("31337");

    await expect(toVerifyProvider(provider).getNetwork()).rejects.toThrow(/not a hex quantity/);
  });
});

describe("toReadProvider", () => {
  it("reports the node's chain id, not the pinned one", async () => {
    const {provider} = nodeAnswering("0x1");

    await expect(toReadProvider(provider).getNetwork()).resolves.toEqual({chainId: 1n});
  });
});
