// The deposit TxStepper of SPEC §9.5 / ACCEPTANCE U02, as an ordered list of prepared writes.
//
//   "Native deposit is one transaction. ERC-20 deposit uses a TxStepper: approve the exact intended amount to
//    the Vault, then deposit; if a nonzero allowance must be reset for token compatibility, present approve(0)
//    and approve(amount) as explicit separate steps. No unlimited default approval and no approval to Draw.
//    Before each ERC-20 deposit the app reads the current allowance to the Vault: if it already covers the
//    amount, the approval step is marked done and skipped; if it is positive but short, offer approve(amount),
//    or approve(0) then approve(amount) for tokens flagged requiresZeroReset in the asset manifest."
//
// The zero reset is therefore *not* the default for a short allowance: it is what a token flagged
// `requiresZeroReset` needs (the USDT-style `approve` that reverts unless the current allowance is zero).
// The manifest's asset record carries the optional `requiresZeroReset` flag (validator rule A9, absent means
// false), and `parseManifest` exposes it as `ManifestAsset.requiresZeroReset`; it still arrives here as an
// explicit argument so a consumer can combine the manifest flag with its own token list.

import type {VerifiedDeployment} from "../deployments/verify.ts";
import {type Address, MAX_UINT256, ZERO_ADDRESS} from "../types/common.ts";
import {
  MAX_EXACT_APPROVAL,
  type PreparedWrite,
  prepareApprove,
  prepareDeposit,
  prepareDepositNative,
  WriteError,
} from "./prepare.ts";

/** What a step does, for the UI to key its own copy off. The `label` is developer-facing, never shown raw. */
export type DepositStepKind = "approveReset" | "approve" | "deposit";

export type DepositStep = {
  kind: DepositStepKind;
  /**
   * A short English description of the step. User-facing copy comes from `src/catalog/` (SPEC §9.7: "every
   * string in one externalized catalog"); this is for logs, tests and developer tooling.
   */
  label: string;
  write: PreparedWrite;
};

export type DepositStepsInput = {
  /** The asset to deposit; the zero address is native BNB (SPEC §4.2). */
  asset: Address;
  /** Raw units to deposit. */
  amount: bigint;
  /** The current ERC-20 allowance from the depositor to the Vault. Ignored for the native asset. */
  currentAllowance: bigint;
  /**
   * True for a token whose `approve` reverts unless the current allowance is zero. Only such a token gets
   * the two-step `approve(0)` then `approve(amount)` sequence (SPEC §9.5).
   */
  requiresZeroReset?: boolean | undefined;
};

/**
 * The ordered steps for one deposit.
 *
 * | asset  | allowance                | steps                                     |
 * |--------|--------------------------|-------------------------------------------|
 * | native | -                        | deposit                                   |
 * | ERC-20 | >= amount                | deposit                                   |
 * | ERC-20 | 0                        | approve(amount), deposit                  |
 * | ERC-20 | 0 < a < amount, reset    | approve(0), approve(amount), deposit      |
 * | ERC-20 | 0 < a < amount, no reset | approve(amount), deposit                  |
 *
 * The spender of every approval is the manifest Vault, fixed by `prepareApprove`, and no step ever approves
 * an unlimited amount or the Draw.
 */
export function depositSteps(verified: VerifiedDeployment, input: DepositStepsInput): readonly DepositStep[] {
  if (input.currentAllowance < 0n || input.currentAllowance > MAX_UINT256) {
    throw new WriteError(
      "InvalidAmount",
      `currentAllowance must be a uint256, received ${input.currentAllowance}`,
    );
  }

  if (input.asset === ZERO_ADDRESS) {
    return [
      {
        kind: "deposit",
        label: "Deposit BNB into your LuckyDraw balance",
        write: prepareDepositNative(verified, input.amount),
      },
    ];
  }

  // The bound `prepareApprove` enforces, applied before the allowance decides whether an approval is needed,
  // so the same amount is refused the same way whatever the current allowance happens to be.
  if (input.amount >= MAX_EXACT_APPROVAL) {
    throw new WriteError(
      "InvalidAmount",
      `an ERC-20 deposit of ${input.amount} raw units is at or above the 2^128 exact-approval bound (SPEC §9.5)`,
    );
  }

  const deposit: DepositStep = {
    kind: "deposit",
    label: "Deposit the approved amount into your LuckyDraw balance",
    write: prepareDeposit(verified, input.asset, input.amount),
  };

  if (input.currentAllowance >= input.amount) return [deposit];

  const approve: DepositStep = {
    kind: "approve",
    label: "Approve the exact amount to the Vault",
    write: prepareApprove(verified, input.asset, input.amount),
  };

  if (input.currentAllowance === 0n) return [approve, deposit];

  if (input.requiresZeroReset === true) {
    const reset: DepositStep = {
      kind: "approveReset",
      label: "Reset the existing allowance to zero first (this token requires it)",
      write: prepareApprove(verified, input.asset, 0n),
    };
    return [reset, approve, deposit];
  }

  return [approve, deposit];
}
