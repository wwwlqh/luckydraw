/// Independent calendar tests (SPEC §6.1, §11.2 "civil-date algorithms against a calendar oracle" and the
/// week/month boundary matrix).
///
/// The oracle is the JavaScript `Date`/`Date.UTC` calendar, which knows nothing about Howard Hinnant's
/// algorithms: `civilFromDays` is compared against `Date`'s own UTC fields, and each cutoff against a cutoff
/// derived by stepping the calendar, for every day from 1970-01-01 to 2100-12-31.

import assert from "node:assert/strict";
import test from "node:test";
import {MAX_UINT64} from "./constants.ts";
import {CADENCE, cadenceOf, KIND, type Kind} from "./localTypes.ts";
import {MathError} from "./mathError.ts";
import {civilFromDays, daysFromCivil, nextCutoff, requestDeadline} from "./schedule.ts";

const DAY = 86_400;
/// Days from 1970-01-01 to 2101-01-01, exclusive: the whole range `spec_reference.py` checks.
const LAST_DAY = Math.floor(Date.UTC(2101, 0, 1) / 1000 / DAY);

/// Independent oracle: the next UTC midnight strictly after `t` that satisfies the kind's calendar rule.
/// Uses only `Date`'s UTC accessors, never the arithmetic under test.
function calendarReference(t: number, kind: Kind): number {
  const instant = new Date(t * 1000);
  const nextMidnight =
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1) / 1000;
  const cadence = cadenceOf(kind);
  if (cadence === CADENCE.Day) return nextMidnight;
  if (cadence === CADENCE.Week) {
    // 0 = Sunday, 1 = Monday. Advance to the first Monday at or after the next midnight.
    const weekday = new Date(nextMidnight * 1000).getUTCDay();
    return nextMidnight + ((1 - weekday + 7) % 7) * DAY;
  }
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1) / 1000;
}

test("civilFromDays matches the Date calendar and round-trips for every day 1970-2100", () => {
  for (let z = 0; z < LAST_DAY; z += 1) {
    const date = new Date(z * DAY * 1000);
    const civil = civilFromDays(BigInt(z));
    if (
      civil.y !== BigInt(date.getUTCFullYear()) ||
      civil.m !== BigInt(date.getUTCMonth() + 1) ||
      civil.d !== BigInt(date.getUTCDate())
    ) {
      assert.fail(
        `civilFromDays(${z}) = ${civil.y}-${civil.m}-${civil.d}, calendar says ${date.toISOString()}`,
      );
    }
    const back = daysFromCivil(civil.y, civil.m, civil.d);
    if (back !== BigInt(z)) assert.fail(`daysFromCivil round trip failed at day ${z}: ${back}`);
  }
});

test("all seven kinds' cutoffs match the calendar oracle at the start and end of every day 1970-2100", () => {
  const kinds: Kind[] = [
    KIND.Day100,
    KIND.Day1k,
    KIND.Day10k,
    KIND.Week1k,
    KIND.Week10k,
    KIND.Week100k,
    KIND.Month100k,
  ];
  for (let z = 0; z < LAST_DAY; z += 1) {
    for (const t of [z * DAY, z * DAY + DAY - 1]) {
      for (const kind of kinds) {
        const got = nextCutoff(BigInt(t), kind);
        const expected = BigInt(calendarReference(t, kind));
        if (got !== expected)
          assert.fail(`nextCutoff(${t}, kind ${kind}) = ${got}, calendar says ${expected}`);
      }
    }
  }
});

test("cutoff invariants hold at every documented edge", () => {
  const edges: number[] = [0, 1, DAY - 1, DAY, 3 * DAY, 4 * DAY, 7 * DAY];
  for (const year of [1970, 1999, 2000, 2024, 2026, 2028, 2099, 2100]) {
    for (let month = 0; month < 12; month += 1) {
      const start = Date.UTC(year, month, 1) / 1000;
      edges.push(Math.max(0, start - 1), start, start + 1, start + DAY - 1);
    }
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    for (const [month, day] of [
      [1, 28],
      [1, leap ? 29 : 28],
      [8, 11],
      [11, 31],
    ] as const) {
      const ts = Date.UTC(year, month, day) / 1000;
      edges.push(Math.max(0, ts - 1), ts, ts + 1, ts + DAY - 1);
    }
  }

  for (const t of edges) {
    for (const kind of [
      KIND.Day100,
      KIND.Day1k,
      KIND.Day10k,
      KIND.Week1k,
      KIND.Week10k,
      KIND.Week100k,
      KIND.Month100k,
    ] as Kind[]) {
      const end = nextCutoff(BigInt(t), kind);
      assert.strictEqual(end, BigInt(calendarReference(t, kind)), `calendar oracle at ${t}`);
      assert.ok(end > BigInt(t), "a cutoff is strictly in the future");
      assert.strictEqual(nextCutoff(end - 1n, kind), end, "the last second of the window still closes at it");
      assert.ok(nextCutoff(end, kind) > end, "a round opened at the exact cutoff gets the next one");
      assert.strictEqual(end % BigInt(DAY), 0n, "every cutoff is UTC midnight");
    }
  }
});

