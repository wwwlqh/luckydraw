/// Grouped-amount tests (SPEC §9.7: "Format numbers with `Intl.NumberFormat` and an explicit locale").
///
/// The point of these is that grouping never costs precision: the integer part goes through `Intl` as a
/// `bigint` and the fraction digits are copied from the exact decimal string, so a uint256-scale amount
/// formats without a float anywhere in the path.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCALE,
  decimalSeparator,
  formatAmount,
  formatAmountFull,
  groupDecimalString,
} from "./number.ts";

const WEI = 10n ** 18n;

test("formatAmount groups the integer part and keeps the exact fraction", () => {
  assert.strictEqual(
    formatAmount(1_234_567_890_000_000_000n, 18, {rounding: "down", maxFractionDigits: 4}),
    "1.2345",
  );
  assert.strictEqual(
    formatAmount(1_234_567_890_000_000_000_000n, 18, {rounding: "down", maxFractionDigits: 2, symbol: "BNB"}),
    "1,234.56 BNB",
  );
  assert.strictEqual(formatAmount(1_234_567n, 0, {rounding: "up"}), "1,234,567");
  assert.strictEqual(formatAmount(0n, 18, {rounding: "up"}), "0");
  assert.strictEqual(formatAmount(0n, 18, {rounding: "up", symbol: "BNB"}), "0 BNB");
  assert.strictEqual(
    formatAmount(WEI, 18, {rounding: "down", symbol: ""}),
    "1",
    "an empty symbol adds nothing",
  );
});

test("formatAmount rounds debits up and prizes down, as SPEC 9.7 requires of the caller", () => {
  const dust = 1_666_666_666_666_667n; // 0.001666666666666667 BNB
  assert.strictEqual(formatAmount(dust, 18, {rounding: "up", maxFractionDigits: 4}), "0.0017");
  assert.strictEqual(formatAmount(dust, 18, {rounding: "down", maxFractionDigits: 4}), "0.0016");
});

test("the locale is explicit and changes both separators", () => {
  const raw = 1_234_567_890_000_000_000_000n;
  assert.strictEqual(
    formatAmount(raw, 18, {rounding: "down", maxFractionDigits: 2, locale: "en-US"}),
    "1,234.56",
  );
  assert.strictEqual(
    formatAmount(raw, 18, {rounding: "down", maxFractionDigits: 2, locale: "de-DE"}),
    "1.234,56",
  );
  assert.strictEqual(DEFAULT_LOCALE, "en-US");
  assert.strictEqual(decimalSeparator("en-US"), ".");
  assert.strictEqual(decimalSeparator("de-DE"), ",");
  assert.strictEqual(decimalSeparator(), ".", "the default locale is used when none is passed");
});

test("digits stay ASCII even in a locale whose default numbering system is not Latin", () => {
  // Without a pinned numbering system the grouped integer part and the exact fraction would be written in two
  // different scripts in the same amount.
  const text = formatAmount(1_234_560_000_000_000_000_000n, 18, {
    rounding: "down",
    maxFractionDigits: 2,
    locale: "ar-EG",
  });
  assert.match(text, /^[0-9]/, "the amount starts with an ASCII digit");
  assert.strictEqual(text.replace(/[^0-9]/g, ""), "123456");
});

test("a uint256-scale amount groups without losing a digit", () => {
  const huge = (1n << 256n) - 1n;
  const text = formatAmount(huge, 18, {rounding: "down", maxFractionDigits: 2});
  assert.strictEqual(
    text,
    "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.58",
  );
  // Every digit of the integer part survives: 60 digits, grouped into 20 groups of three.
  assert.strictEqual(text.split(".")[0]?.replace(/,/g, "").length, 60);
});

test("formatAmountFull is the exact value, and round-trips", () => {
  assert.strictEqual(formatAmountFull(1_666_666_666_666_667n, 18), "0.001666666666666667");
  assert.strictEqual(formatAmountFull(WEI, 18), "1");
  assert.strictEqual(formatAmountFull(1n, 18), "0.000000000000000001");
  assert.strictEqual(
    formatAmountFull(1_234_567n, 0),
    "1234567",
    "no grouping: this is the expanded exact value",
  );
});

test("groupDecimalString handles signs, empty integer parts and long fractions", () => {
  assert.strictEqual(groupDecimalString("1234.56"), "1,234.56");
  assert.strictEqual(groupDecimalString("-1234.5"), "-1,234.5");
  assert.strictEqual(groupDecimalString("0.000000000000000001"), "0.000000000000000001");
  assert.strictEqual(groupDecimalString("999"), "999");
});
