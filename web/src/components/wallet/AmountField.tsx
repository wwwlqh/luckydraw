// The one numeric input both money panels use (SPEC §9.5, §9.7).
//
// "The decimal text parser rejects excess precision, negatives, exponents and malformed separators without
// floating-point conversion" and "numeric input accepts '.' as the only decimal separator with an inline
// hint". The parsing itself is the client's `parseDecimalInput`; this component owns only the label, the
// hint, the error wiring and the optional Max control.
//
// `inputMode="decimal"` rather than `type="number"`: a number input silently normalizes, rejects and rounds
// text in ways that differ per browser, and none of that may ever touch an amount of money.

import {type ParseFailureReason, parseDecimalInput} from "@luckydraw/client";
import {useId} from "react";
import {fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {Button} from "../Button.tsx";

/** The inline message for a rejected input, in the order `parseDecimalInput` checks. */
export function amountErrorText(reason: ParseFailureReason, decimals: number): string {
  const strings = walletEn.deposit;
  switch (reason) {
    case "empty":
      return strings.amountEmpty;
    case "commaSeparator":
      return strings.amountComma;
    case "negative":
      return strings.amountNegative;
    case "tooManyFractionDigits":
      return fill(strings.amountTooManyDecimals, {decimals: decimals.toString()});
    case "aboveMaxUint256":
      return strings.amountTooLarge;
    default:
      return strings.amountInvalid;
  }
}

/** Raw units, or the inline message for why the text is not an amount. Never a float, never a `Number`. */
export function parseAmount(text: string, decimals: number): {raw: bigint} | {error: string} {
  const parsed = parseDecimalInput(text, decimals);
  if (!parsed.ok) return {error: amountErrorText(parsed.reason, decimals)};
  if (parsed.raw <= 0n) return {error: walletEn.deposit.amountEmpty};
  return {raw: parsed.raw};
}

export type AmountFieldProps = {
  label: string;
  decimals: number;
  symbol: string;
  value: string;
  onChange: (text: string) => void;
  /** Shown under the field when the text is not yet a valid amount, or a balance is short. */
  error?: string | null;
  disabled?: boolean;
  maxLabel?: string;
  onMax?: (() => void) | undefined;
};

export function AmountField({
  label,
  decimals,
  symbol,
  value,
  onChange,
  error = null,
  disabled = false,
  maxLabel,
  onMax,
}: AmountFieldProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const hint = fill(walletEn.deposit.amountHint, {decimals: decimals.toString()});
  return (
    <div className="stack">
      <label htmlFor={inputId}>{label}</label>
      <div className="row">
        <input
          id={inputId}
          className="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
          aria-invalid={error === null ? undefined : true}
          onChange={(event) => onChange(event.target.value)}
        />
        <span aria-hidden="true">{symbol}</span>
        {onMax === undefined ? null : (
          <Button variant="ghost" onClick={onMax} disabled={disabled}>
            {maxLabel ?? walletEn.withdraw.max}
          </Button>
        )}
      </div>
      <p id={hintId} className="small muted">
        {hint}
      </p>
      <p id={errorId} className="small" role={error === null ? undefined : "alert"}>
        {error ?? ""}
      </p>
    </div>
  );
}
