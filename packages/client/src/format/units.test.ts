/// Exact unit conversion tests (SPEC §9.7: "displays round debits and fees up and prizes and shares down",
/// "numeric input accepts '.' as the only decimal separator", "full raw precision on expand").

import assert from "node:assert/strict";
import test from "node:test";
import {formatUnits, parseDecimalInput, splitDecimalString} from "./units.ts";

const WEI = 10n ** 18n;

test("formatUnits prints the exact value when no digits are dropped", () => {
  assert.strictEqual(formatUnits(0n, 18, {rounding: "down"}), "0");
  assert.strictEqual(formatUnits(WEI, 18, {rounding: "down"}), "1");
  assert.strictEqual(formatUnits(1n, 18, {rounding: "down"}), "0.000000000000000001");
  assert.strictEqual(formatUnits(1_666_666_666_666_667n, 18, {rounding: "down"}), "0.001666666666666667");
  assert.strictEqual(formatUnits(1_500_000_000_000_000_000n, 18, {rounding: "down"}), "1.5");
  assert.strictEqual(formatUnits(123n, 0, {rounding: "down"}), "123", "a 0-decimal asset has no fraction");
  assert.strictEqual(formatUnits(12_345n, 2, {rounding: "down"}), "123.45");
});

test("formatUnits rounds the dropped digits in the direction the caller asked for", () => {
  const raw = 1_666_666_666_666_667n; // 0.001666666666666667
  assert.strictEqual(formatUnits(raw, 18, {maxFractionDigits: 6, rounding: "down"}), "0.001666");
  assert.strictEqual(formatUnits(raw, 18, {maxFractionDigits: 6, rounding: "up"}), "0.001667");
  assert.strictEqual(formatUnits(raw, 18, {maxFractionDigits: 0, rounding: "down"}), "0");
  assert.strictEqual(
    formatUnits(raw, 18, {maxFractionDigits: 0, rounding: "up"}),
    "1",
    "a dust debit still costs 1",
  );
  // Rounding up only moves when something was actually dropped.
  assert.strictEqual(formatUnits(WEI, 18, {maxFractionDigits: 2, rounding: "up"}), "1");
  assert.strictEqual(formatUnits(WEI + 1n, 18, {maxFractionDigits: 2, rounding: "up"}), "1.01");
  assert.strictEqual(formatUnits(WEI + 1n, 18, {maxFractionDigits: 2, rounding: "down"}), "1");
});

test("formatUnits keeps full precision for a uint256-scale amount", () => {
  const huge = (1n << 256n) - 1n;
  const text = formatUnits(huge, 18, {rounding: "down"});
  assert.strictEqual(text, "115792089237316195423570985008687907853269984665640564039457.584007913129639935");
  const parsed = parseDecimalInput(text, 18);
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.raw, huge, "and the string round-trips back to the same raw value");
});

test("maxFractionDigits above the asset's decimals is the exact value, not padding", () => {
  assert.strictEqual(formatUnits(12_345n, 2, {maxFractionDigits: 9, rounding: "down"}), "123.45");
  assert.strictEqual(formatUnits(5n, 0, {maxFractionDigits: 9, rounding: "up"}), "5");
});

test("a negative raw value formats as a signed magnitude, and never as -0", () => {
  assert.strictEqual(formatUnits(-1_500_000_000_000_000_000n, 18, {rounding: "down"}), "-1.5");
  assert.strictEqual(formatUnits(-1n, 18, {maxFractionDigits: 2, rounding: "down"}), "0");
  assert.strictEqual(formatUnits(-1n, 18, {maxFractionDigits: 2, rounding: "up"}), "-0.01", "away from zero");
});

test("formatUnits validates its digit counts", () => {
  assert.throws(() => formatUnits(1n, -1, {rounding: "down"}), RangeError);
  assert.throws(() => formatUnits(1n, 1.5, {rounding: "down"}), RangeError);
  assert.throws(() => formatUnits(1n, 79, {rounding: "down"}), RangeError);
  assert.throws(() => formatUnits(1n, 18, {maxFractionDigits: -1, rounding: "down"}), RangeError);
});

