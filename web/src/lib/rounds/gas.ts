// The network-fee estimate shown before an entry is signed (SPEC §9.5).
//
// "shows the wallet's estimated network fee converted with the reference price, labeled 'network gas, not a
// platform fee', with a warning when it exceeds 25% of the gross entry", and, when the quote reports
// `reachesTarget`, "shows that estimate" for the larger transaction too.
//
// The estimate is made against the full `buy` calldata at the current state, never from a table
// (SPEC §9.5: "Always estimate the full buy calldata against current state; a gas budget from the test table
// is not a transaction gas limit"). It is the same call `useTransaction.send` makes before it opens the
// wallet, run here only to display a number; the transaction's own limit still comes from that later call.
//
// This never throws: a node that refuses to estimate (an entry the state would revert, a rate limit) yields
// `null` and the panel says the fee could not be estimated, which is honest and not a dead end.

import type {Address, Hex} from "@luckydraw/client";
import type {JsonRpcProvider} from "ethers";

export type FeeEstimate = {
  /** Units of gas the node estimated for this exact calldata. */
  gasLimit: bigint;
  /** Price per unit the node reports now, in wei. */
  gasPriceWei: bigint;
  /** `gasLimit * gasPriceWei`, in wei of the chain's native currency. */
  feeWei: bigint;
};

export type FeeQuery = {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
};

type FeeProvider = Pick<JsonRpcProvider, "estimateGas" | "getFeeData">;

/** Estimates one transaction's network fee, or null when the node would not answer. */
export async function estimateNetworkFee(
  provider: FeeProvider,
  query: FeeQuery,
): Promise<FeeEstimate | null> {
  try {
    const [gasLimit, feeData] = await Promise.all([
      provider.estimateGas({from: query.from, to: query.to, data: query.data, value: query.value ?? 0n}),
      provider.getFeeData(),
    ]);
    const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    return {gasLimit, gasPriceWei, feeWei: gasLimit * gasPriceWei};
  } catch {
    return null;
  }
}
