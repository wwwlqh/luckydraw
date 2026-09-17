// The one Connect control, and the account chip it becomes (SPEC §9.2: "one Connect button, a modal that
// lists wallets, automatic network handling and a persistent account chip").

import {useCallback, useEffect, useState} from "react";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en, fill} from "../strings/en.ts";
import {AccountChip, truncateAddress} from "./AccountChip.tsx";
import {Button} from "./Button.tsx";
import {ConnectModal} from "./ConnectModal.tsx";

export function WalletButton() {
  const wallet = useWallet();
  const {chain} = useDeployment();
  const [open, setOpen] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const onConnect = useCallback(
    (connectorId: string) => {
      setConnectingId(connectorId);
      void wallet.connect(connectorId).finally(() => setConnectingId(null));
    },
    [wallet],
  );

  const close = useCallback(() => {
    setOpen(false);
    wallet.clearError();
  }, [wallet]);

  // A connection that lands closes the dialog; a failure keeps it open with the reason.
  const connected = wallet.status === "connected";
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);

  if (wallet.status === "connected" && wallet.account !== null) {
    return (
      <>
        <AccountChip
          address={wallet.account}
          chain={chain}
          walletChainId={wallet.chainId}
          onDisconnect={wallet.disconnect}
        />
        {/* The dialog closes and the button is replaced in one commit; without this a keyboard user hears
            nothing at all about a connection that just succeeded (SPEC §9.7). */}
        <span className="visually-hidden" role="status" aria-live="polite">
          {fill(en.wallet.connected, {address: truncateAddress(wallet.account)})}
        </span>
      </>
    );
  }

  return (
    <>
      <Button
        variant="primary"
        onClick={() => setOpen(true)}
        loading={wallet.status === "connecting"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {wallet.status === "connecting" ? en.wallet.connecting : en.wallet.connect}
      </Button>
      <ConnectModal
        open={open}
        connectors={wallet.connectors}
        connectingId={connectingId}
        error={wallet.error === null ? null : wallet.error.message}
        onConnect={onConnect}
        onClose={close}
      />
    </>
  );
}
