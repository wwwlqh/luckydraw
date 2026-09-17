// How many RPC requests `/round` costs per block epoch, with and without Multicall3 (SPEC §10.1).
//
// Measurement, not a fix: §10.1 budgets an *idle tab* at under 30 requests a minute and says direct reads
// are batched through Multicall3. Whether the app gets that batching is decided by one field —
// `networkIdentity.multicall3` in the chain record, which `records.ts` reads and `DeploymentProvider` hands
// to every `ReadContext` — and the second axis is the snapshot tag: chain 31337 pins to the head (anvil
// reports `finalized` as block 0), so every head-pinned batch re-reads its block to prove it did not reorg,
// while a chain with a finality tag does not need that proof.
//
// All four combinations are measured here against the same fixtures, so the effect of the chain record's
// Multicall3 is a number in this file rather than a claim in a report. Nothing here changes the polling.

import {
  type Address,
  aggregatorV3Abi,
  luckyDrawAbi,
  luckyVaultAbi,
  multicall3Abi,
  type ReadContext,
  type ReadProvider,
  readEntryPanel,
  readFeed,
  type VerifiedDeployment,
} from "@luckydraw/client";
import {Interface} from "ethers";
import {describe, expect, it} from "vitest";
import {testManifest} from "../../test/harness.tsx";
import {PLAYER, PRICE, pool, position, quote, ranges, round, SEED_ACCOUNT} from "./fixtures.ts";
import {readRoundPage, readRoundPosition, readRoundRanges} from "./round.ts";

const drawAbi = new Interface(luckyDrawAbi);
const vaultAbi = new Interface(luckyVaultAbi);
const feedAbi = new Interface(aggregatorV3Abi);
const multicallAbi = new Interface(multicall3Abi);

/** A labeled stand-in for the canonical deployment; the operator records the real one per chain (ADR 034). */
const MULTICALL3 = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

const BLOCK = {number: 1_234, hash: `0x${"11".repeat(32)}`, timestamp: 1_790_812_800};

type Counter = {
  provider: ReadProvider;
  calls: number;
  blocks: number;
  /** Every request, in order, for the breakdown the report quotes. */
  log: string[];
};

/**
 * A `ReadProvider` that answers the round page's calls from the fixtures and counts every request.
 *
 * With `multicall3` given, a call to that address is decoded as `aggregate3`, each item is answered by the
 * same fixture `answer()` the direct path uses, and the results are re-encoded as `[[true, data], ...]` —
 * so the two measurements differ only in how the calls are carried, never in what they return.
 */
function countingProvider(draw: Address, vault: Address, multicall3?: Address): Counter {
  const counter: Counter = {provider: null as unknown as ReadProvider, calls: 0, blocks: 0, log: []};

  const answer = (to: string, data: string): string => {
    const selector = data.slice(0, 10);
    const lower = to.toLowerCase();
    if (lower === draw) {
      const fragment = drawAbi.getFunction(selector);
      if (fragment === null) throw new Error(`no draw function ${selector}`);
      counter.log.push(`draw.${fragment.name}`);
      switch (fragment.name) {
        case "getRound":
          return drawAbi.encodeFunctionResult(fragment, [round()]);
        case "getPool":
          return drawAbi.encodeFunctionResult(fragment, [pool()]);
        case "getPosition": {
          const held = position();
          return drawAbi.encodeFunctionResult(fragment, [
            held.gross,
            held.refunded,
            held.shareNumerator,
            held.shareDenominator,
          ]);
        }
        case "getCurrent":
          return drawAbi.encodeFunctionResult(fragment, [9n]);
        case "getSeedAccount":
          return drawAbi.encodeFunctionResult(fragment, [SEED_ACCOUNT]);
        case "buysPaused":
          return drawAbi.encodeFunctionResult(fragment, [false]);
        case "quoteBuy":
          return drawAbi.encodeFunctionResult(fragment, [quote()]);
        case "getRanges":
          return drawAbi.encodeFunctionResult(fragment, [ranges(), BigInt(ranges().length)]);
        default:
          throw new Error(`unexpected draw call ${fragment.name}`);
      }
    }
    if (lower === vault) {
      const fragment = vaultAbi.getFunction(selector);
      if (fragment === null) throw new Error(`no vault function ${selector}`);
      counter.log.push(`vault.${fragment.name}`);
      return vaultAbi.encodeFunctionResult(fragment, [0n]);
    }
    const fragment = feedAbi.getFunction(selector);
    if (fragment === null) throw new Error(`no feed function ${selector}`);
    counter.log.push(`feed.${fragment.name}`);
    if (fragment.name === "decimals") return feedAbi.encodeFunctionResult(fragment, [8]);
    return feedAbi.encodeFunctionResult(fragment, [
      42n,
      PRICE,
      BigInt(BLOCK.timestamp) - 60n,
      BigInt(BLOCK.timestamp) - 60n,
      42n,
    ]);
  };

  const aggregate = (data: string): string => {
    const [items] = multicallAbi.decodeFunctionData("aggregate3", data) as unknown as [
      readonly [string, boolean, string][],
    ];
    counter.log.push(`multicall3.aggregate3(${items.length})`);
    const results = items.map((item) => [true, answer(item[0], item[2])]);
    return multicallAbi.encodeFunctionResult("aggregate3", [results]);
  };

  counter.provider = {
    call: (tx) => {
      counter.calls += 1;
      if (multicall3 !== undefined && tx.to.toLowerCase() === multicall3.toLowerCase()) {
        return Promise.resolve(aggregate(tx.data));
      }
      return Promise.resolve(answer(tx.to, tx.data));
    },
    getBlock: (tag) => {
      counter.blocks += 1;
      counter.log.push(`getBlock(${String(tag)})`);
      return Promise.resolve(BLOCK);
    },
    getBlockNumber: () => {
      counter.blocks += 1;
      counter.log.push("getBlockNumber");
      return Promise.resolve(BLOCK.number);
    },
    getNetwork: () => Promise.resolve({chainId: 31_337n}),
  };
  return counter;
}

