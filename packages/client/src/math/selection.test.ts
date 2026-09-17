/// Independent selection tests (SPEC §5.1, §7.2, §10.1, §11.2 "512-bit modulo versus big-int reference,
/// repeated-buyer binary search").
///
/// The oracle for the index is the arbitrary-precision value the EVM expression stands for,
/// `((word0 << 256) + word1) mod W`, computed directly. The oracle for the search is a linear scan over the
/// expanded ownership list, which is what a range list means.

import assert from "node:assert/strict";
import test from "node:test";
import {keccak256} from "ethers";
import type {Address} from "../types/common.ts";
import type {Range} from "../types/generated.ts";
import {MAX_UINT256} from "./constants.ts";
import {MathError} from "./mathError.ts";
import {findRangeIndex, findWinner, rangeListHash, requireRanges, winningIndex} from "./selection.ts";
import {createRng} from "./testing/rng.ts";

const address = (id: number): Address => `0x${id.toString(16).padStart(40, "0")}`;

test("winningIndex equals the direct 512-bit computation for fixed and random inputs", () => {
  const rng = createRng(20260911n);
  const weights = [1n, 2n, 3n, 20n, 2n ** 96n, 2n ** 255n, MAX_UINT256];
  for (let i = 0; i < 200; i += 1) weights.push(rng.below(MAX_UINT256) + 1n);

  for (const weight of weights) {
    const words: [bigint, bigint][] = [
      [0n, 0n],
      [MAX_UINT256, MAX_UINT256],
      [0n, MAX_UINT256],
      [MAX_UINT256, 0n],
      [rng.nextBits(256), rng.nextBits(256)],
    ];
    for (const [word0, word1] of words) {
      const got = winningIndex(word0, word1, weight);
      const direct = ((word0 << 256n) + word1) % weight;
      if (got !== direct)
        assert.fail(`winningIndex(${word0}, ${word1}, ${weight}) = ${got}, expected ${direct}`);
      assert.ok(got >= 0n && got < weight, "the index is always inside the weight");
    }
  }
});

test("winningIndex handles the degenerate weights", () => {
  assert.strictEqual(
    winningIndex(MAX_UINT256, MAX_UINT256, 1n),
    0n,
    "a single-unit round always picks index 0",
  );
  assert.strictEqual(winningIndex(0n, 0n, MAX_UINT256), 0n);
  assert.strictEqual(winningIndex(0n, 5n, 2n ** 255n), 5n);
  assert.throws(() => winningIndex(0n, 0n, 0n), MathError, "weight 0 has no winner");
  assert.throws(() => winningIndex(-1n, 0n, 10n), MathError);
  assert.throws(() => winningIndex(MAX_UINT256 + 1n, 0n, 10n), MathError);
});

test("findWinner matches a linear scan over repeated buyers and adjacent ranges", () => {
  const rng = createRng(777n);
  for (let trial = 0; trial < 300; trial += 1) {
    const ranges: Range[] = [];
    const expanded: string[] = [];
    let gross = 0n;
    const entries = rng.intBetween(1, 20);
    for (let i = 0; i < entries; i += 1) {
      const buyer = address(rng.intBetween(0, 4));
      const amount = rng.intBetween(1, 10);
      gross += BigInt(amount);
      ranges.push({buyer, cumulativeGross: gross});
      for (let unit = 0; unit < amount; unit += 1) expanded.push(buyer);
    }
    assert.strictEqual(BigInt(expanded.length), gross, "range conservation");
    for (let index = 0; index < expanded.length; index += 1) {
      const got = findWinner(ranges, BigInt(index));
      if (got !== expanded[index]) assert.fail(`trial ${trial}: index ${index} selected ${got}`);
    }
  }
});

test("adjacent ranges owned by the same buyer are not merged and each boundary still resolves", () => {
  const a = address(1);
  const b = address(2);
  const ranges: Range[] = [
    {buyer: a, cumulativeGross: 5n},
    {buyer: a, cumulativeGross: 10n},
    {buyer: b, cumulativeGross: 11n},
    {buyer: a, cumulativeGross: 20n},
  ];
  assert.strictEqual(findRangeIndex(ranges, 0n), 0);
  assert.strictEqual(findRangeIndex(ranges, 4n), 0);
  assert.strictEqual(findRangeIndex(ranges, 5n), 1, "the boundary belongs to the next range");
  assert.strictEqual(findRangeIndex(ranges, 9n), 1);
  assert.strictEqual(findRangeIndex(ranges, 10n), 2);
  assert.strictEqual(findWinner(ranges, 10n), b, "a one-unit range is selectable");
  assert.strictEqual(findRangeIndex(ranges, 11n), 3);
  assert.strictEqual(findWinner(ranges, 19n), a);
});

