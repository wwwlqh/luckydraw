// Deployment manifest parsing (SPEC §12 and §15).
//
// A manifest is the only thing that tells the app which Vault and Draw to talk to, which assets exist and
// which of them are listed. SPEC §15: "Validate manifest chain/address agreement before any UI signs" and
// "Load only listed deployment assets". This module turns the JSON document into a typed record with a
// bigint for every chain integer and a lowercase string for every address, and rejects anything that does
// not agree with itself.
//
// It deliberately does not use ajv or the JSON schemas: they stay the concern of scripts/validate_config.ts,
// which runs in CI, and the browser bundle must not carry a schema compiler. The checks below are the subset
// a consumer must repeat at load time, plus the cross-field rules that decide whether it is safe to sign.
//
// Every key is read as an own property. JSON.parse produces objects inheriting Object.prototype, so a naive
// `record.constructor` check can never be undefined; SPEC §12 names the Draw's arguments `constructorArgs`
// for exactly that reason, and `own()` makes the inherited name unusable here too.

import {type Address, type Hex32, isAddress, MAX_UINT256, ZERO_ADDRESS} from "../types/common.ts";
import {type KindName, KindNames, type ReferenceKindName} from "../types/generated.ts";

/** Rejection with the path of the offending field, for example `contracts.draw.constructorArgs`. */
export class ManifestError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ManifestError";
    this.path = path;
  }
}

export type Environment = "local" | "testnet" | "mainnet";

export type ManifestSource = {url: string | null; date: string | null};

export type ManifestChain = {
  chainId: bigint;
  name: string;
  nativeSymbol: string | null;
  explorerUrl: string | null;
  confirmationDepth: bigint;
  /** Scan lower bound, never an equality (SPEC §12: `Finalize` replaces it with the broadcast receipt). */
  startBlock: bigint;
  finalityTag: string | null;
  /** Names of the environment variables carrying the RPC URLs. The URLs themselves are never committed. */
  rpcEnvVars: Readonly<Record<string, string>>;
};

export type ManifestToolchain = {
  foundry: string;
  solc: string;
  evmVersion: string;
  optimizer: boolean;
  optimizerRuns: bigint;
  viaIr: boolean;
  bytecodeHash: string;
};

export type ContractRecord = {
  address: Address;
  /** keccak256 of the deployed runtime code; writes are blocked on a mismatch (SPEC §15, ACCEPTANCE U15). */
  codeHash: Hex32;
  deployBlock: bigint;
  deployTx: Hex32 | null;
  owner: Address;
  pendingOwner: Address;
};

export type DrawConstructorArgs = {
  vault: Address;
  coordinator: Address;
  subscriptionId: bigint;
  keyHash: Hex32;
  requestConfirmations: bigint;
  callbackGasLimit: bigint;
  maxRequestCostNative: bigint;
  feeAccount: Address;
  initialOwner: Address;
};

export type DrawContractRecord = ContractRecord & {constructorArgs: DrawConstructorArgs};

export type ManifestVrf = {
  coordinator: Address;
  coordinatorIsMock: boolean;
  subscriptionId: bigint;
  subscriptionOwner: Address | null;
  keyHash: Hex32;
  nativeBilling: boolean | null;
  requestConfirmations: bigint;
  numWords: bigint;
  callbackGasLimit: bigint;
  maxRequestCostNative: bigint;
  lowFundingThresholdNative: bigint;
  consumerRegistered: boolean | null;
  consumerRegistrationTx: Hex32 | null;
  keyHashGetter: string | null;
  measuredCallbackGasUsed: bigint | null;
};

export type ManifestOwnership = {
  finalOwner: Address;
  feeAccount: Address;
  seedAccount: Address;
  ownershipAccepted: boolean | null;
  makeWholeReserve: bigint | null;
  makeWholeCap: bigint | null;
  note: string | null;
};

