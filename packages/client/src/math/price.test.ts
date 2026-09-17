/// Independent price-math tests (SPEC §3.1, §3.2, §11.2 "USD ceiling exact boundaries across 0-18 decimals,
/// price freshness/future timestamp/changed decimals, whole-USD target boundaries").
///
/// The USD boundaries are asserted as properties over exact rational reasoning rather than restated
/// constants: `minGrossRaw` is the *smallest* gross worth USD 1, so the value at it is at least 1 and the
/// value one raw unit below it is 0. `spec_reference.py` checks the same property with `Fraction`.

import assert from "node:assert/strict";
import test from "node:test";
import {MAX_UINT256} from "./constants.ts";
import {MathError} from "./mathError.ts";
import {
  classifyObservation,
  isEligibleHeartbeat,
  maxPriceAge,
  minGrossRaw,
  type ObservationInput,
  reachesTarget,
  scaleOf,
  targetGross,
  tryUsdValueUint256,
  usdValue,
} from "./price.ts";

const BNB_PRICE = 600n * 10n ** 8n;

test("SPEC 3.2 worked example: d=18, f=8, p=600e8", () => {
  const minimum = minGrossRaw(18, 8, BNB_PRICE);
  assert.strictEqual(minimum, 1_666_666_666_666_667n, "the documented USD 1 minimum in wei");
  assert.strictEqual(usdValue(minimum, 18, 8, BNB_PRICE), 1n, "the minimum is worth USD 1");
  assert.strictEqual(usdValue(minimum - 1n, 18, 8, BNB_PRICE), 0n, "one raw unit less is below USD 1");

  const target = targetGross(18, 8, BNB_PRICE, 1000n);
  assert.strictEqual(target, 1_666_666_666_666_666_667n, "the smallest pot that reaches USD 1,000");
  assert.strictEqual(usdValue(target, 18, 8, BNB_PRICE), 1000n);
  assert.strictEqual(usdValue(target - 1n, 18, 8, BNB_PRICE), 999n, "one raw unit less values at USD 999");
});

test("USD 1 boundary holds for every decimal pair 0-18", () => {
  for (let d = 0; d <= 18; d += 1) {
    for (let f = 0; f <= 18; f += 1) {
      const scale = scaleOf(d, f);
      assert.strictEqual(scale, 10n ** BigInt(d + f));
      for (const price of [1n, 3n, 600n * 10n ** BigInt(f), 987_654_321n, 2n ** 127n - 1n]) {
        const minimum = minGrossRaw(d, f, price);
        assert.ok(minimum >= 1n, `minimum must be positive (d=${d}, f=${f}, p=${price})`);
        // Exact rational statement: minimum * price / scale >= 1 > (minimum - 1) * price / scale.
        assert.ok(minimum * price >= scale, `minimum reaches USD 1 (d=${d}, f=${f}, p=${price})`);
        assert.ok((minimum - 1n) * price < scale, `one raw unit below fails (d=${d}, f=${f}, p=${price})`);
        assert.strictEqual(usdValue(minimum, d, f, price) >= 1n, true);
        assert.strictEqual(usdValue(minimum - 1n, d, f, price), 0n);
      }
    }
  }
});

test("target boundary: the smallest pot that reaches a whole-USD target", () => {
  for (const d of [0, 6, 8, 18]) {
    for (const f of [0, 8, 18]) {
      for (const price of [1n, 3n, 600n * 10n ** BigInt(f), 987_654_321n]) {
        for (const target of [10n, 100n, 1000n, 10_000n]) {
          const gross = targetGross(d, f, price, target);
          assert.ok(usdValue(gross, d, f, price) >= target, `target reached (d=${d}, f=${f}, p=${price})`);
          assert.ok(usdValue(gross - 1n, d, f, price) < target, `one raw unit below misses the target`);
          assert.ok(gross >= minGrossRaw(d, f, price), "a target gross is never below the USD 1 minimum");
        }
      }
    }
  }
});

