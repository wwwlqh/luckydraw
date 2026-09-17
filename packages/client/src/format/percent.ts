/// Ownership-share display (SPEC §9.7: shares round down, never show "100%" unless exact, show "<0.01%"
/// below the floor, full precision on expand).
///
/// A share is the exact rational `numerator / denominator` (`grossByUser / grossTotal`, SPEC §5.1). It is
/// never turned into a float: the percentage is computed with bigint division, which is what makes
/// "99.999% prints as 99.99%, not 100%" exact rather than a rounding accident.

/// Shown when a share has no denominator yet (an empty round): there is no share to state.
export const SHARE_UNAVAILABLE = "—";

/// Hundredths of a percent kept by `formatShare`, i.e. two decimal places.
const PERCENT_SCALE = 10_000n;

/// Formats an ownership share, rounded down to two decimals (SPEC §9.7).
///
/// - denominator 0 -> `SHARE_UNAVAILABLE` (`"—"`), never `"0%"`: no entry exists to own a share of.
/// - numerator 0 -> `"0%"`.
/// - numerator === denominator -> `"100%"`; any smaller share prints below 100 (99.999% -> `"99.99%"`).
/// - positive but below one hundredth of a percent -> `"<0.01%"`.
/// - otherwise the floored percentage with trailing zeros trimmed: `"50%"`, `"12.5%"`, `"12.34%"`.
export function formatShare(numerator: bigint, denominator: bigint): string {
  requireNonNegative(numerator, "numerator");
  requireNonNegative(denominator, "denominator");

  if (denominator === 0n) return SHARE_UNAVAILABLE;
  if (numerator === 0n) return "0%";
  if (numerator === denominator) return "100%";
  // A numerator above the denominator cannot come from a round snapshot; it marks a broken snapshot and must
  // never be flattened into an exact "100%" (SPEC §9.7: only equality is exact).
  if (numerator > denominator) return ">100%";

  // Hundredths of a percent, floored: floor(n * 10000 / d).
  const hundredths = (numerator * PERCENT_SCALE) / denominator;
  if (hundredths === 0n) return "<0.01%";

  const whole = hundredths / 100n;
  const fraction = hundredths % 100n;
  if (fraction === 0n) return `${whole}%`;
  const digits = fraction.toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}.${digits}%`;
}

/// The same share at an arbitrary number of decimals, for the expanded view (SPEC §9.7 "full raw precision on
/// expand"). Always rounded down, always exactly `fractionDigits` digits, no trimming, so the expansion of
/// `formatShare` reads as a refinement of it: `formatShareExact(1n, 3n, 6)` is `"33.333333%"`.
export function formatShareExact(numerator: bigint, denominator: bigint, fractionDigits: number): string {
  requireNonNegative(numerator, "numerator");
  requireNonNegative(denominator, "denominator");
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 78) {
    throw new RangeError(`fractionDigits must be an integer 0-78: ${fractionDigits}`);
  }
  if (denominator === 0n) return SHARE_UNAVAILABLE;

  const scale = 10n ** BigInt(fractionDigits);
  const scaled = (numerator * 100n * scale) / denominator;
  const whole = scaled / scale;
  if (fractionDigits === 0) return `${whole}%`;
  const fraction = (scaled % scale).toString().padStart(fractionDigits, "0");
  return `${whole}.${fraction}%`;
}

function requireNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new RangeError(`${label} must not be negative: ${value}`);
}
