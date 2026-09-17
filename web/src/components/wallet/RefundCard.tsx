// A refunding position and its claim (SPEC §6.2 Refunding, §9.5, §9.6).
//
//   - "each buyer receives exactly grossByUser once, including their fee portion. Reserved fees are fully
//     waived" (§5.2). The card says so in plain words and shows the full gross, not a net;
//   - `claimRefund(roundId, account)` may be called by anyone for any buyer (§8.1), and the keeper normally
//     credits every buyer within minutes (§9.6). The button is therefore a fallback, not the mechanism, and
//     it always names the connected account: this surface never claims for a third party;
//   - once `position.refunded` is true there is nothing left to claim and a second call would revert
//     `AlreadyClaimed`, so the control is replaced by the credited line and a link to Wallet;
//   - the claim is a two-stage review/confirm, the shape `WithdrawPanel` uses, because SPEC §9.6 requires a
//     decoded summary before *every* wallet prompt. Review shows `claimRefund`, the round, the account the
//     credit lands in and what the balance gains; only the second control opens the wallet.

import {type Address, type ManifestAsset, prepareClaimRefund} from "@luckydraw/client";
import {useCallback, useMemo, useState} from "react";
import {Link} from "react-router";
import {useDeployment} from "../../lib/deployment/DeploymentProvider.tsx";
import type {PositionRow} from "../../lib/positions/classify.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {useWriteGate} from "../../lib/wallet/useWriteGate.ts";
import {fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {Button} from "../Button.tsx";
import {EntryRow} from "./EntryRow.tsx";
import {amountText} from "./format.ts";
import {WriteSummaryView} from "./WriteSummaryView.tsx";

export type RefundCardProps = {
  row: PositionRow;
  asset: ManifestAsset | null;
  chainId: bigint;
  /** The connected account. The claim is built for this account and for no other (SPEC §9.5). */
  account: Address;
  tx: TransactionHandle;
  onClaimed: () => void;
};

export function RefundCard({row, asset, chainId, account, tx, onClaimed}: RefundCardProps) {
  const {verified} = useDeployment();
  const gate = useWriteGate();
  const decimals = asset === null ? 0 : Number(asset.decimals);
  const symbol = asset?.symbol ?? "";

  const [preview, setPreview] = useState(false);

  const prepared = useMemo(
    () => (verified === null ? null : prepareClaimRefund(verified, row.roundId, account)),
    [verified, row.roundId, account],
  );

  const claim = useCallback(() => {
    if (prepared === null) return;
    void tx
      .send(prepared, {
        account,
        label: fill(walletEn.entries.claimLabel, {roundId: row.roundId.toString()}),
      })
      .then((result) => {
        if (result.phase === "included" || result.phase === "confirmed") {
          setPreview(false);
          onClaimed();
        }
      });
  }, [prepared, row.roundId, account, tx, onClaimed]);

  const amount = amountText(row.position.gross, decimals, symbol);
  const claimLabel = fill(walletEn.entries.claimLabel, {roundId: row.roundId.toString()});

  const action =
    row.outcome !== "refundClaimable" ? (
      <Link to="/wallet">{walletEn.entries.rowGoToWallet}</Link>
    ) : preview ? (
      <div className="stack">
        <p className="card__title">{walletEn.entries.refundPreviewHeading}</p>
        <dl className="definition-list">
          <dt>{walletEn.entries.refundAmount}</dt>
          <dd className="amount">{amount}</dd>
        </dl>
        <p className="small">{fill(walletEn.entries.refundBalanceAfter, {amount})}</p>
        {prepared === null ? null : (
          <WriteSummaryView summary={prepared.summary} to={prepared.to} decimals={decimals} symbol={symbol} />
        )}
        <div className="row">
          <Button
            variant="primary"
            loading={tx.busy}
            disabledReason={gate.allowed ? null : gate.reason}
            disabled={prepared === null}
            onClick={claim}
            aria-label={claimLabel}
          >
            {walletEn.entries.refundConfirm}
          </Button>
          <Button variant="ghost" disabled={tx.busy} onClick={() => setPreview(false)}>
            {walletEn.entries.refundCancel}
          </Button>
        </div>
      </div>
    ) : (
      <div className="stack">
        <p className="small muted">{walletEn.entries.refundClaimable}</p>
        <dl className="definition-list">
          <dt>{walletEn.entries.refundAmount}</dt>
          <dd className="amount">{amount}</dd>
        </dl>
        <Button
          variant="primary"
          disabledReason={gate.allowed ? null : gate.reason}
          onClick={() => setPreview(true)}
          aria-label={claimLabel}
        >
          {walletEn.entries.rowClaim}
        </Button>
      </div>
    );

  return <EntryRow row={row} asset={asset} chainId={chainId} action={action} />;
}
