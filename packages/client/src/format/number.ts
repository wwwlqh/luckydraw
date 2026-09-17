/// Grouped amount display with an explicit locale (SPEC §9.7: "Format numbers with `Intl.NumberFormat` and
/// an explicit locale").
///
/// `Intl.NumberFormat` is used for the *integer* part only, and it is handed a `bigint`, never a float: the
/// fraction digits come from the exact decimal string that `formatUnits` produced, so an 18-decimal amount
/// keeps every raw unit it is allowed to show. Nothing here converts a raw amount to `Number`.

import {formatUnits, type Rounding, splitDecimalString} from "./units.ts";

/// The locale every formatter defaults to. English is the only v1 language (SPEC §9.7), but the locale stays
/// explicit so no formatter ever silently follows the process or browser default.
export const DEFAULT_LOCALE = "en-US";

/// Options for `formatAmount`.
export interface FormatAmountOptions {
  /// Asset symbol appended after a space, e.g. `"BNB"`. Omitted when absent.
  readonly symbol?: string;
  /// Required: debits and fees round up, prizes and shares round down (SPEC §9.7).
  readonly rounding: Rounding;
  /// Fraction digits to keep; defaults to the asset's `decimals` (the exact value).
  readonly maxFractionDigits?: number;
  /// BCP 47 locale for grouping and the decimal separator.
  readonly locale?: string;
}

/// Formats a raw amount for display: grouped integer part, exact fraction, optional symbol.
///
/// ```text
/// formatAmount(1234567890000000000n, 18, { rounding: "down", maxFractionDigits: 4, symbol: "BNB" })
///   -> "1.2345 BNB"
/// ```
export function formatAmount(raw: bigint, decimals: number, options: FormatAmountOptions): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const exact = formatUnits(raw, decimals, {
    rounding: options.rounding,
    ...(options.maxFractionDigits === undefined ? {} : {maxFractionDigits: options.maxFractionDigits}),
  });
  const grouped = groupDecimalString(exact, locale);
  return options.symbol === undefined || options.symbol === "" ? grouped : `${grouped} ${options.symbol}`;
}

/// The exact value at full raw precision, for the "full raw precision on expand" rule (SPEC §9.7).
///
/// No rounding and no grouping: the string is the raw amount written as a decimal, so
/// `parseDecimalInput(formatAmountFull(raw, d), d)` returns the same `raw`. Trailing zeros are trimmed because
/// they carry no precision.
export function formatAmountFull(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals, {rounding: "down"});
}

/// Applies `Intl.NumberFormat` grouping to the integer part of an exact decimal string and joins it to the
/// untouched fraction with the locale's decimal separator.
///
/// The integer part is parsed as a `bigint` and formatted as a `bigint`, which `Intl.NumberFormat` renders
/// exactly at any magnitude; the fraction digits are copied verbatim.
///
/// The numbering system is pinned to `latn`, so the grouped integer part and the exact fraction are always the
/// same ASCII digits. Without it a locale whose default numbering system is not Latin (`ar-EG`, say) would
/// render the integer part in its own digits and the fraction in ASCII, producing a mixed-script amount that
/// no one can read back. The locale still chooses the grouping and decimal separators.
export function groupDecimalString(exact: string, locale: string = DEFAULT_LOCALE): string {
  const {sign, whole, fraction} = splitDecimalString(exact);
  const formatter = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
    numberingSystem: "latn",
  });
  const groupedWhole = formatter.format(BigInt(whole === "" ? "0" : whole));
  if (fraction === "") return `${sign}${groupedWhole}`;
  return `${sign}${groupedWhole}${decimalSeparator(locale)}${fraction}`;
}

/// The locale's decimal separator, read from `Intl` rather than assumed.
///
/// The probe value `1.1` is a literal, never a number derived from a raw amount, so no chain value is exposed
/// to floating point. The numbering system is pinned to `latn` for the same reason as in
/// `groupDecimalString`, which also means the separator reported here is the one that formatter will use.
export function decimalSeparator(locale: string = DEFAULT_LOCALE): string {
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    numberingSystem: "latn",
  }).formatToParts(1.1);
  return parts.find((part) => part.type === "decimal")?.value ?? ".";
}
