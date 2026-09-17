// Deployment verification (SPEC §15: "Validate manifest chain/address agreement before any UI signs; block
// writes on missing/mismatched deployment code", and §12: "every service asserts eth_chainId equals the
// manifest chainId at start-up and after any RPC failover, halting on mismatch").
//
// `verifyDeployment` is the only producer of `VerifiedDeployment`, and every read and write adapter takes a
// `VerifiedDeployment` rather than a `DeploymentManifest`, so a consumer cannot sign against an unverified
// manifest by construction.

import {Interface, keccak256} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {toBigInt} from "../abi/normalize.ts";
import {type Address, asAddress, type Hex32, isHex} from "../types/common.ts";
import type {DeploymentManifest} from "./manifest.ts";

/**
 * The provider surface verification needs. An ethers `JsonRpcProvider` satisfies it structurally.
 *
 * `blockTag` is passed both inside the transaction object and as the second argument: ethers v6 declares
 * `call(tx)` with one parameter and reads `tx.blockTag`, while a hand-written provider following this type
 * reads the second argument. Passing both keeps either implementation pinned to the same block.
 */
export type VerifyProvider = {
  getNetwork(): Promise<{chainId: bigint | number | string}>;
  getCode(address: string, blockTag?: string): Promise<string>;
  call(tx: {to: string; data: string; blockTag?: string}, blockTag?: string): Promise<string>;
  getBlockNumber?(): Promise<number>;
};

export type VerifyOptions = {
  /** Block the whole verification is pinned to. Defaults to `latest`. */
  blockTag?: string;
  /** Recorded as `verifiedAtBlock` when the provider cannot report a block number. */
  blockNumber?: bigint;
};

export type VerifiedContract = "vault" | "draw";

export type VerifyCheckName =
  | "chainId"
  | "vaultCode"
  | "drawCode"
  | "vaultCodeHash"
  | "drawCodeHash"
  | "drawBinding"
  | "vaultBinding";

export type VerifyCheck = {name: VerifyCheckName; detail: string};

export type VerifyFailure =
  | {kind: "ChainMismatch"; expected: bigint; actual: bigint}
  | {kind: "MissingCode"; contract: VerifiedContract; address: Address}
  | {kind: "CodeHashMismatch"; contract: VerifiedContract; address: Address; expected: Hex32; actual: Hex32}
  | {kind: "BindingMismatch"; contract: VerifiedContract; method: string; expected: Address; actual: Address}
  | {kind: "CallFailed"; contract: VerifiedContract; method: string; message: string}
  | {kind: "ProviderFailed"; step: "getNetwork" | "getCode"; message: string};

/** Only `verifyDeployment` produces this. Reads and writes require it as their argument type. */
export type VerifiedDeployment = {
  manifest: DeploymentManifest;
  chainId: bigint;
  /** The block the checks ran against, when the provider could report one. */
  verifiedAtBlock: bigint | null;
  vault: Address;
  draw: Address;
  checks: readonly VerifyCheck[];
};

export type VerifyResult = {ok: true; verified: VerifiedDeployment} | {ok: false; failure: VerifyFailure};

/** Thrown by `assertSameChain`, which halts by contract of its name; `verifyDeployment` returns instead. */
export class DeploymentVerificationError extends Error {
  readonly failure: VerifyFailure;

  constructor(failure: VerifyFailure) {
    super(describeFailure(failure));
    this.name = "DeploymentVerificationError";
    this.failure = failure;
  }
}

/** A one-line, user-showable description. SPEC §8.1: never a raw stack trace in the app. */
export function describeFailure(failure: VerifyFailure): string {
  switch (failure.kind) {
    case "ChainMismatch":
      return `connected chain ${failure.actual} does not match the manifest chain ${failure.expected}`;
    case "MissingCode":
      return `no contract code at the manifest ${failure.contract} address ${failure.address}`;
    case "CodeHashMismatch":
      return (
        `the ${failure.contract} at ${failure.address} does not match the manifest code hash ` +
        `(expected ${failure.expected}, found ${failure.actual})`
      );
    case "BindingMismatch":
      return (
        `${failure.contract}.${failure.method} returned ${failure.actual}, ` +
        `but the manifest says ${failure.expected}`
      );
    case "CallFailed":
      return `${failure.contract}.${failure.method} could not be read: ${failure.message}`;
    case "ProviderFailed":
      return `the node could not be reached for ${failure.step}: ${failure.message}`;
  }
}

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// LuckyDraw exposes its bound Vault as the public immutable `VAULT()`; LuckyVault exposes `draw()`.
const DRAW_VAULT_METHOD = "VAULT";
const VAULT_DRAW_METHOD = "draw";

