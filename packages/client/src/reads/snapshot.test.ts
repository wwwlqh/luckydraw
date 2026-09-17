import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import type {JsonRpcProvider} from "ethers";
import {parseManifest} from "../deployments/manifest.ts";
import {type Address, asHex} from "../types/common.ts";
import {type BlockSummary, blockTagOf, type ReadProvider} from "./provider.ts";
import {ReadError} from "./readError.ts";
import {
  DEFAULT_CONFIRMATION_DEPTH,
  type ReadCall,
  readBatch,
  resolveSnapshotBlock,
  snapshotOf,
} from "./snapshot.ts";
import {drawInterface, fakeProvider, MULTICALL3, vaultInterface, verifiedFrom} from "./testing/fake.ts";
import {BUYER, roundFixture} from "./testing/views.ts";

// Compile-time proof of the claim in provider.ts: an ethers v6 JsonRpcProvider satisfies `ReadProvider`
// structurally, with no adapter. This is a type, not a value, so it fails the typecheck rather than the run.
type Requires<T extends ReadProvider> = T;
export type EthersSatisfiesReadProvider = Requires<JsonRpcProvider>;

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
const deployment = verifiedFrom(manifest);
const DRAW: Address = deployment.draw;
const VAULT: Address = deployment.vault;

const HASH_400 = `0x${"11".repeat(32)}`;
const HASH_600 = `0x${"22".repeat(32)}`;
const HASH_800 = `0x${"33".repeat(32)}`;

const FINALIZED_BLOCK = {number: 400, hash: HASH_400, timestamp: 1_790_000_000};
const SAFE_BLOCK = {number: 600, hash: HASH_600, timestamp: 1_790_000_400};
const LATEST_BLOCK = {number: 800, hash: HASH_800, timestamp: 1_790_000_800};

// `InvalidId()`, the revert `getRound(0)` produces.
const INVALID_ID = drawInterface.encodeErrorResult("InvalidId", []);

function roundCall(roundId: bigint): ReadCall {
  return {to: DRAW, data: asHex(drawInterface.encodeFunctionData("getRound", [roundId]))};
}

function balanceCall(user: Address, asset: Address): ReadCall {
  return {to: VAULT, data: asHex(vaultInterface.encodeFunctionData("balanceOf", [user, asset]))};
}

function withAnswers(options: Parameters<typeof fakeProvider>[0] = {}) {
  const provider = fakeProvider(options);
  const round = roundFixture();
  provider.answer(DRAW, roundCall(1n).data, {
    ok: true,
    data: drawInterface.encodeFunctionResult("getRound", [round]),
  });
  provider.answer(DRAW, roundCall(0n).data, {ok: false, revertData: INVALID_ID});
  provider.answer(VAULT, balanceCall(BUYER, round.asset).data, {
    ok: true,
    data: vaultInterface.encodeFunctionResult("balanceOf", [7n]),
  });
  return provider;
}

test("resolveSnapshotBlock prefers finalized", async () => {
  const provider = withAnswers({
    blocks: {finalized: FINALIZED_BLOCK, safe: SAFE_BLOCK, latest: LATEST_BLOCK},
  });
  const block = await resolveSnapshotBlock(provider);
  assert.equal(block.blockNumber, 400n);
  assert.equal(block.blockHash, HASH_400);
  assert.equal(block.timestamp, 1_790_000_000n);
  assert.deepStrictEqual(block.confidence, {tag: "finalized", depth: null});
});

test("resolveSnapshotBlock falls back to safe when finalized is unsupported", async () => {
  for (const throwOnUnknownTag of [false, true]) {
    const provider = withAnswers({blocks: {safe: SAFE_BLOCK, latest: LATEST_BLOCK}, throwOnUnknownTag});
    const block = await resolveSnapshotBlock(provider);
    assert.equal(block.blockNumber, 600n, `safe fallback, throwOnUnknownTag=${throwOnUnknownTag}`);
    assert.deepStrictEqual(block.confidence, {tag: "safe", depth: null});
  }
});

