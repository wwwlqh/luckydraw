// The network guard (SPEC §9.2): one action, "Switch to {chain}" named from the chain record's displayName, `wallet_switchEthereumChain`
// with `wallet_addEthereumChain` as the fallback, reads unaffected, every write control disabled with the
// reason shown.
//
// This component renders the reason and the action. The decision itself lives in `useWriteGate`, so a page
// that never renders a NetworkGuard still cannot sign on the wrong chain.

import {useCallback, useState} from "react";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {walletSaid} from "../lib/wallet/errors.ts";
import {useWriteGate} from "../lib/wallet/useWriteGate.ts";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en, fill} from "../strings/en.ts";
import {Button} from "./Button.tsx";

export function NetworkGuard() {
  const gate = useWriteGate();
  const wallet = useWallet();
  const deployment = useDeployment();
  const [switching, setSwitching] = useState(false);

  const onSwitch = useCallback(() => {
    setSwitching(true);
    // `switchToDeploymentChain` rejects as well as setting `wallet.error`, and the rejection is the caller's
    // to handle. Swallowing it here is deliberate: the failure is already on screen below, and letting it
    // escape only produces an unhandled rejection in the console.
    void wallet
      .switchToDeploymentChain()
      .catch(() => undefined)
      .finally(() => setSwitching(false));
  }, [wallet]);

  if (gate.code === "deploymentUnverified") {
    return (
      <div className="notice notice--error" role="alert">
        <p className="notice__title">{en.gate.verifyFailedTitle}</p>
        <p>{gate.reason}</p>
        <div>
          <Button variant="secondary" onClick={deployment.retryVerification}>
            {en.gate.recheck}
          </Button>
        </div>
      </div>
    );
  }

  if (gate.code !== "wrongChain") return null;

  return (
    <div className="notice notice--warning" role="status">
      <p className="notice__title">{en.network.guardTitle}</p>
      <p>{gate.reason}</p>
      <p className="small muted">{en.network.readsStillWork}</p>
      <div>
        <Button variant="primary" onClick={onSwitch} loading={switching}>
          {switching
            ? en.network.switching
            : fill(en.network.switchAction, {chain: deployment.chain.displayName})}
        </Button>
      </div>
      {/* The wallet's own text never stands alone in an alert: the app's sentence first, then the wallet's
          words under a label that says whose they are, capped (SPEC §9.7). */}
      {wallet.error === null ? null : (
        <div className="small" role="alert">
          <p>{en.wallet.errorReported}</p>
          {walletSaid(wallet.error.message) === null ? null : (
            <p className="muted">
              {en.wallet.errorSaidLabel} {walletSaid(wallet.error.message)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
