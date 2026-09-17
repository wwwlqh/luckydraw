// The app's own read provider, and the two narrow surfaces the client library asks for (SPEC §10.1, §15).
//
// The provider is created with a pinned `Network` and `staticNetwork`, so ethers never probes for the chain
// id on its own for ordinary calls. That is deliberate everywhere except one place: `getNetwork()` on a
// `staticNetwork` provider answers out of the pinned object without contacting the node at all, so an
// adapter that forwarded it would hand `verifyDeployment` the chain id the manifest already claims and the
// SPEC §12 assertion ("every service asserts eth_chainId equals the manifest chainId") would be comparing the
// manifest with itself. Both adapters below therefore ask the node directly with `eth_chainId`.
//
// The two adapters below are written out by hand rather than passing the ethers provider directly. An ethers
// `JsonRpcProvider` does satisfy both types structurally, but writing the four methods out keeps a future
// ethers signature change a compile error here instead of a silent behaviour change in every read.

import type {ReadProvider, VerifyProvider} from "@luckydraw/client";
import {JsonRpcProvider, Network} from "ethers";
import type {ChainRecord} from "./records.ts";

/** Creates the read provider for one chain. The URL is the build's configured public RPC. */
export function createReadProvider(chain: ChainRecord, rpcUrl: string): JsonRpcProvider {
  const network = new Network(chain.name, chain.chainId);
  return new JsonRpcProvider(rpcUrl, network, {staticNetwork: network});
}

/** An `eth_chainId` quantity: `0x` and at least one hex digit, never a decimal string and never a number. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;

/**
 * The chain id **the node reports**, asked for over the wire every time.
 *
 * `provider.getNetwork()` is not usable for this: `staticNetwork` makes it return the pinned `Network`
 * without a request. `send` bypasses that and reaches the node, which is the only answer a chain-id
 * assertion can be built on (SPEC §12, §10.1 "after any RPC failover").
 */
async function nodeChainId(provider: JsonRpcProvider): Promise<bigint> {
  const raw: unknown = await provider.send("eth_chainId", []);
  if (typeof raw !== "string" || !HEX_QUANTITY.test(raw)) {
    throw new Error(`the node answered eth_chainId with ${String(raw)}, which is not a hex quantity`);
  }
  return BigInt(raw);
}

/** The `ReadProvider` of `@luckydraw/client`: every call pinned to one explicit block. */
export function toReadProvider(provider: JsonRpcProvider): ReadProvider {
  return {
    async call(tx) {
      return await provider.call(
        tx.blockTag === undefined
          ? {to: tx.to, data: tx.data}
          : {to: tx.to, data: tx.data, blockTag: tx.blockTag},
      );
    },
    async getBlock(tag) {
      const block = await provider.getBlock(tag);
      if (block === null) return null;
      return {number: block.number, hash: block.hash, timestamp: block.timestamp};
    },
    async getBlockNumber() {
      return await provider.getBlockNumber();
    },
    async getNetwork() {
      return {chainId: await nodeChainId(provider)};
    },
  };
}

/** The `VerifyProvider` of `@luckydraw/client`: chain id, deployed code and two binding calls. */
export function toVerifyProvider(provider: JsonRpcProvider): VerifyProvider {
  return {
    async getNetwork() {
      return {chainId: await nodeChainId(provider)};
    },
    async getCode(address, blockTag) {
      return await provider.getCode(address, blockTag ?? "latest");
    },
    async call(tx, blockTag) {
      const pinned = tx.blockTag ?? blockTag;
      return await provider.call(
        pinned === undefined ? {to: tx.to, data: tx.data} : {to: tx.to, data: tx.data, blockTag: pinned},
      );
    },
    async getBlockNumber() {
      return await provider.getBlockNumber();
    },
  };
}

/** Explorer link for a transaction, or null when the chain record has no explorer (local anvil). */
export function explorerTxUrl(chain: ChainRecord, hash: string): string | null {
  if (chain.explorerUrl === null) return null;
  return `${chain.explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

/** Explorer link for an address, or null when the chain record has no explorer. */
export function explorerAddressUrl(chain: ChainRecord, address: string): string | null {
  if (chain.explorerUrl === null) return null;
  return `${chain.explorerUrl.replace(/\/+$/, "")}/address/${address}`;
}

/**
 * Explorer link for a block, or null when the chain record has no explorer. Used by Verify for the
 * manifest's `deployBlock`, so a reader can see the creation of the contract this build signs against.
 */
export function explorerBlockUrl(chain: ChainRecord, block: bigint): string | null {
  if (chain.explorerUrl === null) return null;
  return `${chain.explorerUrl.replace(/\/+$/, "")}/block/${block.toString()}`;
}
