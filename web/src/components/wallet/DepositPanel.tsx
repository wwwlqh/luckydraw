// Deposit, for one asset (SPEC §4.2, §9.4 `/wallet`, §9.5 deposit paragraphs).
//
// The rules this panel exists to keep, in the order they bite:
//
//   - a deposit prompt is never opened on a stale switch. `Vault.getAsset` is read live, at the head, both
//     when the preview is built and again immediately before the wallet opens; a paused or unlisted asset is
//     refused with the client catalog's own sentence and no calldata is ever built. This live read is a
//     recorded requirement from the wave 5 review, and it exists because `depositsEnabled` is operator state
//     that can flip after the manifest was written;
//   - "Native deposit is one transaction." `prepareDepositNative` is the whole flow for BNB;
//   - an ERC-20 deposit's steps are `depositSteps`' decision, recomputed from a fresh allowance every time
//     the user asks for a preview and again before every signature, so changing the amount re-runs the check
//     and returning to the page resumes at the deposit step;
//   - "No unlimited default approval and no approval to Draw": the spender and the exactness are fixed
//     inside `prepareApprove`, and nothing here can pass either of them;
//   - X1: the exact amount, the balance afterwards and the next step are on screen before the wallet opens,
//     together with the decoded summary of §9.6.
//
// What this panel never does: arithmetic on a float, a transfer claim before a receipt, or an entry. A
// deposit creates balance and nothing else (SPEC §9.5).

