// Getting a signer, and only for the account a write was quoted for (SPEC §9.5, §9.6).
//
// SPEC §9.5: "a new amount requires a fresh preview, and so does a new round or a new signing account". The
// enforcement point is here: every caller passes the account its quote and its disclosures were built for,
// and the hook refuses when the wallet's active account is anything else, so an account that changed between
// the preview and the prompt can never be signed with.
//
// The signer is also gated on `useWriteGate`, so an unverified deployment or the wrong chain cannot reach a
// wallet prompt at all. That gate reads React state, which is only refreshed by a `chainChanged` event, so
// the chain is asked for again here, from the provider, immediately before the signer is built: a wallet that
// changed network without emitting the event (or whose event this page missed) is caught rather than signed
// through on a pinned, wrong `Network`.

import {type Address, asAddress, catalogEntryFor, renderMessage} from "@luckydraw/client";
import {BrowserProvider, type JsonRpcSigner, Network} from "ethers";
import {useCallback} from "react";
import {useDeployment} from "../deployment/DeploymentProvider.tsx";
import {parseChainId} from "./connectors.ts";
import {toWalletError, WalletError} from "./errors.ts";
import {useWriteGate} from "./useWriteGate.ts";
import {useWallet} from "./WalletProvider.tsx";

export type SignerHandle = {
  /** True when a signer can be requested right now. Mirrors `useWriteGate().allowed`. */
  ready: boolean;
  /**
   * The signer for `expectedAccount`. Rejects with a `WalletError` when the gate is closed, when no wallet is
   * connected, or when the wallet's active account is not `expectedAccount`.
   */
  requestSigner: (expectedAccount: Address) => Promise<JsonRpcSigner>;
};

export function useSigner(): SignerHandle {
  const wallet = useWallet();
  const deployment = useDeployment();
  const gate = useWriteGate();
  const provider = wallet.connector?.provider ?? null;
  const account = wallet.account;
  const chainId = deployment.chain.chainId;
  const chainName = deployment.chain.name;
  const chainDisplayName = deployment.chain.displayName;

  const requestSigner = useCallback(
    async (expectedAccount: Address): Promise<JsonRpcSigner> => {
      if (!gate.allowed) {
        throw new WalletError("Disconnected", gate.reason ?? "Writes are disabled right now.");
      }
      if (provider === null || account === null) {
        throw new WalletError("Disconnected", "No wallet is connected.");
      }
      const wanted = asAddress(expectedAccount);
      if (account !== wanted) {
        throw new WalletError(
          "AccountMismatch",
          `This action was prepared for ${wanted}, but the connected account is now ${account}. ` +
            "Review it again with the account you want to use.",
        );
      }
      // Ask the wallet itself, every time. React state is only as fresh as the last `chainChanged`.
      let live: bigint;
      try {
        live = parseChainId(await provider.request({method: "eth_chainId"}));
      } catch (caught) {
        throw toWalletError(caught);
      }
      if (live !== chainId) {
        throw new WalletError(
          "WrongChain",
          renderMessage(catalogEntryFor("WrongChain"), {chain: chainDisplayName}),
        );
      }
      const network = new Network(chainName, chainId);
      const browserProvider = new BrowserProvider(provider, network, {staticNetwork: network});
      let signer: JsonRpcSigner;
      try {
        signer = await browserProvider.getSigner(wanted);
      } catch (caught) {
        throw toWalletError(caught);
      }
      const actual = asAddress((await signer.getAddress()).toLowerCase());
      if (actual !== wanted) {
        throw new WalletError(
          "AccountMismatch",
          `The wallet offered ${actual} but this action was prepared for ${wanted}.`,
        );
      }
      return signer;
    },
    [gate.allowed, gate.reason, provider, account, chainId, chainName, chainDisplayName],
  );

  return {ready: gate.allowed, requestSigner};
}
