// Calldata builders and the decoded summary shown before every wallet prompt (SPEC §5.3, §9.5, §9.6).
//
// SPEC §9.6, client security: "a decoded summary (function, round, asset, amount and, for approvals, the
// spender) is shown before every wallet prompt". That summary is not something a page assembles from a
// transaction it already built; it is built here, from the same arguments that were encoded, so the two
// cannot disagree.
//
// Every builder takes a `VerifiedDeployment`. SPEC §15: "Validate manifest chain/address agreement before any
// UI signs; block writes on missing/mismatched deployment code." Only `verifyDeployment` produces that type,
// so an unverified manifest cannot produce calldata at all - the check is structural, not a runtime habit.
//
// Nothing here signs, estimates gas or touches a provider. A builder is a pure function of the deployment and
// its arguments.
//
// The builders consult only the manifest's fixed facts: which assets the deployment has, which one is native
// and which were listed. The deposit switches (`depositsEnabled` per asset, the Vault's `depositsPaused`)
// are live state the operator can flip after the manifest was written, so a deposit is gated at prompt time
// by a live `Vault.getAsset` read (`reads/adapters.readAssetRecord`), never by a builder reading a snapshot
// of the switch that may since have flipped either way.

import {Interface} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import type {ManifestAsset} from "../deployments/manifest.ts";
import type {VerifiedDeployment} from "../deployments/verify.ts";
import {MAX_UINT64} from "../math/constants.ts";
import {type Address, asHex, type Hex, isAddress, MAX_UINT256, ZERO_ADDRESS} from "../types/common.ts";
import {type Kind, KindNames} from "../types/generated.ts";

/** Which contract the transaction is addressed to. `erc20` is only ever an allowance step (SPEC §9.5). */
export type WriteTarget = "vault" | "draw" | "erc20";

/** The actions a wallet prompt can carry. One per builder. */
export type WriteAction =
  | "deposit"
  | "withdraw"
  | "approve"
  | "enter"
  | "closeRound"
  | "requestDraw"
  | "expireUnrequested"
  | "settle"
  | "claimRefund"
  | "seedRound"
  | "ensureCurrent"
  | "authorizeSeed";

/**
 * The decoded summary of SPEC §9.6, shown before the prompt.
 *
 * Every field is present and `null` where it does not apply, rather than optional: an optional property that
 * is sometimes absent makes "the summary showed no spender" indistinguishable from "the summary forgot the
 * spender", and `exactOptionalPropertyTypes` would make every construction site spell the difference out.
 */
export type WriteSummary = {
  action: WriteAction;
  contract: WriteTarget;
  /** The Solidity signature name, for example `buy` or `approve`. */
  function: string;
  roundId: bigint | null;
  /** The asset moved, with the zero address meaning native BNB (SPEC §4.2). */
  asset: Address | null;
  amount: bigint | null;
  /** Approvals only, and always the manifest Vault: "no approval to Draw" (SPEC §5.3, §9.5). */
  spender: Address | null;
  /** The account a call names other than the signer (a refund recipient). */
  account: Address | null;
};

/** One unsigned transaction plus the summary that must be shown before it is signed. */
export type PreparedWrite = {
  contract: WriteTarget;
  to: Address;
  data: Hex;
  /** Nonzero only for `depositNative`; every other write in v1 is nonpayable (SPEC §8.1). */
  value: bigint;
  function: string;
  args: readonly unknown[];
  summary: WriteSummary;
};

export type WriteErrorCode =
  | "InvalidAmount"
  | "InvalidAddress"
  | "InvalidId"
  | "InvalidKind"
  | "InvalidDeadline"
  | "UnknownAsset"
  | "AssetNotListed"
  | "WrongAssetKind"
  | "GuardAboveGross";

/** Every rejection a builder raises before any calldata exists. */
export class WriteError extends Error {
  readonly code: WriteErrorCode;

  constructor(code: WriteErrorCode, message: string) {
    super(message);
    this.name = "WriteError";
    this.code = code;
  }
}

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);

/**
 * Approvals at or above 2^128 raw units are treated as unlimited: no listed asset can hold such a balance,
 * and the "max" sentinels wallets show (2^256-1, 2^255, 2^128-1 rounded up) all sit above it.
 */
export const MAX_EXACT_APPROVAL = 1n << 128n;

/**
 * The ERC-20 surface an allowance step needs, written out rather than imported: the client carries no token
 * ABI, and a deposit only ever calls `approve(address,uint256)`.
 */