test("named calendar cases from SPEC 6.1 and 11.2", () => {
  const at = (iso: string): bigint => BigInt(Math.floor(Date.parse(iso) / 1000));

  assert.strictEqual(
    nextCutoff(at("2024-02-15T12:00:00Z"), KIND.Month100k),
    at("2024-03-01T00:00:00Z"),
    "leap February month end",
  );
  assert.strictEqual(
    nextCutoff(at("2026-12-31T23:59:59Z"), KIND.Month100k),
    at("2027-01-01T00:00:00Z"),
    "year end",
  );
  assert.strictEqual(
    nextCutoff(at("2100-02-28T00:00:00Z"), KIND.Month100k),
    at("2100-03-01T00:00:00Z"),
    "2100 is not a leap year",
  );
  assert.strictEqual(
    nextCutoff(at("2024-02-28T00:00:00Z"), KIND.Day100),
    at("2024-02-29T00:00:00Z"),
    "2024 is a leap year, so the day after 02-28 is 02-29",
  );
  assert.strictEqual(
    nextCutoff(at("2026-09-11T00:00:00Z"), KIND.Week1k),
    at("2026-09-14T00:00:00Z"),
    "next Monday example",
  );
  // Monday rollover: a round created at 00:00 Monday closes the following Monday, not the same instant.
  assert.strictEqual(
    nextCutoff(at("2026-09-14T00:00:00Z"), KIND.Week1k),
    at("2026-09-21T00:00:00Z"),
    "a round opened exactly at a Monday cutoff runs a full week",
  );
  assert.strictEqual(
    nextCutoff(at("2026-09-13T23:59:59Z"), KIND.Week1k),
    at("2026-09-14T00:00:00Z"),
    "one second before the Monday cutoff",
  );
  // 1970-01-01 was a Thursday, so the first weekly cutoff is 1970-01-05.
  assert.strictEqual(nextCutoff(0n, KIND.Week1k), at("1970-01-05T00:00:00Z"));
  assert.strictEqual(nextCutoff(0n, KIND.Day100), at("1970-01-02T00:00:00Z"));
  assert.strictEqual(nextCutoff(0n, KIND.Month100k), at("1970-02-01T00:00:00Z"));
});

test("a cutoff that does not fit in uint64 throws, mirroring the contract's Panic", () => {
  // The daily cutoff of the last representable second overflows uint64.
  const tooLate = MAX_UINT64;
  assert.throws(
    () => nextCutoff(tooLate, KIND.Day100),
    (error: unknown) => error instanceof MathError && error.code === "Overflow",
  );
  assert.throws(() => nextCutoff(-1n, KIND.Day100), MathError);
  assert.throws(() => nextCutoff(0n, 7 as unknown as Kind), Error);
});

test("daysFromCivil normalises an out-of-range month or day, as the Solidity and Python do", () => {
  // Review regression: the TS used to reject month 0 / day 0 while `Schedule.daysFromCivil` and
  // `spec_reference.days_from_civil` normalise them. Cross-checked against Date.UTC.
  const day = (y: number, m: number, d: number): bigint => BigInt(Date.UTC(y, m - 1, d) / 1000 / 86_400);
  assert.strictEqual(daysFromCivil(2026n, 0n, 1n), day(2025, 12, 1), "month 0 is the previous December");
  assert.strictEqual(daysFromCivil(2026n, 13n, 1n), day(2027, 1, 1), "month 13 is the next January");
  assert.strictEqual(daysFromCivil(2026n, 1n, 32n), day(2026, 2, 1), "day 32 of January is 1 February");
  assert.strictEqual(daysFromCivil(2026n, 3n, 0n), day(2026, 2, 28), "day 0 of March is the end of February");
});

test("daysFromCivil rejects dates before the epoch", () => {
  assert.strictEqual(daysFromCivil(1970n, 1n, 1n), 0n);
  assert.throws(
    () => daysFromCivil(1969n, 12n, 31n),
    (error: unknown) => error instanceof MathError && error.code === "Overflow",
  );
  assert.throws(() => civilFromDays(-1n), MathError);
});

test("requestDeadline is closedAt + 24 hours and stays in uint64", () => {
  assert.strictEqual(requestDeadline(0n), 86_400n);
  assert.strictEqual(requestDeadline(1_790_812_800n), 1_790_812_800n + 86_400n);
  assert.throws(
    () => requestDeadline(MAX_UINT64),
    (error: unknown) => error instanceof MathError && error.code === "Overflow",
  );
});

test("the 2400 era boundary: a leap day in a century year divisible by 400", () => {
  assert.deepStrictEqual(civilFromDays(157_113n), {y: 2400n, m: 2n, d: 29n});
  assert.strictEqual(daysFromCivil(2400n, 2n, 29n), 157_113n);
  assert.strictEqual(nextCutoff(13_574_563_200n, KIND.Month100k), 13_574_649_600n);
});
