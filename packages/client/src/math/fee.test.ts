/// Independent fee-arithmetic tests (SPEC §5.2, §11.2 "cumulative fee partition invariance").
///
/// These do not restate the implementation: every expectation is an independently stated property (the total
/// fee of a round is a function of its total gross alone; gross is conserved; per-entry rounding moves by at
/// most one raw unit) or a hand-computed worked example from the spec.

import assert from "node:assert/strict";
import test from "node:test";
import {MAX_UINT256} from "./constants.ts";
import {applyEntry, feeDelta, feeOf, minNetContribution} from "./fee.ts";
import {MathError} from "./mathError.ts";
import {createRng} from "./testing/rng.ts";

test("feeOf is 3% rounded down", () => {
  assert.strictEqual(feeOf(0n), 0n);
  assert.strictEqual(feeOf(1n), 0n);
  assert.strictEqual(feeOf(33n), 0n);
  assert.strictEqual(feeOf(34n), 1n);
  assert.strictEqual(feeOf(100n), 3n);
  assert.strictEqual(feeOf(1000n), 30n);
  // uint256 ceiling: 3% of the largest representable gross, floored.
  assert.strictEqual(feeOf(MAX_UINT256), (MAX_UINT256 * 300n) / 10000n);
});

test("SPEC 5.2 worked example: 1.00 + 2.00 + 7.00 in a 2-decimal asset", () => {
  // Entries 1.00, 2.00 and 7.00 produce gross 10.00, reserved fee 0.30 and prize 9.70.
  let state = {grossTotal: 0n, feeReserved: 0n};
  const results = [100n, 200n, 700n].map((gross) => {
    const applied = applyEntry(state, gross);
    state = {grossTotal: applied.grossTotal, feeReserved: applied.feeReserved};
    return applied;
  });

  assert.strictEqual(state.grossTotal, 1000n);
  assert.strictEqual(state.feeReserved, 30n);
  assert.deepStrictEqual(
    results.map((r) => r.prizePot),
    [97n, 291n, 970n],
  );
  // Weights are 10%, 20%, 70% of gross, unaffected by the fee split.
  assert.deepStrictEqual(
    results.map((r) => r.feeDelta),
    [3n, 6n, 21n],
  );
  assert.deepStrictEqual(
    results.map((r) => r.netDelta),
    [97n, 194n, 679n],
  );
});

test("partition invariance over random splits, including near the uint256 ceiling", () => {
  const rng = createRng(20260911n);
  const totals = [1n, 33n, 34n, 99n, 100n, 1000n, MAX_UINT256];
  for (let i = 0; i < 200; i += 1) totals.push(rng.below(MAX_UINT256) + 1n);

  for (const total of totals) {
    // A random ordered partition of `total` into 1..13 positive pieces.
    const cuts = new Set<bigint>([0n, total]);
    for (let i = 0; i < 12; i += 1) cuts.add(rng.below(total + 1n));
    const ordered = [...cuts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pieces = ordered.slice(1).map((cut, index) => cut - (ordered[index] ?? 0n));

    let state = {grossTotal: 0n, feeReserved: 0n};
    let fees = 0n;
    let net = 0n;
    for (const piece of pieces) {
      if (piece === 0n) continue;
      const applied = applyEntry(state, piece);
      // Per-purchase rounding moves by at most one raw unit from an isolated 3% floor (SPEC §5.2).
      const isolated = (piece * 3n) / 100n;
      assert.ok(
        applied.feeDelta === isolated || applied.feeDelta === isolated + 1n,
        `feeDelta ${applied.feeDelta} outside [${isolated}, ${isolated + 1n}] for piece ${piece}`,
      );
      assert.ok(applied.feeDelta >= 0n && applied.feeDelta <= piece, "fee never exceeds the entry gross");
      fees += applied.feeDelta;
      net += applied.netDelta;
      state = {grossTotal: applied.grossTotal, feeReserved: applied.feeReserved};
    }

    assert.strictEqual(state.grossTotal, total, "the pieces sum to the total");
    assert.strictEqual(fees, feeOf(total), "splitting across buys or wallets does not reduce the total fee");
    assert.strictEqual(fees + net, total, "gross conservation");
    assert.strictEqual(state.feeReserved, fees, "the reserve is the sum of the deltas");
    assert.strictEqual(state.grossTotal - state.feeReserved, net, "the pot is the sum of the net deltas");
  }
});

test("order does not change the round's total fee, only which entry carries the rounding", () => {
  const pieces = [7n, 34n, 1n, 999n, 2n];
  const totalFee = feeOf(pieces.reduce((a, b) => a + b, 0n));
  const permutations = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3],
  ];
  const deltaSets = permutations.map((order) => {
    let state = {grossTotal: 0n, feeReserved: 0n};
    const deltas: bigint[] = [];
    for (const at of order) {
      const piece = pieces[at];
      assert.ok(piece !== undefined);
      const applied = applyEntry(state, piece);
      deltas.push(applied.feeDelta);
      state = {grossTotal: applied.grossTotal, feeReserved: applied.feeReserved};
    }
    assert.strictEqual(state.feeReserved, totalFee);
    return deltas.reduce((a, b) => a + b, 0n);
  });
  assert.deepStrictEqual(deltaSets, [totalFee, totalFee, totalFee]);
});

test("feeDelta matches applyEntry and rejects a zero or overflowing entry", () => {
  assert.strictEqual(feeDelta(0n, 34n), 1n);
  assert.strictEqual(
    feeDelta(33n, 1n),
    1n,
    "the entry that crosses a 100-unit boundary carries the raw unit",
  );
  assert.strictEqual(feeDelta(34n, 1n), 0n, "the next entry carries none");
  assert.throws(() => feeDelta(0n, 0n), MathError);
  assert.throws(
    () => feeDelta(MAX_UINT256, 1n),
    (error: unknown) => error instanceof MathError && error.code === "Overflow",
  );
});

test("applyEntry rejects a fee reserve that does not match the stored gross", () => {
  assert.throws(
    () => applyEntry({grossTotal: 100n, feeReserved: 50n}, 10n),
    (error: unknown) => error instanceof MathError && error.code === "InvalidInput",
  );
});

test("minNetContribution allows one raw unit of fee-rounding movement", () => {
  assert.strictEqual(minNetContribution(0n), 0n);
  assert.strictEqual(minNetContribution(1n), 0n);
  assert.strictEqual(minNetContribution(970n), 969n);
  assert.strictEqual(minNetContribution(MAX_UINT256), MAX_UINT256 - 1n);
});

test("the guard accepts a purchase whose fee moved up by one raw unit", () => {
  // Quote against an empty round, then execute after someone else's entry landed first.
  const quoted = applyEntry({grossTotal: 0n, feeReserved: 0n}, 34n);
  const guard = minNetContribution(quoted.netDelta);
  const executed = applyEntry({grossTotal: 33n, feeReserved: feeOf(33n)}, 34n);
  assert.strictEqual(quoted.netDelta, 33n);
  assert.strictEqual(executed.netDelta, 32n, "the same entry can contribute one raw unit less");
  assert.ok(executed.netDelta >= guard, "and the guard still accepts it");
});