import {
  type Address,
  catalogEntryFor,
  type DepositStep,
  depositSteps,
  formatAmount,
  formatAmountFull,
  type ManifestAsset,
  type PreparedWrite,
  prepareApprove,
  type ReadContext,
  readAssetRecord,
  WriteError,
} from "@luckydraw/client";
import {type ReactNode, useCallback, useMemo, useState} from "react";
import {useDeployment} from "../../lib/deployment/DeploymentProvider.tsx";
import {readDepositsPaused, readTokenAccountState} from "../../lib/positions/tokenReads.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {useWriteGate} from "../../lib/wallet/useWriteGate.ts";
import {en, fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {Button} from "../Button.tsx";
import {Card} from "../Card.tsx";
import {ErrorState} from "../StatePanels.tsx";
import {TxStepper} from "../TxStepper.tsx";
import {AllowanceStepper, type AllowanceStepView, depositStepText} from "./AllowanceStepper.tsx";
import {AmountField, parseAmount} from "./AmountField.tsx";
import {revertParams} from "./format.ts";
import {WriteSummaryView} from "./WriteSummaryView.tsx";
import {requiresZeroReset} from "./zeroReset.ts";

/** A refusal decided before any calldata existed, carrying the catalog's own three columns (SPEC §9.6). */
export type DepositRefusal = {message: string; funds: string; nextAction: string};

export type DepositPanelProps = {
  asset: ManifestAsset;
  account: Address;
  /** The account's own balance of this asset, or null while it is still being read. */
  walletBalance: bigint | null;
  /** The account's available LuckyDraw balance of this asset, or null while it is still being read. */
  vaultBalance: bigint | null;
  /** The account's current allowance to the Vault. Always zero for the native asset. */
  allowance: bigint;
  /** Re-reads the balances and the allowance. Called after every included receipt. */
  onRefresh: () => void;
  tx: TransactionHandle;
  /** Prefill from the `/wallet?amount=` top-up link (SPEC §9.5). */
  initialAmount?: string;
  /** Shown once a deposit receipt is included; the top-up flow puts its "Back to round" action here. */
  afterDeposit?: ReactNode;
};

export function DepositPanel({
  asset,
  account,
  walletBalance,
  vaultBalance,
  allowance,
  onRefresh,
  tx,
  initialAmount,
  afterDeposit,
}: DepositPanelProps) {
  const {chain, verified, readCtx} = useDeployment();
  const gate = useWriteGate();
  const decimals = Number(asset.decimals);
  const symbol = asset.symbol;

  const [amountText, setAmountText] = useState(initialAmount ?? "");
  const [plan, setPlan] = useState<readonly DepositStep[] | null>(null);
  const [planFrom, setPlanFrom] = useState<readonly DepositStep[] | null>(null);
  const [refusal, setRefusal] = useState<DepositRefusal | null>(null);
  const [checking, setChecking] = useState(false);
  const [deposited, setDeposited] = useState(false);

  const parsed = useMemo(() => parseAmount(amountText, decimals), [amountText, decimals]);
  const amount = "raw" in parsed ? parsed.raw : null;

  const balanceError =
    amount !== null && walletBalance !== null && amount > walletBalance
      ? fill(walletEn.deposit.amountAboveWallet, {
          available: formatAmount(walletBalance, decimals, {rounding: "down", symbol}),
          amount: formatAmount(amount, decimals, {rounding: "up", symbol}),
        })
      : null;
  const fieldError = amountText.trim() === "" ? null : "error" in parsed ? parsed.error : balanceError;

  const changeAmount = useCallback((text: string) => {
    setAmountText(text);
    setPlan(null);
    setPlanFrom(null);
    setRefusal(null);
    setDeposited(false);
  }, []);

  /**
   * The live check of SPEC §9.5, run before the preview and again before every prompt: `Vault.getAsset` at
   * the head, then the allowance at the head, then `depositSteps`. Returns the plan, or null after setting
   * the refusal the catalog defines for what the chain actually said.
   */
  const checkAndPlan = useCallback(
    async (raw: bigint): Promise<readonly DepositStep[] | null> => {
      if (verified === null || readCtx === null) return null;
      // `tag: "latest"` because a deposit acts on current state, not on the display depth (SPEC §9.6).
      const live: ReadContext = {...readCtx, tag: "latest"};
      // The Vault's global switch is read before the per-asset one: `LuckyVault.deposit` reverts
      // `DepositsPaused()` on either, and a refusal decided here never opens a wallet (SPEC §4.2, §9.6).
      const [paused, record] = await Promise.all([
        readDepositsPaused(live),
        readAssetRecord(live, asset.asset),
      ]);
      if (paused.value) {
        setRefusal(catalogEntryFor("DepositsPaused"));
        return null;
      }
      if (!record.value.listed) {
        setRefusal(catalogEntryFor("InvalidAsset"));
        return null;
      }
      if (!record.value.depositsEnabled) {
        setRefusal(catalogEntryFor("DepositsPaused"));
        return null;
      }
      let currentAllowance = 0n;
      if (!asset.native) {
        const state = await readTokenAccountState(live, asset.asset, account);
        currentAllowance = state.value.allowance;
      }
      try {
        const steps = depositSteps(verified, {
          asset: asset.asset,
          amount: raw,
          currentAllowance,
          requiresZeroReset: requiresZeroReset(asset, chain.chainId),
        });
        setRefusal(null);
        return steps;
      } catch (error) {
        if (error instanceof WriteError) {
          setRefusal({message: error.message, funds: "Nothing transferred", nextAction: en.app.retry});
          return null;
        }
        throw error;
      }
    },
    [verified, readCtx, asset, account, chain.chainId],
  );

  const review = useCallback(() => {
    if (amount === null || balanceError !== null) return;
    setChecking(true);
    void checkAndPlan(amount)
      .then((steps) => {
        if (steps === null) return;
        setPlan(steps);
        setPlanFrom(steps);
      })
      .catch((caught: unknown) => {
        setRefusal({
          message: caught instanceof Error ? caught.message : String(caught),
          funds: "No change",
          nextAction: en.app.retry,
        });
      })
      .finally(() => setChecking(false));
  }, [amount, balanceError, checkAndPlan]);

  const next = plan === null ? null : (plan[0] ?? null);

  const confirm = useCallback(() => {
    if (amount === null) return;
    // The step whose decoded summary is on screen right now. The re-check below may produce a different
    // first step — a third party can move the allowance between Review and Confirm — and signing that one
    // would break the §9.6 rule that a decoded summary is shown before every wallet prompt.
    const shown = next;
    if (shown === null) return;
    setChecking(true);
    void checkAndPlan(amount)
      .then(async (steps) => {
        if (steps === null || steps.length === 0) return;
        const step = steps[0] as DepositStep;
        if (
          step.kind !== shown.kind ||
          step.write.data !== shown.write.data ||
          step.write.to !== shown.write.to ||
          step.write.value !== shown.write.value
        ) {
          // Install the new plan so the user is looking at the step that would actually be signed, and send
          // nothing: this is a refusal, not a retry.
          setPlan(steps);
          setPlanFrom(steps);
          setRefusal({
            message: walletEn.deposit.allowanceChanged,
            funds: "Nothing transferred",
            nextAction: walletEn.deposit.allowanceChangedNext,
          });
          return;
        }
        setPlan(steps);
        const amountText2 = formatAmount(amount, decimals, {rounding: "up", symbol});
        const label =
          step.kind === "deposit"
            ? fill(walletEn.deposit.label, {amount: amountText2})
            : fill(walletEn.deposit.approveLabel, {amount: amountText2});
        const result = await tx.send(step.write, {
          account,
          label,
          formatParams: revertParams(decimals, symbol, {available: walletBalance, amount}),
        });
        if (result.phase === "included" || result.phase === "confirmed") {
          onRefresh();
          if (step.kind === "deposit") setDeposited(true);
          else setPlan(steps.slice(1));
        }
      })
      .catch((caught: unknown) => {
        setRefusal({
          message: caught instanceof Error ? caught.message : String(caught),
          funds: "No change",
          nextAction: en.app.retry,
        });
      })
      .finally(() => setChecking(false));
  }, [amount, next, checkAndPlan, tx, account, decimals, symbol, walletBalance, onRefresh]);

  const stepViews = useMemo<readonly AllowanceStepView[]>(() => {
    const full = planFrom ?? plan;
    if (full === null) return [];
    const doneCount = full.length - (plan?.length ?? full.length);
    return full.map((step, index) => ({
      kind: step.kind,
      status: index < doneCount ? "done" : index === doneCount ? "current" : "waiting",
    }));
  }, [planFrom, plan]);

  const balanceAfter = amount === null || vaultBalance === null ? null : vaultBalance + amount;
  const walletAfter =
    amount === null || walletBalance === null || amount > walletBalance ? null : walletBalance - amount;

  const outstanding = asset.native ? 0n : allowance;
  // The Revoke control of SPEC §9.5. `prepareApprove` fixes the spender to the manifest Vault, so this can
  // only ever zero the allowance this page just showed, never touch another spender.
  //
  // It is reviewed and then confirmed, exactly like a deposit step: §9.6 requires a decoded summary (function,
  // asset, amount and, for an approval, the spender) before *every* wallet prompt, and a revoke is a wallet
  // prompt. The first click builds the calldata and shows what it says; only the second opens the wallet.
  const [revokePlan, setRevokePlan] = useState<PreparedWrite | null>(null);
  const reviewRevoke = useCallback(() => {
    if (verified === null) return;
    setRevokePlan(prepareApprove(verified, asset.asset, 0n));
  }, [verified, asset.asset]);

  const confirmRevoke = useCallback(() => {
    if (revokePlan === null) return;
    void tx
      .send(revokePlan, {
        account,
        label: fill(walletEn.deposit.revokeTxLabel, {symbol}),
      })
      .then((result) => {
        if (result.phase === "included" || result.phase === "confirmed") {
          setRevokePlan(null);
          onRefresh();
        }
      });
  }, [revokePlan, tx, account, symbol, onRefresh]);

  const busy = checking || tx.busy;
  const canReview = amount !== null && balanceError === null && gate.allowed;

  return (
    <Card title={walletEn.deposit.heading}>
      {plan === null ? (
        <div className="stack">
          <AmountField
            label={walletEn.deposit.amountLabel}
            decimals={decimals}
            symbol={symbol}
            value={amountText}
            onChange={changeAmount}
            error={fieldError}
            disabled={busy}
            maxLabel={walletEn.deposit.max}
            onMax={
              walletBalance === null || walletBalance <= 0n
                ? undefined
                : () => changeAmount(formatAmountFull(walletBalance, decimals))
            }
          />
          <Button
            variant="primary"
            block
            loading={busy}
            disabledReason={gate.allowed ? null : gate.reason}
            disabled={!canReview}
            onClick={review}
          >
            {walletEn.deposit.review}
          </Button>
        </div>
      ) : (
        <div className="stack">
          <p className="card__title">{walletEn.deposit.previewHeading}</p>
          <dl className="definition-list">
            <dt>{walletEn.deposit.previewAmount}</dt>
            <dd className="amount">
              {amount === null ? "—" : formatAmount(amount, decimals, {rounding: "up", symbol})}
            </dd>
            <dt>{walletEn.deposit.previewBalanceAfter}</dt>
            <dd className="amount">
              {balanceAfter === null ? "—" : formatAmount(balanceAfter, decimals, {rounding: "down", symbol})}
            </dd>
            <dt>{walletEn.deposit.previewWalletAfter}</dt>
            <dd className="amount">
              {walletAfter === null ? "—" : formatAmount(walletAfter, decimals, {rounding: "down", symbol})}
            </dd>
            <dt>{walletEn.deposit.previewNextStep}</dt>
            <dd>
              {next === null
                ? walletEn.deposit.stepDone
                : depositStepText(
                    next.kind,
                    formatAmount(amount ?? 0n, decimals, {rounding: "up", symbol}),
                    asset.native,
                  )}
            </dd>
          </dl>
          <AllowanceStepper
            steps={stepViews}
            amount={amount ?? 0n}
            decimals={decimals}
            symbol={symbol}
            native={asset.native}
            approvalSkipped={(planFrom?.length ?? 0) === 1 && !asset.native}
          />
          {next === null ? null : (
            <WriteSummaryView
              summary={next.write.summary}
              to={next.write.to}
              decimals={decimals}
              symbol={symbol}
            />
          )}
          <div className="row">
            <Button
              variant="primary"
              loading={busy}
              disabledReason={gate.allowed ? null : gate.reason}
              disabled={next === null}
              onClick={confirm}
            >
              {walletEn.deposit.confirm}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => changeAmount(amountText)}>
              {walletEn.deposit.cancel}
            </Button>
          </div>
        </div>
      )}

      {refusal === null ? null : (
        <ErrorState
          title={walletEn.deposit.refusedTitle}
          body={refusal.message}
          funds={refusal.funds}
          nextAction={refusal.nextAction}
        />
      )}

      {tx.state.summary?.action === "deposit" || tx.state.summary?.action === "approve" ? (
        <TxStepper state={tx.state} chain={chain} />
      ) : null}

      {deposited ? (
        <div className="stack">
          <p className="notice notice--info">{walletEn.deposit.success}</p>
          {afterDeposit}
        </div>
      ) : null}

      {outstanding > 0n ? (
        <div className="stack">
          <p className="card__title">{walletEn.deposit.allowanceHeading}</p>
          <p className="small muted">
            {fill(walletEn.deposit.allowanceBody, {
              amount: formatAmount(outstanding, decimals, {rounding: "down", symbol}),
            })}
          </p>
          {revokePlan === null ? (
            <Button
              variant="secondary"
              loading={busy}
              disabledReason={gate.allowed ? null : gate.reason}
              onClick={reviewRevoke}
              aria-label={fill(walletEn.deposit.revokeLabel, {symbol})}
            >
              {walletEn.deposit.revoke}
            </Button>
          ) : (
            <div className="stack">
              <p className="card__title">{walletEn.deposit.revokePreviewHeading}</p>
              <p className="small muted">{fill(walletEn.deposit.revokePreviewBody, {symbol})}</p>
              <WriteSummaryView
                summary={revokePlan.summary}
                to={revokePlan.to}
                decimals={decimals}
                symbol={symbol}
              />
              <div className="row">
                <Button
                  variant="secondary"
                  loading={busy}
                  disabledReason={gate.allowed ? null : gate.reason}
                  onClick={confirmRevoke}
                  aria-label={fill(walletEn.deposit.revokeConfirmLabel, {symbol})}
                >
                  {walletEn.deposit.revokeConfirm}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setRevokePlan(null)}>
                  {walletEn.deposit.revokeCancel}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
