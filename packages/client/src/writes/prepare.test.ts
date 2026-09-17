import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {Interface, id as keccakId} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {parseManifest} from "../deployments/manifest.ts";
import type {VerifiedDeployment} from "../deployments/verify.ts";
import {type Address, asAddress, MAX_UINT256, ZERO_ADDRESS} from "../types/common.ts";
import {Kind} from "../types/generated.ts";
import {
  encodeAllowanceCall,
  type PreparedWrite,
  prepareApprove,
  prepareAuthorizeSeed,
  prepareBuy,
  prepareClaimRefund,
  prepareCloseRound,
  prepareDeposit,
  prepareDepositNative,
  prepareEnsureCurrent,
  prepareExpireUnrequested,
  prepareRequestDraw,
  prepareSeedRound,
  prepareSettle,
  prepareWithdraw,
  WriteError,
} from "./prepare.ts";

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "config",
  "deployments",
  "31337",
  "0x610178da211fef7d417bc0e6fed39f05609ad788.json",
);

const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown);
const verified: VerifiedDeployment = {
  manifest,
  chainId: manifest.chain.chainId,
  verifiedAtBlock: null,
  vault: manifest.contracts.vault.address,
  draw: manifest.contracts.draw.address,
  checks: [],
};

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const erc20Interface = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

const TOKEN: Address = asAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
const PLAYER: Address = asAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
const ONE_BNB = 1_000_000_000_000_000_000n;

