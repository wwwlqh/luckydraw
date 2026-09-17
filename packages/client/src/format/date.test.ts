/// Date and countdown tests (SPEC §6.1 "Expose dates in UTC and optionally local time, labeled explicitly",
/// SPEC §9.7 "show dates as '2026-10-01 00:00 UTC (08:00 your time)' with the IANA zone named").
///
/// Every case uses a fixed instant and an explicit IANA zone, so the assertions are exact strings and nothing
/// depends on the machine's own time zone or the moment the suite runs.

import assert from "node:assert/strict";
import test from "node:test";
import {formatCountdown, formatIanaZone, formatUtc, formatUtcWithLocal, zoneOffsetSeconds} from "./date.ts";

/// A UTC instant, as bigint seconds.
const at = (iso: string): bigint => BigInt(Math.floor(Date.parse(iso) / 1000));

const MONTHLY_CUTOFF = at("2026-10-01T00:00:00Z");

test("formatUtc is the fixed UTC layout", () => {
  assert.strictEqual(formatUtc(MONTHLY_CUTOFF), "2026-10-01 00:00 UTC");
  assert.strictEqual(formatUtc(0n), "1970-01-01 00:00 UTC");
  assert.strictEqual(formatUtc(at("2026-09-14T00:00:00Z")), "2026-09-14 00:00 UTC", "a weekly cutoff");
  assert.strictEqual(formatUtc(at("2100-02-28T23:59:00Z")), "2100-02-28 23:59 UTC");
});

test("the SPEC 9.7 example: the local time alone when the date agrees", () => {
  assert.strictEqual(
    formatUtcWithLocal(MONTHLY_CUTOFF, "Asia/Singapore"),
    "2026-10-01 00:00 UTC (08:00 your time)",
  );
});

test("the SPEC 9.7 example: the local date too when it differs", () => {
  assert.strictEqual(
    formatUtcWithLocal(MONTHLY_CUTOFF, "America/New_York"),
    "2026-10-01 00:00 UTC (2026-09-30 20:00 your time)",
  );
  // East of the date line the local date can be ahead instead of behind.
  assert.strictEqual(
    formatUtcWithLocal(at("2026-07-01T12:00:00Z"), "Pacific/Kiritimati"),
    "2026-07-01 12:00 UTC (2026-07-02 02:00 your time)",
  );
});

test("a UTC viewer sees the same clock twice, never a contradiction", () => {
  assert.strictEqual(formatUtcWithLocal(MONTHLY_CUTOFF, "UTC"), "2026-10-01 00:00 UTC (00:00 your time)");
});

test("half-hour zones and daylight saving are handled by the zone database, not by an offset guess", () => {
  assert.strictEqual(
    formatUtcWithLocal(MONTHLY_CUTOFF, "Asia/Kolkata"),
    "2026-10-01 00:00 UTC (05:30 your time)",
  );
  // Summer: New York is UTC-4.
  assert.strictEqual(
    formatUtcWithLocal(at("2026-07-01T12:00:00Z"), "America/New_York"),
    "2026-07-01 12:00 UTC (08:00 your time)",
  );
  // Winter: UTC-5, and the local date is the day before.
  assert.strictEqual(
    formatUtcWithLocal(at("2026-01-15T02:30:00Z"), "America/New_York"),
    "2026-01-15 02:30 UTC (2026-01-14 21:30 your time)",
  );
  // One minute before the 2026 US spring-forward transition (07:00 UTC).
  assert.strictEqual(
    formatUtcWithLocal(at("2026-03-08T06:59:00Z"), "America/New_York"),
    "2026-03-08 06:59 UTC (01:59 your time)",
  );
  assert.strictEqual(
    formatUtcWithLocal(at("2026-03-08T07:00:00Z"), "America/New_York"),
    "2026-03-08 07:00 UTC (03:00 your time)",
    "02:00 local never exists on that date",
  );
});

test("the locale argument never changes the fixed layout", () => {
  for (const locale of ["en-US", "de-DE", "ar-EG", "ja-JP"]) {
    assert.strictEqual(
      formatUtcWithLocal(MONTHLY_CUTOFF, "Asia/Singapore", locale),
      "2026-10-01 00:00 UTC (08:00 your time)",
      `locale ${locale}`,
    );
  }
});

