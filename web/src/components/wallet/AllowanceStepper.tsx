// The deposit's ordered steps, as SPEC §9.5 requires them to be presented.
//
// "ERC-20 deposit uses a TxStepper: approve the exact intended amount to the Vault, then deposit; if a
// nonzero allowance must be reset for token compatibility, present approve(0) and approve(amount) as
// explicit separate steps." Two things follow and both are visible here: a reset is never folded into the
// approval, and an approval that is already covered is "marked done and skipped" rather than hidden.
//
// The order and the membership of the list are `depositSteps`' decision, not this component's; it is handed
// a plan and a count of how many of its steps the chain has already satisfied.

import {type DepositStepKind, formatAmount} from "@luckydraw/client";
import {fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";

export type AllowanceStepView = {
  kind: DepositStepKind;
  status: "done" | "current" | "waiting";
};

export type AllowanceStepperProps = {
  steps: readonly AllowanceStepView[];
  amount: bigint;
  decimals: number;
  symbol: string;
  native: boolean;
  /** True when the account's existing allowance already covered the amount (SPEC §9.5). */
  approvalSkipped: boolean;
};

/** The user-facing sentence for one step. `DepositStep.label` is developer-facing and is never shown raw. */
export function depositStepText(kind: DepositStepKind, amountText: string, native: boolean): string {
  switch (kind) {
    case "approveReset":
      return walletEn.deposit.stepApproveReset;
    case "approve":
      return fill(walletEn.deposit.stepApprove, {amount: amountText});
    default:
      return fill(native ? walletEn.deposit.stepDepositNative : walletEn.deposit.stepDeposit, {
        amount: amountText,
      });
  }
}

const STATUS_LABEL: Readonly<Record<AllowanceStepView["status"], string>> = {
  done: walletEn.deposit.stepDone,
  current: walletEn.deposit.stepCurrent,
  waiting: walletEn.deposit.stepWaiting,
};

export function AllowanceStepper({
  steps,
  amount,
  decimals,
  symbol,
  native,
  approvalSkipped,
}: AllowanceStepperProps) {
  // A deposit debits the user, so SPEC §9.7 rounds it up.
  const amountText = formatAmount(amount, decimals, {rounding: "up", symbol});
  return (
    <div className="stack">
      <p className="card__title">{walletEn.deposit.stepsHeading}</p>
      <ol className="stepper" aria-label={walletEn.deposit.stepsHeading}>
        {steps.map((step, index) => (
          <li
            key={step.kind}
            className={`stepper__item stepper__item--${step.status === "waiting" ? "waiting" : step.status}`}
          >
            <span className="small">
              {index + 1}. {depositStepText(step.kind, amountText, native)}
            </span>
            <span className="stepper__time small muted">{STATUS_LABEL[step.status]}</span>
          </li>
        ))}
      </ol>
      {approvalSkipped ? <p className="small muted">{walletEn.deposit.approvalSkipped}</p> : null}
    </div>
  );
}