async function readAddress(
  provider: VerifyProvider,
  contract: VerifiedContract,
  target: Address,
  iface: Interface,
  method: string,
  blockTag: string,
): Promise<{ok: true; value: Address} | {ok: false; failure: VerifyFailure}> {
  let raw: string;
  try {
    const data = iface.encodeFunctionData(method, []);
    raw = await provider.call({to: target, data, blockTag}, blockTag);
  } catch (error) {
    return {ok: false, failure: {kind: "CallFailed", contract, method, message: errorMessage(error)}};
  }
  try {
    const decoded = iface.decodeFunctionResult(method, raw);
    return {ok: true, value: asAddress(decoded[0])};
  } catch (error) {
    return {ok: false, failure: {kind: "CallFailed", contract, method, message: errorMessage(error)}};
  }
}

/**
 * Runs the SPEC §15 pre-sign checks in order and stops at the first failure:
 *
 *  1. the connected chain id equals the manifest chain id;
 *  2. both the Vault and the Draw have code at their manifest addresses;
 *  3. keccak256 of each deployed runtime code equals the manifest `codeHash`;
 *  4. the Draw's bound Vault is the manifest Vault and the Vault's bound Draw is the manifest Draw.
 *
 * Failures are returned, never thrown, so the caller can render them from the string catalog.
 */
