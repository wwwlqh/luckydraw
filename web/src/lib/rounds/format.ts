// Display helpers for these pages (SPEC §9.7).
//
// Every one of them is a thin wrapper over `@luckydraw/client`'s `format*`: nothing here does arithmetic on
// an amount, and no component formats money any other way. The two rules the wrappers exist to enforce are
// the ones that are easy to get wrong at a call site: the rounding direction is explicit and never defaulted
// (debits and fees up, prizes and shares down), and the locale and time zone are always passed in.

import {
  DEFAULT_LOCALE,
  formatAmount,
  formatAmountFull,
  formatIanaZone,
  formatShare,
  formatUtc,
  formatUtcWithLocal,
  groupDecimalString,
} from "@luckydraw/client";

export {DEFAULT_LOCALE, formatAmountFull, formatShare, formatUtc};

/** The viewer's IANA zone, read once. `Intl` resolves it; nothing else in the app reads a browser default. */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** A debit, a fee or any amount the user pays: rounded up, so the figure is never understated (§9.7). */
export function debit(raw: bigint, decimals: bigint | number, symbol?: string): string {
  return formatAmount(raw, Number(decimals), {
    rounding: "up",
    ...(symbol === undefined ? {} : {symbol}),
    locale: DEFAULT_LOCALE,
  });
}

/** A prize, a pot or a balance: rounded down, so the figure is never overstated (§9.7). */
export function credit(raw: bigint, decimals: bigint | number, symbol?: string): string {
  return formatAmount(raw, Number(decimals), {
    rounding: "down",
    ...(symbol === undefined ? {} : {symbol}),
    locale: DEFAULT_LOCALE,
  });
}

/** A whole-USD reference value, grouped. Callers prefix it with `≈` through the string catalog. */
export function usdWholeText(usd: bigint): string {
  return groupDecimalString(usd.toString(), DEFAULT_LOCALE);
}

/** USD cents as a grouped two-decimal string, for a network fee too small to show in whole USD. */
export function usdCentsText(cents: bigint): string {
  const whole = cents / 100n;
  const rest = (cents % 100n).toString().padStart(2, "0");
  return groupDecimalString(`${whole}.${rest}`, DEFAULT_LOCALE);
}

/** "2026-10-01 00:00 UTC (08:00 your time)" (§9.7). */
export function cutoffText(tsSeconds: bigint, zone: string = viewerZone()): string {
  return formatUtcWithLocal(tsSeconds, zone, DEFAULT_LOCALE);
}

/** "Asia/Singapore (UTC+08:00)": the zone is always named, never just an offset (§9.7). */
export function zoneText(tsSeconds: bigint, zone: string = viewerZone()): string {
  return formatIanaZone(zone, tsSeconds);
}
