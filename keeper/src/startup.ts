// Start-up gates. Every one of them refuses rather than degrades (SPEC §12, §15).
//
//   1. the manifest exists, parses and is the one the environment named (chain id and Draw address);
//   2. a private key is never used against a `local` deployment - a local chain's accounts are unlocked and
//      a key pointed at anvil is almost always a key that was meant for a real chain;
//   3. on chain 56 the manifest names no mock: no labeled mock artifact, no mock coordinator, no mock asset
//      and no mock price feed. A keeper is the component that acts, so it refuses to act against one;
//   4. `eth_chainId` equals `KEEPER_CHAIN_ID` and the manifest chain id ("every service asserts eth_chainId
//      equals the manifest chainId at start-up", SPEC §12);
//   5. `verifyDeployment` passes: code present at both addresses, code hashes equal to the manifest's, and
//      the Vault/Draw binding intact. Only that function produces the `VerifiedDeployment` every read and
//      write adapter demands, so a keeper that skipped it could not build a single call;
//   6. the Multicall3 the chain record names, if any, has code and answers one real `aggregate3` probe. It
//      is operator-supplied configuration for a contract this repository never deployed, and a keeper whose
//      every batched read throws is a keeper that restarts forever without ever closing a round.
//
// Gate 4 asks the node itself, with a raw `eth_chainId` request, and so does the chain-id check inside gate 5.
// It cannot use `provider.getNetwork()`: `main.ts` builds the provider with `staticNetwork: true` (which is
// what stops ethers from re-detecting the network on every call), and a static network answers `getNetwork`
// from the configured chain id without a request, so the gate would be comparing `KEEPER_CHAIN_ID` with
// itself and an RPC URL pointed at the wrong chain would sail through both checks.

import {readFileSync} from "node:fs";
import {
  type Address,
  type DeploymentManifest,
  describeFailure,
  isAddress,
  parseManifest,
  type ReadProvider,
  readSeedAccount,
  resolveSnapshotBlock,
  type VerifiedDeployment,
  type VerifyProvider,
  verifyDeployment,
} from "./client.ts";
import {ConfigError, chainRecordPathOf, type KeeperConfig, manifestPathOf} from "./config.ts";
import {describeError} from "./transport.ts";

/** A refusal to start. The keeper exits non-zero; it never continues with a partial check. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** Reads and parses the manifest the configuration names, checking that it is in fact that manifest. */
export function loadManifest(
  config: KeeperConfig,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): DeploymentManifest {
  const path = manifestPathOf(config);
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartupError(`the deployment manifest ${path} could not be read: ${message}`);
  }
  let manifest: DeploymentManifest;
  try {
    manifest = parseManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartupError(`the deployment manifest ${path} is not valid: ${message}`);
  }
  if (manifest.chain.chainId !== config.chainId) {
    throw new StartupError(
      `KEEPER_CHAIN_ID is ${config.chainId} but ${path} records chain ${manifest.chain.chainId}`,
    );
  }
  if (manifest.contracts.draw.address !== config.drawAddress) {
    throw new StartupError(
      `KEEPER_DRAW_ADDRESS is ${config.drawAddress} but ${path} records ${manifest.contracts.draw.address}`,
    );
  }
  return manifest;
}

/** SPEC §10.5 in miniature: a hot key belongs to a real chain, never to a throwaway local one. */
export function assertSigningAllowed(config: KeeperConfig, manifest: DeploymentManifest): void {
  if (config.signing.kind === "privateKey" && manifest.environment === "local") {
    throw new StartupError(
      "KEEPER_PRIVATE_KEY must not be used against a local deployment; a local chain's accounts are " +
        "unlocked, so set KEEPER_UNLOCKED_ADDRESS instead",
    );
  }
}

/** A JSON value's type as an operator reading the file would name it, without quoting the value itself. */
function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a fractional number";
  if (value === undefined) return "absent";
  return `a ${typeof value}`;
}

/**
 * Multicall3 for this chain from `config/chains/<chainId>.json`, or undefined when there is none.
 *
 * Without it every read in a cycle is its own `eth_call`: the keeper reads the pool page, the seed account,
 * a cap and a balance per pool, `getCurrent` three times per pool and one `getRound` per tracked round, so a
 * handful of pools is already tens of calls every fifteen seconds. Public BSC endpoints rate-limit exactly
 * that shape, and a throttled cycle is a round that closes late. With the address set, `reads.ts` groups
 * those into three `aggregate3` calls a cycle (SPEC §10.1) - and `prepare` proves the address works before
 * the first one is sent.
 *
 * Absent file or a null/absent `networkIdentity.multicall3` is undefined, not an error: chain 56's record
 * carries null until the operator verifies the address against the live chain (item 4), and a keeper must
 * still run - slower - in the meantime. A record for the *wrong chain* is an error, because it means the
 * tree the keeper was pointed at is not the one it thinks it is, and the address inside it would be a
 * contract on another network.
 */
