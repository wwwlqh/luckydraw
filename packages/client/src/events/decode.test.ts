import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {getAddress, Interface} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import type {AbiEntryLike, AbiParamLike} from "../abi/normalize.ts";
import {type DeploymentManifest, parseManifest} from "../deployments/manifest.ts";
import {drawEventTopics, vaultEventTopics} from "../types/generated.ts";
import {decodeLog, entryCorrelationKey, eventFilters, eventKey, type RawLog} from "./decode.ts";

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

const manifest: DeploymentManifest = parseManifest(
  JSON.parse(readFileSync(LOCAL_MANIFEST_PATH, "utf8")) as unknown,
);
const VAULT = manifest.contracts.vault.address;
const DRAW = manifest.contracts.draw.address;

const vaultInterface = new Interface(luckyVaultAbi);
const drawInterface = new Interface(luckyDrawAbi);

const BLOCK_HASH = `0x${"1a".repeat(32)}`;
const TX_HASH = `0x${"2b".repeat(32)}`;

function addressFor(seed: number): string {
  return getAddress(`0x${seed.toString(16).padStart(40, "0")}`);
}

/** The key `normalizeAbiStruct` uses for a parameter; mirrors the generator's own fallback. */
function fieldName(param: AbiParamLike, index: number): string {
  return param.name !== undefined && param.name.length > 0 ? param.name : `field${index}`;
}

/** An encodable value for one ABI parameter, with the value `normalizeAbiStruct` should hand back. */
function sample(param: AbiParamLike, seed: number): {value: unknown; expected: unknown} {
  const arrayMatch = /^(.*?)(\[(\d*)\])$/.exec(param.type);
  if (arrayMatch) {
    const inner: AbiParamLike = {...param, type: arrayMatch[1] ?? ""};
    const fixed = arrayMatch[3] ?? "";
    const size = fixed.length === 0 ? 2 : Number.parseInt(fixed, 10);
    const values: unknown[] = [];
    const expected: unknown[] = [];
    for (let index = 0; index < size; index += 1) {
      const item = sample(inner, seed + index + 1);
      values.push(item.value);
      expected.push(item.expected);
    }
    return {value: values, expected};
  }
  if (param.type === "tuple") {
    const values: unknown[] = [];
    const expected: Record<string, unknown> = {};
    (param.components ?? []).forEach((component, index) => {
      const item = sample(component, seed * 10 + index + 1);
      values.push(item.value);
      expected[fieldName(component, index)] = item.expected;
    });
    return {value: values, expected};
  }
  if (param.type === "address") {
    const value = addressFor(seed + 0x1000);
    return {value, expected: value.toLowerCase()};
  }
  if (param.type === "bool") return {value: seed % 2 === 1, expected: seed % 2 === 1};
  if (param.type === "string") return {value: `s${seed}`, expected: `s${seed}`};
  if (param.type === "bytes")
    return {
      value: `0x${seed.toString(16).padStart(8, "0")}`,
      expected: `0x${seed.toString(16).padStart(8, "0")}`,
    };
  if (/^bytes\d+$/.test(param.type)) {
    const value = `0x${seed.toString(16).padStart(64, "0")}`;
    return {value, expected: value};
  }
  if (/^u?int\d*$/.test(param.type)) {
    if (param.internalType?.startsWith("enum ") === true) {
      // Enum members start at zero; 1 is valid for every enum in Types.sol and is a number, not a bigint.
      return {value: 1n, expected: 1};
    }
    return {value: BigInt(seed), expected: BigInt(seed)};
  }
  throw new Error(`no sample for ${param.type}`);
}

function eventEntries(abi: readonly AbiEntryLike[]): AbiEntryLike[] {
  return abi.filter((entry) => entry.type === "event");
}

function encodeLog(
  iface: Interface,
  entry: AbiEntryLike,
  address: string,
): {log: RawLog; expected: Record<string, unknown>} {
  const inputs = entry.inputs ?? [];
  const values: unknown[] = [];
  const expected: Record<string, unknown> = {};
  inputs.forEach((input, index) => {
    const item = sample(input, index + 1);
    values.push(item.value);
    expected[fieldName(input, index)] = item.expected;
  });
  const encoded = iface.encodeEventLog(entry.name ?? "", values);
  return {
    log: {
      address,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: 1234,
      blockHash: BLOCK_HASH,
      transactionHash: TX_HASH,
      index: 7,
      transactionIndex: 3,
    },
    expected,
  };
}

test("every Vault event round-trips through decodeLog", () => {
  const entries = eventEntries(luckyVaultAbi as readonly AbiEntryLike[]);
  assert.equal(entries.length, Object.keys(vaultEventTopics).length);
  for (const entry of entries) {
    const {log, expected} = encodeLog(vaultInterface, entry, VAULT);
    const decoded = decodeLog(manifest, log);
    assert.ok(decoded, `${entry.name} did not decode`);
    assert.equal(decoded.emitter, "vault");
    assert.equal(decoded.name, entry.name);
    assert.deepEqual(decoded.args, expected);
    assert.equal(decoded.address, VAULT);
    assert.equal(decoded.blockNumber, 1234n);
    assert.equal(decoded.logIndex, 7n);
    assert.equal(decoded.txIndex, 3n);
    assert.equal(decoded.blockHash, BLOCK_HASH);
    assert.equal(decoded.txHash, TX_HASH);
  }
});