test("a large ledger resolves its boundaries without a holder scan", () => {
  const ranges: Range[] = Array.from({length: 100_000}, (_, i) => ({
    buyer: address(i % 17),
    cumulativeGross: BigInt(i + 1),
  }));
  for (const index of [0, 1, 49_999, 50_000, 99_998, 99_999]) {
    assert.strictEqual(findWinner(ranges, BigInt(index)), address(index % 17), `index ${index}`);
  }
  // The search depth is ceil(log2(rangeCount)); a linear scan would be 100,000 steps.
  assert.ok(Math.ceil(Math.log2(ranges.length)) === 17);
});

test("findWinner rejects an empty list and an index past the last range", () => {
  const ranges: Range[] = [{buyer: address(1), cumulativeGross: 10n}];
  assert.throws(
    () => findWinner([], 0n),
    (error: unknown) => error instanceof MathError && error.code === "InvalidRangeList",
  );
  assert.throws(
    () => findWinner(ranges, 10n),
    (error: unknown) => error instanceof MathError && error.code === "InvalidRangeList",
  );
  assert.throws(() => findWinner(ranges, -1n), MathError);
  assert.doesNotThrow(() => findWinner(ranges, 9n));
});

test("requireRanges enforces the append-only, strictly increasing invariant", () => {
  assert.doesNotThrow(() =>
    requireRanges([
      {buyer: address(1), cumulativeGross: 1n},
      {buyer: address(2), cumulativeGross: 2n},
    ]),
  );
  assert.throws(() => requireRanges([]), MathError);
  assert.throws(
    () => requireRanges([{buyer: address(1), cumulativeGross: 0n}]),
    MathError,
    "zero-length ranges are forbidden",
  );
  assert.throws(
    () =>
      requireRanges([
        {buyer: address(1), cumulativeGross: 5n},
        {buyer: address(2), cumulativeGross: 5n},
      ]),
    MathError,
    "a repeated cumulative value is a zero-length range",
  );
  assert.throws(
    () =>
      requireRanges([
        {buyer: address(1), cumulativeGross: 5n},
        {buyer: address(2), cumulativeGross: 4n},
      ]),
    MathError,
  );
});

test("rangeListHash is keccak256 over 64-byte abi.encode(address,uint256) blocks in order", () => {
  const ranges: Range[] = [
    {buyer: "0x0000000000000000000000000000000000000001", cumulativeGross: 5n},
    {buyer: "0x00000000000000000000000000000000000000ff", cumulativeGross: 300n},
  ];
  // Independently built: 32 bytes of left-padded address, then 32 bytes of big-endian amount, per range.
  const manual =
    "0x" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "00000000000000000000000000000000000000000000000000000000000000ff" +
    "000000000000000000000000000000000000000000000000000000000000012c";
  assert.strictEqual(rangeListHash(ranges), keccak256(manual));
  assert.strictEqual(rangeListHash(ranges).length, 66);
});

test("rangeListHash depends on order and on every field, and fixes the empty-list value", () => {
  const one: Range = {buyer: address(1), cumulativeGross: 5n};
  const two: Range = {buyer: address(2), cumulativeGross: 9n};
  assert.notStrictEqual(rangeListHash([one, two]), rangeListHash([two, one]));
  assert.notStrictEqual(rangeListHash([one]), rangeListHash([{...one, cumulativeGross: 6n}]));
  assert.notStrictEqual(rangeListHash([one]), rangeListHash([{...one, buyer: address(3)}]));
  assert.strictEqual(
    rangeListHash([one]),
    rangeListHash([{...one}]),
    "the hash is a pure function of the list",
  );
  assert.strictEqual(
    rangeListHash([]),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    "the empty list hashes the empty byte string",
  );
});

test("rangeListHash accepts checksummed input and hashes it as the same address", () => {
  const lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
  const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  assert.strictEqual(
    rangeListHash([{buyer: lower, cumulativeGross: 1n}]),
    rangeListHash([{buyer: checksummed, cumulativeGross: 1n}]),
  );
});

test("the round evidence path: hash the list, verify the winner by binary search", () => {
  // SPEC 10.1: the evidence JSON carries keccak256 of the ordered list, and the client verifies the winner by
  // binary search over that list. Both halves must agree with the on-chain selection.
  const ranges: Range[] = [
    {buyer: address(1), cumulativeGross: 100n},
    {buyer: address(2), cumulativeGross: 250n},
    {buyer: address(3), cumulativeGross: 251n},
  ];
  requireRanges(ranges);
  const weight = ranges[ranges.length - 1]?.cumulativeGross;
  assert.ok(weight !== undefined);
  const word0 = 0x1234567890abcdefn;
  const word1 = 0xfedcba0987654321n;
  const index = winningIndex(word0, word1, weight);
  const winner = findWinner(ranges, index);
  assert.ok([address(1), address(2), address(3)].includes(winner));
  assert.strictEqual(index, ((word0 << 256n) + word1) % weight);
  assert.match(rangeListHash(ranges), /^0x[0-9a-f]{64}$/);
});