export type ManifestPrice = {
  feed: Address | null;
  feedIsMock: boolean;
  feedDecimals: bigint;
  baseQuote: string;
  heartbeatSeconds: bigint | null;
  observedP999IntervalSeconds: bigint | null;
  maxPriceAge: bigint;
  minAnswer: bigint;
  maxAnswer: bigint;
  answerBoundsConfirmedAbsent: boolean;
  referenceKind: ReferenceKindName;
  displayLabel: string | null;
  pegAssumption: string | null;
  verifiedOn: string | null;
  source: ManifestSource;
};

export type ManifestPool = {
  poolId: bigint;
  enabled: boolean;
  /** Raw asset units; 0 disables seeding for this pool (SPEC §5.4). */
  seedAmount: bigint;
  /**
   * The cap the seed account itself set with `Vault.authorizeSeed(asset, maxPerRound)` for THIS asset; null
   * when it has not authorized this asset. Consent is per asset (SPEC §5.4), which is why the field lives on
   * the asset's pool record and not on `ownership`.
   */
  seedAuthorizedMaxPerRound: bigint | null;
  /** Whole-USD target per kind, keyed by `KindName` (Types.sol Kind order). */
  targetsUsd: Readonly<Record<KindName, bigint>>;
  /** The seven round ids `addPool` created, in Kind order. */
  firstRoundIds: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
};

export type ManifestAsset = {
  asset: Address;
  native: boolean;
  symbol: string;
  name: string;
  decimals: bigint;
  isMock: boolean;
  /** `Vault.listAsset` has been called. SPEC §15: load only listed deployment assets. */
  listed: boolean;
  depositsEnabled: boolean;
  exactTransferEvidence: string | null;
  /**
   * SPEC §9.5: "offer approve(amount), or approve(0) then approve(amount) for tokens flagged
   * requiresZeroReset in the asset manifest". Optional in the document and false when absent, because only a
   * USDT-style `approve` that reverts on a nonzero-to-nonzero change needs the extra step.
   */
  requiresZeroReset: boolean;
  status: string;
  source: ManifestSource;
  price: ManifestPrice;
  pool: ManifestPool;
};

export type DeploymentManifest = {
  schemaVersion: bigint;
  /** `${chainId}:${lowercase Draw address}` (SPEC §10.1, §12). */
  deploymentId: string;
  environment: Environment;
  createdAtUtc: string;
  notes: string | null;
  chain: ManifestChain;
  toolchain: ManifestToolchain;
  contracts: {vault: ContractRecord; draw: DrawContractRecord};
  vrf: ManifestVrf;
  ownership: ManifestOwnership;
  assets: readonly ManifestAsset[];
  /** Artifact names of the labeled mocks. Must be empty outside `local` (SPEC §12). */
  mocks: readonly string[];
};

// ---------------------------------------------------------------------------
// Field readers. Each one names the path it failed at.
// ---------------------------------------------------------------------------

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.hasOwn(value as object, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function objectAt(parent: unknown, key: string, path: string): Record<string, unknown> {
  const value = own(parent, key);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function stringAt(parent: unknown, key: string, path: string): string {
  const value = own(parent, key);
  if (typeof value !== "string") throw new ManifestError(path, "expected a string");
  return value;
}

function optionalStringAt(parent: unknown, key: string, path: string): string | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ManifestError(path, "expected a string or null");
  return value;
}

function boolAt(parent: unknown, key: string, path: string): boolean {
  const value = own(parent, key);
  if (typeof value !== "boolean") throw new ManifestError(path, "expected a boolean");
  return value;
}

function optionalBoolAt(parent: unknown, key: string, path: string): boolean | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new ManifestError(path, "expected a boolean or null");
  return value;
}

/** A JSON integer (block numbers, decimals, confirmations) read as a bigint: no chain integer is a number. */
function integerAt(parent: unknown, key: string, path: string): bigint {
  const value = own(parent, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ManifestError(path, "expected a non-negative safe integer");
  }
  return BigInt(value);
}