test("every Draw event round-trips through decodeLog", () => {
  const entries = eventEntries(luckyDrawAbi as readonly AbiEntryLike[]);
  assert.equal(entries.length, Object.keys(drawEventTopics).length);
  for (const entry of entries) {
    const {log, expected} = encodeLog(drawInterface, entry, DRAW);
    const decoded = decodeLog(manifest, log);
    assert.ok(decoded, `${entry.name} did not decode`);
    assert.equal(decoded.emitter, "draw");
    assert.equal(decoded.name, entry.name);
    assert.deepEqual(decoded.args, expected);
  }
});

test("RoundOpened decodes the nested pricing tuple (SPEC 8.2)", () => {
  const encoded = drawInterface.encodeEventLog("RoundOpened", [
    11n,
    2n,
    1n, // Kind.Week1k
    3n,
    addressFor(0x5678),
    18n,
    1_800_000_000n,
    1_800_086_400n,
    1000n,
    addressFor(0x9abc),
    [addressFor(0xfeed), 8n, 3600n, 0n, 0n, 0n],
  ]);
  const decoded = decodeLog(manifest, {
    address: DRAW,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 9n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 0,
  });
  assert.ok(decoded);
  assert.equal(decoded.name, "RoundOpened");
  if (decoded.name !== "RoundOpened") return;
  assert.equal(decoded.args.roundId, 11n);
  assert.equal(decoded.args.kind, 1);
  assert.equal(decoded.args.targetUsd, 1000n);
  assert.equal(decoded.args.opensAt, 1_800_000_000n);
  assert.deepEqual(decoded.args.pricing, {
    feed: addressFor(0xfeed).toLowerCase(),
    feedDecimals: 8n,
    maxPriceAge: 3600n,
    referenceKind: 0,
    minAnswer: 0n,
    maxAnswer: 0n,
  });
  assert.equal(decoded.txIndex, null, "a log without a transaction index decodes to null");
});

test("PoolAdded decodes the uint32[7] target tuple as seven bigints", () => {
  const encoded = drawInterface.encodeEventLog("PoolAdded", [
    1n,
    addressFor(0x1111),
    addressFor(0x2222),
    18n,
    [addressFor(0x3333), 8n, 3600n, 1n, 0n, 0n],
    10_000_000_000_000_000n,
    [100n, 1000n, 10000n, 1000n, 10000n, 100000n, 100000n],
  ]);
  const decoded = decodeLog(manifest, {
    address: DRAW,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: "0x10",
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: "0x2",
  });
  assert.ok(decoded);
  assert.equal(decoded.name, "PoolAdded");
  if (decoded.name !== "PoolAdded") return;
  assert.deepEqual(decoded.args.targetUsd, [100n, 1000n, 10000n, 1000n, 10000n, 100000n, 100000n]);
  assert.equal(decoded.args.seedAmount, 10_000_000_000_000_000n);
  assert.equal(decoded.args.pricing.referenceKind, 1);
  // SPEC 10.1: hex-string JSON-RPC numbers become bigints.
  assert.equal(decoded.blockNumber, 16n);
  assert.equal(decoded.logIndex, 2n);
});

test("SeedAuthorized decodes the per-asset consent of SPEC 5.4", () => {
  // Seed consent is per asset: the log carries the asset as a second indexed topic, so an indexer can follow
  // one account's consent in each asset separately. Both the account and the asset are indexed, so the
  // argument words in `data` are only the two caps.
  const account = addressFor(11);
  const asset = addressFor(12);
  const encoded = vaultInterface.encodeEventLog("SeedAuthorized", [account, asset, 0n, 500n]);
  assert.equal(
    encoded.topics[0],
    "0x13c36af969c397f564598c00572b3aeb0b69780eaf1ce87d3b67b01e327a3a3b",
    "the topic is keccak(SeedAuthorized(address,address,uint256,uint256))",
  );
  assert.equal(vaultEventTopics.SeedAuthorized, encoded.topics[0], "the generated topic table agrees");
  assert.equal(encoded.topics.length, 3, "account and asset are both indexed");

  const decoded = decodeLog(manifest, {
    address: VAULT,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 21n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 4,
  });
  assert.ok(decoded, "SeedAuthorized did not decode");
  assert.equal(decoded.name, "SeedAuthorized");
  assert.equal(decoded.emitter, "vault");
  assert.deepEqual(decoded.args, {
    account: account.toLowerCase(),
    asset: asset.toLowerCase(),
    oldMaxPerRound: 0n,
    newMaxPerRound: 500n,
  });

  // A revocation is the same event with a zero new cap, and it revokes that asset alone.
  const revoked = decodeLog(manifest, {
    address: VAULT,
    topics: vaultInterface.encodeEventLog("SeedAuthorized", [account, asset, 500n, 0n]).topics,
    data: vaultInterface.encodeEventLog("SeedAuthorized", [account, asset, 500n, 0n]).data,
    blockNumber: 22n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 5,
  });
  assert.equal((revoked?.args as {newMaxPerRound: bigint} | undefined)?.newMaxPerRound, 0n);
});

