import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {AbiCoder, Interface, keccak256} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {type DeploymentManifest, parseManifest} from "./manifest.ts";
import {type JsonObject, setAt} from "./testing/json.ts";
import {
  assertSameChain,
  DeploymentVerificationError,
  describeFailure,
  isVerifiedDeployment,
  manifestOf,
  type VerifyProvider,
  verifyDeployment,
} from "./verify.ts";

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

const drawInterface = new Interface(luckyDrawAbi);
const vaultInterface = new Interface(luckyVaultAbi);
const coder = AbiCoder.defaultAbiCoder();

// Synthetic runtime code: the test must not depend on the real bytecode, only on the hashes agreeing.
const VAULT_CODE = `0x60${"aa".repeat(64)}`;
const DRAW_CODE = `0x60${"bb".repeat(64)}`;

function manifestWithSyntheticCode(): DeploymentManifest {
  const raw = JSON.parse(readFileSync(LOCAL_MANIFEST_PATH, "utf8")) as JsonObject;
  setAt(raw, "contracts.vault.codeHash", keccak256(VAULT_CODE));
  setAt(raw, "contracts.draw.codeHash", keccak256(DRAW_CODE));
  return parseManifest(raw);
}

type RecordedCall = {to: string; data: string; blockTag: string | undefined};

type FakeOptions = {
  chainId?: bigint;
  vaultCode?: string;
  drawCode?: string;
  drawVault?: string;
  vaultDraw?: string;
  blockNumber?: number;
};

type FakeProvider = VerifyProvider & {calls: RecordedCall[]};

function fakeProvider(manifest: DeploymentManifest, options: FakeOptions = {}): FakeProvider {
  const vault = manifest.contracts.vault.address;
  const draw = manifest.contracts.draw.address;
  const calls: RecordedCall[] = [];
  return {
    calls,
    async getNetwork() {
      return {chainId: options.chainId ?? manifest.chain.chainId};
    },
    async getCode(address: string) {
      const lowered = address.toLowerCase();
      if (lowered === vault) return options.vaultCode ?? VAULT_CODE;
      if (lowered === draw) return options.drawCode ?? DRAW_CODE;
      return "0x";
    },
    async call(tx: {to: string; data: string; blockTag?: string}) {
      calls.push({to: tx.to.toLowerCase(), data: tx.data, blockTag: tx.blockTag});
      if (tx.to.toLowerCase() === draw && tx.data === drawInterface.encodeFunctionData("VAULT", [])) {
        return coder.encode(["address"], [options.drawVault ?? vault]);
      }
      if (tx.to.toLowerCase() === vault && tx.data === vaultInterface.encodeFunctionData("draw", [])) {
        return coder.encode(["address"], [options.vaultDraw ?? draw]);
      }
      throw new Error(`unexpected call to ${tx.to}`);
    },
    async getBlockNumber() {
      return options.blockNumber ?? 42;
    },
  };
}

test("verifyDeployment accepts a matching chain, code, code hashes and bindings", async () => {
  const manifest = manifestWithSyntheticCode();
  const result = await verifyDeployment(fakeProvider(manifest), manifest);
  assert.ok(result.ok);
  assert.equal(result.verified.chainId, 31337n);
  assert.equal(result.verified.vault, manifest.contracts.vault.address);
  assert.equal(result.verified.draw, manifest.contracts.draw.address);
  assert.equal(result.verified.verifiedAtBlock, 42n);
  assert.deepEqual(
    result.verified.checks.map((check) => check.name),
    ["chainId", "vaultCode", "drawCode", "vaultCodeHash", "drawCodeHash", "drawBinding", "vaultBinding"],
  );
  assert.equal(isVerifiedDeployment(result.verified), true);
  assert.equal(isVerifiedDeployment(manifest), false);
  assert.equal(manifestOf(result.verified), manifest);
  assert.equal(manifestOf(manifest), manifest);
});

test("verifyDeployment pins every call to one block tag", async () => {
  const manifest = manifestWithSyntheticCode();
  const provider = fakeProvider(manifest);
  const result = await verifyDeployment(provider, manifest, {blockTag: "finalized"});
  assert.ok(result.ok);
  assert.equal(provider.calls.length, 2);
  for (const call of provider.calls) assert.equal(call.blockTag, "finalized");
});

test("verifyDeployment reports a chain mismatch and reads nothing else", async () => {
  const manifest = manifestWithSyntheticCode();
  const provider = fakeProvider(manifest, {chainId: 56n});
  const result = await verifyDeployment(provider, manifest);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "ChainMismatch");
  assert.equal(provider.calls.length, 0);
  assert.match(describeFailure(result.failure), /connected chain 56 does not match the manifest chain 31337/);
});

test("verifyDeployment reports missing deployment code (SPEC 15 blocks writes on it)", async () => {
  const manifest = manifestWithSyntheticCode();
  const noVault = await verifyDeployment(fakeProvider(manifest, {vaultCode: "0x"}), manifest);
  assert.ok(!noVault.ok);
  assert.equal(noVault.failure.kind, "MissingCode");
  if (noVault.failure.kind === "MissingCode") assert.equal(noVault.failure.contract, "vault");

  const noDraw = await verifyDeployment(fakeProvider(manifest, {drawCode: "0x"}), manifest);
  assert.ok(!noDraw.ok);
  assert.equal(noDraw.failure.kind, "MissingCode");
  if (noDraw.failure.kind === "MissingCode") assert.equal(noDraw.failure.contract, "draw");
});