function optionalIntegerAt(parent: unknown, key: string, path: string): bigint | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  return integerAt(parent, key, path);
}

const UINT_STRING_RE = /^(0|[1-9][0-9]{0,77})$/;

/** A uint256 written as a decimal string (SPEC §10.1: never a JS number, never floating point). */
function uintStringAt(parent: unknown, key: string, path: string): bigint {
  const value = own(parent, key);
  if (typeof value !== "string") throw new ManifestError(path, "expected a decimal uint256 string");
  if (!UINT_STRING_RE.test(value)) throw new ManifestError(path, `not a decimal uint256 string: ${value}`);
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new ManifestError(path, "value exceeds 2^256-1");
  return parsed;
}

function optionalUintStringAt(parent: unknown, key: string, path: string): bigint | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  return uintStringAt(parent, key, path);
}

const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const LOWER_BYTES32_RE = /^0x[0-9a-f]{64}$/;

/** Manifest addresses are stored lowercase (SPEC §10.1); a mixed-case address is a rejection, not a fixup. */
function addressAt(parent: unknown, key: string, path: string): Address {
  const value = own(parent, key);
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ManifestError(path, "expected an address (0x + 40 hex)");
  }
  if (!LOWER_ADDRESS_RE.test(value)) throw new ManifestError(path, `address must be lowercase: ${value}`);
  return value as Address;
}

function optionalAddressAt(parent: unknown, key: string, path: string): Address | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  return addressAt(parent, key, path);
}

function bytes32At(parent: unknown, key: string, path: string): Hex32 {
  const value = own(parent, key);
  if (typeof value !== "string" || !LOWER_BYTES32_RE.test(value)) {
    throw new ManifestError(path, "expected a lowercase bytes32 (0x + 64 hex)");
  }
  return value as Hex32;
}

function optionalBytes32At(parent: unknown, key: string, path: string): Hex32 | null {
  const value = own(parent, key);
  if (value === undefined || value === null) return null;
  return bytes32At(parent, key, path);
}

function arrayAt(parent: unknown, key: string, path: string): unknown[] {
  const value = own(parent, key);
  if (!Array.isArray(value)) throw new ManifestError(path, "expected an array");
  return value;
}

function sourceAt(parent: unknown, key: string, path: string): ManifestSource {
  const value = own(parent, key);
  if (value === undefined || value === null) return {url: null, date: null};
  if (typeof value !== "object" || Array.isArray(value)) throw new ManifestError(path, "expected an object");
  return {
    url: optionalStringAt(value, "url", `${path}.url`),
    date: optionalStringAt(value, "date", `${path}.date`),
  };
}

const ENVIRONMENTS: readonly string[] = ["local", "testnet", "mainnet"];
const REFERENCE_KINDS: readonly string[] = ["ExactToken", "UnderlyingAsset"];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function parseChain(root: unknown): ManifestChain {
  const chain = objectAt(root, "chain", "chain");
  const envVarsRaw = objectAt(chain, "rpcEnvVars", "chain.rpcEnvVars");
  const rpcEnvVars: Record<string, string> = {};
  for (const key of Object.keys(envVarsRaw)) {
    const value = envVarsRaw[key];
    if (typeof value !== "string") throw new ManifestError(`chain.rpcEnvVars.${key}`, "expected a string");
    rpcEnvVars[key] = value;
  }
  return {
    chainId: integerAt(chain, "chainId", "chain.chainId"),
    name: stringAt(chain, "name", "chain.name"),
    nativeSymbol: optionalStringAt(chain, "nativeSymbol", "chain.nativeSymbol"),
    explorerUrl: optionalStringAt(chain, "explorerUrl", "chain.explorerUrl"),
    confirmationDepth: integerAt(chain, "confirmationDepth", "chain.confirmationDepth"),
    startBlock: integerAt(chain, "startBlock", "chain.startBlock"),
    finalityTag: optionalStringAt(chain, "finalityTag", "chain.finalityTag"),
    rpcEnvVars,
  };
}

