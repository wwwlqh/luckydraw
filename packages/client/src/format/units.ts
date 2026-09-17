/// Exact raw-unit <-> decimal-string conversion (SPEC §9.7).
///
/// All arithmetic is bigint. No value ever passes through `Number`, so a 78-digit uint256 formats and parses
/// without losing a raw unit. The rounding direction is always the caller's explicit choice because SPEC §9.7
/// requires debits and fees to round *up* and prizes and shares to round *down*: there is no safe default.

import {MAX_UINT256} from "../types/common.ts";

/// Rounding direction applied to the digits that are dropped. `"up"` rounds away from zero, `"down"` toward
/// zero, so the magnitude of the displayed number never surprises in the caller's favour.
export type Rounding = "up" | "down";

/// Options for `formatUnits`.
export interface FormatUnitsOptions {
  /// Fraction digits to keep; defaults to `decimals` (the exact value). Values above `decimals` are treated
  /// as `decimals`, since no further digit exists.
  readonly maxFractionDigits?: number;
  /// Required: which way the dropped digits go.
  readonly rounding: Rounding;
}

/// Why `parseDecimalInput` rejected the text. One reason per failure, in the order the checks run.
export type ParseFailureReason =
  /// Nothing but whitespace.
  | "empty"
  /// A `,` appeared: SPEC §9.7 admits `.` as the only decimal separator.
  | "commaSeparator"
  /// A leading or embedded `-`.
  | "negative"
  /// More than one `.`.
  | "multipleDots"
  /// Anything other than digits and a single `.` (signs, exponents, spaces inside, hex, unicode digits).
  | "invalidCharacter"
  /// More fraction digits than the asset has decimals; accepting them would silently truncate the input.
  | "tooManyFractionDigits"
  /// The raw amount does not fit in uint256, which no balance, entry or withdrawal can hold.
  | "aboveMaxUint256";

/// Result of `parseDecimalInput`.
export type ParseDecimalResult =
  | {readonly ok: true; readonly raw: bigint}
  | {readonly ok: false; readonly reason: ParseFailureReason};

/// Formats a raw amount as a plain decimal string: no grouping, no symbol, no locale (SPEC §9.7).
///
/// `formatAmount` adds grouping and a symbol on top of this string; this function is the exact arithmetic
/// underneath, and is what `parseDecimalInput` round-trips against when no digits are dropped.
///
/// Trailing zeros in the fraction are trimmed, and a value with no fraction left prints as an integer, so
/// `1.500000000000000000` prints as `1.5` and `1.000000000000000000` as `1`.
///
/// A negative `raw` (only feed answers are signed; balances never are) formats as `-` plus the magnitude, and
/// the rounding direction applies to that magnitude: `"up"` rounds away from zero.
export function formatUnits(raw: bigint, decimals: number, options: FormatUnitsOptions): string {
  requireDecimals(decimals);
  const keep = resolveFractionDigits(options.maxFractionDigits, decimals);

  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;

  const dropped = decimals - keep;
  const divisor = 10n ** BigInt(dropped);
  let scaled = magnitude / divisor;
  if (options.rounding === "up" && magnitude % divisor !== 0n) scaled += 1n;

  const keepUnit = 10n ** BigInt(keep);
  const whole = scaled / keepUnit;
  const fraction = scaled % keepUnit;

  let text = whole.toString();
  if (keep > 0 && fraction !== 0n) {
    const digits = fraction.toString().padStart(keep, "0").replace(/0+$/, "");
    text = `${text}.${digits}`;
  }
  // Never print "-0": a magnitude that rounded away to nothing is zero.
  return negative && (whole !== 0n || fraction !== 0n) ? `-${text}` : text;
}

/// Parses user input into raw units (SPEC §9.7: "numeric input accepts '.' as the only decimal separator").
///
/// Accepts only ASCII digits and at most one `.`, after trimming surrounding whitespace. Signs, exponents,
/// thousands separators and more fraction digits than the asset carries are rejected with a specific reason so
/// the panel can show the right inline hint and preserve the input (SPEC §3.2, §9.6).
export function parseDecimalInput(text: string, decimals: number): ParseDecimalResult {
  requireDecimals(decimals);
  const trimmed = text.trim();

  if (trimmed.length === 0) return {ok: false, reason: "empty"};
  if (trimmed.includes(",")) return {ok: false, reason: "commaSeparator"};
  if (trimmed.includes("-")) return {ok: false, reason: "negative"};

  const dots = trimmed.split(".").length - 1;
  if (dots > 1) return {ok: false, reason: "multipleDots"};
  if (!/^[0-9]*\.?[0-9]*$/.test(trimmed)) return {ok: false, reason: "invalidCharacter"};

  const dot = trimmed.indexOf(".");
  const wholeText = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const fractionText = dot === -1 ? "" : trimmed.slice(dot + 1);
  // "." on its own carries no digit at all.
  if (wholeText.length === 0 && fractionText.length === 0) return {ok: false, reason: "invalidCharacter"};
  if (fractionText.length > decimals) return {ok: false, reason: "tooManyFractionDigits"};

  const whole = wholeText.length === 0 ? 0n : BigInt(wholeText);
  const fraction = fractionText.length === 0 ? 0n : BigInt(fractionText.padEnd(decimals, "0"));
  const raw = whole * 10n ** BigInt(decimals) + fraction;
  if (raw > MAX_UINT256) return {ok: false, reason: "aboveMaxUint256"};
  return {ok: true, raw};
}

/// Splits an exact decimal string into its integer and fraction parts, for formatters that group only the
/// integer part. The fraction excludes the separator and is `""` when there is none.
export function splitDecimalString(text: string): {sign: string; whole: string; fraction: string} {
  const sign = text.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? text : text.slice(1);
  const dot = unsigned.indexOf(".");
  if (dot === -1) return {sign, whole: unsigned, fraction: ""};
  return {sign, whole: unsigned.slice(0, dot), fraction: unsigned.slice(dot + 1)};
}

function requireDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 78) {
    throw new RangeError(`decimals must be an integer 0-78: ${decimals}`);
  }
}

function resolveFractionDigits(maxFractionDigits: number | undefined, decimals: number): number {
  if (maxFractionDigits === undefined) return decimals;
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0) {
    throw new RangeError(`maxFractionDigits must be a non-negative integer: ${maxFractionDigits}`);
  }
  return Math.min(maxFractionDigits, decimals);
}