test("verifyDeployment reports a tampered code hash", async () => {
  const manifest = manifestWithSyntheticCode();
  const tampered = `0x60${"cc".repeat(64)}`;
  const result = await verifyDeployment(fakeProvider(manifest, {drawCode: tampered}), manifest);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "CodeHashMismatch");
  if (result.failure.kind === "CodeHashMismatch") {
    assert.equal(result.failure.contract, "draw");
    assert.equal(result.failure.expected, manifest.contracts.draw.codeHash);
    assert.equal(result.failure.actual, keccak256(tampered));
  }
});

test("verifyDeployment reports a Draw bound to another Vault", async () => {
  const manifest = manifestWithSyntheticCode();
  const other = "0x000000000000000000000000000000000000dead";
  const result = await verifyDeployment(fakeProvider(manifest, {drawVault: other}), manifest);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "BindingMismatch");
  if (result.failure.kind === "BindingMismatch") {
    assert.equal(result.failure.contract, "draw");
    assert.equal(result.failure.method, "VAULT");
    assert.equal(result.failure.actual, other);
    assert.equal(result.failure.expected, manifest.contracts.vault.address);
  }
});

test("verifyDeployment reports a Vault bound to another Draw", async () => {
  const manifest = manifestWithSyntheticCode();
  const other = "0x000000000000000000000000000000000000beef";
  const result = await verifyDeployment(fakeProvider(manifest, {vaultDraw: other}), manifest);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "BindingMismatch");
  if (result.failure.kind === "BindingMismatch") {
    assert.equal(result.failure.contract, "vault");
    assert.equal(result.failure.method, "draw");
    assert.equal(result.failure.actual, other);
  }
});

test("verifyDeployment reports a failed view call instead of throwing", async () => {
  const manifest = manifestWithSyntheticCode();
  const provider = fakeProvider(manifest);
  const broken: VerifyProvider = {
    getNetwork: () => provider.getNetwork(),
    getCode: (address: string, blockTag?: string) => provider.getCode(address, blockTag),
    call: () => Promise.reject(new Error("execution reverted")),
  };
  const result = await verifyDeployment(broken, manifest);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "CallFailed");
  assert.match(describeFailure(result.failure), /could not be read/);
});

test("assertSameChain throws after a failover onto the wrong chain (SPEC 12 halts on mismatch)", async () => {
  const manifest = manifestWithSyntheticCode();
  const result = await verifyDeployment(fakeProvider(manifest), manifest);
  assert.ok(result.ok);
  await assertSameChain(fakeProvider(manifest), result.verified);
  await assert.rejects(
    () => assertSameChain(fakeProvider(manifest, {chainId: 97n}), result.verified),
    (error: unknown) => {
      assert.ok(error instanceof DeploymentVerificationError);
      assert.equal(error.failure.kind, "ChainMismatch");
      return true;
    },
  );
});

test("verifiedAtBlock falls back to the option when the provider cannot report one", async () => {
  const manifest = manifestWithSyntheticCode();
  const provider = fakeProvider(manifest);
  const withoutBlockNumber: VerifyProvider = {
    getNetwork: () => provider.getNetwork(),
    getCode: (address: string, blockTag?: string) => provider.getCode(address, blockTag),
    call: (tx: {to: string; data: string; blockTag?: string}) => provider.call(tx),
  };
  const withOption = await verifyDeployment(withoutBlockNumber, manifest, {blockNumber: 7n});
  assert.ok(withOption.ok);
  assert.equal(withOption.verified.verifiedAtBlock, 7n);

  const withoutOption = await verifyDeployment(withoutBlockNumber, manifest);
  assert.ok(withoutOption.ok);
  assert.equal(withoutOption.verified.verifiedAtBlock, null);
});

test("verifyDeployment returns a provider failure for malformed provider output rather than throwing", async () => {
  const manifest = manifestWithSyntheticCode();
  // A chain id that is not an integer in any accepted shape: `toBigInt` would throw, the verifier must not.
  for (const chainId of ["bsc", "", " ", 31337.5, {}]) {
    const provider = fakeProvider(manifest, {chainId: chainId as unknown as bigint});
    const result = await verifyDeployment(provider, manifest);
    assert.ok(!result.ok, `chain id ${JSON.stringify(chainId)}`);
    assert.equal(result.failure.kind, "ProviderFailed");
    assert.equal(result.failure.kind === "ProviderFailed" ? result.failure.step : "", "getNetwork");
    assert.equal(provider.calls.length, 0, "nothing else is read");
  }
  // Code that is not hex bytes: no prefix, an odd length, a number, an empty string.
  for (const vaultCode of ["", VAULT_CODE.slice(2), `${VAULT_CODE}a`, 123]) {
    const provider = fakeProvider(manifest, {vaultCode: vaultCode as unknown as string});
    const result = await verifyDeployment(provider, manifest);
    assert.ok(!result.ok, `code ${JSON.stringify(vaultCode)}`);
    assert.equal(result.failure.kind, "ProviderFailed");
    assert.equal(result.failure.kind === "ProviderFailed" ? result.failure.step : "", "getCode");
    assert.match(describeFailure(result.failure), /getCode/);
  }
});
