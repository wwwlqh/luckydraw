import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {
  assetByAddress,
  assetBySymbol,
  deploymentIdOf,
  listedAssets,
  ManifestError,
  manifestDirectory,
  manifestFileName,
  parseManifest,
} from "./manifest.ts";
import {arrayAt, deleteAt, getAt, type JsonObject, setAt} from "./testing/json.ts";

const LOCAL_MANIFEST_PATH = join(
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

/** A fresh mutable copy of the checked-in local manifest, as plain JSON. */
function rawManifest(): JsonObject {
  return JSON.parse(readFileSync(LOCAL_MANIFEST_PATH, "utf8")) as JsonObject;
}

/** Indexing helper that keeps `noUncheckedIndexedAccess` honest without a non-null assertion. */
function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `no element at index ${index}`);
  return value;
}

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const VAULT = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";

test("parses the checked-in local manifest into bigint fields", () => {
  const manifest = parseManifest(rawManifest());
  assert.equal(manifest.schemaVersion, 1n);
  assert.equal(manifest.environment, "local");
  assert.equal(manifest.deploymentId, `31337:${DRAW}`);
  assert.equal(manifest.chain.chainId, 31337n);
  assert.equal(manifest.chain.confirmationDepth, 200n);
  assert.equal(manifest.chain.startBlock, 10n);
  assert.equal(manifest.chain.explorerUrl, null);
  assert.equal(manifest.chain.rpcEnvVars.public, "LUCKYDRAW_RPC_URL");
  assert.equal(manifest.chain.rpcEnvVars.operational, "LUCKYDRAW_OPS_RPC_URL");
  assert.equal(manifest.toolchain.solc, "0.8.28");
  assert.equal(manifest.toolchain.optimizerRuns, 600n);
  assert.equal(manifest.toolchain.viaIr, true);
});

test("parses the contract records and the Draw constructor arguments", () => {
  const manifest = parseManifest(rawManifest());
  assert.equal(manifest.contracts.vault.address, VAULT);
  assert.equal(manifest.contracts.vault.deployBlock, 10n);
  assert.equal(manifest.contracts.draw.address, DRAW);
  assert.equal(manifest.contracts.draw.deployBlock, 11n);
  assert.equal(manifest.contracts.draw.constructorArgs.subscriptionId, 1n);
  assert.equal(manifest.contracts.draw.constructorArgs.vault, VAULT);
  assert.equal(manifest.contracts.draw.constructorArgs.requestConfirmations, 200n);
  assert.equal(manifest.contracts.draw.constructorArgs.callbackGasLimit, 300000n);
  assert.equal(manifest.contracts.draw.constructorArgs.maxRequestCostNative, 3612500000000000n);
});

test("parses the VRF and ownership records", () => {
  const manifest = parseManifest(rawManifest());
  assert.equal(manifest.vrf.numWords, 2n);
  assert.equal(manifest.vrf.requestConfirmations, 200n);
  assert.equal(manifest.vrf.lowFundingThresholdNative, 36125000000000000n);
  assert.equal(manifest.vrf.consumerRegistrationTx, null);
  assert.equal(manifest.vrf.measuredCallbackGasUsed, null);
  assert.equal(manifest.ownership.seedAccount, "0x90f79bf6eb2c4f870365e785982e1f101e93b906");
  assert.equal(manifest.ownership.ownershipAccepted, false);
  assert.equal(manifest.ownership.makeWholeReserve, null);
});