test("a look-alike emitter is ignored (SPEC 10.1)", () => {
  const encoded = vaultInterface.encodeEventLog("Deposited", [addressFor(1), addressFor(2), 5n]);
  const log: RawLog = {
    address: "0x00000000000000000000000000000000deadbeef",
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 1n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 0,
  };
  assert.equal(decodeLog(manifest, log), null);
  assert.ok(decodeLog(manifest, {...log, address: VAULT}));
  // The Draw address does not emit Vault events, so the same topic there is unknown, not accepted.
  assert.equal(decodeLog(manifest, {...log, address: DRAW}), null);
});

test("an unknown topic and a malformed log return null instead of throwing", () => {
  const base: RawLog = {
    address: VAULT,
    topics: [`0x${"ff".repeat(32)}`],
    data: "0x",
    blockNumber: 1n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 0,
  };
  assert.equal(decodeLog(manifest, base), null);
  assert.equal(decodeLog(manifest, {...base, topics: []}), null);
  assert.equal(decodeLog(manifest, {...base, address: "not-an-address"}), null);
  const encoded = vaultInterface.encodeEventLog("Deposited", [addressFor(1), addressFor(2), 5n]);
  assert.equal(
    decodeLog(manifest, {...base, topics: encoded.topics, data: "0xdeadbeef"}),
    null,
    "truncated data must not throw",
  );
});

test("the mixed-case emitter of an ethers log still matches the manifest", () => {
  const encoded = vaultInterface.encodeEventLog("Withdrawn", [addressFor(1), addressFor(2), 5n]);
  const decoded = decodeLog(manifest, {
    address: getAddress(VAULT),
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 1n,
    blockHash: BLOCK_HASH.toUpperCase().replace("0X", "0x"),
    transactionHash: TX_HASH,
    index: 1,
  });
  assert.ok(decoded);
  assert.equal(decoded.address, VAULT);
  assert.equal(decoded.blockHash, BLOCK_HASH);
});

test("eventKey is the SPEC 10.1 unique key and entryCorrelationKey pairs a transaction", () => {
  assert.equal(eventKey(56n, TX_HASH.toUpperCase().replace("0X", "0x"), 4n), `56:${TX_HASH}:4`);
  assert.notEqual(eventKey(56n, TX_HASH, 4n), eventKey(97n, TX_HASH, 4n));
  assert.notEqual(eventKey(56n, TX_HASH, 4n), eventKey(56n, TX_HASH, 5n));
  assert.equal(entryCorrelationKey(TX_HASH, 12n, VAULT.toUpperCase()), `${TX_HASH}:12:${VAULT}`);
  assert.notEqual(entryCorrelationKey(TX_HASH, 12n, VAULT), entryCorrelationKey(TX_HASH, 12n, DRAW));
});

test("eventFilters covers every topic of both contracts", () => {
  const filters = eventFilters(manifest);
  assert.equal(filters.length, 2);
  const [vault, draw] = filters;
  assert.ok(vault && draw);
  assert.equal(vault.address, VAULT);
  assert.equal(draw.address, DRAW);
  assert.deepEqual([...vault.topics[0]].sort(), Object.values(vaultEventTopics).slice().sort());
  assert.deepEqual([...draw.topics[0]].sort(), Object.values(drawEventTopics).slice().sort());
  for (const topic of [...vault.topics[0], ...draw.topics[0]]) assert.match(topic, /^0x[0-9a-f]{64}$/);
});

test("a log with an empty, blank or negative block number, log index or tx index is not an event", () => {
  const encoded = vaultInterface.encodeEventLog("Deposited", [addressFor(1), addressFor(2), 5n]);
  const base = {
    address: VAULT,
    topics: encoded.topics,
    data: encoded.data,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
  };
  const wellFormed = decodeLog(manifest, {...base, blockNumber: "0x10", logIndex: "0x0"});
  assert.notEqual(wellFormed, null, "the well-formed log decodes");
  assert.equal(wellFormed?.blockNumber, 16n);
  const bad: readonly [string, string][] = [
    ["", "0x0"],
    [" ", "0x0"],
    ["-1", "0x0"],
    ["0x10", "-7"],
    ["0x10", ""],
  ];
  for (const [blockNumber, logIndex] of bad) {
    assert.equal(
      decodeLog(manifest, {...base, blockNumber, logIndex}),
      null,
      `blockNumber ${JSON.stringify(blockNumber)} logIndex ${JSON.stringify(logIndex)}`,
    );
  }
  assert.equal(
    decodeLog(manifest, {...base, blockNumber: "0x10", logIndex: "0x0", transactionIndex: "-1"}),
    null,
  );
});
