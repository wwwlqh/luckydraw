// The signing request carries the chain it was prepared for (SPEC §9.2 network guard, §12).
//
// Every chain check before this point is a check: the write gate reads React state, and `useSigner` asks the
// wallet for `eth_chainId`. A wallet can switch network between the last check and the prompt. A request that
// names its `chainId` is refused by the wallet instead of signed on whatever chain it happens to be on.

import type {JsonRpcSigner} from "ethers";
import {describe, expect, it} from "vitest";
import {toTxSigner} from "./ethersAdapters.ts";
import type {TxRequest} from "./types.ts";

const REQUEST: TxRequest & {gasLimit: bigint} = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0x610178da211fef7d417bc0e6fed39f05609ad788",
  data: "0xabcdef01",
  value: 1_000n,
  gasLimit: 125_000n,
};

function fakeSigner(responseChainId: bigint) {
  const sent: Record<string, unknown>[] = [];
  const signer = {
    estimateGas: () => Promise.resolve(100_000n),
    sendTransaction: (tx: Record<string, unknown>) => {
      sent.push(tx);
      return Promise.resolve({hash: `0x${"ab".repeat(32)}`, nonce: 7, chainId: responseChainId});
    },
  };
  return {signer: signer as unknown as JsonRpcSigner, sent};
}

describe("toTxSigner", () => {
  it("puts the chain id in the request the wallet is asked to sign", async () => {
    const {signer, sent} = fakeSigner(31_337n);

    await toTxSigner(signer, 31_337n).sendTransaction(REQUEST);

    expect(sent[0]).toMatchObject({chainId: 31_337n, to: REQUEST.to, gasLimit: 125_000n});
  });

  it("refuses a response signed for another chain and reports it as WrongChain", async () => {
    const {signer} = fakeSigner(1n);

    await expect(toTxSigner(signer, 31_337n).sendTransaction(REQUEST)).rejects.toMatchObject({
      code: "WrongChain",
    });
  });
});