test("parses assets, prices and pool configuration", () => {
  const manifest = parseManifest(rawManifest());
  assert.equal(manifest.assets.length, 2);

  const bnb = nth(manifest.assets, 0);
  assert.equal(bnb.asset, "0x0000000000000000000000000000000000000000");
  assert.equal(bnb.native, true);
  assert.equal(bnb.decimals, 18n);
  assert.equal(bnb.price.feedDecimals, 8n);
  assert.equal(bnb.price.maxPriceAge, 3600n);
  assert.equal(bnb.price.referenceKind, "ExactToken");
  assert.equal(bnb.price.heartbeatSeconds, null);
  assert.equal(bnb.pool.poolId, 1n);
  assert.equal(bnb.pool.seedAmount, 10_000_000_000_000_000n);
  assert.equal(bnb.pool.seedAuthorizedMaxPerRound, 10_000_000_000_000_000n);
  assert.deepEqual(bnb.pool.targetsUsd, {
    Day100: 100n,
    Day1k: 1000n,
    Day10k: 10000n,
    Week1k: 1000n,
    Week10k: 10000n,
    Week100k: 100000n,
    Month100k: 100000n,
  });
  assert.deepEqual(bnb.pool.firstRoundIds, [1n, 2n, 3n, 4n, 5n, 6n, 7n]);

  const second = nth(manifest.assets, 1);
  assert.equal(second.symbol, "TEST2");
  assert.equal(second.decimals, 2n);
  assert.equal(second.price.heartbeatSeconds, 1800n);
  assert.equal(second.pool.poolId, 2n);
  assert.equal(second.pool.seedAmount, 500n);
  assert.deepEqual(second.pool.firstRoundIds, [8n, 9n, 10n, 11n, 12n, 13n, 14n]);
});

test("requiresZeroReset round-trips and is false when the document omits it (SPEC 9.5)", () => {
  // The checked-in local manifest carries no flag: both mocks are plain ERC-20s.
  const plain = parseManifest(rawManifest());
  assert.equal(nth(plain.assets, 0).requiresZeroReset, false);
  assert.equal(nth(plain.assets, 1).requiresZeroReset, false);

  const raw = rawManifest();
  setAt(raw, "assets.1.requiresZeroReset", true);
  assert.equal(nth(parseManifest(raw).assets, 1).requiresZeroReset, true);

  const off = rawManifest();
  setAt(off, "assets.1.requiresZeroReset", false);
  assert.equal(nth(parseManifest(off).assets, 1).requiresZeroReset, false);

  // A truthy string would otherwise turn the extra approve(0) step on by accident.
  rejects((entry) => setAt(entry, "assets.1.requiresZeroReset", "true"), "assets[1].requiresZeroReset");
  rejects((entry) => setAt(entry, "assets.1.requiresZeroReset", 1), "assets[1].requiresZeroReset");
});

test("accessors follow the SPEC naming and the listed-only rule", () => {
  const manifest = parseManifest(rawManifest());
  assert.equal(deploymentIdOf(manifest), `31337:${DRAW}`);
  assert.equal(manifestFileName(manifest), `${DRAW}.json`);
  assert.equal(manifestDirectory(manifest), "31337");
  assert.equal(listedAssets(manifest).length, 2);
  assert.equal(assetBySymbol(manifest, "bnb")?.symbol, "BNB");
  assert.equal(assetBySymbol(manifest, "NOPE"), null);
  assert.equal(assetByAddress(manifest, "0x5FBDB2315678AFECB367F032D93F642F64180AA3")?.symbol, "TEST2");
  assert.equal(assetByAddress(manifest, DRAW), null);
});

