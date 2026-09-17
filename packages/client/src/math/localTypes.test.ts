/// Guards the hand-written enum stand-ins against `contracts/src/Types.sol` ("Enum member order is part of the
/// ABI and of the generated client types. Never reorder.").
///
/// `localTypes.ts` duplicates three Solidity enums so `src/math` can run before the generated `src/types/`
/// module exists. A duplicate is only safe while something checks it, so this test parses the enum bodies out
/// of `Types.sol` and compares member names and positions. When the generated module lands and `localTypes.ts`
/// is re-pointed at it, this test is what proves the two agreed at the moment of the switch.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {KIND, QUOTE_REASON, quoteReasonNameOf, ROUND_STATE} from "./localTypes.ts";

// src/math -> src -> client -> packages -> repository root.
const TYPES_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", "contracts", "src", "Types.sol");
const source = readFileSync(TYPES_PATH, "utf8");

/// Member names of a Solidity enum, in declaration order.
function solidityEnumMembers(name: string): string[] {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `Types.sol has no enum ${name}`);
  const body = match[1];
  assert.ok(body !== undefined);
  return body
    .split(",")
    .map((member) => member.replace(/\/\/.*$/gm, "").trim())
    .filter((member) => member.length > 0);
}

/// The client's mapping as an ordered member list.
function clientMembers(map: Record<string, number>): string[] {
  const members: string[] = [];
  for (const [name, value] of Object.entries(map)) members[value] = name;
  return members;
}

test("Kind matches Types.sol", () => {
  assert.deepStrictEqual(clientMembers(KIND), solidityEnumMembers("Kind"));
  assert.deepStrictEqual(solidityEnumMembers("Kind"), [
    "Day100",
    "Day1k",
    "Day10k",
    "Week1k",
    "Week10k",
    "Week100k",
    "Month100k",
  ]);
});

test("State matches Types.sol", () => {
  assert.deepStrictEqual(clientMembers(ROUND_STATE), solidityEnumMembers("State"));
});

test("QuoteReason matches Types.sol, including the appended members", () => {
  const members = solidityEnumMembers("QuoteReason");
  assert.deepStrictEqual(clientMembers(QUOTE_REASON), members);
  // SPEC 8.1: "Existing numeric reason values are preserved; SeedAccountCannotBuy and ArithmeticOverflow are
  // appended." A reorder would silently change every stored and logged reason.
  assert.strictEqual(members[0], "None");
  assert.strictEqual(members[members.length - 2], "SeedAccountCannotBuy");
  assert.strictEqual(members[members.length - 1], "ArithmeticOverflow");
});

test("the reason-name lookup covers every value exactly once", () => {
  const entries = Object.entries(QUOTE_REASON);
  const names = entries.map(([, value]) => quoteReasonNameOf(value));
  assert.strictEqual(new Set(names).size, names.length);
  for (const [name, value] of entries) {
    assert.strictEqual(quoteReasonNameOf(value), name);
  }
});