export function loadMulticall3(
  config: KeeperConfig,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Address | undefined {
  const path = chainRecordPathOf(config);
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return undefined; // No chain record for this chain: batching is simply off.
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `the chain record ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new ConfigError(`the chain record ${path} is not an object`);
  }
  const recorded = record.chainId;
  // Split from the comparison below on purpose: a record whose `chainId` is the JSON *string* `"56"` used to
  // produce "is for chain 56 but KEEPER_CHAIN_ID is 56", which reads like a bug in the keeper rather than a
  // typed field in the file the operator has to fix (F9).
  if (typeof recorded !== "number" || !Number.isSafeInteger(recorded)) {
    throw new ConfigError(
      `the chain record ${path} records chainId as ${describeJsonType(recorded)}, which is not a whole ` +
        "number; the file cannot be matched against KEEPER_CHAIN_ID until it is corrected",
    );
  }
  if (BigInt(recorded) !== config.chainId) {
    throw new ConfigError(
      `the chain record ${path} is for chain ${recorded} but KEEPER_CHAIN_ID is ${config.chainId}`,
    );
  }
  const identity = record.networkIdentity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  const address = (identity as Record<string, unknown>).multicall3;
  if (address === null || address === undefined) return undefined;
  if (!isAddress(address)) {
    throw new ConfigError(`${path}: networkIdentity.multicall3 is not an address`);
  }
  return address.toLowerCase() as Address;
}

/** The raw JSON-RPC surface the chain-id gate needs. An ethers `JsonRpcProvider` satisfies it structurally. */
export type RawRpcProvider = {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
};

/** `eth_chainId` is a hex quantity: `0x38`, never `56`, never a decimal string. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;

/**
 * The chain id the *node* reports, from a raw `eth_chainId` request.
 *
 * Deliberately not `getNetwork()`: under `staticNetwork: true` that answers from configuration.
 */
export async function nodeChainId(provider: RawRpcProvider): Promise<bigint> {
  let raw: unknown;
  try {
    raw = await provider.send("eth_chainId", []);
  } catch (error) {
    // `describeError`, not `error.message`: the first gate to touch the network is the one an operator reads
    // when nothing works, and a `TypeError` whose explanation lives in `cause` (`fetch failed` ->
    // `WebAssembly is not defined`, under `node --jitless`) printed this as
    // `refused_to_start reason="eth_chainId could not be read: "` - a blank reason, with nothing to grep.
    throw new StartupError(`eth_chainId could not be read: ${describeError(error)}`);
  }
  if (typeof raw !== "string" || !HEX_QUANTITY.test(raw)) {
    throw new StartupError(`eth_chainId returned ${JSON.stringify(raw)}, which is not a hex quantity`);
  }
  return BigInt(raw);
}

/**
 * The same provider, with `getNetwork` replaced by the raw `eth_chainId` request.
 *
 * `verifyDeployment` runs its own chain check through `getNetwork`, so without this its `ChainMismatch` would
 * be as unasked-for as gate 3's was: both have to reach the node.
 */
export function withNodeChainId<T extends VerifyProvider & RawRpcProvider>(provider: T): VerifyProvider {
  const getBlockNumber = provider.getBlockNumber?.bind(provider);
  const wrapped: VerifyProvider = {
    async getNetwork(): Promise<{chainId: bigint}> {
      return {chainId: await nodeChainId(provider)};
    },
    getCode: (address, blockTag) => provider.getCode(address, blockTag),
    call: (tx, blockTag) => provider.call(tx, blockTag),
  };
  return getBlockNumber === undefined ? wrapped : {...wrapped, getBlockNumber};
}

/** `eth_chainId` against both `KEEPER_CHAIN_ID` and the manifest, before anything else touches the node. */
export async function assertChainId(
  config: KeeperConfig,
  provider: RawRpcProvider,
  manifest: DeploymentManifest,
): Promise<void> {
  const reported = await nodeChainId(provider);
  // `loadManifest` has already refused a manifest that disagrees with `KEEPER_CHAIN_ID`, so these two are
  // the same comparison today. Both are written out because the environment variable is what the operator
  // typed and the systemd unit records, and a future manifest lookup that did not key on it would silently
  // remove the check that SPEC §12 actually asks for: "every service asserts eth_chainId equals the
  // manifest chainId at start-up".
  if (reported !== manifest.chain.chainId) {
    throw new StartupError(
      `the node reports chain ${reported} but the manifest is for chain ${manifest.chain.chainId}`,
    );
  }
  if (reported !== config.chainId) {
    throw new StartupError(`the node reports chain ${reported} but KEEPER_CHAIN_ID is ${config.chainId}`);
  }
}

/** BSC mainnet. The one chain on which a labeled mock is a refusal rather than a convenience (SPEC §12). */
export const BSC_MAINNET_CHAIN_ID = 56n;

/**
 * No mock of any kind may be reached on chain 56.
 *
 * `parseManifest` already refuses a mock in a manifest whose `environment` is `testnet` or `mainnet`, and
 * `validate:config` refuses one too. This gate keys on the **chain id** instead, which closes the one case
 * both of those miss: a manifest still labelled `environment: "local"` - a copy of an anvil run, or a file
 * an older script wrote - whose `chain.chainId` says 56. Every mock check above it is then switched off by
 * its own label while the keeper is pointed at real money.
 *
 * It matters here more than anywhere else because the keeper is the component that *acts*. It would seed,
 * close and settle rounds priced by a mock feed and drawn by a mock coordinator, against customer deposits
 * in the Vault, and every transaction would look healthy in the log.
 */
export function assertNoMocks(config: KeeperConfig, manifest: DeploymentManifest): void {
  if (config.chainId !== BSC_MAINNET_CHAIN_ID) return;
  const offenders: string[] = [];
  if (manifest.mocks.length > 0) offenders.push(`mocks: ${manifest.mocks.join(", ")}`);
  if (manifest.vrf.coordinatorIsMock) offenders.push(`vrf.coordinatorIsMock (${manifest.vrf.coordinator})`);
  manifest.assets.forEach((asset, index) => {
    if (asset.isMock) offenders.push(`assets[${index}].isMock (${asset.symbol} ${asset.asset})`);
    if (asset.price.feedIsMock) {
      offenders.push(`assets[${index}].price.feedIsMock (${asset.symbol} ${asset.price.feed ?? "null"})`);
    }
  });
  if (offenders.length > 0) {
    throw new StartupError(
      `chain ${BSC_MAINNET_CHAIN_ID} refuses a manifest that names a mock: ${offenders.join("; ")}`,
    );
  }
}

/** The whole provider surface the gates need: raw requests, verification and one batched read. */
export type StartupProvider = VerifyProvider & RawRpcProvider & ReadProvider;

/**
 * Gate 6: the configured Multicall3 is a Multicall3, on this chain, answering `aggregate3`.
 *
 * `loadMulticall3` checks the *shape* of the address and nothing else, which is the whole failure mode: one
 * transposed character in `config/chains/<id>.json` passes start-up, every `aggregate3` in every cycle
 * throws, ten consecutive cycles fail, `Restart=on-failure` brings the unit straight back and the keeper
 * never closes a round again. The address is operator-supplied configuration for a contract nobody in this
 * repository deployed, so it is checked against the node exactly like the Vault and the Draw are.
 *
 * Two checks, because they fail differently: no code at all is a wrong address or a chain that has no
 * Multicall3, and code that cannot answer one `aggregate3` is a different contract at a real address. The
 * probe is a real cycle read (`getSeedAccount` on the Draw) through the client's own `readBatch`, so what is
 * proven is the exact path every cycle takes, decoding included - not that *some* call succeeded.
 */
export async function assertMulticall3(
  provider: StartupProvider,
  deployment: VerifiedDeployment,
  multicall3: Address,
  config: KeeperConfig,
): Promise<void> {
  const where = `networkIdentity.multicall3 in ${chainRecordPathOf(config)}`;
  let code: string;
  try {
    code = await provider.getCode(multicall3);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartupError(`Multicall3 ${multicall3} (${where}) could not be read: ${message}`);
  }
  if (code === "" || code === "0x") {
    throw new StartupError(
      `Multicall3 ${multicall3} (${where}) has no code on chain ${config.chainId}; correct the address or ` +
        "set it to null to run without batching",
    );
  }
  try {
    const block = await resolveSnapshotBlock(provider, {tag: "latest"});
    await readSeedAccount({provider, deployment, block, multicall3});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartupError(
      `Multicall3 ${multicall3} (${where}) did not answer an aggregate3 probe: ${message}`,
    );
  }
}

/**
 * Runs every gate in order and returns the verified deployment the adapters require, plus the Multicall3
 * this chain's record names once it has been proven to work.
 *
 * The Multicall3 gate is last because its probe is a read of the Draw: it has nothing to say until the Draw
 * has been verified to be the Draw.
 */
export async function prepare(
  config: KeeperConfig,
  provider: StartupProvider,
  readFile?: (path: string) => string,
): Promise<{
  manifest: DeploymentManifest;
  deployment: VerifiedDeployment;
  multicall3: Address | undefined;
}> {
  const manifest = readFile === undefined ? loadManifest(config) : loadManifest(config, readFile);
  assertSigningAllowed(config, manifest);
  assertNoMocks(config, manifest);
  await assertChainId(config, provider, manifest);
  const result = await verifyDeployment(withNodeChainId(provider), manifest);
  if (!result.ok) {
    throw new StartupError(`the deployment did not verify: ${describeFailure(result.failure)}`);
  }
  const multicall3 = readFile === undefined ? loadMulticall3(config) : loadMulticall3(config, readFile);
  if (multicall3 !== undefined) await assertMulticall3(provider, result.verified, multicall3, config);
  return {manifest, deployment: result.verified, multicall3};
}