export async function verifyDeployment(
  provider: VerifyProvider,
  manifest: DeploymentManifest,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const blockTag = options?.blockTag ?? "latest";
  const checks: VerifyCheck[] = [];

  let network: {chainId: bigint | number | string};
  try {
    network = await provider.getNetwork();
  } catch (error) {
    return {ok: false, failure: {kind: "ProviderFailed", step: "getNetwork", message: errorMessage(error)}};
  }
  // A hand-written provider may report the chain id as a number or a hex string; the manifest holds a bigint.
  // Anything else is a provider failure to return, not a TypeError to throw: this function never throws.
  let chainId: bigint;
  try {
    chainId = toBigInt(network.chainId);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "ProviderFailed",
        step: "getNetwork",
        message: `unusable chain id ${String(network.chainId)}: ${errorMessage(error)}`,
      },
    };
  }
  if (chainId !== manifest.chain.chainId) {
    return {ok: false, failure: {kind: "ChainMismatch", expected: manifest.chain.chainId, actual: chainId}};
  }
  checks.push({name: "chainId", detail: `chain ${chainId}`});

  const targets: readonly {contract: VerifiedContract; address: Address; codeHash: Hex32}[] = [
    {
      contract: "vault",
      address: manifest.contracts.vault.address,
      codeHash: manifest.contracts.vault.codeHash,
    },
    {contract: "draw", address: manifest.contracts.draw.address, codeHash: manifest.contracts.draw.codeHash},
  ];

  const codes: {contract: VerifiedContract; address: Address; codeHash: Hex32; code: string}[] = [];
  for (const target of targets) {
    let code: string;
    try {
      code = await provider.getCode(target.address, blockTag);
    } catch (error) {
      return {ok: false, failure: {kind: "ProviderFailed", step: "getCode", message: errorMessage(error)}};
    }
    // `getCode` answers hex bytes; anything else (null, no `0x`, an odd length, a number) is a provider
    // failure to return, not a `keccak256` exception to throw.
    if (!isHex(code)) {
      return {
        ok: false,
        failure: {
          kind: "ProviderFailed",
          step: "getCode",
          message: `malformed code for ${target.address}: ${String(code).slice(0, 24)}`,
        },
      };
    }
    if (code.length <= 2) {
      return {ok: false, failure: {kind: "MissingCode", contract: target.contract, address: target.address}};
    }
    codes.push({...target, code});
    checks.push({
      name: target.contract === "vault" ? "vaultCode" : "drawCode",
      detail: `${(code.length - 2) / 2} bytes at ${target.address}`,
    });
  }

  for (const target of codes) {
    const actual = keccak256(target.code).toLowerCase() as Hex32;
    if (actual !== target.codeHash) {
      return {
        ok: false,
        failure: {
          kind: "CodeHashMismatch",
          contract: target.contract,
          address: target.address,
          expected: target.codeHash,
          actual,
        },
      };
    }
    checks.push({
      name: target.contract === "vault" ? "vaultCodeHash" : "drawCodeHash",
      detail: actual,
    });
  }

  const drawVault = await readAddress(
    provider,
    "draw",
    manifest.contracts.draw.address,
    drawInterface,
    DRAW_VAULT_METHOD,
    blockTag,
  );
  if (!drawVault.ok) return {ok: false, failure: drawVault.failure};
  if (drawVault.value !== manifest.contracts.vault.address) {
    return {
      ok: false,
      failure: {
        kind: "BindingMismatch",
        contract: "draw",
        method: DRAW_VAULT_METHOD,
        expected: manifest.contracts.vault.address,
        actual: drawVault.value,
      },
    };
  }
  checks.push({name: "drawBinding", detail: `draw.${DRAW_VAULT_METHOD}() == ${drawVault.value}`});

  const vaultDraw = await readAddress(
    provider,
    "vault",
    manifest.contracts.vault.address,
    vaultInterface,
    VAULT_DRAW_METHOD,
    blockTag,
  );
  if (!vaultDraw.ok) return {ok: false, failure: vaultDraw.failure};
  if (vaultDraw.value !== manifest.contracts.draw.address) {
    return {
      ok: false,
      failure: {
        kind: "BindingMismatch",
        contract: "vault",
        method: VAULT_DRAW_METHOD,
        expected: manifest.contracts.draw.address,
        actual: vaultDraw.value,
      },
    };
  }
  checks.push({name: "vaultBinding", detail: `vault.${VAULT_DRAW_METHOD}() == ${vaultDraw.value}`});

  // The block the checks ran against: the explicit option, else the pinned numeric tag, else the head when
  // the tag was `latest`. A symbolic tag such as `finalized` without a block number stays null.
  let verifiedAtBlock: bigint | null = options?.blockNumber ?? null;
  if (verifiedAtBlock === null && /^0x[0-9a-fA-F]+$/.test(blockTag)) verifiedAtBlock = BigInt(blockTag);
  if (verifiedAtBlock === null && blockTag === "latest" && typeof provider.getBlockNumber === "function") {
    try {
      verifiedAtBlock = BigInt(await provider.getBlockNumber());
    } catch {
      verifiedAtBlock = null;
    }
  }

  return {
    ok: true,
    verified: {
      manifest,
      chainId,
      verifiedAtBlock,
      vault: manifest.contracts.vault.address,
      draw: manifest.contracts.draw.address,
      checks,
    },
  };
}

/**
 * Re-checks the connected chain id against an already verified deployment. SPEC §10.1 requires this after
 * every RPC failover; SPEC §12 requires halting on mismatch, so this one throws rather than returning.
 */
export async function assertSameChain(provider: VerifyProvider, verified: VerifiedDeployment): Promise<void> {
  const network = await provider.getNetwork();
  const actual = toBigInt(network.chainId);
  if (actual !== verified.chainId) {
    throw new DeploymentVerificationError({kind: "ChainMismatch", expected: verified.chainId, actual});
  }
}

/** True when the value is a `VerifiedDeployment` rather than a bare manifest. */
export function isVerifiedDeployment(
  value: DeploymentManifest | VerifiedDeployment,
): value is VerifiedDeployment {
  return Object.hasOwn(value, "manifest");
}

/** The manifest behind either shape, so a helper can accept both. */
export function manifestOf(value: DeploymentManifest | VerifiedDeployment): DeploymentManifest {
  return isVerifiedDeployment(value) ? value.manifest : value;
}
