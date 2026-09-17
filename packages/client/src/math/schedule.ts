/// Fixed UTC round cutoffs and the civil-date algorithms behind them (SPEC §6.1, §6.2).
///
/// Mirrors `contracts/src/lib/Schedule.sol` and `spec_reference.py` (`civil_from_days`, `days_from_civil`,
/// `cutoff`). Every input and output is a bigint count of seconds or days since the Unix epoch; results that
/// do not fit in uint64 throw `MathError("Overflow")`, which is what the Solidity reports as `Panic(0x11)`.

import {
  DAYS_SHIFT,
  ERA_DAYS,
  MAX_UINT64,
  REQUEST_WINDOW,
  SECONDS_PER_DAY,
  SECONDS_PER_WEEK,
  WEEK_OFFSET,
} from "./constants.ts";
import {CADENCE, cadenceOf, type Kind} from "./localTypes.ts";
import {require_} from "./mathError.ts";

/// A proleptic Gregorian civil date.
export interface CivilDate {
  /// Year.
  readonly y: bigint;
  /// Month, 1-12.
  readonly m: bigint;
  /// Day of month, 1-31.
  readonly d: bigint;
}

/// Howard Hinnant's `civil_from_days`, unsigned form (SPEC §6.1, `Schedule.civilFromDays`,
/// `spec_reference.civil_from_days`).
///
/// `z` is days since 1970-01-01 (`floor(t / 86400)`) and must be non-negative; for `z >= 0` every
/// intermediate value is non-negative, so floor division reproduces the signed algorithm exactly.
export function civilFromDays(z: bigint): CivilDate {
  require_(z >= 0n, "InvalidInput", `days since epoch must be non-negative: ${z}`);
  const shifted = z + DAYS_SHIFT;
  const era = shifted / ERA_DAYS;
  const doe = shifted - era * ERA_DAYS; // [0, 146096]
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n; // [0, 399]
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n); // [0, 365]
  const mp = (5n * doy + 2n) / 153n; // [0, 11], March-based
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  return {y, m, d};
}

/// Howard Hinnant's `days_from_civil`, unsigned form (SPEC §6.1, `Schedule.daysFromCivil`,
/// `spec_reference.days_from_civil`).
///
/// Defined for dates on or after 1970-01-01; an earlier date underflows, which the Solidity reports as
/// `Panic(0x11)` and this function reports as `MathError("Overflow")`. The caller supplies a valid
/// `(y, m, d)`: an out-of-range month or day yields a normalised, not rejected, day count, exactly as the
/// Solidity and `spec_reference.days_from_civil` do (`daysFromCivil(2026, 0, 1)` is 2025-12-01). Only a
/// negative year is rejected outright, because Solidity takes unsigned arguments and bigint division would
/// otherwise truncate toward zero where the EVM cannot.
export function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  require_(
    year >= 0n && month >= 0n && day >= 0n,
    "InvalidInput",
    `invalid civil date ${year}-${month}-${day}`,
  );
  const y = year - (month <= 2n ? 1n : 0n);
  const era = y / 400n;
  const yoe = y - era * 400n; // [0, 399]
  const doy = (153n * (month > 2n ? month - 3n : month + 9n) + 2n) / 5n + day - 1n; // [0, 365]
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy; // [0, 146096]
  const days = era * ERA_DAYS + doe - DAYS_SHIFT;
  require_(days >= 0n, "Overflow", `civil date ${year}-${month}-${day} is before 1970-01-01`);
  return days;
}

/// The round cutoff strictly after `t` for a sequence kind (SPEC §6.1, `Schedule.nextCutoff`,
/// `spec_reference.cutoff`).
///
/// The kind's cadence (`cadenceOf`) picks the boundary:
/// - `Day`: `(t/86400 + 1) * 86400`, the next UTC midnight.
/// - `Week`: `((t + 259200)/604800 + 1) * 604800 - 259200`, the next Monday 00:00 UTC.
/// - `Month`: 00:00 UTC on the first day of the next calendar month.
///
/// The result is always a multiple of 86,400, strictly greater than `t`, and idempotent in the sense that
/// `nextCutoff(result - 1) === result`. A result above uint64 throws `MathError("Overflow")`, matching the
/// contract's `Panic(0x11)` (SPEC §8.1: overflow has no custom error).
export function nextCutoff(t: bigint, kind: Kind): bigint {
  require_(t >= 0n, "InvalidInput", `timestamp must be non-negative: ${t}`);

  let cutoff: bigint;
  const cadence = cadenceOf(kind);
  if (cadence === CADENCE.Day) {
    cutoff = (t / SECONDS_PER_DAY + 1n) * SECONDS_PER_DAY;
  } else if (cadence === CADENCE.Week) {
    cutoff = ((t + WEEK_OFFSET) / SECONDS_PER_WEEK + 1n) * SECONDS_PER_WEEK - WEEK_OFFSET;
  } else if (cadence === CADENCE.Month) {
    const {y, m} = civilFromDays(t / SECONDS_PER_DAY);
    const nextYear = m === 12n ? y + 1n : y;
    const nextMonth = m === 12n ? 1n : m + 1n;
    cutoff = daysFromCivil(nextYear, nextMonth, 1n) * SECONDS_PER_DAY;
  } else {
    // Unreachable while `Cadence` covers every `Kind`; kept so a future cadence cannot silently fall
    // through to a zero cutoff, exactly as `Schedule.nextCutoff` reverts `InvalidKind`.
    throw new Error(`unknown round cadence: ${String(cadence)}`);
  }

  require_(cutoff <= MAX_UINT64, "Overflow", `cutoff ${cutoff} does not fit in uint64`);
  return cutoff;
}

/// `requestDeadline = closedAt + 86400` (SPEC §6.2, `REQUEST_WINDOW` in Types.sol).
///
/// Set by whichever transaction closes a round, including the Void and Refunding branches where no request is
/// possible, so that D8 holds uniformly.
export function requestDeadline(closedAt: bigint): bigint {
  require_(
    closedAt >= 0n && closedAt <= MAX_UINT64,
    "InvalidInput",
    `closedAt out of uint64 range: ${closedAt}`,
  );
  const deadline = closedAt + REQUEST_WINDOW;
  require_(deadline <= MAX_UINT64, "Overflow", `requestDeadline ${deadline} does not fit in uint64`);
  return deadline;
}
