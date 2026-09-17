/// Share-display tests (SPEC §9.7: "never show '100%' unless exact and show '<0.01%' below the floor, with
/// full raw precision on expand"; SPEC §9.8: "Odds are current shares and can change until cutoff").

import assert from "node:assert/strict";
import test from "node:test";
import {formatShare, formatShareExact, SHARE_UNAVAILABLE} from "./percent.ts";

test("100% appears only when the share is exactly the whole round", () => {
  assert.strictEqual(formatShare(1n, 1n), "100%");
  assert.strictEqual(formatShare(10n ** 18n, 10n ** 18n), "100%");
  // 99.999% must not round up into a claim of the whole pot.
  assert.strictEqual(formatShare(99_999n, 100_000n), "99.99%");
  assert.strictEqual(formatShare(999_999_999n, 1_000_000_000n), "99.99%");
});

test("a positive share below one hundredth of a percent shows the floor marker", () => {
  assert.strictEqual(formatShare(1n, 100_000n), "<0.01%");
  assert.strictEqual(formatShare(1n, 10_001n), "<0.01%");
  assert.strictEqual(formatShare(1n, 10_000n), "0.01%", "exactly at the floor it is printable");
  assert.strictEqual(formatShare(1n, 10n ** 30n), "<0.01%");
});

test("zero and an empty round are distinguished", () => {
  assert.strictEqual(formatShare(0n, 100n), "0%");
  assert.strictEqual(formatShare(0n, 0n), SHARE_UNAVAILABLE);
  assert.strictEqual(formatShare(5n, 0n), SHARE_UNAVAILABLE);
  assert.strictEqual(SHARE_UNAVAILABLE, "—");
});

test("shares round down to two decimals, with trailing zeros trimmed", () => {
  assert.strictEqual(formatShare(1n, 2n), "50%");
  assert.strictEqual(formatShare(1n, 8n), "12.5%");
  assert.strictEqual(formatShare(1n, 3n), "33.33%", "33.333... rounds down");
  assert.strictEqual(formatShare(2n, 3n), "66.66%", "66.666... rounds down, never up to 66.67%");
  assert.strictEqual(formatShare(1n, 4n), "25%");
  assert.strictEqual(formatShare(7n, 10n), "70%");
  assert.strictEqual(formatShare(1234n, 10_000n), "12.34%");
});

test("the SPEC 5.2 worked example prints 10%, 20% and 70%", () => {
  assert.strictEqual(formatShare(100n, 1000n), "10%");
  assert.strictEqual(formatShare(200n, 1000n), "20%");
  assert.strictEqual(formatShare(700n, 1000n), "70%");
});

test("formatShareExact expands the same share without trimming", () => {
  assert.strictEqual(formatShareExact(1n, 3n, 6), "33.333333%");
  assert.strictEqual(formatShareExact(2n, 3n, 6), "66.666666%");
  assert.strictEqual(formatShareExact(1n, 2n, 4), "50.0000%");
  assert.strictEqual(formatShareExact(1n, 1n, 2), "100.00%");
  assert.strictEqual(formatShareExact(1n, 100_000n, 4), "0.0010%", "the share hidden behind '<0.01%'");
  assert.strictEqual(formatShareExact(1n, 3n, 0), "33%");
  assert.strictEqual(formatShareExact(1n, 0n, 4), SHARE_UNAVAILABLE);
});

test("exactness holds at uint256 scale", () => {
  const total = (1n << 256n) - 1n;
  assert.strictEqual(formatShare(total, total), "100%");
  assert.strictEqual(formatShare(total - 1n, total), "99.99%");
  assert.strictEqual(formatShare(1n, total), "<0.01%");
  assert.strictEqual(formatShare(total / 2n, total), "49.99%");
});

test("negative inputs and bad digit counts are rejected", () => {
  assert.throws(() => formatShare(-1n, 10n), RangeError);
  assert.throws(() => formatShare(1n, -10n), RangeError);
  assert.throws(() => formatShareExact(1n, 3n, -1), RangeError);
  assert.throws(() => formatShareExact(1n, 3n, 1.5), RangeError);
});

test("a numerator above the denominator marks a broken snapshot instead of printing 100%", () => {
  assert.strictEqual(formatShare(20_001n, 20_000n), ">100%");
  assert.strictEqual(formatShare(3n, 2n), ">100%");
});