function parseToolchain(root: unknown): ManifestToolchain {
  const toolchain = objectAt(root, "toolchain", "toolchain");
  return {
    foundry: stringAt(toolchain, "foundry", "toolchain.foundry"),
    solc: stringAt(toolchain, "solc", "toolchain.solc"),
    evmVersion: stringAt(toolchain, "evmVersion", "toolchain.evmVersion"),
    optimizer: boolAt(toolchain, "optimizer", "toolchain.optimizer"),
    optimizerRuns: integerAt(toolchain, "optimizerRuns", "toolchain.optimizerRuns"),
    viaIr: boolAt(toolchain, "viaIr", "toolchain.viaIr"),
    bytecodeHash: stringAt(toolchain, "bytecodeHash", "toolchain.bytecodeHash"),
  };
}

function parseContractRecord(parent: unknown, key: string, path: string): ContractRecord {
  const record = objectAt(parent, key, path);
  return {
    address: addressAt(record, "address", `${path}.address`),
    codeHash: bytes32At(record, "codeHash", `${path}.codeHash`),
    deployBlock: integerAt(record, "deployBlock", `${path}.deployBlock`),
    deployTx: optionalBytes32At(record, "deployTx", `${path}.deployTx`),
    owner: addressAt(record, "owner", `${path}.owner`),
    pendingOwner: addressAt(record, "pendingOwner", `${path}.pendingOwner`),
  };
}

function parseDrawRecord(contracts: unknown): DrawContractRecord {
  const path = "contracts.draw";
  const base = parseContractRecord(contracts, "draw", path);
  const record = objectAt(contracts, "draw", path);
  // SPEC §12: the arguments are keyed `constructorArgs`, never `constructor`, because every JSON object
  // inherits a `constructor` property and a missing record would otherwise pass a naive presence check.
  const argsPath = `${path}.constructorArgs`;
  if (own(record, "constructorArgs") === undefined) {
    throw new ManifestError(argsPath, "missing; the Draw record must carry its own constructorArgs object");
  }
  const args = objectAt(record, "constructorArgs", argsPath);
  return {
    ...base,
    constructorArgs: {
      vault: addressAt(args, "vault", `${argsPath}.vault`),
      coordinator: addressAt(args, "coordinator", `${argsPath}.coordinator`),
      subscriptionId: uintStringAt(args, "subscriptionId", `${argsPath}.subscriptionId`),
      keyHash: bytes32At(args, "keyHash", `${argsPath}.keyHash`),
      requestConfirmations: integerAt(args, "requestConfirmations", `${argsPath}.requestConfirmations`),
      callbackGasLimit: integerAt(args, "callbackGasLimit", `${argsPath}.callbackGasLimit`),
      maxRequestCostNative: uintStringAt(args, "maxRequestCostNative", `${argsPath}.maxRequestCostNative`),
      feeAccount: addressAt(args, "feeAccount", `${argsPath}.feeAccount`),
      initialOwner: addressAt(args, "initialOwner", `${argsPath}.initialOwner`),
    },
  };
}

