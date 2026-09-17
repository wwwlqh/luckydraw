// Tests for scripts/generate.ts. They live under src/ because the package test glob is "src/**/*.test.ts";
// the generator itself stays in scripts/ so it is not part of the published dist/.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
  type AbiEntry,
  ARTIFACTS,
  artifactPath,
  canonicalSignature,
  checkGenerated,
  collectErrors,
  collectEvents,
  collectStructs,
  ERRORS_SOL,
  GenerateError,
  generateAll,
  normalizeAbi,
  parseEnums,
  parseErrorNames,
  readArtifactAbi,
  shortInternalName,
  solidityTypeToTs,
  stripSolidityComments,
  TYPES_SOL,
} from "../../scripts/generate.ts";

const typesSol = readFileSync(TYPES_SOL, "utf8");
const errorsSol = readFileSync(ERRORS_SOL, "utf8");

// ---------------------------------------------------------------------------
// Types.sol parser
// ---------------------------------------------------------------------------

test("parseEnums finds every enum of Types.sol in source order", () => {
  const enums = parseEnums(typesSol);
  assert.deepEqual(
    enums.map((e) => e.name),
    [
      "Kind",
      "Cadence",
      "State",
      "ReleaseReason",
      "RefundReason",
      "ReferenceKind",
      "CallbackIgnoreReason",
      "QuoteReason",
      "SeedSkipReason",
      "CloseReason",
    ],
  );
  assert.equal(enums.length, 10);
});

test("parseEnums reproduces the exact member list of every enum", () => {
  const byName = new Map(parseEnums(typesSol).map((e) => [e.name, e.members]));
  assert.deepEqual(byName.get("Kind"), [
    "Day100",
    "Day1k",
    "Day10k",
    "Week1k",
    "Week10k",
    "Week100k",
    "Month100k",
  ]);
  assert.deepEqual(byName.get("Cadence"), ["Day", "Week", "Month"]);
  assert.deepEqual(byName.get("State"), [
    "Open",
    "AwaitingRequest",
    "Drawing",
    "Ready",
    "Settled",
    "Refunding",
    "Void",
  ]);
  assert.equal(byName.get("State")?.length, 7);
  assert.deepEqual(byName.get("ReleaseReason"), ["Prize", "Fee", "Refund"]);
  assert.deepEqual(byName.get("RefundReason"), ["InsufficientPlayers", "RequestDeadlineExpired"]);
  assert.deepEqual(byName.get("ReferenceKind"), ["ExactToken", "UnderlyingAsset"]);
  assert.deepEqual(byName.get("CallbackIgnoreReason"), [
    "UnknownRequest",
    "DuplicateOrWrongState",
    "Malformed",
  ]);
  assert.deepEqual(byName.get("SeedSkipReason"), [
    "NotConfigured",
    "NotAuthorized",
    "InsufficientSeedBalance",
    "NotOpen",
  ]);
  assert.deepEqual(byName.get("CloseReason"), ["Cutoff", "TargetReached"]);
});

test("QuoteReason has 13 append-only members ending in ArithmeticOverflow", () => {
  const quoteReason = parseEnums(typesSol).find((e) => e.name === "QuoteReason");
  assert.ok(quoteReason);
  assert.equal(quoteReason.members.length, 13);
  assert.equal(quoteReason.members[0], "None");
  assert.equal(quoteReason.members[11], "SeedAccountCannotBuy");
  assert.equal(quoteReason.members[12], "ArithmeticOverflow");
  // SPEC §5.1: the numeric values are the ABI. Position is the value.
  assert.equal(quoteReason.members.indexOf("BelowMinimum"), 9);
  assert.equal(quoteReason.members.indexOf("InsufficientBalance"), 10);
});

test("the enum parser tolerates comments and blank lines between members", () => {
  const source = `
    // leading line comment
    enum Foo {
        // a member comment
        A,
        /* a block comment */ B,

        C // trailing
    }
    /* enum Ignored { X } was commented out */
  `;
  assert.deepEqual(parseEnums(source), [{name: "Foo", members: ["A", "B", "C"]}]);
});

test("stripSolidityComments removes both comment forms", () => {
  const lineStripped = stripSolidityComments("keepA // dropB\nkeepC");
  assert.ok(!lineStripped.includes("dropB"));
  assert.ok(lineStripped.includes("keepA") && lineStripped.includes("keepC"));
  assert.ok(lineStripped.includes("\n"), "a line comment must not swallow its newline");
  assert.equal(
    stripSolidityComments("keepA /* dropB\ndropC */ keepD").replace(/\s+/g, " ").trim(),
    "keepA keepD",
  );
});

