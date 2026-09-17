/// UTC-first date and countdown display (SPEC §6.1 "Expose dates in UTC and optionally local time, labeled
/// explicitly", SPEC §9.7 "show dates as '2026-10-01 00:00 UTC (08:00 your time)' with the IANA zone named").
///
/// Every cutoff in this product is a UTC instant, so UTC is always the primary rendering and the viewer's
/// local time is the parenthetical. The viewer's zone is always an explicit IANA identifier the caller passes
/// in: nothing here reads the process or browser default zone, so a server-rendered page and a browser render
/// the same string.
///
/// Timestamps are bigint seconds. They are converted to a `Number` of milliseconds only after a range check
/// that keeps them well inside `Number.MAX_SAFE_INTEGER`, and only to drive `Date`/`Intl`; no chain amount is
/// ever converted.

import {DEFAULT_LOCALE} from "./number.ts";

/// Largest timestamp `Date` can represent, in seconds (8.64e15 ms).
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000n;

/// Wall-clock fields of an instant in some zone.
interface WallClock {
  readonly date: string;
  readonly time: string;
}

/// `"2026-10-01 00:00 UTC"` (SPEC §9.7).
export function formatUtc(tsSeconds: bigint): string {
  const {date, time} = utcWallClock(tsSeconds);
  return `${date} ${time} UTC`;
}

/// `"2026-10-01 00:00 UTC (08:00 your time)"`, or `"2026-10-01 00:00 UTC (2026-09-30 20:00 your time)"` when
/// the viewer's local date differs from the UTC date (SPEC §9.7).
///
/// The local date is repeated only when it differs, so the common case stays short while a viewer west of UTC
/// is never misled about which day a cutoff falls on.
///
/// `timeZone` is an IANA identifier such as `"Asia/Singapore"`; an unknown identifier throws `RangeError` from
/// `Intl`. `locale` is accepted so no call site relies on the process default; the layout SPEC §9.7 fixes is
/// ASCII `YYYY-MM-DD HH:MM` in every locale, so it currently changes nothing in the output.
export function formatUtcWithLocal(
  tsSeconds: bigint,
  timeZone: string,
  locale: string = DEFAULT_LOCALE,
): string {
  void locale;
  const utc = utcWallClock(tsSeconds);
  const local = zoneWallClock(tsSeconds, timeZone);
  const suffix =
    local.date === utc.date ? `${local.time} your time` : `${local.date} ${local.time} your time`;
  return `${utc.date} ${utc.time} UTC (${suffix})`;
}

/// Names the viewer's zone for the label SPEC §9.7 requires: `"Asia/Singapore (UTC+08:00)"`.
///
/// The offset is the zone's offset *at that instant*, so a DST zone is labelled correctly on both sides of a
/// transition (`"America/New_York (UTC-04:00)"` in July, `"(UTC-05:00)"` in January). The IANA identifier is
/// always shown, because an offset alone does not identify a zone.
export function formatIanaZone(timeZone: string, tsSeconds: bigint): string {
  const offsetSeconds = zoneOffsetSeconds(tsSeconds, timeZone);
  const sign = offsetSeconds < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetSeconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  return `${timeZone} (UTC${sign}${pad2(hours)}:${pad2(minutes)})`;
}

/// `"2d 03:04:05"` when at least a day remains, otherwise `"03:04:05"`; `"00:00:00"` at or past zero.
///
/// The hours/minutes/seconds block is always fixed-width so a 1 Hz ticker never reflows the layout
/// (SPEC §10.1 drives every countdown from one ticker; SPEC §9.7 announces it only at thresholds). Days are
/// not padded: `"2d"`, `"10d"`, `"400d"`.
export function formatCountdown(remainingSeconds: bigint): string {
  const remaining = remainingSeconds > 0n ? remainingSeconds : 0n;
  const days = remaining / 86_400n;
  const hours = (remaining % 86_400n) / 3_600n;
  const minutes = (remaining % 3_600n) / 60n;
  const seconds = remaining % 60n;
  const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return days > 0n ? `${days}d ${clock}` : clock;
}

/// The zone's UTC offset at an instant, in seconds (positive east of Greenwich).
///
/// Derived by reading the zone's wall clock for the instant and subtracting the UTC instant, which works for
/// every zone and every DST rule without a table.
export function zoneOffsetSeconds(tsSeconds: bigint, timeZone: string): number {
  const ms = toMilliseconds(tsSeconds);
  const parts = zoneParts(new Date(ms), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - ms) / 1000);
}

function utcWallClock(tsSeconds: bigint): WallClock {
  // Not `toISOString().slice(...)`: years outside 0001-9999 use the expanded `±YYYYYY-MM-DD` form, which is
  // two characters longer and shifts every fixed offset. The UTC getters are exact at any supported year and
  // produce the same zero-padded shape `zoneWallClock` does, so the date comparison stays meaningful.
  const at = new Date(toMilliseconds(tsSeconds));
  const year = at.getUTCFullYear().toString().padStart(4, "0");
  return {
    date: `${year}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`,
    time: `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`,
  };
}

function zoneWallClock(tsSeconds: bigint, timeZone: string): WallClock {
  const parts = zoneParts(new Date(toMilliseconds(tsSeconds)), timeZone);
  return {
    date: `${parts.year.toString().padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
  };
}

interface ZoneParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/// Wall-clock fields of an instant in `timeZone`.
///
/// The internal formatter is pinned to `en-US` with `hourCycle: "h23"` so the extracted digits are ASCII and
/// midnight is `00`, never `24` or a localized numbering system. The caller's display locale never reaches
/// this function, because SPEC §9.7's layout is fixed.
function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") fields[part.type] = Number.parseInt(part.value, 10);
  }
  const year = fields.year;
  const month = fields.month;
  const day = fields.day;
  const hour = fields.hour;
  const minute = fields.minute;
  const second = fields.second;
  /* c8 ignore next 3 */
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new RangeError(`time zone ${timeZone} produced no wall-clock parts`);
  }
  return {year, month, day, hour, minute, second};
}

function toMilliseconds(tsSeconds: bigint): number {
  if (tsSeconds < 0n || tsSeconds > MAX_TIMESTAMP_SECONDS) {
    throw new RangeError(`timestamp out of displayable range: ${tsSeconds}`);
  }
  return Number(tsSeconds) * 1000;
}

function pad2(value: number | bigint): string {
  return value.toString().padStart(2, "0");
}