type Budget = {calls: number; blocks: number; total: number};

/**
 * Runs exactly the five reads `Round.tsx` issues in one block epoch, in the order its hooks mount them, and
 * returns what they cost. `multicall3` and `tag` are the two fields `readContextFor` varies by chain.
 */
async function measure(options: {
  multicall3?: Address;
  tag?: "latest" | undefined;
}): Promise<{budget: Budget; log: readonly string[]}> {
  const manifest = testManifest();
  const deployment: VerifiedDeployment = {
    manifest,
    chainId: manifest.chain.chainId,
    verifiedAtBlock: BigInt(BLOCK.number),
    vault: manifest.contracts.vault.address,
    draw: manifest.contracts.draw.address,
    checks: [],
  };
  const counter = countingProvider(deployment.draw, deployment.vault, options.multicall3);
  const ctx: ReadContext = {
    provider: counter.provider,
    deployment,
    multicall3: options.multicall3,
    depth: 200n,
    tag: options.tag,
  };

  const roundId = 1n;
  const nativeFeed = manifest.assets.find((entry) => entry.native)?.price.feed as Address;

  await readRoundPage(ctx, roundId);
  await readRoundPosition(ctx, roundId, PLAYER);
  await readRoundRanges(ctx, roundId);
  await readEntryPanel(ctx, roundId, PLAYER, 0n);
  await readFeed(ctx, nativeFeed);

  return {
    budget: {calls: counter.calls, blocks: counter.blocks, total: counter.calls + counter.blocks},
    log: counter.log,
  };
}

describe("the round page's RPC budget, chain 31337 (head-pinned)", () => {
  it("costs 42 requests an epoch with no Multicall3 in the chain record", async () => {
    // Exactly what `readContextFor` builds for chain 31337: no Multicall3, pinned to the head (anvil
    // reports `finalized` as block 0), depth 200.
    const {budget, log} = await measure({tag: "latest"});
    // Recorded so a change in the read composition shows up as a number rather than as a slow page:
    //
    //   readRoundPage      7 eth_call  +  7 block reads  (1 head + 6 `requireSameHead`)
    //   readRoundPosition  1           +  2
    //   readRoundRanges    2           +  3
    //   readEntryPanel    13           +  3
    //   readFeed (native)  2           +  2
    expect(budget).toEqual({calls: 25, blocks: 17, total: 42});
    // Five reads, five independent head resolutions: nothing shares one block across the page.
    expect(log.filter((entry) => entry === "getBlock(latest)")).toHaveLength(5);
  });

  it("costs 29 with Multicall3, because the 25 calls collapse into 12 aggregate3 batches", async () => {
    const {budget, log} = await measure({tag: "latest", multicall3: MULTICALL3});
    expect(budget).toEqual({calls: 12, blocks: 17, total: 29});
    // Every call went through the batcher: nothing reached a contract directly.
    expect(log.filter((entry) => entry.startsWith("multicall3.aggregate3"))).toHaveLength(12);
    // The 17 block reads are untouched by batching: each read resolves its own head and each head-pinned
    // batch re-reads it to prove it did not reorg. Only a finality tag removes those (below).
    expect(budget.blocks).toBe(17);
  });
});

describe("the round page's RPC budget, a chain with a finality tag (chain 56 shape)", () => {
  it("costs 32 requests an epoch with no Multicall3 in the chain record", async () => {
    // `tag: undefined` is what `readContextFor` builds off 31337: the client's own finalized -> safe ->
    // depth walk. A finalized block cannot reorg, so no batch re-reads it.
    const {budget} = await measure({});
    expect(budget).toEqual({calls: 25, blocks: 7, total: 32});
  });

  it("costs 19 with Multicall3 from the chain record", async () => {
    const {budget, log} = await measure({multicall3: MULTICALL3});
    expect(budget).toEqual({calls: 12, blocks: 7, total: 19});
    expect(log.filter((entry) => entry.startsWith("multicall3.aggregate3"))).toHaveLength(12);
  });

  it("is the configuration chain 56 must ship: 19 requests, not 42", async () => {
    // One field in config/chains/56.json — networkIdentity.multicall3 — is the difference between a round
    // page a public BSC RPC will serve and one it will rate-limit (SPEC §10.1).
    const worst = await measure({tag: "latest"});
    const best = await measure({multicall3: MULTICALL3});
    expect(worst.budget.total - best.budget.total).toBe(23);
  });
});