function parseVrf(root: unknown): ManifestVrf {
  const vrf = objectAt(root, "vrf", "vrf");
  return {
    coordinator: addressAt(vrf, "coordinator", "vrf.coordinator"),
    coordinatorIsMock: boolAt(vrf, "coordinatorIsMock", "vrf.coordinatorIsMock"),
    subscriptionId: uintStringAt(vrf, "subscriptionId", "vrf.subscriptionId"),
    subscriptionOwner: optionalAddressAt(vrf, "subscriptionOwner", "vrf.subscriptionOwner"),
    keyHash: bytes32At(vrf, "keyHash", "vrf.keyHash"),
    nativeBilling: optionalBoolAt(vrf, "nativeBilling", "vrf.nativeBilling"),
    requestConfirmations: integerAt(vrf, "requestConfirmations", "vrf.requestConfirmations"),
    numWords: integerAt(vrf, "numWords", "vrf.numWords"),
    callbackGasLimit: integerAt(vrf, "callbackGasLimit", "vrf.callbackGasLimit"),
    maxRequestCostNative: uintStringAt(vrf, "maxRequestCostNative", "vrf.maxRequestCostNative"),
    lowFundingThresholdNative: uintStringAt(
      vrf,
      "lowFundingThresholdNative",
      "vrf.lowFundingThresholdNative",
    ),
    consumerRegistered: optionalBoolAt(vrf, "consumerRegistered", "vrf.consumerRegistered"),
    consumerRegistrationTx: optionalBytes32At(vrf, "consumerRegistrationTx", "vrf.consumerRegistrationTx"),
    keyHashGetter: optionalStringAt(vrf, "keyHashGetter", "vrf.keyHashGetter"),
    measuredCallbackGasUsed: optionalIntegerAt(vrf, "measuredCallbackGasUsed", "vrf.measuredCallbackGasUsed"),
  };
}

function parseOwnership(root: unknown): ManifestOwnership {
  const ownership = objectAt(root, "ownership", "ownership");
  return {
    finalOwner: addressAt(ownership, "finalOwner", "ownership.finalOwner"),
    feeAccount: addressAt(ownership, "feeAccount", "ownership.feeAccount"),
    seedAccount: addressAt(ownership, "seedAccount", "ownership.seedAccount"),
    ownershipAccepted: optionalBoolAt(ownership, "ownershipAccepted", "ownership.ownershipAccepted"),
    makeWholeReserve: optionalUintStringAt(ownership, "makeWholeReserve", "ownership.makeWholeReserve"),
    makeWholeCap: optionalUintStringAt(ownership, "makeWholeCap", "ownership.makeWholeCap"),
    note: optionalStringAt(ownership, "note", "ownership.note"),
  };
}

function parsePrice(asset: unknown, path: string): ManifestPrice {
  const price = objectAt(asset, "price", path);
  const referenceKind = stringAt(price, "referenceKind", `${path}.referenceKind`);
  if (!REFERENCE_KINDS.includes(referenceKind)) {
    throw new ManifestError(`${path}.referenceKind`, `expected one of ${REFERENCE_KINDS.join(", ")}`);
  }
  return {
    feed: optionalAddressAt(price, "feed", `${path}.feed`),
    feedIsMock: boolAt(price, "feedIsMock", `${path}.feedIsMock`),
    feedDecimals: integerAt(price, "feedDecimals", `${path}.feedDecimals`),
    baseQuote: stringAt(price, "baseQuote", `${path}.baseQuote`),
    heartbeatSeconds: optionalIntegerAt(price, "heartbeatSeconds", `${path}.heartbeatSeconds`),
    observedP999IntervalSeconds: optionalIntegerAt(
      price,
      "observedP999IntervalSeconds",
      `${path}.observedP999IntervalSeconds`,
    ),
    maxPriceAge: integerAt(price, "maxPriceAge", `${path}.maxPriceAge`),
    minAnswer: uintStringAt(price, "minAnswer", `${path}.minAnswer`),
    maxAnswer: uintStringAt(price, "maxAnswer", `${path}.maxAnswer`),
    answerBoundsConfirmedAbsent:
      optionalBoolAt(price, "answerBoundsConfirmedAbsent", `${path}.answerBoundsConfirmedAbsent`) ?? false,
    referenceKind: referenceKind as ReferenceKindName,
    displayLabel: optionalStringAt(price, "displayLabel", `${path}.displayLabel`),
    pegAssumption: optionalStringAt(price, "pegAssumption", `${path}.pegAssumption`),
    verifiedOn: optionalStringAt(price, "verifiedOn", `${path}.verifiedOn`),
    source: sourceAt(price, "source", `${path}.source`),
  };
}

