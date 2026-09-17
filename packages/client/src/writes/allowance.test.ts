import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {Interface} from "ethers";
import {parseManifest} from "../deployments/manifest.ts";
import type {VerifiedDeployment} from "../deployments/verify.ts";
import {type Address, asAddress, ZERO_ADDRESS} from "../types/common.ts";
import {type DepositStep, depositSteps} from "./allowance.ts";
import {WriteError} from "./prepare.ts";

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

const erc20Interface = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
const TOKEN: Address = asAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
const AMOUNT = 500n;

function shape(steps: readonly DepositStep[]): readonly string[] {
  return steps.map((step) => step.kind);
}

function approvalAmounts(steps: readonly DepositStep[]): readonly bigint[] {
  return steps
    .filter((step) => step.kind === "approve" || step.kind === "approveReset")
    .map((step) => {
      const parsed = erc20Interface.parseTransaction({data: step.write.data});
      assert.ok(parsed !== null);
      return parsed.args[1] as bigint;
    });
}

test("native deposit is one transaction", () => {
  const steps = depositSteps(verified, {asset: ZERO_ADDRESS, amount: 1n, currentAllowance: 0n});
  assert.deepStrictEqual(shape(steps), ["deposit"]);
  assert.equal(steps[0]?.write.function, "depositNative");
  assert.equal(steps[0]?.write.value, 1n);
});

test("an allowance that already covers the amount skips the approval", () => {
  for (const allowance of [AMOUNT, AMOUNT + 1n]) {
    const steps = depositSteps(verified, {asset: TOKEN, amount: AMOUNT, currentAllowance: allowance});
    assert.deepStrictEqual(shape(steps), ["deposit"], `allowance ${allowance}`);
    assert.equal(steps[0]?.write.function, "deposit");
  }
});

test("a zero allowance approves the exact amount, then deposits", () => {
  const steps = depositSteps(verified, {asset: TOKEN, amount: AMOUNT, currentAllowance: 0n});
  assert.deepStrictEqual(shape(steps), ["approve", "deposit"]);
  assert.deepStrictEqual(approvalAmounts(steps), [AMOUNT], "the exact intended amount, never unlimited");
});

test("a short allowance on a requiresZeroReset token is reset first", () => {
  const steps = depositSteps(verified, {
    asset: TOKEN,
    amount: AMOUNT,
    currentAllowance: 100n,
    requiresZeroReset: true,
  });
  assert.deepStrictEqual(shape(steps), ["approveReset", "approve", "deposit"]);
  assert.deepStrictEqual(approvalAmounts(steps), [0n, AMOUNT], "approve(0) then approve(amount)");
});

test("a short allowance on an ordinary token is a single approve(amount)", () => {
  for (const requiresZeroReset of [undefined, false]) {
    const steps = depositSteps(verified, {
      asset: TOKEN,
      amount: AMOUNT,
      currentAllowance: 100n,
      requiresZeroReset,
    });
    assert.deepStrictEqual(shape(steps), ["approve", "deposit"], `requiresZeroReset=${requiresZeroReset}`);
    assert.deepStrictEqual(approvalAmounts(steps), [AMOUNT]);
  }
});

test("every approval names the Vault, never the Draw, and never an unlimited amount", () => {
  const matrix: readonly {allowance: bigint; reset: boolean}[] = [
    {allowance: 0n, reset: false},
    {allowance: 0n, reset: true},
    {allowance: 100n, reset: false},
    {allowance: 100n, reset: true},
  ];
  for (const {allowance, reset} of matrix) {
    const steps = depositSteps(verified, {
      asset: TOKEN,
      amount: AMOUNT,
      currentAllowance: allowance,
      requiresZeroReset: reset,
    });
    for (const step of steps) {
      if (step.kind === "deposit") continue;
      assert.equal(step.write.summary.spender, verified.vault);
      assert.notEqual(step.write.summary.spender, verified.draw);
      assert.equal(step.write.to, TOKEN.toLowerCase());
      const parsed = erc20Interface.parseTransaction({data: step.write.data});
      assert.ok(parsed !== null);
      assert.equal(String(parsed.args[0]).toLowerCase(), verified.vault);
      assert.ok((parsed.args[1] as bigint) <= AMOUNT, "no unlimited approval");
    }
    assert.equal(steps[steps.length - 1]?.kind, "deposit", "the deposit is always the last step");
  }
});

test("depositSteps rejects an impossible allowance", () => {
  assert.throws(
    () => depositSteps(verified, {asset: TOKEN, amount: AMOUNT, currentAllowance: -1n}),
    (error: unknown) => error instanceof WriteError && error.code === "InvalidAmount",
  );
});

test("an ERC-20 deposit at or above 2^128 raw units is refused the same way whatever the allowance", () => {
  // prepareApprove refuses such an amount as an unlimited-looking approval; the deposit step must not slip
  // through just because the allowance already covers it, or the same input would fail on one path only.
  for (const currentAllowance of [0n, 1n, 1n << 128n, (1n << 256n) - 1n]) {
    assert.throws(
      () => depositSteps(verified, {asset: TOKEN, amount: 1n << 128n, currentAllowance}),
      (error: unknown) => error instanceof WriteError && error.code === "InvalidAmount",
      `allowance ${currentAllowance}`,
    );
  }
  const largest = depositSteps(verified, {asset: TOKEN, amount: (1n << 128n) - 1n, currentAllowance: 0n});
  assert.deepEqual(shape(largest), ["approve", "deposit"], "one raw unit below the bound still builds");
});