test("formatIanaZone names the zone and its offset at that instant", () => {
  assert.strictEqual(formatIanaZone("Asia/Singapore", MONTHLY_CUTOFF), "Asia/Singapore (UTC+08:00)");
  assert.strictEqual(formatIanaZone("UTC", MONTHLY_CUTOFF), "UTC (UTC+00:00)");
  assert.strictEqual(formatIanaZone("Asia/Kolkata", MONTHLY_CUTOFF), "Asia/Kolkata (UTC+05:30)");
  assert.strictEqual(formatIanaZone("Pacific/Marquesas", MONTHLY_CUTOFF), "Pacific/Marquesas (UTC-09:30)");
  // The same zone, two offsets, because the offset is read at the instant.
  assert.strictEqual(
    formatIanaZone("America/New_York", at("2026-07-01T12:00:00Z")),
    "America/New_York (UTC-04:00)",
  );
  assert.strictEqual(
    formatIanaZone("America/New_York", at("2026-01-15T02:30:00Z")),
    "America/New_York (UTC-05:00)",
  );
});

test("zoneOffsetSeconds is the zone's offset, not the process zone's", () => {
  assert.strictEqual(zoneOffsetSeconds(MONTHLY_CUTOFF, "UTC"), 0);
  assert.strictEqual(zoneOffsetSeconds(MONTHLY_CUTOFF, "Asia/Singapore"), 8 * 3600);
  assert.strictEqual(zoneOffsetSeconds(MONTHLY_CUTOFF, "Asia/Kathmandu"), 5 * 3600 + 45 * 60);
  assert.strictEqual(zoneOffsetSeconds(at("2026-01-15T02:30:00Z"), "America/New_York"), -5 * 3600);
});

test("an unknown zone is rejected rather than silently falling back to UTC", () => {
  assert.throws(() => formatUtcWithLocal(MONTHLY_CUTOFF, "Mars/Olympus"), RangeError);
  assert.throws(() => formatIanaZone("Not/AZone", MONTHLY_CUTOFF), RangeError);
});

test("timestamps outside the displayable range are rejected", () => {
  assert.throws(() => formatUtc(-1n), RangeError);
  assert.throws(() => formatUtc(8_640_000_000_001n), RangeError);
  // The documented maximum and the first five-digit year render in the fixed layout, not in the expanded
  // `+YYYYYY` ISO form that a sliced `toISOString()` would leak.
  assert.strictEqual(formatUtc(8_640_000_000_000n), "275760-09-13 00:00 UTC");
  assert.strictEqual(formatUtc(253_402_300_800n), "10000-01-01 00:00 UTC");
  assert.strictEqual(formatUtcWithLocal(253_402_300_800n, "UTC"), "10000-01-01 00:00 UTC (00:00 your time)");
});

test("formatCountdown uses a fixed-width clock and an unpadded day count", () => {
  assert.strictEqual(formatCountdown(0n), "00:00:00");
  assert.strictEqual(formatCountdown(-5n), "00:00:00", "a passed cutoff never counts backwards");
  assert.strictEqual(formatCountdown(59n), "00:00:59");
  assert.strictEqual(formatCountdown(60n), "00:01:00");
  assert.strictEqual(formatCountdown(3600n), "01:00:00");
  assert.strictEqual(formatCountdown(11_045n), "03:04:05");
  assert.strictEqual(formatCountdown(86_399n), "23:59:59", "the last second before a day appears");
  assert.strictEqual(formatCountdown(86_400n), "1d 00:00:00");
  assert.strictEqual(formatCountdown(183_845n), "2d 03:04:05");
  assert.strictEqual(formatCountdown(8_640_000n), "100d 00:00:00");
});

test("a countdown to a real cutoff matches the difference of the two instants", () => {
  const now = at("2026-09-29T20:55:55Z");
  assert.strictEqual(formatCountdown(MONTHLY_CUTOFF - now), "1d 03:04:05");
  assert.strictEqual(formatUtc(MONTHLY_CUTOFF), "2026-10-01 00:00 UTC");
});