function parsePool(asset: unknown, path: string): ManifestPool {
  const pool = objectAt(asset, "pool", path);
  const targetsPath = `${path}.targetsUsd`;
  const targets = objectAt(pool, "targetsUsd", targetsPath);
  const ids = arrayAt(pool, "firstRoundIds", `${path}.firstRoundIds`);
  if (ids.length !== KindNames.length) {
    throw new ManifestError(
      `${path}.firstRoundIds`,
      `expected exactly ${KindNames.length} round ids, in Kind order`,
    );
  }
  // Kind order is Types.sol's: Day100, Day1k, Day10k, Week1k, Week10k, Week100k, Month100k. The length
  // check above makes this tuple exact.
  const firstRoundIds = KindNames.map((_name, k) =>
    uintStringAt(ids, String(k), `${path}.firstRoundIds[${k}]`),
  ) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    poolId: uintStringAt(pool, "poolId", `${path}.poolId`),
    enabled: boolAt(pool, "enabled", `${path}.enabled`),
    seedAmount: uintStringAt(pool, "seedAmount", `${path}.seedAmount`),
    seedAuthorizedMaxPerRound: optionalUintStringAt(
      pool,
      "seedAuthorizedMaxPerRound",
      `${path}.seedAuthorizedMaxPerRound`,
    ),
    targetsUsd: Object.fromEntries(
      KindNames.map((name) => [name, integerAt(targets, name, `${targetsPath}.${name}`)]),
    ) as Record<KindName, bigint>,
    firstRoundIds,
  };
}

