import assert from "node:assert/strict";
import test from "node:test";
import {getAddress, Interface} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {drawErrorSelectors, projectErrorNames, vaultErrorSelectors} from "../types/generated.ts";
import {decodeRevert, extractRevertData, PANIC_NAMES, panicName} from "./decode.ts";

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const panicInterface = new Interface(["error Panic(uint256)", "error Error(string)"]);

// A real EIP-55 checksum, so ethers will encode it; the decoder must hand it back lowercase.
const SOME_ADDRESS = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

function sampleArgs(iface: Interface, name: string): unknown[] {
  const fragment = iface.getError(name);
  assert.ok(fragment);
  return fragment.inputs.map((input) => {
    if (input.type === "address") return SOME_ADDRESS;
    if (input.type.startsWith("uint") || input.type.startsWith("int")) return 1n;
    if (input.type === "bool") return true;
    if (input.type === "string") return "x";
    if (input.type === "bytes32") return `0x${"11".repeat(32)}`;
    throw new Error(`no sample for ${input.type}`);
  });
}

test("every Vault custom error round-trips", () => {
  const names = Object.keys(vaultErrorSelectors);
  assert.ok(names.length >= 25, `expected the whole Vault error set, saw ${names.length}`);
  for (const name of names) {
    const data = vaultInterface.encodeErrorResult(name, sampleArgs(vaultInterface, name));
    const decoded = decodeRevert(data, {emitter: "vault"});
    assert.equal(decoded.kind, "custom", `${name} did not decode as a custom error`);
    if (decoded.kind !== "custom") continue;
    assert.equal(decoded.name, name);
    assert.equal(decoded.selector, vaultErrorSelectors[name as keyof typeof vaultErrorSelectors]);
    const expectedOrigin = (projectErrorNames as readonly string[]).includes(name) ? "vault" : "dependency";
    // A name declared by both contracts follows the emitter hint, which is "vault" here.
    assert.equal(decoded.contract, expectedOrigin);
  }
});

test("every Draw custom error round-trips", () => {
  const names = Object.keys(drawErrorSelectors);
  assert.ok(names.length >= 30, `expected the whole Draw error set, saw ${names.length}`);
  for (const name of names) {
    const data = drawInterface.encodeErrorResult(name, sampleArgs(drawInterface, name));
    const decoded = decodeRevert(data);
    assert.equal(decoded.kind, "custom", `${name} did not decode as a custom error`);
    if (decoded.kind !== "custom") continue;
    assert.equal(decoded.name, name);
    assert.equal(decoded.selector, drawErrorSelectors[name as keyof typeof drawErrorSelectors]);
    assert.equal(
      decoded.contract,
      (projectErrorNames as readonly string[]).includes(name) ? "draw" : "dependency",
    );
  }
});

test("a Vault-only error is attributed to the Vault without a hint", () => {
  // EscrowClosed, SeedCapExceeded and SeedAlreadyLocked exist only in LuckyVault (SPEC 8.1, V5).
  for (const name of ["EscrowClosed", "SeedCapExceeded", "SeedAlreadyLocked", "RefundExceedsLocked"]) {
    const data = vaultInterface.encodeErrorResult(name, []);
    const decoded = decodeRevert(data);
    assert.equal(decoded.kind, "custom");
    if (decoded.kind !== "custom") continue;
    assert.equal(decoded.name, name);
    assert.equal(decoded.contract, "vault");
  }
});

test("a Draw-only error is attributed to the Draw", () => {
  for (const name of ["BelowMinimum", "NetContributionTooLow", "KeyHashUnsupported", "AlreadySeeded"]) {
    const data = drawInterface.encodeErrorResult(name, []);
    const decoded = decodeRevert(data);
    assert.equal(decoded.kind, "custom");
    if (decoded.kind !== "custom") continue;
    assert.equal(decoded.contract, "draw");
  }
});

test("OwnableUnauthorizedAccount decodes with a lowercase address argument", () => {
  const data = drawInterface.encodeErrorResult("OwnableUnauthorizedAccount", [SOME_ADDRESS]);
  const decoded = decodeRevert(data);
  assert.equal(decoded.kind, "custom");
  if (decoded.kind !== "custom") return;
  assert.equal(decoded.name, "OwnableUnauthorizedAccount");
  // SPEC 8.1: dependency errors may be decoded directly when documented; it is not in Errors.sol.
  assert.equal(decoded.contract, "dependency");
  assert.deepEqual(decoded.args, {account: SOME_ADDRESS.toLowerCase()});
});

test("Panic(0x11) is the arithmetic overflow SPEC 8.1 promises", () => {
  const data = panicInterface.encodeErrorResult("Panic", [0x11]);
  const decoded = decodeRevert(data);
  assert.equal(decoded.kind, "panic");
  if (decoded.kind !== "panic") return;
  assert.equal(decoded.code, 17n);
  assert.equal(decoded.name, "arithmetic overflow or underflow");
});