const erc20Interface = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** The `allowance(owner, spender)` calldata for the pre-deposit check of SPEC §9.5. */
export function encodeAllowanceCall(owner: Address, spender: Address): Hex {
  requireAddress(owner, "owner");
  requireAddress(spender, "spender");
  return asHex(erc20Interface.encodeFunctionData("allowance", [owner, spender]));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireAddress(value: Address, label: string): void {
  if (!isAddress(value) || value !== value.toLowerCase()) {
    throw new WriteError("InvalidAddress", `${label} must be a lowercase address, received ${value}`);
  }
}

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) throw new WriteError("InvalidAmount", `${label} must be positive, received ${value}`);
  if (value > MAX_UINT256) throw new WriteError("InvalidAmount", `${label} exceeds uint256: ${value}`);
}

function requireUint256(value: bigint, label: string): void {
  if (value < 0n || value > MAX_UINT256) {
    throw new WriteError("InvalidAmount", `${label} must be a uint256, received ${value}`);
  }
}

function requireId(value: bigint, label: string): void {
  if (value <= 0n) throw new WriteError("InvalidId", `${label} must be positive, received ${value}`);
  if (value > MAX_UINT256) throw new WriteError("InvalidId", `${label} exceeds uint256: ${value}`);
}

function requireDeadline(deadline: bigint): void {
  // Zero is not a deadline: `buy` reverts `DeadlineExpired` at any real block timestamp.
  if (deadline <= 0n || deadline > MAX_UINT64) {
    throw new WriteError("InvalidDeadline", `deadline must be a positive uint64, received ${deadline}`);
  }
}