test("reachesTarget needs two distinct addresses as well as the value (SPEC 3.2)", () => {
  const gross = targetGross(18, 8, BNB_PRICE, 1000n);
  assert.strictEqual(reachesTarget(gross, 2n, 18, 8, BNB_PRICE, 1000n), true);
  assert.strictEqual(reachesTarget(gross, 1n, 18, 8, BNB_PRICE, 1000n), false, "a lone player never closes");
  assert.strictEqual(reachesTarget(gross - 1n, 2n, 18, 8, BNB_PRICE, 1000n), false);
  assert.strictEqual(reachesTarget(gross, 0n, 18, 8, BNB_PRICE, 1000n), false);
});

test("invalid decimals and prices are rejected", () => {
  assert.throws(() => scaleOf(19, 0), MathError);
  assert.throws(() => scaleOf(0, 19), MathError);
  assert.throws(() => scaleOf(-1, 0), MathError);
  assert.throws(() => scaleOf(1.5, 0), MathError);
  assert.throws(
    () => minGrossRaw(18, 8, 0n),
    (error: unknown) => error instanceof MathError && error.code === "InvalidInput",
  );
  assert.throws(() => targetGross(18, 8, 0n, 100n), MathError);
});

test("tryUsdValueUint256 agrees with usdValue and fails exactly at the uint256 boundary", () => {
  // The projection is floor(gross * price / scale); the largest gross whose projection still fits in uint256
  // is floor(((2^256) * scale - 1) / price), capped at uint256.
  const cases: [d: number, f: number, price: bigint][] = [
    [0, 0, 2n],
    [0, 0, MAX_UINT256],
    // Overflows in the checked add rather than the checked multiply: the whole term is exactly uint256 max
    // and the fractional term pushes the sum over it.
    [0, 1, MAX_UINT256],
    [0, 8, 10n ** 9n],
    [18, 0, 2n * 10n ** 18n],
    [18, 8, BNB_PRICE],
    [0, 0, 1n],
  ];
  for (const [d, f, price] of cases) {
    const scale = scaleOf(d, f);
    const ceiling = ((MAX_UINT256 + 1n) * scale - 1n) / price;
    const largest = ceiling < MAX_UINT256 ? ceiling : MAX_UINT256;

    const ok = tryUsdValueUint256(largest, d, f, price);
    assert.ok(ok.ok, `largest gross must fit (d=${d}, f=${f}, p=${price})`);
    assert.strictEqual(ok.value, usdValue(largest, d, f, price), "and must equal the unbounded value");
    assert.ok(ok.value <= MAX_UINT256);

    if (largest < MAX_UINT256) {
      const overflowed = tryUsdValueUint256(largest + 1n, d, f, price);
      assert.strictEqual(
        overflowed.ok,
        false,
        `one raw unit more must overflow (d=${d}, f=${f}, p=${price})`,
      );
    }
  }
});

test("tryUsdValueUint256 reproduces the split-and-add identity at full precision", () => {
  for (const gross of [0n, 1n, 10n ** 18n, 1_666_666_666_666_666_667n, 10n ** 30n]) {
    const result = tryUsdValueUint256(gross, 18, 8, BNB_PRICE);
    assert.ok(result.ok);
    assert.strictEqual(result.value, (gross * BNB_PRICE) / scaleOf(18, 8));
  }
});

/// A usable observation; each test flips exactly the fields it is about.
function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    available: true,
    decimals: 8,
    expectedDecimals: 8,
    roundId: 42n,
    answer: BNB_PRICE,
    updatedAt: 1_000_000n,
    now: 1_000_100n,
    maxPriceAge: 3600n,
    minAnswer: 0n,
    maxAnswer: 0n,
    ...overrides,
  };
}

test("classifyObservation reproduces the spec_reference.valid_price boundary table", () => {
  // (now, updatedAt, maxPriceAge, answer, roundId, expected valid)
  const rows: [bigint, bigint, bigint, bigint, bigint, boolean][] = [
    [100n, 100n, 10n, 1n, 1n, true],
    [100n, 90n, 10n, 1n, 1n, true],
    [100n, 89n, 10n, 1n, 1n, false],
    [100n, 101n, 10n, 1n, 1n, false],
    [100n, 0n, 100n, 1n, 1n, false],
    [100n, 99n, 10n, 0n, 1n, false],
    [100n, 99n, 10n, -1n, 1n, false],
    [100n, 99n, 10n, 1n, 0n, false],
  ];
  for (const [now, updatedAt, age, answer, roundId, expected] of rows) {
    const got = classifyObservation(observation({now, updatedAt, maxPriceAge: age, answer, roundId}));
    assert.strictEqual(
      got === "ok",
      expected,
      `now=${now} updatedAt=${updatedAt} age=${age} answer=${answer} roundId=${roundId}`,
    );
  }
});

