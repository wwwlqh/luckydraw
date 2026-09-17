import assert from "node:assert/strict";
import test from "node:test";
import {
  asAddress,
  asHex,
  asHex32,
  HexFormatError,
  isAddress,
  isHex,
  isHex32,
  isUint256,
  MAX_UINT256,
  ZERO_ADDRESS,
} from "./common.ts";
import {Kind, KindNames, kindName, QuoteReason, quoteReasonName, State, stateName} from "./generated.ts";

const CHECKSUMMED = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test("isAddress accepts either case and rejects anything else", () => {
  assert.equal(isAddress(CHECKSUMMED), true);
  assert.equal(isAddress(CHECKSUMMED.toLowerCase()), true);
  assert.equal(isAddress(ZERO_ADDRESS), true);
  assert.equal(isAddress("0x1234"), false);
  assert.equal(isAddress(`${CHECKSUMMED}00`), false);
  assert.equal(isAddress(CHECKSUMMED.slice(2)), false);
  assert.equal(isAddress(null), false);
  assert.equal(isAddress(123n), false);
});

test("asAddress lowercases at the boundary and throws otherwise", () => {
  assert.equal(asAddress(CHECKSUMMED), CHECKSUMMED.toLowerCase());
  assert.throws(() => asAddress("0xnothex"), HexFormatError);
  assert.throws(
    () => asAddress(undefined),
    (error: unknown) => {
      assert.ok(error instanceof HexFormatError);
      assert.equal(error.name, "HexFormatError");
      assert.equal(error.expected, "address (0x + 40 hex)");
      return true;
    },
  );
});

test("isHex32 and asHex32 cover 32-byte values", () => {
  const hash = `0x${"AB".repeat(32)}`;
  assert.equal(isHex32(hash), true);
  assert.equal(isHex32(`0x${"ab".repeat(31)}`), false);
  assert.equal(asHex32(hash), hash.toLowerCase());
  assert.throws(() => asHex32("0x"), HexFormatError);
});

test("isHex and asHex cover arbitrary byte strings", () => {
  assert.equal(isHex("0x"), true);
  assert.equal(isHex("0x00ff"), true);
  assert.equal(isHex("0x0"), false, "odd length is not a byte string");
  assert.equal(asHex("0xAABB"), "0xaabb");
});

test("isUint256 bounds the uint256 range", () => {
  assert.equal(MAX_UINT256, (1n << 256n) - 1n);
  assert.equal(isUint256(0n), true);
  assert.equal(isUint256(MAX_UINT256), true);
  assert.equal(isUint256(MAX_UINT256 + 1n), false);
  assert.equal(isUint256(-1n), false);
});

test("an enum name lookup throws on a value outside the enum instead of returning undefined", () => {
  assert.throws(() => kindName(9 as Kind), RangeError);
  assert.throws(() => stateName(-1 as State), RangeError);
});

test("generated enums carry the Types.sol values and names", () => {
  assert.equal(Kind.Day100, 0);
  assert.equal(Kind.Month100k, 6);
  assert.deepEqual(KindNames, ["Day100", "Day1k", "Day10k", "Week1k", "Week10k", "Week100k", "Month100k"]);
  assert.equal(kindName(Kind.Week1k), "Week1k");
  assert.equal(State.Void, 6);
  assert.equal(stateName(State.Refunding), "Refunding");
  assert.equal(QuoteReason.ArithmeticOverflow, 12);
  assert.equal(quoteReasonName(QuoteReason.SeedAccountCannotBuy), "SeedAccountCannotBuy");
});