/** The manifest record for an asset, or a rejection: SPEC §15 loads only listed deployment assets. */
function assetRecord(verified: VerifiedDeployment, asset: Address): ManifestAsset {
  requireAddress(asset, "asset");
  const record = verified.manifest.assets.find((entry) => entry.asset === asset);
  if (record === undefined) {
    const id = verified.manifest.deploymentId;
    throw new WriteError("UnknownAsset", `${asset} is not an asset of deployment ${id}`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Builders: Vault
// ---------------------------------------------------------------------------

function vaultWrite(
  verified: VerifiedDeployment,
  method: string,
  args: readonly unknown[],
  value: bigint,
  summary: Omit<WriteSummary, "contract" | "function">,
): PreparedWrite {
  return {
    contract: "vault",
    to: verified.vault,
    data: asHex(vaultInterface.encodeFunctionData(method, args as unknown[])),
    value,
    function: method,
    args,
    summary: {...summary, contract: "vault", function: method},
  };
}

function drawWrite(
  verified: VerifiedDeployment,
  method: string,
  args: readonly unknown[],
  summary: Omit<WriteSummary, "contract" | "function">,
): PreparedWrite {
  return {
    contract: "draw",
    to: verified.draw,
    data: asHex(drawInterface.encodeFunctionData(method, args as unknown[])),
    value: 0n,
    function: method,
    args,
    summary: {...summary, contract: "draw", function: method},
  };
}

/** `Vault.depositNative()` with `msg.value = amount`. The only write in v1 that carries value (SPEC §4.2). */
export function prepareDepositNative(verified: VerifiedDeployment, amount: bigint): PreparedWrite {
  requirePositive(amount, "amount");
  const record = assetRecord(verified, ZERO_ADDRESS);
  if (!record.native) {
    const id = verified.manifest.deploymentId;
    throw new WriteError("WrongAssetKind", `${id} records the zero address as a token, not native BNB`);
  }
  if (!record.listed) {
    throw new WriteError("AssetNotListed", "the native asset is not listed on this deployment");
  }
  return vaultWrite(verified, "depositNative", [], amount, {
    action: "deposit",
    roundId: null,
    asset: ZERO_ADDRESS,
    amount,
    spender: null,
    account: null,
  });
}

/** `Vault.deposit(asset, amount)` for a listed ERC-20. The approval is a separate step (SPEC §9.5). */
export function prepareDeposit(verified: VerifiedDeployment, asset: Address, amount: bigint): PreparedWrite {
  requirePositive(amount, "amount");
  const record = assetRecord(verified, asset);
  if (record.native || asset === ZERO_ADDRESS) {
    throw new WriteError("WrongAssetKind", "the native asset is deposited with prepareDepositNative");
  }
  if (!record.listed) {
    throw new WriteError("AssetNotListed", `${asset} is not listed on this deployment`);
  }
  return vaultWrite(verified, "deposit", [asset, amount], 0n, {
    action: "deposit",
    roundId: null,
    asset,
    amount,
    spender: null,
    account: null,
  });
}

/**
 * `Vault.withdraw(asset, amount)`.
 *
 * No USD minimum: SPEC §9.5 says "Withdraw has no USD 1 minimum: any positive representable available amount
 * is allowed". Unlike a deposit this does not require the asset to be listed, because an exit must stay
 * available whatever the deposit switches say (SPEC §8.1: pausing "never stops financial exits").
 */
export function prepareWithdraw(verified: VerifiedDeployment, asset: Address, amount: bigint): PreparedWrite {
  requirePositive(amount, "amount");
  // Deliberately not `assetRecord`: an asset dropped from the manifest must still be withdrawable, because
  // nothing in the app may stop a financial exit (SPEC §8.1). The Vault itself rejects an unknown asset.
  requireAddress(asset, "asset");
  return vaultWrite(verified, "withdraw", [asset, amount], 0n, {
    action: "withdraw",
    roundId: null,
    asset,
    amount,
    spender: null,
    account: null,
  });
}

/**
 * ERC-20 `approve(spender, amount)` with the spender fixed to the manifest Vault.
 *
 * SPEC §5.3 and §9.5: "no wallet approval is used in buy and no allowance to Draw is ever requested", "no
 * unlimited default approval". The spender is not a parameter, so a caller cannot approve anything else, and
 * `amount` is the exact intended amount - or zero, which is the reset step of the two-step sequence.
 */
export function prepareApprove(verified: VerifiedDeployment, token: Address, amount: bigint): PreparedWrite {
  requireUint256(amount, "amount");
  if (amount >= MAX_EXACT_APPROVAL) {
    throw new WriteError(
      "InvalidAmount",
      "an unlimited or sentinel approval is never requested; approve the exact deposit amount (SPEC §9.5)",
    );
  }
  const record = assetRecord(verified, token);
  if (record.native || token === ZERO_ADDRESS) {
    throw new WriteError("WrongAssetKind", "the native asset has no allowance");
  }
  const spender = verified.vault;
  return {
    contract: "erc20",
    to: token,
    data: asHex(erc20Interface.encodeFunctionData("approve", [spender, amount])),
    value: 0n,
    function: "approve",
    args: [spender, amount],
    summary: {
      action: "approve",
      contract: "erc20",
      function: "approve",
      roundId: null,
      asset: token,
      amount,
      spender,
      account: null,
    },
  };
}

/**
 * `Vault.authorizeSeed(asset, maxPerRound)`: the seed Safe's own consent, per asset (SPEC §5.4, D9).
 *
 * Consent is not a blanket permission: the cap is in the raw units of one listed asset, so a cap sized for
 * BNB grants nothing in a 2-decimal token pool, and zero revokes that asset alone. The asset is therefore a
 * required argument and reaches the decoded summary of SPEC §9.6, which must name the asset the signer is
 * consenting for; a summary that showed only a number could not distinguish 500 TEST2 from 500 wei.
 *
 * The Vault reverts `InvalidAsset` for an asset it never listed, so an asset outside the deployment's
 * manifest, or one the manifest records as unlisted, is refused here before any calldata exists. The zero
 * address is not rejected: it is the native-BNB sentinel of SPEC §4.2 and a native pool's seed is authorized
 * under it like any other asset.
 */
export function prepareAuthorizeSeed(
  verified: VerifiedDeployment,
  asset: Address,
  maxPerRound: bigint,
): PreparedWrite {
  requireUint256(maxPerRound, "maxPerRound");
  const record = assetRecord(verified, asset);
  if (!record.listed) {
    throw new WriteError("AssetNotListed", `${asset} is not listed on this deployment`);
  }
  return vaultWrite(verified, "authorizeSeed", [asset, maxPerRound], 0n, {
    action: "authorizeSeed",
    roundId: null,
    asset,
    amount: maxPerRound,
    spender: null,
    account: null,
  });
}

// ---------------------------------------------------------------------------
// Builders: Draw
// ---------------------------------------------------------------------------

/** The four `buy` arguments, produced by `entryFromQuote` (SPEC §5.3). */
export type BuyParams = {
  roundId: bigint;
  /**
   * The round's asset, shown in the decoded summary (SPEC §9.6 names the asset before every prompt). It is
   * not a `buy` argument (the round fixes it), so it never reaches the calldata.
   */
  asset: Address;
  /** Gross raw units, fee reserve included. */
  gross: bigint;
  /** `max(0, quotedNetDelta - 1)`: tolerates fee rounding and order movement only (SPEC §9.5). */
  minNetContribution: bigint;
  /** uint64 seconds; the transaction reverts `DeadlineExpired` after it. */
  deadline: bigint;
};

/** `Draw.buy(roundId, grossAmount, minNetContribution, deadline)` (SPEC §5.3). */
export function prepareBuy(verified: VerifiedDeployment, params: BuyParams): PreparedWrite {
  requireId(params.roundId, "roundId");
  // The summary names the asset (SPEC §9.6), so it must be one of the deployment's, not any address.
  assetRecord(verified, params.asset);
  requirePositive(params.gross, "gross");
  requireUint256(params.minNetContribution, "minNetContribution");
  requireDeadline(params.deadline);
  if (params.minNetContribution > params.gross) {
    throw new WriteError(
      "GuardAboveGross",
      `minNetContribution ${params.minNetContribution} is above the gross ${params.gross}, which can never pass`,
    );
  }
  const args = [params.roundId, params.gross, params.minNetContribution, params.deadline] as const;
  return drawWrite(verified, "buy", args, {
    action: "enter",
    roundId: params.roundId,
    asset: params.asset,
    amount: params.gross,
    spender: null,
    account: null,
  });
}

/** `Draw.closeRound(roundId)`: anyone may call it after the cutoff (SPEC §6.2, §9.6). */
export function prepareCloseRound(verified: VerifiedDeployment, roundId: bigint): PreparedWrite {
  requireId(roundId, "roundId");
  return drawWrite(verified, "closeRound", [roundId], {
    action: "closeRound",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}

/** `Draw.requestDraw(roundId)`. */
export function prepareRequestDraw(verified: VerifiedDeployment, roundId: bigint): PreparedWrite {
  requireId(roundId, "roundId");
  return drawWrite(verified, "requestDraw", [roundId], {
    action: "requestDraw",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}

/** `Draw.expireUnrequested(roundId)`: enables full refunds once the request window closed (SPEC §6.2). */
export function prepareExpireUnrequested(verified: VerifiedDeployment, roundId: bigint): PreparedWrite {
  requireId(roundId, "roundId");
  return drawWrite(verified, "expireUnrequested", [roundId], {
    action: "expireUnrequested",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}

/** `Draw.settle(roundId)`. */
export function prepareSettle(verified: VerifiedDeployment, roundId: bigint): PreparedWrite {
  requireId(roundId, "roundId");
  return drawWrite(verified, "settle", [roundId], {
    action: "settle",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}

/** `Draw.claimRefund(roundId, account)`: credits the named buyer, and anyone may call it (SPEC §8.1). */
export function prepareClaimRefund(
  verified: VerifiedDeployment,
  roundId: bigint,
  account: Address,
): PreparedWrite {
  requireId(roundId, "roundId");
  requireAddress(account, "account");
  if (account === ZERO_ADDRESS) {
    throw new WriteError("InvalidAddress", "the refund recipient must not be the zero address");
  }
  return drawWrite(verified, "claimRefund", [roundId, account], {
    action: "claimRefund",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account,
  });
}

/** `Draw.seedRound(roundId)`: the keeper's explicit seed, which reverts rather than skipping (SPEC §5.4). */
export function prepareSeedRound(verified: VerifiedDeployment, roundId: bigint): PreparedWrite {
  requireId(roundId, "roundId");
  return drawWrite(verified, "seedRound", [roundId], {
    action: "seedRound",
    roundId,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}

/** `Draw.ensureCurrent(poolId, kind)`: opens the pool's next round of that kind when none is open. */
export function prepareEnsureCurrent(
  verified: VerifiedDeployment,
  poolId: bigint,
  kind: Kind,
): PreparedWrite {
  requireId(poolId, "poolId");
  if (!Number.isInteger(kind) || kind < 0 || kind >= KindNames.length) {
    throw new WriteError("InvalidKind", `kind must be 0..${KindNames.length - 1}, received ${String(kind)}`);
  }
  return drawWrite(verified, "ensureCurrent", [poolId, kind], {
    action: "ensureCurrent",
    roundId: null,
    asset: null,
    amount: null,
    spender: null,
    account: null,
  });
}