test("resolveSnapshotBlock falls back to a fixed depth behind latest", async () => {
  const behind = {number: 600, hash: HASH_600, timestamp: 1_790_000_400};
  const provider = withAnswers({
    blocks: {latest: LATEST_BLOCK},
    byNumber: {[blockTagOf(800n - DEFAULT_CONFIRMATION_DEPTH)]: behind},
    throwOnUnknownTag: true,
  });
  const block = await resolveSnapshotBlock(provider);
  assert.equal(block.blockNumber, 600n, "800 - 200");
  assert.deepStrictEqual(block.confidence, {tag: "latest", depth: DEFAULT_CONFIRMATION_DEPTH});
});

test("resolveSnapshotBlock never asks for a negative block on a young chain", async () => {
  const genesis = {number: 0, hash: HASH_400, timestamp: 1_790_000_000};
  const provider = withAnswers({
    blocks: {latest: {number: 3, hash: HASH_800, timestamp: 1_790_000_300}},
    byNumber: {[blockTagOf(0n)]: genesis},
    throwOnUnknownTag: true,
  });
  const block = await resolveSnapshotBlock(provider);
  assert.equal(block.blockNumber, 0n);
});

test("resolveSnapshotBlock honours a forced tag", async () => {
  const provider = withAnswers({blocks: {finalized: FINALIZED_BLOCK, latest: LATEST_BLOCK}});
  const head = await resolveSnapshotBlock(provider, {tag: "latest"});
  assert.equal(head.blockNumber, 800n);
  assert.deepStrictEqual(head.confidence, {tag: "latest", depth: 0n}, "the head carries no depth");
});

test("resolveSnapshotBlock reports SnapshotUnavailable when nothing answers", async () => {
  const provider = withAnswers({throwOnUnknownTag: true});
  await assert.rejects(
    () => resolveSnapshotBlock(provider),
    (error: unknown) => error instanceof ReadError && error.code === "SnapshotUnavailable",
  );
});

test("readBatch pins every call to the snapshot block, with and without Multicall3", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const calls = [roundCall(1n), balanceCall(BUYER, roundFixture().asset)];

  const direct = withAnswers();
  await readBatch(direct, block, calls);
  assert.equal(direct.calls.length, 2, "one eth_call per item");
  for (const recorded of direct.calls) {
    assert.equal(recorded.blockTag, blockTagOf(400n), "every direct call carries the snapshot block");
  }

  const batched = withAnswers();
  await readBatch(batched, block, calls, {multicall3: MULTICALL3});
  assert.equal(batched.calls.length, 1, "one aggregate3 for the whole snapshot");
  assert.equal(batched.calls[0]?.blockTag, blockTagOf(400n));
  assert.equal(batched.calls[0]?.to, MULTICALL3);
});

test("the Multicall3 and direct paths return equal outcomes, reverts included", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const calls = [roundCall(1n), roundCall(0n), balanceCall(BUYER, roundFixture().asset)];

  const direct = await readBatch(withAnswers(), block, calls);
  const batched = await readBatch(withAnswers(), block, calls, {multicall3: MULTICALL3});
  assert.deepStrictEqual(batched, direct, "the two batch paths must be interchangeable");
});

test("a reverting call is a per-call failure, not a lost batch", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const calls = [roundCall(0n), roundCall(1n)];
  for (const options of [{}, {multicall3: MULTICALL3}]) {
    const outcomes = await readBatch(withAnswers(), block, calls, options);
    const failed = outcomes[0];
    const survived = outcomes[1];
    assert.equal(failed?.ok, false, "getRound(0) reverted");
    assert.equal(failed?.ok === false ? failed.revertData : "", INVALID_ID.toLowerCase());
    assert.equal(survived?.ok, true, "the rest of the snapshot survived the revert");
  }
});