test("parseDecimalInput accepts the forms the entry field allows", () => {
  const cases: [text: string, decimals: number, raw: bigint][] = [
    ["1", 18, WEI],
    ["1.5", 18, 1_500_000_000_000_000_000n],
    ["0.000000000000000001", 18, 1n],
    [".5", 18, 500_000_000_000_000_000n],
    ["5.", 18, 5n * WEI],
    ["  2.25  ", 2, 225n],
    ["0", 18, 0n],
    ["0.0", 18, 0n],
    ["000123", 0, 123n],
    [
      "115792089237316195423570985008687907853269984665640564039457.584007913129639935",
      18,
      (1n << 256n) - 1n,
    ],
  ];
  for (const [text, decimals, raw] of cases) {
    const result = parseDecimalInput(text, decimals);
    assert.ok(result.ok, `expected "${text}" to parse`);
    assert.strictEqual(result.raw, raw, `"${text}"`);
  }
});

test("parseDecimalInput names exactly why it rejected the input", () => {
  const cases: [text: string, decimals: number, reason: string][] = [
    ["", 18, "empty"],
    ["   ", 18, "empty"],
    ["1,5", 18, "commaSeparator"],
    ["1,234.5", 18, "commaSeparator"],
    ["-1", 18, "negative"],
    ["1-2", 18, "negative"],
    ["1.2.3", 18, "multipleDots"],
    ["+1", 18, "invalidCharacter"],
    ["1e18", 18, "invalidCharacter"],
    ["1 2", 18, "invalidCharacter"],
    ["0x10", 18, "invalidCharacter"],
    ["١٢٣", 18, "invalidCharacter"],
    [".", 18, "invalidCharacter"],
    ["1.234", 2, "tooManyFractionDigits"],
    ["1.5", 0, "tooManyFractionDigits"],
  ];
  for (const [text, decimals, reason] of cases) {
    const result = parseDecimalInput(text, decimals);
    assert.strictEqual(result.ok, false, `expected "${text}" to be rejected`);
    assert.strictEqual(result.reason, reason, `"${text}"`);
  }
});

test("parse and format round-trip in both directions", () => {
  const raws = [0n, 1n, WEI, 1_666_666_666_666_667n, 999_999_999_999_999_999n, 12_345_678_900_000_000_000n];
  for (const raw of raws) {
    const text = formatUnits(raw, 18, {rounding: "down"});
    const parsed = parseDecimalInput(text, 18);
    assert.ok(parsed.ok);
    assert.strictEqual(parsed.raw, raw, `round trip of ${raw}`);
  }
  for (const text of ["0", "1", "1.5", "0.001666666666666667", "123456.789"]) {
    const parsed = parseDecimalInput(text, 18);
    assert.ok(parsed.ok);
    assert.strictEqual(formatUnits(parsed.raw, 18, {rounding: "down"}), text, `round trip of "${text}"`);
  }
});

test("splitDecimalString separates the parts a grouping formatter needs", () => {
  assert.deepStrictEqual(splitDecimalString("1234.56"), {sign: "", whole: "1234", fraction: "56"});
  assert.deepStrictEqual(splitDecimalString("7"), {sign: "", whole: "7", fraction: ""});
  assert.deepStrictEqual(splitDecimalString("-0.5"), {sign: "-", whole: "0", fraction: "5"});
});

test("parseDecimalInput refuses an amount above uint256 with its own reason", () => {
  assert.deepStrictEqual(parseDecimalInput("9".repeat(200), 18), {ok: false, reason: "aboveMaxUint256"});
  const max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  assert.deepStrictEqual(parseDecimalInput(max, 0), {ok: true, raw: (1n << 256n) - 1n});
  assert.deepStrictEqual(
    parseDecimalInput("115792089237316195423570985008687907853269984665640564039457584007913129639936", 0),
    {ok: false, reason: "aboveMaxUint256"},
  );
});