test("listedAssets hides an unlisted asset (SPEC 15: load only listed deployment assets)", () => {
  const raw = rawManifest();
  setAt(raw, "assets.1.listed", false);
  const manifest = parseManifest(raw);
  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(
    listedAssets(manifest).map((asset) => asset.symbol),
    ["BNB"],
  );
  assert.equal(assetBySymbol(manifest, "TEST2"), null);
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

function rejects(mutate: (raw: JsonObject) => void, path: string): void {
  const raw = rawManifest();
  mutate(raw);
  assert.throws(
    () => parseManifest(raw),
    (error: unknown) => {
      assert.ok(error instanceof ManifestError, `expected ManifestError, got ${String(error)}`);
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("rejects a non-object document", () => {
  assert.throws(() => parseManifest(null), ManifestError);
  assert.throws(() => parseManifest([]), ManifestError);
  assert.throws(() => parseManifest("{}"), ManifestError);
});

test("rejects missing or mistyped required fields", () => {
  rejects((raw) => deleteAt(raw, "chain"), "chain");
  rejects((raw) => deleteAt(raw, "contracts"), "contracts");
  rejects((raw) => deleteAt(raw, "vrf"), "vrf");
  rejects((raw) => deleteAt(raw, "assets"), "assets");
  rejects((raw) => deleteAt(raw, "mocks"), "mocks");
  rejects((raw) => setAt(raw, "chain.chainId", "31337"), "chain.chainId");
  rejects((raw) => setAt(raw, "chain.confirmationDepth", 200.5), "chain.confirmationDepth");
  rejects((raw) => setAt(raw, "toolchain.viaIr", "true"), "toolchain.viaIr");
  rejects((raw) => deleteAt(raw, "contracts.vault.codeHash"), "contracts.vault.codeHash");
  rejects((raw) => setAt(raw, "assets.0.decimals", "18"), "assets[0].decimals");
  rejects((raw) => setAt(raw, "assets", []), "assets");
  rejects((raw) => setAt(raw, "assets.0.pool.firstRoundIds", ["1", "2"]), "assets[0].pool.firstRoundIds");
  rejects((raw) => setAt(raw, "assets.0.price.referenceKind", "Whatever"), "assets[0].price.referenceKind");
});

test("rejects a deploymentId that disagrees with the chain id and Draw address", () => {
  rejects((raw) => setAt(raw, "deploymentId", `56:${DRAW}`), "deploymentId");
  rejects((raw) => setAt(raw, "deploymentId", `31337:${DRAW.toUpperCase()}`), "deploymentId");
  rejects((raw) => setAt(raw, "chain.chainId", 97), "deploymentId");
});

test("rejects a Draw whose constructor Vault is not the manifest Vault (SPEC 15)", () => {
  rejects(
    (raw) => setAt(raw, "contracts.draw.constructorArgs.vault", DRAW),
    "contracts.draw.constructorArgs.vault",
  );
  rejects(
    (raw) => setAt(raw, "contracts.vault.address", "0x1111111111111111111111111111111111111111"),
    "contracts.draw.constructorArgs.vault",
  );
});

test("rejects an address that is not lowercase 40-hex", () => {
  rejects((raw) => setAt(raw, "contracts.vault.address", VAULT.toUpperCase()), "contracts.vault.address");
  rejects((raw) => setAt(raw, "ownership.feeAccount", "0x1234"), "ownership.feeAccount");
  rejects(
    (raw) => setAt(raw, "assets.0.asset", "0xABCdef0000000000000000000000000000000000"),
    "assets[0].asset",
  );
});

test("rejects a uint string out of range or not decimal", () => {
  const twoPow256 = (1n << 256n).toString();
  rejects(
    (raw) => setAt(raw, "contracts.draw.constructorArgs.subscriptionId", twoPow256),
    "contracts.draw.constructorArgs.subscriptionId",
  );
  rejects((raw) => setAt(raw, "assets.0.pool.seedAmount", "0x10"), "assets[0].pool.seedAmount");
  rejects((raw) => setAt(raw, "assets.0.pool.seedAmount", "007"), "assets[0].pool.seedAmount");
  rejects((raw) => setAt(raw, "assets.0.pool.seedAmount", 10), "assets[0].pool.seedAmount");
});

test("rejects an unknown environment", () => {
  rejects((raw) => setAt(raw, "environment", "staging"), "environment");
  rejects((raw) => setAt(raw, "environment", "Local"), "environment");
});

test("rejects a mock artifact outside the local environment (SPEC 12)", () => {
  rejects((raw) => setAt(raw, "environment", "testnet"), "mocks");
  rejects((raw) => {
    setAt(raw, "environment", "mainnet");
    setAt(raw, "mocks", []);
  }, "vrf.coordinatorIsMock");
  rejects((raw) => {
    setAt(raw, "environment", "mainnet");
    setAt(raw, "mocks", []);
    setAt(raw, "vrf.coordinatorIsMock", false);
  }, "assets[0].isMock");
  rejects((raw) => {
    setAt(raw, "environment", "testnet");
    setAt(raw, "mocks", []);
    setAt(raw, "vrf.coordinatorIsMock", false);
    setAt(raw, "assets.0.isMock", false);
    setAt(raw, "assets.1.isMock", false);
  }, "assets[0].price.feedIsMock");
});

test("accepts a testnet manifest once every mock is gone", () => {
  const raw = rawManifest();
  setAt(raw, "environment", "testnet");
  setAt(raw, "mocks", []);
  setAt(raw, "vrf.coordinatorIsMock", false);
  for (const asset of arrayAt(raw, "assets")) {
    setAt(asset, "isMock", false);
    setAt(asset, "price.feedIsMock", false);
  }
  const manifest = parseManifest(raw);
  assert.equal(manifest.environment, "testnet");
  assert.deepEqual(manifest.mocks, []);
});

test("rejects a Draw record without its own constructorArgs (SPEC 12)", () => {
  rejects((raw) => deleteAt(raw, "contracts.draw.constructorArgs"), "contracts.draw.constructorArgs");
  rejects((raw) => setAt(raw, "contracts.draw.constructorArgs", null), "contracts.draw.constructorArgs");
  rejects(
    (raw) => deleteAt(raw, "contracts.draw.constructorArgs.keyHash"),
    "contracts.draw.constructorArgs.keyHash",
  );
});

test("an inherited constructorArgs never satisfies the check", () => {
  const raw = rawManifest();
  const original = getAt(raw, "contracts.draw") as JsonObject;
  const prototype: JsonObject = {constructorArgs: original.constructorArgs};
  const drawRecord = Object.create(prototype) as JsonObject;
  for (const key of Object.keys(original)) {
    if (key === "constructorArgs") continue;
    drawRecord[key] = original[key];
  }
  assert.equal(
    getAt(drawRecord, "constructorArgs.subscriptionId"),
    "1",
    "the prototype really does expose the value",
  );
  assert.equal(Object.hasOwn(drawRecord, "constructorArgs"), false);
  setAt(raw, "contracts.draw", drawRecord);
  assert.throws(
    () => parseManifest(raw),
    (error: unknown) => {
      assert.ok(error instanceof ManifestError);
      assert.equal(error.path, "contracts.draw.constructorArgs");
      return true;
    },
  );
});

test("the inherited `constructor` property can never pass as a record", () => {
  const raw = rawManifest();
  deleteAt(raw, "contracts.draw.constructorArgs");
  // Every JSON object inherits `constructor`; SPEC 12 names the key `constructorArgs` for this reason.
  const drawRecord = getAt(raw, "contracts.draw") as JsonObject;
  assert.notEqual(drawRecord.constructor, undefined);
  assert.equal(Object.hasOwn(drawRecord, "constructor"), false);
  assert.throws(() => parseManifest(raw), ManifestError);
});

test("parseManifest enforces the validator's native, decimals and distinct-address rules", () => {
  // The local manifest lists native BNB (the zero address) first and the mock token second.
  const expectPath = (raw: JsonObject, path: string) =>
    assert.throws(
      () => parseManifest(raw),
      (error: unknown) => error instanceof ManifestError && error.path === path,
      path,
    );

  const flaggedNative = rawManifest();
  setAt(flaggedNative, "assets.1.native", true);
  expectPath(flaggedNative, "assets[1].native");

  const unflaggedZero = rawManifest();
  setAt(unflaggedZero, "assets.0.native", false);
  expectPath(unflaggedZero, "assets[0].native");

  const wideDecimals = rawManifest();
  setAt(wideDecimals, "assets.1.decimals", 19);
  expectPath(wideDecimals, "assets[1].decimals");

  const shared = rawManifest();
  const draw = getAt(shared, "contracts.draw.address");
  setAt(shared, "contracts.vault.address", draw);
  setAt(shared, "contracts.draw.constructorArgs.vault", draw);
  expectPath(shared, "contracts.draw.address");
});