test("parseErrorNames lists the Errors.sol declarations in source order", () => {
  const names = parseErrorNames(errorsSol);
  assert.equal(names[0], "InvalidId");
  assert.equal(names[names.length - 1], "AlreadySeeded");
  for (const expected of [
    "WrongState",
    "EntryWindowClosed",
    "SeedAccountCannotBuy",
    "NetContributionTooLow",
    "SeedNotAuthorized",
  ]) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  // SPEC §8.1: arithmetic overflow surfaces as Panic(0x11); there is deliberately no custom error for it.
  assert.ok(!names.includes("ArithmeticOverflow"));
  // OpenZeppelin's errors reach the ABI but are not declared here, which is how the decoder tells them apart.
  assert.ok(!names.includes("OwnableUnauthorizedAccount"));
});

// ---------------------------------------------------------------------------
// Type mapper
// ---------------------------------------------------------------------------

test("solidityTypeToTs maps every shape the LuckyDraw ABIs contain", () => {
  assert.equal(solidityTypeToTs({name: "gross", type: "uint256", internalType: "uint256"}), "bigint");
  assert.equal(solidityTypeToTs({name: "answer", type: "int256", internalType: "int256"}), "bigint");
  assert.equal(solidityTypeToTs({name: "opensAt", type: "uint64", internalType: "uint64"}), "bigint");
  assert.equal(solidityTypeToTs({name: "roundId", type: "uint80", internalType: "uint80"}), "bigint");
  assert.equal(solidityTypeToTs({name: "decimals", type: "uint8", internalType: "uint8"}), "bigint");
  assert.equal(solidityTypeToTs({name: "user", type: "address", internalType: "address"}), "Address");
  assert.equal(solidityTypeToTs({name: "seeded", type: "bool", internalType: "bool"}), "boolean");
  assert.equal(solidityTypeToTs({name: "keyHash", type: "bytes32", internalType: "bytes32"}), "Hex32");
  assert.equal(solidityTypeToTs({name: "callData", type: "bytes", internalType: "bytes"}), "Hex");
  assert.equal(solidityTypeToTs({name: "sel", type: "bytes4", internalType: "bytes4"}), "Hex");
  assert.equal(solidityTypeToTs({name: "label", type: "string", internalType: "string"}), "string");
});

test("solidityTypeToTs maps a uint8 enum to its numeric literal union", () => {
  assert.equal(solidityTypeToTs({name: "kind", type: "uint8", internalType: "enum Kind"}), "Kind");
  assert.equal(solidityTypeToTs({name: "state", type: "uint8", internalType: "enum State"}), "State");
  assert.equal(
    solidityTypeToTs({name: "reason", type: "uint8", internalType: "enum QuoteReason"}),
    "QuoteReason",
  );
});

test("solidityTypeToTs maps arrays and tuples", () => {
  assert.equal(
    solidityTypeToTs({name: "targetUsd", type: "uint32[7]", internalType: "uint32[7]"}),
    "readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]",
  );
  assert.equal(
    solidityTypeToTs({name: "words", type: "uint256[]", internalType: "uint256[]"}),
    "readonly bigint[]",
  );
  assert.equal(
    solidityTypeToTs({name: "pricing", type: "tuple", internalType: "struct PricingConfig"}),
    "PricingConfig",
  );
  assert.equal(
    solidityTypeToTs({name: "page", type: "tuple[]", internalType: "struct ILuckyDraw.PoolView[]"}),
    "readonly PoolView[]",
  );
  assert.equal(
    solidityTypeToTs({name: "pair", type: "tuple[2]", internalType: "struct Range[2]"}),
    "readonly [Range, Range]",
  );
  // A tuple element inside an array type needs parentheses.
  assert.equal(
    solidityTypeToTs({name: "grid", type: "uint32[3][]", internalType: "uint32[3][]"}),
    "readonly (readonly [bigint, bigint, bigint])[]",
  );
});

test("solidityTypeToTs rejects what it cannot map", () => {
  assert.throws(() => solidityTypeToTs({name: "x", type: "function"}), GenerateError);
  assert.throws(() => solidityTypeToTs({name: "x", type: "tuple"}), GenerateError);
});

