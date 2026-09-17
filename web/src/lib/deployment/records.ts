// Loading the pinned deployment manifest and its chain record from `config/` (SPEC §12, §15).
//
// Both trees are pulled in with `import.meta.glob(..., {eager: true})`, so the JSON is part of the bundle and
// there is no runtime fetch of configuration: an attacker who can answer a network request cannot change
// which contract the app signs against. `web/vite.config.ts` already refuses to build when the selected
// manifest is missing; the lookups below throw with the same detail so dev and test fail the same way.
//
// The manifest is parsed with the client's `parseManifest`, which is the only parser in the repo that turns
// these documents into bigints and lowercased addresses. The chain record has no client parser (it is not a
// deployment document), so the few fields the app needs are read and checked here.

import {type DeploymentManifest, parseManifest} from "@luckydraw/client";

/** Thrown when a configuration record is absent or disagrees with the build's environment variables. */
export class DeploymentRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentRecordError";
  }
}

/** The part of `config/chains/<chainId>.json` the app uses. Everything else is deployment-manifest data. */
export type ChainRecord = {
  chainId: bigint;
  /** Stable slug (`bsc-testnet`), for logs, the Verify page and ethers' Network name. */
  name: string;
  /** What the app calls the network to a player: the network guard, the Switch button, `wallet_addEthereumChain`. */
  displayName: string;
  nativeSymbol: string;
  explorerUrl: string | null;
  confirmationDepth: bigint;
  finalityTag: string | null;
  /** Canonical Multicall3 when the operator verified one against this chain; null otherwise (SPEC §10.1). */
  multicall3: string | null;
  /** Name of the environment variable that carries the public RPC URL. */
  publicRpcEnvVar: string | null;
};

const manifestModules = import.meta.glob("../../../../config/deployments/**/*.json", {
  eager: true,
  import: "default",
}) as Readonly<Record<string, unknown>>;

const chainModules = import.meta.glob("../../../../config/chains/*.json", {
  eager: true,
  import: "default",
}) as Readonly<Record<string, unknown>>;

function moduleBySuffix(modules: Readonly<Record<string, unknown>>, suffix: string, what: string): unknown {
  const keys = Object.keys(modules).filter((key) => key.endsWith(suffix));
  const key = keys[0];
  if (key === undefined) {
    throw new DeploymentRecordError(
      `No ${what} at config${suffix} in this build. Known records: ${Object.keys(modules).join(", ") || "none"}.`,
    );
  }
  if (keys.length > 1) {
    throw new DeploymentRecordError(`More than one ${what} matches config${suffix}: ${keys.join(", ")}.`);
  }
  return modules[key];
}

/**
 * The manifest for one deployment. `chainIdText` and `drawAddress` come from the build environment and must
 * agree with the document's own `deploymentId`, which is the `${chainId}:${lowercase draw}` form of §10.1.
 */
export function loadManifest(chainIdText: string, drawAddress: string): DeploymentManifest {
  // SPEC §12 names a manifest by the lowercase Draw address. Anything else in that directory is an operator
  // plan or a template, and must never be reachable as a deployment.
  if (!/^0x[0-9a-f]{40}$/.test(drawAddress)) {
    throw new DeploymentRecordError(
      `A deployment manifest is named by its lowercase Draw address; ${JSON.stringify(drawAddress)} is not one.`,
    );
  }
  const raw = moduleBySuffix(
    manifestModules,
    `/deployments/${chainIdText}/${drawAddress}.json`,
    "deployment manifest",
  );
  const manifest = parseManifest(raw);
  const expectedId = `${chainIdText}:${drawAddress}`;
  if (manifest.deploymentId !== expectedId) {
    throw new DeploymentRecordError(
      `The manifest at config/deployments/${chainIdText}/${drawAddress}.json declares deploymentId ` +
        `${manifest.deploymentId}, but the build selected ${expectedId}.`,
    );
  }
  if (manifest.contracts.draw.address !== drawAddress) {
    throw new DeploymentRecordError(
      `The manifest file name says draw ${drawAddress} but the document says ` +
        `${manifest.contracts.draw.address}.`,
    );
  }
  return manifest;
}

function stringOrNull(source: Record<string, unknown>, key: string, path: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DeploymentRecordError(`${path} must be a string or null.`);
  return value;
}

/** The chain record for one chain id, with the handful of fields the app reads validated. */
export function loadChainRecord(chainIdText: string): ChainRecord {
  const raw = moduleBySuffix(chainModules, `/chains/${chainIdText}.json`, "chain record");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DeploymentRecordError(`config/chains/${chainIdText}.json must be a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  const chainId = record.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
    throw new DeploymentRecordError(`config/chains/${chainIdText}.json: chainId must be an integer.`);
  }
  if (String(chainId) !== chainIdText) {
    throw new DeploymentRecordError(
      `config/chains/${chainIdText}.json declares chainId ${chainId}, which is not its file name.`,
    );
  }
  const depth = record.confirmationDepth;
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) {
    throw new DeploymentRecordError(
      `config/chains/${chainIdText}.json: confirmationDepth must be a non-negative integer.`,
    );
  }
  const identity = record.networkIdentity;
  const multicall3 =
    identity !== null && typeof identity === "object"
      ? stringOrNull(identity as Record<string, unknown>, "multicall3", "networkIdentity.multicall3")
      : null;
  const rpcEnvVars = record.rpcEnvVars;
  const publicRpcEnvVar =
    rpcEnvVars !== null && typeof rpcEnvVars === "object"
      ? stringOrNull(rpcEnvVars as Record<string, unknown>, "public", "rpcEnvVars.public")
      : null;
  // A missing display name is refused rather than defaulted: on a chain 97 build, "BNB Smart Chain" would
  // send a player to mainnet, and a bare chain id says nothing to someone reading a wallet prompt.
  const displayName = stringOrNull(record, "displayName", "displayName");
  if (displayName === null) {
    throw new DeploymentRecordError(
      `config/chains/${chainIdText}.json: displayName is required; it is what the app calls the network.`,
    );
  }
  return {
    chainId: BigInt(chainId),
    name: stringOrNull(record, "name", "name") ?? chainIdText,
    displayName,
    nativeSymbol: stringOrNull(record, "nativeSymbol", "nativeSymbol") ?? "BNB",
    explorerUrl: stringOrNull(record, "explorerUrl", "explorerUrl"),
    confirmationDepth: BigInt(depth),
    finalityTag: stringOrNull(record, "finalityTag", "finalityTag"),
    multicall3: multicall3 === null ? null : multicall3.toLowerCase(),
    publicRpcEnvVar,
  };
}