test("classifyObservation names each failure", () => {
  assert.strictEqual(classifyObservation(observation()), "ok");
  assert.strictEqual(classifyObservation(observation({available: false})), "PriceUnavailable");
  assert.strictEqual(classifyObservation(observation({decimals: undefined})), "PriceUnavailable");
  assert.strictEqual(classifyObservation(observation({decimals: 18})), "PriceDecimalsChanged");
  assert.strictEqual(classifyObservation(observation({roundId: 0n})), "PriceInvalid");
  assert.strictEqual(classifyObservation(observation({answer: 0n})), "PriceInvalid");
  assert.strictEqual(classifyObservation(observation({answer: -1n})), "PriceInvalid");
  assert.strictEqual(classifyObservation(observation({updatedAt: 0n})), "PriceInvalid");
  assert.strictEqual(
    classifyObservation(observation({updatedAt: 1_000_101n})),
    "PriceInvalid",
    "a future answer",
  );
  assert.strictEqual(classifyObservation(observation({now: 1_000_000n + 3601n})), "PriceStale");
  assert.strictEqual(
    classifyObservation(observation({now: 1_000_000n + 3600n})),
    "ok",
    "the age bound is inclusive",
  );
});

test("an answer at or beyond a nonzero circuit-breaker bound is invalid (SPEC 3.1)", () => {
  const bounded = {minAnswer: 1n, maxAnswer: 10n} as const;
  assert.strictEqual(classifyObservation(observation({...bounded, answer: 5n})), "ok");
  assert.strictEqual(
    classifyObservation(observation({...bounded, answer: 1n})),
    "PriceInvalid",
    "at the floor",
  );
  assert.strictEqual(
    classifyObservation(observation({...bounded, answer: 10n})),
    "PriceInvalid",
    "at the ceiling",
  );
  assert.strictEqual(classifyObservation(observation({...bounded, answer: 2n})), "ok");
  // A zero bound means the aggregator has none; a huge answer stays valid.
  assert.strictEqual(
    classifyObservation(observation({minAnswer: 0n, maxAnswer: 0n, answer: 10n ** 30n})),
    "ok",
  );
});

test("observation precedence: the earlier check wins in every adjacent pair", () => {
  // Unavailable beats a changed decimal count.
  assert.strictEqual(classifyObservation(observation({available: false, decimals: 18})), "PriceUnavailable");
  // A changed decimal count beats an invalid answer.
  assert.strictEqual(
    classifyObservation(observation({decimals: 18, roundId: 0n, answer: -5n, updatedAt: 0n})),
    "PriceDecimalsChanged",
  );
  // An invalid answer beats staleness.
  assert.strictEqual(
    classifyObservation(observation({answer: 0n, now: 1_000_000n + 100_000n})),
    "PriceInvalid",
  );
  // A clamped answer beats staleness too.
  assert.strictEqual(
    classifyObservation(observation({minAnswer: 1000n, answer: 500n, now: 1_000_000n + 100_000n})),
    "PriceInvalid",
  );
});

test("maxPriceAge applies the max(2H, 3600) policy inside the 60-172,800 bounds", () => {
  assert.strictEqual(maxPriceAge(27n), 3600n, "a 27-second heartbeat still gets an hour of tolerance");
  assert.strictEqual(maxPriceAge(1800n), 3600n);
  assert.strictEqual(maxPriceAge(1801n), 3602n, "above the floor the policy is exactly 2H");
  assert.strictEqual(maxPriceAge(3600n), 7200n);
  assert.strictEqual(maxPriceAge(86_400n), 172_800n, "the largest eligible heartbeat");

  assert.throws(() => maxPriceAge(86_401n), MathError, "a feed that cannot fit the policy is ineligible");
  assert.throws(() => maxPriceAge(0n), MathError);
  assert.strictEqual(isEligibleHeartbeat(86_400n), true);
  assert.strictEqual(isEligibleHeartbeat(86_401n), false);
  assert.strictEqual(isEligibleHeartbeat(0n), false);
});