test("shortInternalName strips the keyword, the contract prefix and array suffixes", () => {
  assert.equal(shortInternalName("struct ILuckyDraw.RoundView"), "RoundView");
  assert.equal(shortInternalName("struct PriceReader.Observation"), "Observation");
  assert.equal(shortInternalName("struct Range[]"), "Range");
  assert.equal(shortInternalName("struct IMulticall3.Call3[2]"), "Call3");
  assert.equal(shortInternalName("enum Kind"), "Kind");
});

// ---------------------------------------------------------------------------
// Collection over the real artifacts
// ---------------------------------------------------------------------------

function artifactAbi(outFile: string): AbiEntry[] {
  const spec = ARTIFACTS.find((entry) => entry.outFile === outFile);
  assert.ok(spec, `no artifact spec for ${outFile}`);
  return readArtifactAbi(artifactPath(spec));
}

test("collectStructs reaches every view struct, nested ones included", () => {
  const structs = collectStructs([
    artifactAbi("luckyVault.ts"),
    artifactAbi("luckyDraw.ts"),
    artifactAbi("multicall3.ts"),
  ]);
  const names = structs.map((s) => s.name);
  for (const expected of [
    "AssetRecord",
    "Escrow",
    "Observation",
    "PoolView",
    "PricingConfig",
    "Quote",
    "Range",
    "RoundView",
    "Call3",
    "Result",
  ]) {
    assert.ok(names.includes(expected), `${expected} missing from ${names.join(", ")}`);
  }
  const observation = structs.find((s) => s.name === "Observation");
  assert.equal(observation?.qualified, "PriceReader.Observation");
});

test("collectEvents and collectErrors compute topics and selectors", () => {
  const drawAbi = artifactAbi("luckyDraw.ts");
  const events = collectEvents(drawAbi);
  const roundOpened = events.find((e) => e.name === "RoundOpened");
  assert.ok(roundOpened);
  // SPEC §8.2: the six pricing fields travel inside one named tuple, so the canonical signature nests them.
  assert.equal(
    roundOpened.signature,
    "RoundOpened(uint256,uint256,uint8,uint256,address,uint8,uint64,uint64,uint32,address,(address,uint8,uint32,uint8,int256,int256))",
  );
  assert.match(roundOpened.topic0, /^0x[0-9a-f]{64}$/);

  const errors = collectErrors(drawAbi);
  const unauthorized = errors.find((e) => e.name === "Unauthorized");
  assert.ok(unauthorized);
  assert.equal(unauthorized.selector.length, 10);
  assert.match(unauthorized.selector, /^0x[0-9a-f]{8}$/);
});

test("canonicalSignature expands nested tuples and array suffixes", () => {
  assert.equal(
    canonicalSignature("F", [
      {
        name: "a",
        type: "tuple",
        components: [
          {name: "x", type: "address"},
          {name: "y", type: "uint256"},
        ],
      },
      {name: "b", type: "uint32[3]"},
    ]),
    "F((address,uint256),uint32[3])",
  );
});

test("normalizeAbi keeps entry order and internalType", () => {
  const abi = artifactAbi("luckyDraw.ts");
  const normalized = normalizeAbi(abi);
  assert.equal(normalized.length, abi.length);
  assert.deepEqual(
    normalized.map((entry) => entry.name),
    abi.map((entry) => entry.name),
  );
  const roundOpened = normalized.find((entry) => entry.name === "RoundOpened");
  assert.ok(roundOpened);
  const inputs = roundOpened.inputs as {name: string; internalType?: string}[];
  const pricing = inputs.find((input) => input.name === "pricing");
  assert.equal(pricing?.internalType, "struct PricingConfig");
  // Canonical key order, independent of the artifact's own order.
  assert.deepEqual(Object.keys(roundOpened), ["type", "name", "inputs", "anonymous"]);
});

// ---------------------------------------------------------------------------
// Determinism and freshness
// ---------------------------------------------------------------------------

test("two generations produce identical bytes", () => {
  const first = generateAll();
  const second = generateAll();
  assert.equal(first.length, second.length);
  assert.deepEqual(first, second);
});

test("generated files end with one newline and contain no CR", () => {
  for (const file of generateAll()) {
    assert.ok(file.content.endsWith("\n"), `${file.path} does not end with a newline`);
    assert.ok(!file.content.includes("\r"), `${file.path} contains a carriage return`);
    assert.ok(
      file.content.startsWith("// GENERATED FILE - DO NOT EDIT BY HAND."),
      `${file.path} has no header`,
    );
  }
});

test("the committed generated files are up to date", () => {
  const stale = checkGenerated(generateAll());
  assert.deepEqual(stale, [], `run \`node scripts/generate.ts\`: ${stale.join(", ")}`);
});
