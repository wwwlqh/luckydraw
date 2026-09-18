// The signing request carries the chain it was prepared for (SPEC §9.2 network guard, §12).
//
// Every chain check before this point is a check: the write gate reads React state, and `useSigner` asks the
// wallet for `eth_chainId`. A wallet can switch network between the last check and the prompt. A request that
// names its `chainId` is refused by the wallet instead of signed on whatever chain it happens to be on.

import type {JsonRpcSigner} from "ethers";
import {describe, expect, it} from "vitest";
import type {WalletError} from "../wallet/errors.ts";
import {toTxSigner} from "./ethersAdapters.ts";
import {wrongChainWithHashFailure} from "./failure.ts";
import type {TxRequest} from "./types.ts";

const REQUEST: TxRequest & {gasLimit: bigint} = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0x610178da211fef7d417bc0e6fed39f05609ad788",
  data: "0xabcdef01",
  value: 1_000n,
  gasLimit: 125_000n,
};

const HASH = `0x${"ab".repeat(32)}`;

function fakeSigner(responseChainId: bigint | null, signature?: {legacyChainId?: bigint}) {
  const sent: Record<string, unknown>[] = [];
  const signer = {
    estimateGas: () => Promise.resolve(100_000n),
    sendTransaction: (tx: Record<string, unknown>) => {
      sent.push(tx);
      return Promise.resolve({hash: HASH, nonce: 7, chainId: responseChainId, signature});
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

  it("accepts a response whose chain id matches the deployment chain", async () => {
    const {signer} = fakeSigner(97n);

    await expect(toTxSigner(signer, 97n).sendTransaction(REQUEST)).resolves.toEqual({hash: HASH, nonce: 7});
  });

  // Field-found on chain 97: MetaMask's default BSC-testnet RPC is a bnbchain data seed, whose
  // `eth_getTransactionByHash` omits `chainId`, and ethers' formatter turns that into `null`. The old guard
  // read null as "another chain" and told the operator nothing was sent while the transaction was mining.
  it("proceeds when the wallet's node did not report a chain id at all", async () => {
    const {signer} = fakeSigner(null);

    await expect(toTxSigner(signer, 97n).sendTransaction(REQUEST)).resolves.toEqual({hash: HASH, nonce: 7});
  });

  it("proceeds when the response omits chainId entirely", async () => {
    const signer = {
      estimateGas: () => Promise.resolve(100_000n),
      sendTransaction: () => Promise.resolve({hash: HASH, nonce: 7}),
    } as unknown as JsonRpcSigner;

    await expect(toTxSigner(signer, 97n).sendTransaction(REQUEST)).resolves.toEqual({hash: HASH, nonce: 7});
  });

  it("falls back to the legacy chain id in the signature when the node omitted the field", async () => {
    const {signer} = fakeSigner(null, {legacyChainId: 56n});

    await expect(toTxSigner(signer, 97n).sendTransaction(REQUEST)).rejects.toMatchObject({
      code: "WrongChain",
      sendTransactionHash: HASH,
    });
  });

  it("keeps the hash on a positively different chain so the funds effect is not 'Nothing sent'", async () => {
    const {signer} = fakeSigner(56n);

    const error = await toTxSigner(signer, 97n)
      .sendTransaction(REQUEST)
      .then(
        () => null,
        (thrown: unknown) => thrown as WalletError,
      );

    expect(error).toMatchObject({code: "WrongChain", sendTransactionHash: HASH});
    expect(error?.message).toContain("chain 56");
    expect(wrongChainWithHashFailure(error as WalletError)).toMatchObject({
      funds: "Unknown until receipt",
    });
  });
});
