// Withdraw, for one asset (SPEC §4.2, §9.4 `/wallet`, §9.5 last paragraph).
//
//   - "Withdraw has no USD 1 minimum: any positive representable available amount is allowed." There is no
//     minimum check here and none in `prepareWithdraw`;
//   - "no pause/price/round gate" (§4.2) and "Application pause/price/round state never gates available
//     withdrawal" (V3): this panel asks the deposit switches nothing. An exit is never blocked by the app;
//   - the destination is the connected address, read-only and copyable, with the §9.4 sentence. It is not a
//     field, because `Vault.withdraw` transfers to its caller and to nobody else (V4). Showing an editable
//     destination would be a lie about what the contract does;
//   - "When the connected address has code and the asset is BNB, warn before signing that the wallet must
//     accept plain BNB transfers or the transaction reverts and the balance stays in place." The warning sits
//     in the pre-signature preview, where it is read before the wallet opens, and it never disables anything:
//     a contract wallet that does accept BNB is an ordinary user.
//
// X1 again: the exact amount, the balance afterwards, the destination and the decoded summary are all on
// screen before the wallet opens.

import {
  type Address,
  catalogEntryFor,
  formatAmount,
  formatAmountFull,
  type ManifestAsset,
  prepareWithdraw,
  renderMessage,
} from "@luckydraw/client";
import {useCallback, useMemo, useState} from "react";
import {useDeployment} from "../../lib/deployment/DeploymentProvider.tsx";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {useWriteGate} from "../../lib/wallet/useWriteGate.ts";
import {en, fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {Button} from "../Button.tsx";
import {Card} from "../Card.tsx";
import {TxStepper} from "../TxStepper.tsx";
import {AmountField, parseAmount} from "./AmountField.tsx";
import {revertParams} from "./format.ts";
import {WriteSummaryView} from "./WriteSummaryView.tsx";

export type WithdrawPanelProps = {
  asset: ManifestAsset;
  account: Address;
  /** Available LuckyDraw balance, or null while it is still being read. Escrow is never included. */
  vaultBalance: bigint | null;
  /** True when the connected address holds code, from a live `eth_getCode` (SPEC §9.4). */
  accountHasCode: boolean;
  onRefresh: () => void;
  tx: TransactionHandle;
};

export function WithdrawPanel({
  asset,
  account,
  vaultBalance,
  accountHasCode,
  onRefresh,
  tx,
}: WithdrawPanelProps) {
  const {chain, verified} = useDeployment();
  const gate = useWriteGate();
  const decimals = Number(asset.decimals);
  const symbol = asset.symbol;

  const [amountText, setAmountText] = useState("");
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseAmount(amountText, decimals), [amountText, decimals]);
  const amount = "raw" in parsed ? parsed.raw : null;

  // Refused here rather than at the wallet: the §9.6 `InsufficientBalance` row is written for an entry, and
  // the catalog carries `WithdrawAboveBalance` for exactly this case.
  const balanceError =
    amount !== null && vaultBalance !== null && amount > vaultBalance
      ? renderMessage(catalogEntryFor("WithdrawAboveBalance"), {
          available: formatAmount(vaultBalance, decimals, {rounding: "down"}),
          symbol,
          amount: formatAmount(amount, decimals, {rounding: "up", symbol}),
        })
      : null;
  const fieldError = amountText.trim() === "" ? null : "error" in parsed ? parsed.error : balanceError;

  const changeAmount = useCallback((text: string) => {
    setAmountText(text);
    setPreview(false);
  }, []);

  const copyDestination = useCallback(() => {
    void navigator.clipboard
      ?.writeText(account)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [account]);

  const prepared = useMemo(() => {
    if (verified === null || amount === null || amount <= 0n) return null;
    return prepareWithdraw(verified, asset.asset, amount);
  }, [verified, asset.asset, amount]);

  const confirm = useCallback(() => {
    if (prepared === null || amount === null) return;
    void tx
      .send(prepared, {
        account,
        label: fill(walletEn.withdraw.label, {
          amount: formatAmount(amount, decimals, {rounding: "up", symbol}),
        }),
        formatParams: revertParams(decimals, symbol, {available: vaultBalance, amount}),
      })
      .then((result) => {
        if (result.phase === "included" || result.phase === "confirmed") {
          onRefresh();
          setAmountText("");
          setPreview(false);
        }
      });
  }, [prepared, amount, tx, account, decimals, symbol, vaultBalance, onRefresh]);

  // Never negative: a balance that fell under the amount while the preview was open is a refusal, not a
  // figure to render (SPEC §9.1 X1 — the balance afterwards is what this transaction would actually leave).
  const balanceAfter =
    amount === null || vaultBalance === null || amount > vaultBalance ? null : vaultBalance - amount;
  const warnNativeContract = accountHasCode && asset.native;
  const canReview = amount !== null && balanceError === null && gate.allowed;

  const destination = (
    <div className="stack">
      <p className="card__title">{walletEn.withdraw.destinationLabel}</p>
      <div className="row">
        <output className="mono" aria-label={walletEn.withdraw.destinationLabel}>
          {account}
        </output>
        <Button variant="ghost" onClick={copyDestination} aria-label={walletEn.withdraw.copyDestination}>
          {copied ? en.app.copied : en.app.copy}
        </Button>
      </div>
      <p className="small muted">{walletEn.withdraw.destinationNote}</p>
    </div>
  );

  return (
    <Card title={walletEn.withdraw.heading}>
      {preview ? (
        <div className="stack">
          <p className="card__title">{walletEn.withdraw.previewHeading}</p>
          <dl className="definition-list">
            <dt>{walletEn.withdraw.previewAmount}</dt>
            <dd className="amount">
              {amount === null ? "—" : formatAmount(amount, decimals, {rounding: "up", symbol})}
            </dd>
            <dt>{walletEn.withdraw.previewBalanceAfter}</dt>
            <dd className="amount">
              {balanceAfter === null ? "—" : formatAmount(balanceAfter, decimals, {rounding: "down", symbol})}
            </dd>
            <dt>{walletEn.withdraw.previewDestination}</dt>
            <dd className="mono">{account}</dd>
          </dl>
          {/*
            The balance is read once per block and the preview stays open across those reads, so the check
            made at Review is made again here. A withdrawal above the available balance reverts, and X2 says
            a control that cannot succeed must not look as though it can.
          */}
          {balanceError === null ? null : (
            <p className="notice notice--error small" role="alert">
              {balanceError}
            </p>
          )}
          {warnNativeContract ? (
            <div className="notice notice--warning">
              <p className="notice__title">{walletEn.withdraw.contractWarningTitle}</p>
              <p>{fill(walletEn.withdraw.contractWarningBody, {symbol})}</p>
            </div>
          ) : null}
          {prepared === null ? null : (
            <WriteSummaryView
              summary={prepared.summary}
              to={prepared.to}
              decimals={decimals}
              symbol={symbol}
            />
          )}
          <div className="row">
            <Button
              variant="primary"
              loading={tx.busy}
              disabledReason={gate.allowed ? null : gate.reason}
              disabled={prepared === null || balanceError !== null}
              onClick={confirm}
            >
              {walletEn.withdraw.confirm}
            </Button>
            <Button variant="ghost" disabled={tx.busy} onClick={() => setPreview(false)}>
              {walletEn.withdraw.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">{walletEn.withdraw.noMinimum}</p>
          <AmountField
            label={walletEn.withdraw.amountLabel}
            decimals={decimals}
            symbol={symbol}
            value={amountText}
            onChange={changeAmount}
            error={fieldError}
            disabled={tx.busy}
            maxLabel={walletEn.withdraw.max}
            onMax={
              vaultBalance === null || vaultBalance <= 0n
                ? undefined
                : () => changeAmount(formatAmountFull(vaultBalance, decimals))
            }
          />
          {vaultBalance !== null && vaultBalance <= 0n ? (
            <p className="small muted">{fill(walletEn.withdraw.nothingToWithdraw, {symbol})}</p>
          ) : null}
          {destination}
          <Button
            variant="primary"
            block
            disabledReason={gate.allowed ? null : gate.reason}
            disabled={!canReview}
            onClick={() => setPreview(true)}
          >
            {walletEn.withdraw.review}
          </Button>
        </div>
      )}
      {tx.state.summary?.action === "withdraw" ? <TxStepper state={tx.state} chain={chain} /> : null}
    </Card>
  );
}
