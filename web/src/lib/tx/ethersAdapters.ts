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
 * that names one is refused by the wallet instead (SPEC §9.2 network guard, §12 chain-id assertion). The
 * response is checked too, for a wallet that accepts the field and signs on another chain anyway.
 */
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
      if (response.chainId !== chainId) {
        throw new WalletError(
          "WrongChain",
          `This action was prepared for chain ${chainId}, but your wallet signed it for chain ` +
            `${response.chainId}.`,
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