test("readBatch rethrows a transport failure rather than inventing an empty revert", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const provider = fakeProvider();
  // No answer registered: the fake throws a plain Error with no revert bytes, like a dead RPC.
  await assert.rejects(() => readBatch(provider, block, [roundCall(1n)]));
});

test("snapshotOf takes the chain id from the verified deployment, never a re-fetch", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const snapshot = snapshotOf(deployment, block, 42n);
  assert.equal(snapshot.chainId, manifest.chain.chainId);
  assert.equal(snapshot.blockNumber, 400n);
  assert.equal(snapshot.blockHash, HASH_400);
  assert.equal(snapshot.timestamp, 1_790_000_000n);
  assert.equal(snapshot.value, 42n);
});

test("blockTagOf produces a JSON-RPC quantity and refuses a negative block", () => {
  assert.equal(blockTagOf(0n), "0x0");
  assert.equal(blockTagOf(255n), "0xff");
  assert.throws(() => blockTagOf(-1n), RangeError);
});

test("readBatch turns a node-reported execution failure without revert bytes into an empty revert", async () => {
  const block = {
    blockNumber: 400n,
    blockHash: asHex(HASH_400) as `0x${string}`,
    timestamp: 1_790_000_000n,
    confidence: {tag: "finalized" as const, depth: null},
  };
  const base = fakeProvider();
  const provider = {
    ...base,
    call: () =>
      Promise.reject(Object.assign(new Error("missing revert data"), {code: "CALL_EXCEPTION", data: null})),
  };
  // Multicall3 answers `(false, "0x")` for an invalid opcode; the direct path must be interchangeable.
  assert.deepEqual(await readBatch(provider, block, [roundCall(1n)]), [{ok: false, revertData: "0x"}]);
});

test("a head-pinned read fails as SnapshotReorged when the block's hash changes underneath it", async () => {
  // SPEC 10.1 makes the hash the snapshot's identity; a one-block reorg between getBlock and the calls must
  // not label fork-B state with fork-A's hash.
  const HASH_A = `0x${"aa".repeat(32)}`;
  const HASH_B = `0x${"bb".repeat(32)}`;
  let canonical: BlockSummary = {number: 10, hash: HASH_A, timestamp: 1_000};
  let reorgOnCall = true;
  const provider: ReadProvider = {
    async getBlock() {
      return canonical;
    },
    async call() {
      if (reorgOnCall) canonical = {number: 10, hash: HASH_B, timestamp: 1_001};
      return `0x${"02".padStart(64, "0")}`;
    },
    async getBlockNumber() {
      return 10;
    },
    async getNetwork() {
      return {chainId: 31337n};
    },
  };
  const calls: ReadCall[] = [{to: DRAW, data: asHex("0x12345678")}];

  const head = await resolveSnapshotBlock(provider, {tag: "latest"});
  assert.equal(head.blockHash, HASH_A);
  await assert.rejects(
    readBatch(provider, head, calls),
    (error: unknown) => error instanceof ReadError && error.code === "SnapshotReorged",
  );

  // A stable head answers, and the snapshot carries the hash the calls were read under.
  reorgOnCall = false;
  canonical = {number: 10, hash: HASH_A, timestamp: 1_000};
  const stable = await resolveSnapshotBlock(provider, {tag: "latest"});
  const outcomes = await readBatch(provider, stable, calls);
  assert.equal(outcomes.length, 1);
  assert.equal(snapshotOf(deployment, stable, outcomes).blockHash, HASH_A);

  // Deeper tags are not re-read: finalized and safe do not reorg, so the provider is asked nothing extra.
  reorgOnCall = true;
  let blockReads = 0;
  const finalizedProvider: ReadProvider = {
    ...provider,
    async getBlock() {
      blockReads += 1;
      return canonical;
    },
  };
  const finalized = await resolveSnapshotBlock(finalizedProvider, {tag: "finalized"});
  await readBatch(finalizedProvider, finalized, calls);
  assert.equal(blockReads, 1, "one getBlock to choose the block, none to re-check it");
});
