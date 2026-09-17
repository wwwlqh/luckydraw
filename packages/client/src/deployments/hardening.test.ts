// Regressions from the wave 5 adversarial review: manifest uniqueness, provider failures and chain-id
// coercion in verification, and the pinned-block bookkeeping.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {Interface, keccak256} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {ManifestError, parseManifest} from "./manifest.ts";
import {assertSameChain, type VerifyProvider, verifyDeployment} from "./verify.ts";

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

type Json = {[key: string]: unknown};

function raw(): Json {
  return JSON.parse(readFileSync(LOCAL_MANIFEST_PATH, "utf8")) as Json;
}

function assets(doc: Json): Json[] {
  return doc.assets as Json[];
}

function pool(doc: Json, index: number): Json {
  const asset = assets(doc)[index];
  assert.ok(asset !== undefined, `no asset at index ${index}`);
  return asset.pool as Json;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rejectsAt(doc: Json, path: string): void {
  assert.throws(
    () => parseManifest(doc),
    (error: unknown) => error instanceof ManifestError && error.path === path,
    `expected a ManifestError at ${path}`,
  );
}

test("a second asset with the same symbol is rejected, so assetBySymbol cannot resolve to a decoy", () => {
  const doc = raw();
  const decoy = clone(assets(doc)[0]) as Json;
  decoy.asset = "0xdededededededededededededededededededede";
  // A token that only borrows the native symbol; the native flag must agree with the address on its own.
  decoy.native = false;
  (decoy.pool as Json).poolId = "9";
  (decoy.pool as Json).firstRoundIds = ["70", "71", "72", "73", "74", "75", "76"];
  assets(doc).unshift(decoy);
  rejectsAt(doc, "assets[1].symbol");
});

test("a second asset with the same address is rejected", () => {
  const doc = raw();
  const decoy = clone(assets(doc)[0]) as Json;
  decoy.symbol = "OTHER";
  (decoy.pool as Json).poolId = "9";
  (decoy.pool as Json).firstRoundIds = ["70", "71", "72", "73", "74", "75", "76"];
  assets(doc).push(decoy);
  rejectsAt(doc, "assets[2].asset");
});

test("a pool id shared by two assets is rejected", () => {
  const doc = raw();
  const second = assets(doc)[1] as Json;
  (second.pool as Json).poolId = pool(doc, 0).poolId;
  rejectsAt(doc, "assets[1].pool.poolId");
});

test("first round ids must increase in Kind order and be unique across assets", () => {
  const doc = raw();
  pool(doc, 0).firstRoundIds = ["7", "6", "5", "4", "3", "2", "1"];
  rejectsAt(doc, "assets[0].pool.firstRoundIds");

  const again = raw();
  pool(again, 1).firstRoundIds = ["2", "20", "21", "22", "23", "24", "25"];
  rejectsAt(again, "assets[1].pool.firstRoundIds[0]");
});

// ---------------------------------------------------------------------------
// Verification against a fake provider
// ---------------------------------------------------------------------------

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const VAULT_CODE = "0x600160005260206000f3";
const DRAW_CODE = "0x600260005260206000f3";

function manifestWithFakeCode(): ReturnType<typeof parseManifest> {
  const doc = raw();
  const contracts = doc.contracts as Json;
  (contracts.vault as Json).codeHash = keccak256(VAULT_CODE);
  (contracts.draw as Json).codeHash = keccak256(DRAW_CODE);
  return parseManifest(doc);
}

function fakeProvider(overrides: Partial<VerifyProvider> = {}): VerifyProvider {
  const manifest = manifestWithFakeCode();
  const vault = manifest.contracts.vault.address;
  const draw = manifest.contracts.draw.address;
  return {
    getNetwork: () => Promise.resolve({chainId: 31337n}),
    getCode: (address) => Promise.resolve(address.toLowerCase() === vault ? VAULT_CODE : DRAW_CODE),
    call: (tx) => {
      const to = tx.to.toLowerCase();
      if (to === draw) return Promise.resolve(drawInterface.encodeFunctionResult("VAULT", [vault]));
      return Promise.resolve(vaultInterface.encodeFunctionResult("draw", [draw]));
    },
    getBlockNumber: () => Promise.resolve(42),
    ...overrides,
  };
}

test("a provider that throws a non-Error from getNetwork or getCode yields a returned failure, never a throw", async () => {
  const manifest = manifestWithFakeCode();
  const network = await verifyDeployment(
    fakeProvider({getNetwork: () => Promise.reject("boom-string")}),
    manifest,
  );
  assert.equal(network.ok, false);
  if (!network.ok)
    assert.deepEqual(network.failure, {kind: "ProviderFailed", step: "getNetwork", message: "boom-string"});

  const code = await verifyDeployment(
    fakeProvider({getCode: () => Promise.reject({code: -32000})}),
    manifest,
  );
  assert.equal(code.ok, false);
  if (!code.ok) assert.equal(code.failure.kind, "ProviderFailed");
});

test("a chain id reported as a number or hex string still matches the manifest", async () => {
  const manifest = manifestWithFakeCode();
  const asNumber = await verifyDeployment(
    fakeProvider({getNetwork: () => Promise.resolve({chainId: 31337})}),
    manifest,
  );
  assert.equal(asNumber.ok, true);
  const asHex = await verifyDeployment(
    fakeProvider({getNetwork: () => Promise.resolve({chainId: "0x7a69"})}),
    manifest,
  );
  assert.equal(asHex.ok, true);
  if (asHex.ok)
    await assert.doesNotReject(() =>
      assertSameChain(fakeProvider({getNetwork: () => Promise.resolve({chainId: 31337})}), asHex.verified),
    );
});

test("verifiedAtBlock records the pinned block, not the head, when a numeric tag is used", async () => {
  const manifest = manifestWithFakeCode();
  const pinned = await verifyDeployment(fakeProvider(), manifest, {blockTag: "0x1234"});
  assert.equal(pinned.ok, true);
  if (pinned.ok) assert.equal(pinned.verified.verifiedAtBlock, 0x1234n);

  const symbolic = await verifyDeployment(fakeProvider(), manifest, {blockTag: "finalized"});
  assert.equal(symbolic.ok, true);
  if (symbolic.ok) assert.equal(symbolic.verified.verifiedAtBlock, null);

  const head = await verifyDeployment(fakeProvider(), manifest);
  assert.equal(head.ok, true);
  if (head.ok) assert.equal(head.verified.verifiedAtBlock, 42n);
});
