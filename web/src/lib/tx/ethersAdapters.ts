// The only place ethers meets the transaction state machine.
//
// Errors are deliberately re-thrown unwrapped: `decodeRevert` and `toWalletError` both dig through ethers'
// nested error objects for the revert data and the EIP-1193 code, and wrapping them here would hide both.

import type {JsonRpcProvider, JsonRpcSigner} from "ethers";
import {WalletError} from "../wallet/errors.ts";
import type {TxRequest, TxSignerLike, TxWatcherLike} from "./types.ts";

/**
 * `chainId` is not decoration: it is written into the transaction the wallet is asked to sign.
 *
 * The chain is checked twice before this point — the write gate on React state, and `useSigner`'s own live
 * `eth_chainId` — but both are checks, and a wallet can switch network in the moment between the last check
 * and the prompt. A request with no `chainId` is signed for whatever chain the wallet is on *then*; a request
 * that names one carries the chain into the prompt, because ethers 6.17's `JsonRpcSigner.sendTransaction`
 * passes the field straight through to `eth_sendTransaction` without asserting on it itself. Enforcement is
 * therefore the wallet's, not ethers' and not this app's, and wallets differ in whether they refuse a
 * mismatch or sign it anyway. The guard that matters is the deployment-chain watcher (SPEC §9.2 network
 * guard, §12 chain-id assertion); the response is checked too, for a wallet that took the field and signed
 * on another chain regardless.
 */
/**
 * The chain the wallet's node reported for a broadcast transaction, or `null` when it did not report one.
 *
 * `JsonRpcSigner.sendTransaction` polls `eth_getTransactionByHash` through the *wallet's* provider, not this
 * app's read RPC, and ethers' formatter maps a missing `chainId` field to `null` (`allowNull(getBigInt,
 * null)`). MetaMask's default BSC-testnet endpoint is a bnbchain data seed, which omits it, so a perfectly
 * good chain-97 transaction comes back with `chainId: null`. That is "the node did not say", not "another
 * chain". The pre-EIP-1559 `v` still encodes the chain for legacy transactions, and ethers exposes it as
 * `signature.legacyChainId`, so that is tried before giving up.
 */
function reportedChainId(response: {chainId?: bigint | null; signature?: unknown}): bigint | null {
  if (response.chainId !== null && response.chainId !== undefined) return response.chainId;
  const signature = response.signature;
  if (signature !== null && typeof signature === "object") {
    const legacy = (signature as {legacyChainId?: unknown}).legacyChainId;
    if (typeof legacy === "bigint") return legacy;
  }
  return null;
}

export function toTxSigner(signer: JsonRpcSigner, chainId: bigint): TxSignerLike {
  return {
    async estimateGas(tx: TxRequest): Promise<bigint> {
      return await signer.estimateGas({from: tx.from, to: tx.to, data: tx.data, value: tx.value});
    },
    async sendTransaction(tx): Promise<{hash: string; nonce: number}> {
      const response = await signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit,
        chainId,
      });
      // Only a chain the node positively named and that differs is a wrong chain. An unknown chain is left
      // alone because the real guard is downstream and does not depend on this field at all: the tracking
      // watcher polls the *deployment* chain's read provider, so a transaction genuinely signed for another
      // chain is never found there and ends as `dropped` rather than being narrated as confirmed.
      const reported = reportedChainId(response);
      if (reported !== null && reported !== chainId) {
        // The hash exists, so this is not "Nothing sent": SPEC §9.6 requires "Unknown until receipt" from the
        // moment a hash exists. It travels on the error so the machine can keep it (see `broadcastHashOf`).
        throw new WalletError(
          "WrongChain",
          `This action was prepared for chain ${chainId}, but your wallet signed it for chain ${reported}.`,
          {sendTransactionHash: response.hash},
        );
      }
      return {hash: response.hash, nonce: response.nonce};
    },
  };
}

export function toTxWatcher(provider: JsonRpcProvider): TxWatcherLike {
  return {
    async getTransactionReceipt(hash) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt === null) return null;
      // `to` and `from` come along so the machine can refuse a receipt that belongs to another transaction.
      return {
        hash: receipt.hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        to: receipt.to,
        from: receipt.from,
      };
    },
    async getTransaction(hash) {
      const tx = await provider.getTransaction(hash);
      if (tx === null) return null;
      return {
        blockNumber: tx.blockNumber,
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value,
        nonce: tx.nonce,
      };
    },
    async getTransactionCount(account, blockTag) {
      return await provider.getTransactionCount(account, blockTag);
    },
    async getBlockNumber() {
      return await provider.getBlockNumber();
    },
    async getFinalityHead(tag) {
      try {
        const block = await provider.getBlock(tag);
        return block === null ? null : BigInt(block.number);
      } catch {
        return null;
      }
    },
    async call(tx) {
      return await provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        blockTag: tx.blockTag,
      });
    },
  };
}