function parseAsset(entry: unknown, index: number): ManifestAsset {
  const path = `assets[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ManifestError(path, "expected an object");
  }
  const record: ManifestAsset = {
    asset: addressAt(entry, "asset", `${path}.asset`),
    native: boolAt(entry, "native", `${path}.native`),
    symbol: stringAt(entry, "symbol", `${path}.symbol`),
    name: stringAt(entry, "name", `${path}.name`),
    decimals: integerAt(entry, "decimals", `${path}.decimals`),
    isMock: boolAt(entry, "isMock", `${path}.isMock`),
    listed: boolAt(entry, "listed", `${path}.listed`),
    depositsEnabled: boolAt(entry, "depositsEnabled", `${path}.depositsEnabled`),
    exactTransferEvidence: optionalStringAt(entry, "exactTransferEvidence", `${path}.exactTransferEvidence`),
    // Absent means false: the flag is an exception for one token family, never a default (SPEC §9.5). A
    // present value must still be a boolean, so a `"true"` string is a rejection and not a silent truth.
    requiresZeroReset: optionalBoolAt(entry, "requiresZeroReset", `${path}.requiresZeroReset`) ?? false,
    status: stringAt(entry, "status", `${path}.status`),
    source: sourceAt(entry, "source", `${path}.source`),
    price: parsePrice(entry, `${path}.price`),
    pool: parsePool(entry, `${path}.pool`),
  };
  // The same cross-field rules scripts/validate_config.ts enforces: the native flag and the zero-address
  // sentinel agree (SPEC §4.2), and decimals stay within PriceReader's 0-18 (SPEC §3.1), so a formatter's
  // `10n ** decimals` can never throw at render time.
  if (record.native !== (record.asset === ZERO_ADDRESS)) {
    throw new ManifestError(
      `${path}.native`,
      record.native
        ? `true on ${record.asset}, which is not the native sentinel address`
        : "false on the native sentinel address",
    );
  }
  if (record.decimals > 18n)
    throw new ManifestError(`${path}.decimals`, `expected 0-18, found ${record.decimals}`);
  return record;
}

/**
 * The uniqueness rules `scripts/validate_config.ts` enforces (D12, D13, D19, D20), repeated here because a
 * consumer never runs the validator: a duplicate symbol, address or pool id would make `assetBySymbol` or
 * `assetByAddress` resolve to whichever entry comes first, which is a way to sign against the wrong token.
 */
function requireUniqueAssets(assets: readonly ManifestAsset[]): void {
  const seenSymbols = new Map<string, number>();
  const seenAddresses = new Map<string, number>();
  const seenPoolIds = new Map<string, number>();
  const seenRoundIds = new Map<string, number>();
  assets.forEach((asset, index) => {
    const symbol = asset.symbol.toLowerCase();
    const bySymbol = seenSymbols.get(symbol);
    if (bySymbol !== undefined) {
      throw new ManifestError(`assets[${index}].symbol`, `repeats the symbol of assets[${bySymbol}]`);
    }
    seenSymbols.set(symbol, index);

    const byAddress = seenAddresses.get(asset.asset);
    if (byAddress !== undefined) {
      throw new ManifestError(`assets[${index}].asset`, `repeats the address of assets[${byAddress}]`);
    }
    seenAddresses.set(asset.asset, index);

    const poolKey = asset.pool.poolId.toString();
    const byPool = seenPoolIds.get(poolKey);
    if (byPool !== undefined) {
      throw new ManifestError(`assets[${index}].pool.poolId`, `reuses the pool id of assets[${byPool}]`);
    }
    seenPoolIds.set(poolKey, index);

    const ids = asset.pool.firstRoundIds;
    if (!ids.every((id, k) => k === 0 || (ids[k - 1] as bigint) < id)) {
      throw new ManifestError(
        `assets[${index}].pool.firstRoundIds`,
        "the seven first round ids must increase in Kind order (addPool creates them in one transaction)",
      );
    }
    ids.forEach((id, k) => {
      const roundKey = id.toString();
      const byRound = seenRoundIds.get(roundKey);
      if (byRound !== undefined) {
        throw new ManifestError(
          `assets[${index}].pool.firstRoundIds[${k}]`,
          `round id ${id} already belongs to assets[${byRound}]`,
        );
      }
      seenRoundIds.set(roundKey, index);
    });
  });
}

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

/**
 * Parses and validates a deployment manifest. Throws `ManifestError` with the offending `path` on the first
 * violation. Beyond field shapes it enforces the cross-field rules a consumer must not skip:
 *
 *  - `deploymentId` is exactly `${chain.chainId}:${contracts.draw.address}`, lowercase (SPEC §10.1, §12);
 *  - the Draw's recorded constructor Vault is the manifest Vault (SPEC §15 chain/address agreement);
 *  - the Draw record carries its own `constructorArgs` object (SPEC §12);
 *  - `environment` is local, testnet or mainnet (SPEC §12);
 *  - outside `local`, `mocks` is empty and no `isMock`, `feedIsMock` or `coordinatorIsMock` is true, because
 *    "a mainnet manifest may reference no mock artifact" (SPEC §12) and a mock feed or token on a public
 *    chain is a release failure, not a fallback (SPEC §15).
 */
export function parseManifest(json: unknown): DeploymentManifest {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ManifestError("", "expected a JSON object");
  }

  const schemaVersion = integerAt(json, "schemaVersion", "schemaVersion");
  const environment = stringAt(json, "environment", "environment");
  if (!ENVIRONMENTS.includes(environment)) {
    throw new ManifestError("environment", `expected one of ${ENVIRONMENTS.join(", ")}`);
  }

  const chain = parseChain(json);
  const contractsPath = "contracts";
  const contracts = objectAt(json, "contracts", contractsPath);
  const vault = parseContractRecord(contracts, "vault", "contracts.vault");
  const draw = parseDrawRecord(contracts);
  if (draw.constructorArgs.vault !== vault.address) {
    throw new ManifestError(
      "contracts.draw.constructorArgs.vault",
      `expected the manifest Vault ${vault.address}, found ${draw.constructorArgs.vault}`,
    );
  }
  if (vault.address === draw.address) {
    throw new ManifestError("contracts.draw.address", `the Draw and the Vault cannot share ${draw.address}`);
  }

  const deploymentId = stringAt(json, "deploymentId", "deploymentId");
  const expectedId = `${chain.chainId}:${draw.address}`;
  if (deploymentId !== expectedId) {
    throw new ManifestError("deploymentId", `expected ${expectedId}, found ${deploymentId}`);
  }

  const assetsRaw = arrayAt(json, "assets", "assets");
  if (assetsRaw.length === 0) throw new ManifestError("assets", "expected at least one asset");
  const assets = assetsRaw.map((entry, index) => parseAsset(entry, index));
  requireUniqueAssets(assets);

  const mocksRaw = arrayAt(json, "mocks", "mocks");
  const mocks = mocksRaw.map((entry, index) => {
    if (typeof entry !== "string") throw new ManifestError(`mocks[${index}]`, "expected a string");
    return entry;
  });

  const vrf = parseVrf(json);

  if (environment !== "local") {
    if (mocks.length > 0) {
      throw new ManifestError("mocks", `a ${environment} manifest may reference no mock artifact`);
    }
    if (vrf.coordinatorIsMock) {
      throw new ManifestError(
        "vrf.coordinatorIsMock",
        `a ${environment} manifest may not use a mock coordinator`,
      );
    }
    assets.forEach((asset, index) => {
      if (asset.isMock) {
        throw new ManifestError(
          `assets[${index}].isMock`,
          `a ${environment} manifest may not use a mock asset`,
        );
      }
      if (asset.price.feedIsMock) {
        throw new ManifestError(
          `assets[${index}].price.feedIsMock`,
          `a ${environment} manifest may not use a mock feed`,
        );
      }
    });
  }

  return {
    schemaVersion,
    deploymentId,
    environment: environment as Environment,
    createdAtUtc: stringAt(json, "createdAtUtc", "createdAtUtc"),
    notes: optionalStringAt(json, "notes", "notes"),
    chain,
    toolchain: parseToolchain(json),
    contracts: {vault, draw},
    vrf,
    ownership: parseOwnership(json),
    assets,
    mocks,
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** `${chainId}:${lowercase Draw address}`: the identity used by the API, caches, keeper and manifest. */
export function deploymentIdOf(manifest: DeploymentManifest): string {
  return `${manifest.chain.chainId}:${manifest.contracts.draw.address}`;
}

/** SPEC §15: "Load only listed deployment assets." Everything else stays unavailable with a clear reason. */
export function listedAssets(manifest: DeploymentManifest): readonly ManifestAsset[] {
  return manifest.assets.filter((asset) => asset.listed);
}

/** Case-insensitive symbol lookup over the listed assets only. */
export function assetBySymbol(manifest: DeploymentManifest, symbol: string): ManifestAsset | null {
  const wanted = symbol.toLowerCase();
  return listedAssets(manifest).find((asset) => asset.symbol.toLowerCase() === wanted) ?? null;
}

/** Address lookup over the listed assets only; the argument may be in any case. */
export function assetByAddress(manifest: DeploymentManifest, address: string): ManifestAsset | null {
  const wanted = address.toLowerCase();
  return listedAssets(manifest).find((asset) => asset.asset === wanted) ?? null;
}

/**
 * The manifest's file name. SPEC §12 names the file by the Draw address because a colon cannot appear in a
 * file name on every supported platform, while `deploymentId` keeps the `${chainId}:${address}` form.
 */
export function manifestFileName(manifest: DeploymentManifest): string {
  return `${manifest.contracts.draw.address}.json`;
}

/** The directory a manifest belongs in, relative to `config/deployments/`. */
export function manifestDirectory(manifest: DeploymentManifest): string {
  return String(manifest.chain.chainId);
}