/** ethers decodes addresses in checksum case; the package compares them lowercase (README, SPEC §10.1). */
function lower(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

/** Decodes a prepared write back through the ABI it was built with: name and arguments must survive. */
function decoded(write: PreparedWrite): {name: string; args: readonly unknown[]} {
  const iface =
    write.contract === "draw" ? drawInterface : write.contract === "vault" ? vaultInterface : erc20Interface;
  const parsed = iface.parseTransaction({data: write.data, value: write.value});
  assert.ok(parsed !== null, `calldata did not decode for ${write.function}`);
  return {name: parsed.name, args: [...parsed.args].map(lower)};
}

test("prepareDepositNative is the only write that carries value", () => {
  const write = prepareDepositNative(verified, ONE_BNB);
  assert.equal(write.contract, "vault");
  assert.equal(write.to, verified.vault);
  assert.equal(write.value, ONE_BNB);
  assert.deepStrictEqual(decoded(write), {name: "depositNative", args: []});
  assert.deepStrictEqual(write.summary, {
    action: "deposit",
    contract: "vault",
    function: "depositNative",
    roundId: null,
    asset: ZERO_ADDRESS,
    amount: ONE_BNB,
    spender: null,
    account: null,
  });

  const others: readonly PreparedWrite[] = [
    prepareDeposit(verified, TOKEN, 500n),
    prepareWithdraw(verified, ZERO_ADDRESS, ONE_BNB),
    prepareApprove(verified, TOKEN, 500n),
    prepareBuy(verified, {
      roundId: 1n,
      asset: ZERO_ADDRESS,
      gross: ONE_BNB,
      minNetContribution: 0n,
      deadline: 1_790_000_000n,
    }),
    prepareCloseRound(verified, 1n),
    prepareRequestDraw(verified, 1n),
    prepareExpireUnrequested(verified, 1n),
    prepareSettle(verified, 1n),
    prepareClaimRefund(verified, 1n, PLAYER),
    prepareSeedRound(verified, 1n),
    prepareEnsureCurrent(verified, 1n, Kind.Day100),
    prepareAuthorizeSeed(verified, ZERO_ADDRESS, ONE_BNB),
  ];
  for (const write of others) {
    assert.equal(write.value, 0n, `${write.function} must be nonpayable`);
  }
});

test("the Vault builders decode back to their function and arguments", () => {
  const deposit = prepareDeposit(verified, TOKEN, 500n);
  assert.deepStrictEqual(decoded(deposit), {name: "deposit", args: [TOKEN.toLowerCase(), 500n]});
  assert.equal(deposit.summary.action, "deposit");
  assert.equal(deposit.summary.asset, TOKEN.toLowerCase());
  assert.equal(deposit.summary.amount, 500n);

  const withdraw = prepareWithdraw(verified, ZERO_ADDRESS, ONE_BNB);
  assert.deepStrictEqual(decoded(withdraw), {name: "withdraw", args: [ZERO_ADDRESS, ONE_BNB]});
  assert.equal(withdraw.summary.action, "withdraw");

  const authorize = prepareAuthorizeSeed(verified, ZERO_ADDRESS, 10_000_000_000_000_000n);
  assert.deepStrictEqual(decoded(authorize), {
    name: "authorizeSeed",
    args: [ZERO_ADDRESS, 10_000_000_000_000_000n],
  });
  assert.equal(authorize.summary.action, "authorizeSeed");
  assert.equal(authorize.summary.amount, 10_000_000_000_000_000n);

  // Zero revokes the consent (SPEC §5.4), so it must be buildable.
  assert.equal(prepareAuthorizeSeed(verified, ZERO_ADDRESS, 0n).summary.amount, 0n);
});

test("prepareAuthorizeSeed encodes the asset the consent is for and names it in the summary", () => {
  // SPEC §5.4: consent is per asset, and the cap is in that asset's raw units. 500 raw units is USD 5 of a
  // 2-decimal token and dust in BNB, so the asset is the difference between the two prompts.
  const token = prepareAuthorizeSeed(verified, TOKEN, 500n);
  assert.deepStrictEqual(decoded(token), {name: "authorizeSeed", args: [TOKEN.toLowerCase(), 500n]});
  assert.equal(token.summary.asset, TOKEN.toLowerCase(), "the summary names the asset being authorized");
  assert.equal(token.summary.amount, 500n);
  assert.equal(token.contract, "vault");
  assert.equal(token.to, verified.vault, "consent is recorded in the Vault, never in the Draw");

  // The new selector, spelled out: `authorizeSeed(address,uint256)`, not the old `authorizeSeed(uint256)`.
  assert.equal(token.data.slice(0, 10), "0x8f54a920");
  assert.equal(token.data.slice(0, 10), keccakId("authorizeSeed(address,uint256)").slice(0, 10));
  assert.notEqual(token.data.slice(0, 10), keccakId("authorizeSeed(uint256)").slice(0, 10));

  // A native cap and a token cap are different transactions even at the same number.
  assert.notEqual(prepareAuthorizeSeed(verified, ZERO_ADDRESS, 500n).data, token.data);

  // A missing asset is an invalid address, exactly as everywhere else in the builders.
  for (const bad of ["", "0x", "0xnothex", TOKEN.toUpperCase()]) {
    assert.throws(
      () => prepareAuthorizeSeed(verified, bad as Address, 500n),
      (error: unknown) => error instanceof WriteError && error.code === "InvalidAddress",
      `${bad} is not an asset address`,
    );
  }

  // The Vault reverts InvalidAsset for an unlisted asset, so the builder refuses before any calldata exists.
  assert.throws(
    () => prepareAuthorizeSeed(verified, PLAYER, 500n),
    (error: unknown) => error instanceof WriteError && error.code === "UnknownAsset",
    "an address that is not an asset of this deployment",
  );
});

test("prepareApprove always names the Vault as the spender and never approves the Draw", () => {
  const approve = prepareApprove(verified, TOKEN, 500n);
  assert.equal(approve.contract, "erc20");
  assert.equal(approve.to, TOKEN.toLowerCase(), "an approval goes to the token, not the Vault");
  assert.deepStrictEqual(decoded(approve), {name: "approve", args: [verified.vault, 500n]});
  assert.equal(approve.summary.spender, verified.vault);
  assert.notEqual(approve.summary.spender, verified.draw, "no allowance to Draw is ever requested");
  assert.equal(approve.summary.action, "approve");
  assert.equal(approve.summary.asset, TOKEN.toLowerCase());

  // The zero reset of SPEC §9.5 is a legitimate approval amount.
  assert.deepStrictEqual(decoded(prepareApprove(verified, TOKEN, 0n)).args, [verified.vault, 0n]);

  assert.throws(
    () => prepareApprove(verified, TOKEN, MAX_UINT256),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidAmount",
    "no unlimited default approval",
  );
  assert.throws(
    () => prepareApprove(verified, ZERO_ADDRESS, 1n),
    (error: unknown) => error instanceof WriteError && error.code === "WrongAssetKind",
  );
});

test("encodeAllowanceCall builds the pre-deposit allowance read", () => {
  const data = encodeAllowanceCall(PLAYER, verified.vault);
  const parsed = new Interface([
    "function allowance(address owner, address spender) view returns (uint256)",
  ]).parseTransaction({data});
  assert.equal(parsed?.name, "allowance");
  assert.deepStrictEqual([...(parsed?.args ?? [])].map(lower), [PLAYER.toLowerCase(), verified.vault]);
});

test("prepareBuy encodes the four SPEC §5.3 arguments and summarizes the entry", () => {
  const write = prepareBuy(verified, {
    roundId: 3n,
    asset: ZERO_ADDRESS,
    gross: 10_000_000_000_000_000n,
    minNetContribution: 9_699_999_999_999_999n,
    deadline: 1_790_000_300n,
  });
  assert.equal(write.contract, "draw");
  assert.equal(write.to, verified.draw);
  assert.deepStrictEqual(decoded(write), {
    name: "buy",
    args: [3n, 10_000_000_000_000_000n, 9_699_999_999_999_999n, 1_790_000_300n],
  });
  assert.deepStrictEqual(write.summary, {
    action: "enter",
    contract: "draw",
    function: "buy",
    roundId: 3n,
    asset: ZERO_ADDRESS,
    amount: 10_000_000_000_000_000n,
    spender: null,
    account: null,
  });
});

test("prepareBuy validates its inputs", () => {
  const base = {roundId: 1n, asset: ZERO_ADDRESS, gross: 100n, minNetContribution: 0n, deadline: 10n};
  assert.throws(
    () => prepareBuy(verified, {...base, gross: 0n}),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidAmount",
  );
  assert.throws(
    () => prepareBuy(verified, {...base, roundId: 0n}),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidId",
  );
  assert.throws(
    () => prepareBuy(verified, {...base, deadline: 1n << 64n}),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidDeadline",
    "deadline is a uint64",
  );
  assert.throws(
    () => prepareBuy(verified, {...base, minNetContribution: 101n}),
    (error: unknown) => error instanceof WriteError && error.code === "GuardAboveGross",
  );
  assert.throws(
    () => prepareBuy(verified, {...base, deadline: 0n}),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidDeadline",
    "a zero deadline is DeadlineExpired at any real block",
  );
  assert.throws(
    () => prepareBuy(verified, {...base, asset: "0x00000000000000000000000000000000deadbeef"}),
    (error: unknown) => error instanceof WriteError && error.code === "UnknownAsset",
    "the summary may only name an asset of the deployment",
  );
});

test("the lifecycle builders decode back and summarize their round", () => {
  const cases: readonly [PreparedWrite, string, readonly unknown[]][] = [
    [prepareCloseRound(verified, 5n), "closeRound", [5n]],
    [prepareRequestDraw(verified, 5n), "requestDraw", [5n]],
    [prepareExpireUnrequested(verified, 5n), "expireUnrequested", [5n]],
    [prepareSettle(verified, 5n), "settle", [5n]],
    [prepareSeedRound(verified, 5n), "seedRound", [5n]],
    [prepareClaimRefund(verified, 5n, PLAYER), "claimRefund", [5n, PLAYER.toLowerCase()]],
    [prepareEnsureCurrent(verified, 2n, Kind.Month100k), "ensureCurrent", [2n, 6n]],
  ];
  for (const [write, name, args] of cases) {
    assert.equal(write.contract, "draw", name);
    assert.deepStrictEqual(decoded(write), {name, args}, name);
    assert.equal(write.function, name);
  }
  assert.equal(prepareClaimRefund(verified, 5n, PLAYER).summary.account, PLAYER.toLowerCase());
  assert.equal(prepareEnsureCurrent(verified, 2n, Kind.Month100k).summary.roundId, null);
});

test("builders refuse assets the manifest does not list", () => {
  const stranger = asAddress("0x00000000000000000000000000000000deadbeef");
  assert.throws(
    () => prepareDeposit(verified, stranger, 1n),
    (error: unknown) => error instanceof WriteError && error.code === "UnknownAsset",
  );
  assert.throws(
    () => prepareDeposit(verified, ZERO_ADDRESS, 1n),
    (error: unknown) => error instanceof WriteError && error.code === "WrongAssetKind",
    "native deposits use prepareDepositNative",
  );
  assert.throws(
    () => prepareEnsureCurrent(verified, 1n, 7 as Kind),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidKind",
  );
  assert.throws(
    () => prepareClaimRefund(verified, 1n, ZERO_ADDRESS),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidAddress",
  );
});

test("every prepared write targets the manifest Vault or Draw, or the token being approved", () => {
  const writes: readonly PreparedWrite[] = [
    prepareDepositNative(verified, 1n),
    prepareDeposit(verified, TOKEN, 1n),
    prepareWithdraw(verified, TOKEN, 1n),
    prepareApprove(verified, TOKEN, 1n),
    prepareBuy(verified, {roundId: 1n, asset: ZERO_ADDRESS, gross: 1n, minNetContribution: 0n, deadline: 1n}),
    prepareSettle(verified, 1n),
  ];
  for (const write of writes) {
    const expected =
      write.contract === "vault"
        ? verified.vault
        : write.contract === "draw"
          ? verified.draw
          : TOKEN.toLowerCase();
    assert.equal(write.to, expected, `${write.function} must not address anything else`);
    assert.equal(write.summary.contract, write.contract);
    assert.equal(write.summary.function, write.function);
  }
});

test("the buy summary names the round's asset without changing the calldata", () => {
  const write = prepareBuy(verified, {
    roundId: 3n,
    asset: ZERO_ADDRESS,
    gross: 5n,
    minNetContribution: 0n,
    deadline: 9n,
  });
  assert.equal(write.summary.asset, ZERO_ADDRESS);
  assert.deepEqual([...write.args], [3n, 5n, 0n, 9n]);
  assert.throws(
    () =>
      prepareBuy(verified, {
        roundId: 3n,
        asset: "0xnot-an-address" as Address,
        gross: 5n,
        minNetContribution: 0n,
        deadline: 9n,
      }),
    WriteError,
  );
});

test("a withdrawal never consults the manifest's asset list (exits are never gated, SPEC 8.1)", () => {
  const unknown = "0x1111111111111111111111111111111111111111" as Address;
  const write = prepareWithdraw(verified, unknown, 7n);
  assert.equal(write.function, "withdraw");
  assert.deepEqual([...write.args], [unknown, 7n]);
});

test("an approval at or above 2^128 raw units is refused as unlimited", () => {
  assert.throws(() => prepareApprove(verified, TOKEN, 1n << 128n), WriteError);
  assert.throws(() => prepareApprove(verified, TOKEN, (1n << 256n) - 2n), WriteError);
  assert.doesNotThrow(() => prepareApprove(verified, TOKEN, (1n << 128n) - 1n));
});
