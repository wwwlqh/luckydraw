// Regressions from the wave 5 adversarial review: message text is not revert data unless a data marker
// introduces an ABI-shaped payload, and the decoder stays total on hostile inputs.

import assert from "node:assert/strict";
import test from "node:test";
import {Interface} from "ethers";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {projectErrorNames, vaultErrorSelectors} from "../types/generated.ts";
import {
  decodeOptionsForWrite,
  decodeRevert,
  extractRevertData,
  panicName,
  VAULT_OWN_ERRORS,
} from "./decode.ts";

const UNAUTHORIZED = "0x82b42900";

test("a bare address or hash inside a message is not revert data", () => {
  assert.deepEqual(
    decodeRevert(
      `ERC20: insufficient allowance for spender ${UNAUTHORIZED}1111111111111111111111111111111111`,
    ),
    {kind: "none"},
  );
  assert.deepEqual(decodeRevert({error: `nonce too low for 0x${"82b42900".padEnd(40, "1")}`}), {
    kind: "none",
  });
  assert.deepEqual(
    decodeRevert(`missing revert data (action="call", to="0xde4168ba22222222222222222222222222222222")`),
    {kind: "none"},
  );
});

test("hex introduced by a data marker is still decoded when it is ABI-shaped", () => {
  assert.equal(
    extractRevertData(`execution reverted (action="call", data="${UNAUTHORIZED}", reason=null)`),
    UNAUTHORIZED,
  );
  const withArg = `${UNAUTHORIZED}${"00".repeat(32)}`;
  assert.equal(extractRevertData(`execution reverted, data=${withArg}`), withArg);
  assert.equal(extractRevertData(`Reverted ${withArg}`), withArg);
  assert.equal(extractRevertData(`revert data: ${withArg}`), withArg);
  // A marker followed by a non-ABI-shaped run (a 20-byte address) is still refused.
  assert.equal(extractRevertData(`data="0x${"ab".repeat(20)}"`), null);
});

test("cyclic, deep and throwing inputs decode to none instead of throwing", () => {
  const cyclic: {data?: unknown} = {};
  cyclic.data = cyclic;
  assert.deepEqual(decodeRevert(cyclic), {kind: "none"});

  let deep: unknown = UNAUTHORIZED;
  for (let level = 0; level < 9; level += 1) deep = {data: deep};
  assert.deepEqual(decodeRevert(deep), {kind: "none"});

  const throwing = {};
  Object.defineProperty(throwing, "data", {
    get() {
      throw new Error("getter failure");
    },
    enumerable: true,
  });
  assert.deepEqual(decodeRevert(throwing), {kind: "none"});
});

test("an Error(string) payload ethers cannot decode becomes unknown, and unknown Panic codes are labelled", () => {
  const truncated = "0x08c379a0deadbeef";
  assert.equal(decodeRevert(truncated).kind, "unknown");
  assert.match(panicName(0x99n), /unrecognized panic 0x99/);
});

test("a token's revert bytes are the token's, even when the selector equals a project error", () => {
  const insufficient = new Interface(luckyVaultAbi).encodeErrorResult("InsufficientBalance", []);
  // A Solady-style token declares `InsufficientBalance()`; `Vault.deposit` bubbles it through SafeERC20 and
  // cannot raise that error itself, so it is the token's, not "your LuckyDraw balance".
  const viaDeposit = decodeRevert(insufficient, {emitter: "vault", method: "deposit"});
  assert.equal(viaDeposit.kind, "custom");
  assert.equal(viaDeposit.kind === "custom" ? viaDeposit.contract : "", "token");
  // `withdraw` does raise InsufficientBalance itself, so there it stays the Vault's.
  const viaWithdraw = decodeRevert(insufficient, {emitter: "vault", method: "withdraw"});
  assert.equal(viaWithdraw.kind === "custom" ? viaWithdraw.contract : "", "vault");
  // An approval step is a call to the token: everything it reverts with is the token's.
  const approve = decodeOptionsForWrite({contract: "erc20", function: "approve"});
  const viaApprove = decodeRevert(UNAUTHORIZED, approve);
  assert.equal(viaApprove.kind === "custom" ? viaApprove.contract : "", "token");
  // Without a method the Vault hint still wins for a shared error, as before.
  const plain = decodeRevert(insufficient, {emitter: "vault"});
  assert.equal(plain.kind === "custom" ? plain.contract : "", "vault");
  // A method the table does not know, including prototype names, changes nothing.
  for (const method of ["closeEscrow", "constructor", "__proto__", "hasOwnProperty"]) {
    const other = decodeRevert(insufficient, {emitter: "vault", method});
    assert.equal(other.kind === "custom" ? other.contract : "", "vault", method);
  }
});

test("the Vault's own-error table names only errors Errors.sol declares and the Vault ABI carries", () => {
  const declared = new Set<string>(projectErrorNames);
  for (const [method, names] of Object.entries(VAULT_OWN_ERRORS)) {
    assert.ok(names.size > 0, method);
    for (const name of names) {
      assert.ok(declared.has(name), `${method}: ${name} is declared in Errors.sol`);
      assert.ok(Object.hasOwn(vaultErrorSelectors, name), `${method}: ${name} is in the Vault ABI`);
    }
  }
});

test("hex inside an error object is revert data only when it is revert-shaped", () => {
  // 20 bytes whose first four equal a project selector: an address, filed by ethers under `value`.
  const address = `${UNAUTHORIZED}${"11".repeat(16)}`;
  assert.equal(extractRevertData({code: "INVALID_ARGUMENT", argument: "address", value: address}), null);
  assert.deepEqual(decodeRevert({code: "INVALID_ARGUMENT", value: address}), {kind: "none"});
  assert.deepEqual(decodeRevert({result: `0x${"ab".repeat(20)}`}), {kind: "none"});
  // `0x` inside an object is still a revert that carried no data.
  assert.equal(decodeRevert({data: "0x"}).kind, "unknown");
  // A selector followed by a partial word is not a custom error, whatever ethers' parser tolerates.
  const trailing = decodeRevert(`${UNAUTHORIZED}${"00".repeat(32)}${"ff".repeat(7)}`);
  assert.equal(trailing.kind, "unknown");
  // Whole words still decode, directly and nested.
  assert.equal(decodeRevert(UNAUTHORIZED).kind, "custom");
  assert.equal(decodeRevert({data: {data: UNAUTHORIZED}}).kind, "custom");
});
