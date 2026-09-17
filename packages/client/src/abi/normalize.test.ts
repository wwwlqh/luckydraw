// Direct tests for the ABI-driven value normalization that events and reads rely on.

import assert from "node:assert/strict";
import test from "node:test";
import {normalizeAbiStruct, normalizeAbiValue, toBigInt} from "./normalize.ts";

test("toBigInt accepts bigint, safe number, decimal and hex strings, and rejects the rest", () => {
  assert.equal(toBigInt(7n), 7n);
  assert.equal(toBigInt(42), 42n);
  assert.equal(toBigInt("0x1f"), 31n);
  assert.equal(toBigInt("1000000000000000000000"), 10n ** 21n);
  assert.throws(() => toBigInt(1.5), TypeError);
  assert.throws(() => toBigInt(Number.MAX_SAFE_INTEGER + 2), TypeError);
  assert.throws(() => toBigInt(null), TypeError);
  assert.throws(() => toBigInt("not a number"));
});

test("scalars normalize by ABI type: bigint integers, lowercase addresses and bytes, enum numbers", () => {
  assert.equal(normalizeAbiValue({type: "uint64"}, "12"), 12n);
  assert.equal(normalizeAbiValue({type: "int256"}, -5n), -5n);
  assert.equal(
    normalizeAbiValue({type: "address"}, "0xABCDEFabcdef0000000000000000000000000000"),
    "0xabcdefabcdef0000000000000000000000000000",
  );
  assert.equal(normalizeAbiValue({type: "bytes32"}, `0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`);
  assert.equal(normalizeAbiValue({type: "bool"}, true), true);
  assert.equal(normalizeAbiValue({type: "string"}, "x"), "x");
  assert.equal(normalizeAbiValue({type: "uint8", internalType: "enum Kind"}, 2n), 2);
  assert.throws(() => normalizeAbiValue({type: "function"}, 0), TypeError);
});

test("fixed and nested arrays of tuples normalize element by element", () => {
  assert.deepEqual(normalizeAbiValue({type: "uint32[3]"}, [1, 2, 3]), [1n, 2n, 3n]);
  assert.deepEqual(normalizeAbiValue({type: "uint32[3][]"}, [[1, 2, 3]]), [[1n, 2n, 3n]]);
  const tupleArray = {
    type: "tuple[]",
    components: [
      {name: "buyer", type: "address"},
      {name: "cumulativeGross", type: "uint256"},
    ],
  };
  assert.deepEqual(normalizeAbiValue(tupleArray, [["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 9]]), [
    {buyer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cumulativeGross: 9n},
  ]);
});

test("a struct field literally named __proto__ becomes an own property", () => {
  const out = normalizeAbiStruct(
    [
      {name: "__proto__", type: "uint256"},
      {name: "ok", type: "uint256"},
    ],
    [7n, 9n],
  );
  assert.ok(Object.hasOwn(out, "__proto__"));
  assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, 7n);
  assert.equal(out.ok, 9n);
  assert.deepEqual(normalizeAbiStruct([{type: "uint8"}], [1]), {field0: 1n});
});