test("every documented Panic code decodes with a name", () => {
  for (const code of [0x00, 0x01, 0x11, 0x12, 0x21, 0x22, 0x31, 0x32, 0x41, 0x51]) {
    const data = panicInterface.encodeErrorResult("Panic", [code]);
    const decoded = decodeRevert(data);
    assert.equal(decoded.kind, "panic", `panic 0x${code.toString(16)} did not decode`);
    if (decoded.kind !== "panic") continue;
    assert.equal(decoded.code, BigInt(code));
    assert.equal(decoded.name, PANIC_NAMES[String(code)]);
    assert.notEqual(decoded.name, undefined);
  }
  assert.match(panicName(0x99n), /unrecognized panic 0x99/);
});

test("Error(string) becomes a reason", () => {
  const data = panicInterface.encodeErrorResult("Error", ["something went wrong"]);
  const decoded = decodeRevert(data);
  assert.equal(decoded.kind, "reason");
  if (decoded.kind !== "reason") return;
  assert.equal(decoded.message, "something went wrong");
});

test("unknown selectors and empty data become unknown, never a throw", () => {
  const random = `0xdeadbeef${"00".repeat(32)}`;
  const unknown = decodeRevert(random);
  assert.equal(unknown.kind, "unknown");
  if (unknown.kind === "unknown") {
    assert.equal(unknown.selector, "0xdeadbeef");
    assert.equal(unknown.data, random);
  }

  const empty = decodeRevert("0x");
  assert.equal(empty.kind, "unknown");
  if (empty.kind === "unknown") {
    assert.equal(empty.data, "0x");
    assert.equal(empty.selector, "0x");
  }

  // Truncated custom-error data: the selector matches nothing decodable.
  assert.equal(decodeRevert("0xdead").kind, "unknown");
});

test("no revert data at all is `none`, as with a rejected wallet prompt", () => {
  assert.equal(decodeRevert(undefined).kind, "none");
  assert.equal(decodeRevert(null).kind, "none");
  assert.equal(decodeRevert({code: 4001, message: "User rejected the request."}).kind, "none");
  assert.equal(decodeRevert(new Error("user rejected action")).kind, "none");
  assert.equal(decodeRevert(12345).kind, "none");
});

test("revert data is found in the nested provider error shapes", () => {
  const data = drawInterface.encodeErrorResult("EntryWindowClosed", []);

  // ethers CallExceptionError
  assert.equal(extractRevertData({code: "CALL_EXCEPTION", data}), data);
  // JSON-RPC error wrapped once
  assert.equal(extractRevertData({error: {code: 3, message: "execution reverted", data}}), data);
  // ethers wraps the provider payload under info.error
  assert.equal(extractRevertData({info: {error: {code: 3, data}}}), data);
  // doubly nested
  assert.equal(extractRevertData({error: {error: {data}}}), data);
  // body returned as a JSON string
  assert.equal(extractRevertData({body: JSON.stringify({error: {data}})}), data);
  // data hidden in a message string
  assert.equal(extractRevertData({data: `execution reverted: ${data}`}), data);
  // cycles do not hang the walk
  const cyclic: {error?: unknown} = {};
  cyclic.error = cyclic;
  assert.equal(extractRevertData(cyclic), null);
});

test("a fabricated ethers-style error with info.error.data decodes to its custom error", () => {
  const error = {
    code: "CALL_EXCEPTION",
    action: "estimateGas",
    shortMessage: "execution reverted",
    info: {
      error: {
        code: 3,
        message: "execution reverted",
        data: drawInterface.encodeErrorResult("BelowMinimum", []),
      },
    },
  };
  const decoded = decodeRevert(error);
  assert.equal(decoded.kind, "custom");
  if (decoded.kind !== "custom") return;
  assert.equal(decoded.name, "BelowMinimum");
  assert.equal(decoded.contract, "draw");
});

test("the emitter hint disambiguates an error declared by both contracts", () => {
  const data = vaultInterface.encodeErrorResult("WrongState", []);
  assert.equal(data, drawInterface.encodeErrorResult("WrongState", []), "the selector really is shared");
  const withoutHint = decodeRevert(data);
  const withHint = decodeRevert(data, {emitter: "vault"});
  assert.equal(withoutHint.kind === "custom" ? withoutHint.contract : null, "draw");
  assert.equal(withHint.kind === "custom" ? withHint.contract : null, "vault");
});

test("decodeRevert never throws, whatever it is handed", () => {
  const inputs: unknown[] = [
    Symbol("x"),
    () => 0,
    {data: {nested: "not hex"}},
    {data: "0xZZZZ"},
    new Map([["data", "0x"]]),
    [1, 2, 3],
    "",
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => decodeRevert(input));
  }
});
