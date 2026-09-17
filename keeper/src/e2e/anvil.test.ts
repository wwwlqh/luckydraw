// Opt-in end-to-end journey: the real keeper loop against a real local anvil, with no private key anywhere.
//
//   LUCKYDRAW_ANVIL=1 node --test src/e2e/anvil.test.ts
//
// Without `LUCKYDRAW_ANVIL=1` the test skips, so `node --test "src/**/*.test.ts"` stays hermetic.
//
// What it proves that a fake node cannot: that the keeper started from a manifest the repository's own
// `DeployLocal` -> `Finalize` flow wrote actually drives a round from Open to Settled without anyone calling
// a lifecycle method by hand - seed, close, request, settle - and that it credits a single-player round's
// refund. The coordinator is the labeled mock, whose delivery is explicit, so the test plays the part of the
// oracle and nothing else (SPEC §7.1: "real delivery is asynchronous; mocks must model it accordingly").
//
// The process harness is the client's, unchanged: same anvil, same `forge script` invocation, same
// `contracts/test/script/tmp/<run>` sandbox. Everything this test writes lives there; `config/` is read and
// asserted unchanged.

import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {mkdirSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {Interface, JsonRpcProvider, type JsonRpcSigner} from "ethers";
import {
  CONTRACTS_DIR,
  DEPLOYER,
  findManifest,
  REPO_ROOT,
  runForgeScript,
  startAnvil,
} from "../../../packages/client/src/e2e/testing/harness.ts";
import {
  type Address,
  asAddress,
  type Hex32,
  Kind,
  type PreparedWrite,
  prepareAuthorizeSeed,
  prepareBuy,
  prepareDepositNative,
  type RawLog,
  type ReadContext,
  type RoundView,
  readCurrent,
  readFeed,
  readPosition,
  readRound,
  State,
  stateName,
  ZERO_ADDRESS,
} from "../client.ts";
import {type Environment, loadConfig} from "../config.ts";
import {type CoordinatorLogQuery, createCostMeter, parseReceipt} from "../costs.ts";
import {createKeeper} from "../keeper.ts";
import {createLogger} from "../log.ts";
import type {LogQuery} from "../refunds.ts";
import {createDispatcher, createSender} from "../sender.ts";
import {prepare} from "../startup.ts";

const ENABLED = process.env.LUCKYDRAW_ANVIL === "1";

// anvil default accounts. 3 is the labeled seed Safe of `DeployLocal`; 4 is this keeper; 5 and 6 are players.
const SEED_INDEX = 3;
const KEEPER_INDEX = 4;
const PLAYER_A_INDEX = 5;
const PLAYER_B_INDEX = 6;

const ONE_BNB = 1_000_000_000_000_000_000n;
const ENTRY_GROSS = 10_000_000_000_000_000n; // 0.01 BNB, USD 6 at the local mock price of USD 600.
const SEED_AMOUNT = 10_000_000_000_000_000n; // `DeployLocal` SEED_NATIVE.

const feedInterface = new Interface(["function set(uint80 roundId, int256 answer, uint256 updatedAt)"]);
const coordinatorInterface = new Interface(["function fulfill(uint256 requestId, uint256[] words)"]);

let steps = 0;
let assertions = 0;

function step(name: string): void {
  steps += 1;
  process.stdout.write(`LDKEEPER_E2E step ${steps}: ${name}\n`);
}

function eq<T>(actual: T, expected: T, message: string): void {
  assertions += 1;
  assert.strictEqual(actual, expected, message);
}

function ok(value: unknown, message: string): asserts value {
  assertions += 1;
  assert.ok(value, message);
}

async function send(signer: JsonRpcSigner, write: PreparedWrite): Promise<void> {
  const sent = await signer.sendTransaction({to: write.to, data: write.data, value: write.value});
  const receipt = await sent.wait();
  if (receipt === null) throw new Error(`${write.function} produced no receipt`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `accept` holds, so the assertions describe the keeper's effect rather than its schedule. */
async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  describe: (value: T) => string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last seen ${describe(last)}`);
    await sleep(250);
    last = await read();
  }
  assertions += 1;
  process.stdout.write(`LDKEEPER_E2E observed ${label}: ${describe(last)}\n`);
  return last;
}

const describeRound = (round: RoundView): string =>
  `round ${round.id} ${stateName(round.state)} players=${round.playerCount} seeded=${round.seeded}`;

test("the keeper drives a local deployment through the SPEC 6.2 lifecycle", {
  timeout: 900_000,
}, async (t: TestContext) => {
  if (!ENABLED) {
    t.skip("set LUCKYDRAW_ANVIL=1 to run the anvil keeper journey (it starts a node and runs forge)");
    return;
  }

  const runId = `keeper-e2e-${randomBytes(6).toString("hex")}`;
  const relativeDir = `test/script/tmp/${runId}`;
  const runDir = join(CONTRACTS_DIR, relativeDir);
  const deploymentsDir = join(runDir, "deployments");
  mkdirSync(deploymentsDir, {recursive: true});

  const configDir = join(REPO_ROOT, "config", "deployments", "31337");
  const fingerprint = (): string[] =>
    readdirSync(configDir)
      .sort()
      .map(
        (name) =>
          `${name}:${createHash("sha256")
            .update(readFileSync(join(configDir, name)))
            .digest("hex")}`,
      );
  const configBefore = fingerprint();

  step(`start anvil and deploy into ${relativeDir}`);
  const node = await startAnvil(runDir);
  let provider: JsonRpcProvider | null = null;
  let stopKeeper: (() => Promise<void>) | null = null;
  try {
    const scriptEnv: Record<string, string> = {
      LUCKYDRAW_DEPLOYMENTS_DIR: `${relativeDir}/deployments`,
      FOUNDRY_BROADCAST: `${relativeDir}/broadcast`,
    };
    await runForgeScript({
      name: "DeployLocal",
      args: ["--broadcast", "--unlocked", "--sender", DEPLOYER],
      env: scriptEnv,
      rpcUrl: node.url,
      logPath: join(runDir, "deploy.log"),
    });
    const manifestPath = findManifest(deploymentsDir);
    await runForgeScript({
      name: "Finalize",
      args: [],
      env: {
        ...scriptEnv,
        LUCKYDRAW_MANIFEST: manifestPath,
        LUCKYDRAW_BROADCAST: `${relativeDir}/broadcast/DeployLocal.s.sol/31337/run-latest.json`,
      },
      rpcUrl: node.url,
      logPath: join(runDir, "finalize.log"),
    });

    // `cacheTimeout: -1` disables ethers' 250 ms response cache: a keeper assertion taken straight after a
    // receipt must not be answered from the block before it (the client e2e records the same reason).
    const rpc = new JsonRpcProvider(node.url, 31337, {staticNetwork: true, cacheTimeout: -1});
    provider = rpc;
    const deployer = await rpc.getSigner(0);
    const keeperSigner = await rpc.getSigner(KEEPER_INDEX);
    const seedSigner = await rpc.getSigner(SEED_INDEX);
    const playerA = await rpc.getSigner(PLAYER_A_INDEX);
    const playerB = await rpc.getSigner(PLAYER_B_INDEX);
    const keeperAddress = asAddress((await keeperSigner.getAddress()).toLowerCase());
    const addressB = asAddress((await playerB.getAddress()).toLowerCase());

    step("start the keeper in unlocked mode against the manifest the scripts just wrote");
    const drawAddress = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contracts: {draw: {address: string}};
      vrf: {coordinator: string};
      assets: {price: {feed: string}}[];
    };
    const env: Environment = {
      KEEPER_RPC_URL: node.url,
      KEEPER_CHAIN_ID: "31337",
      KEEPER_DRAW_ADDRESS: drawAddress.contracts.draw.address,
      KEEPER_UNLOCKED_ADDRESS: keeperAddress,
      KEEPER_INTERVAL_MS: "400",
      KEEPER_LOG_WINDOW: "500",
      KEEPER_DEPLOYMENTS_DIR: deploymentsDir,
    };
    const config = loadConfig(env);
    // `prepare` also loads and probes the chain record's Multicall3, so the journey runs the same gate the
    // process does; chain 31337's record carries null today, which is the "no batching" path.
    const {manifest, deployment, multicall3} = await prepare(config, rpc);
    eq(manifest.environment, "local", "the keeper verified a local manifest");
    const sender = createSender(config, rpc, env);
    eq(sender.kind, "unlocked", "no key exists in this run");
    eq(sender.address, keeperAddress, "the keeper signs as anvil account 4");

    const logQuery: LogQuery = async (range) => {
      const logs = await rpc.getLogs({
        address: deployment.draw,
        topics: [[...range.topics] as Hex32[]],
        fromBlock: Number(range.fromBlock),
        toBlock: Number(range.toBlock),
      });
      return logs as unknown as readonly RawLog[];
    };
    // The same two provider calls `main.ts` gives the cost meter, against a real node: what this adds over
    // the unit tests is that `parseReceipt` is fed anvil's own `eth_getTransactionReceipt` answer.
    const coordinatorLogs: CoordinatorLogQuery = async (filter) => {
      const logs = await rpc.getLogs({
        address: filter.address,
        topics: [...filter.topics],
        fromBlock: Number(filter.fromBlock),
        toBlock: Number(filter.toBlock),
      });
      return logs as unknown as readonly RawLog[];
    };
    const keeperLines: string[] = [];
    const logger = createLogger({
      write: (line) => {
        keeperLines.push(line);
        process.stdout.write(`${line}\n`);
      },
    });
    const keeper = createKeeper({
      config,
      deployment,
      provider: rpc,
      dispatcher: createDispatcher(rpc, sender, {dryRun: false}),
      logQuery,
      logger,
      multicall3,
      costMeter: createCostMeter({
        deployment,
        logger,
        receipt: async (hash) => parseReceipt(await rpc.send("eth_getTransactionReceipt", [hash])),
        logs: coordinatorLogs,
        window: config.logWindow,
      }),
    });
    stopKeeper = () => keeper.stop();

    const ctx: ReadContext = {provider: rpc, deployment, tag: "latest"};
    const nativeAsset = manifest.assets[0];
    ok(nativeAsset?.native, "the first manifest asset is native BNB");
    const poolId = nativeAsset.pool.poolId;
    const roundId = nativeAsset.pool.firstRoundIds[0] ?? 0n;
    const feed = nativeAsset.price.feed;
    ok(feed !== null, "the local native pool has a mock feed");

    step("fund both players and the operator seed Safe");
    await send(playerA, prepareDepositNative(deployment, ONE_BNB / 2n));
    await send(playerB, prepareDepositNative(deployment, ONE_BNB / 2n));
    await send(seedSigner, prepareDepositNative(deployment, ONE_BNB / 2n));

    keeper.start();

    step("the keeper seeds the first daily round (SPEC 5.4)");
    const seeded = await waitFor(
      "the daily round to be seeded by the keeper",
      async () => (await readRound(ctx, roundId)).value,
      (round) => round.seeded,
      describeRound,
    );
    eq(seeded.seedGross, SEED_AMOUNT, "the seed entered at the pool's configured amount");
    eq(seeded.seedAccount, manifest.ownership.seedAccount, "the round records the seed account");
    eq(seeded.playerCount, 1n, "the seed is the only entry so far");

    step("two players enter, then the seed Safe revokes its BNB consent so the successor stays unseeded");
    await buy(ctx, deployment, playerA, roundId);
    await buy(ctx, deployment, playerB, roundId);
    const entered = (await readRound(ctx, roundId)).value;
    eq(entered.playerCount, 3n, "the seed plus two distinct players");
    await send(seedSigner, prepareAuthorizeSeed(deployment, ZERO_ADDRESS, 0n));

    step("travel past the daily cutoff; the keeper closes and requests");
    await warpPast(rpc, entered.closesAt);
    await refreshFeed(ctx, deployer, feed);
    await waitFor(
      "the keeper to close the round into AwaitingRequest",
      async () => (await readRound(ctx, roundId)).value,
      (round) => round.state !== State.Open,
      describeRound,
    );
    const requested = await waitFor(
      "the keeper to request randomness",
      async () => (await readRound(ctx, roundId)).value,
      (round) => round.state === State.Drawing,
      describeRound,
    );
    ok(requested.requestId > 0n, "the Draw recorded a coordinator request id");

    step("the mock coordinator delivers two words; the keeper settles");
    await deployer.sendTransaction({
      to: manifest.vrf.coordinator,
      data: coordinatorInterface.encodeFunctionData("fulfill", [
        requested.requestId,
        [123_456_789n, 987_654_321n],
      ]),
      gasLimit: 2_000_000n,
    });
    const settled = await waitFor(
      "the keeper to settle the round",
      async () => (await readRound(ctx, roundId)).value,
      (round) => round.state === State.Settled,
      describeRound,
    );
    ok(settled.winner !== ZERO_ADDRESS, "settlement chose a winner");
    ok(settled.settledAt > 0n, "settlement is timestamped");

    step("the cost meter reports what the settled draw cost");
    const costLine = await waitFor(
      "the keeper to report the settled round's cost",
      async () => keeperLines.find((line) => line.includes(`event=draw_cost round=${roundId} `)),
      (line) => line !== undefined,
      (line) => line ?? "no draw_cost line yet",
    );
    ok(/keeperGasWei=[1-9][0-9]*/.test(costLine ?? ""), "the keeper's own gas is a positive wei figure");
    // The labeled mock coordinator emits a different `RandomWordsFulfilled` (no payment), so there is no VRF
    // charge to read here and the meter says so rather than inventing one. On chain 56 this is the number.
    ok(
      (costLine ?? "").includes("vrfPaymentWei=null") && (costLine ?? "").includes("note=FulfilmentNotFound"),
      "a mock fulfilment reports no payment, with the reason",
    );

    step("a second round with a single player refunds, credited by the keeper");
    const successorId = (await readCurrent(ctx, poolId, Kind.Day100)).value;
    ok(successorId !== 0n && successorId !== roundId, "the close advanced current to a successor");
    const successor = (await readRound(ctx, successorId)).value;
    eq(successor.seeded, false, "the revoked consent keeps the successor unseeded");
    await buy(ctx, deployment, playerB, successorId);
    const lone = (await readRound(ctx, successorId)).value;
    eq(lone.playerCount, 1n, "exactly one distinct address entered");

    await warpPast(rpc, lone.closesAt);
    await refreshFeed(ctx, deployer, feed);
    await waitFor(
      "the keeper to close the single-player round into Refunding",
      async () => (await readRound(ctx, successorId)).value,
      (round) => round.state === State.Refunding,
      describeRound,
    );
    await waitFor(
      "the keeper to credit player B's refund",
      async () => (await readPosition(ctx, successorId, addressB)).value,
      (position) => position.refunded,
      (position) => `gross=${position.gross} refunded=${position.refunded}`,
    );
    const refunded = (await readRound(ctx, successorId)).value;
    eq(refunded.refundedGross, refunded.grossTotal, "the round is fully refunded");

    assertions += 1;
    assert.deepStrictEqual(
      fingerprint(),
      configBefore,
      "config/deployments/31337 is untouched, byte for byte",
    );

    process.stdout.write(
      `LDKEEPER_E2E | steps=${steps} | assertions=${assertions} | keeper=${keeperAddress}` +
        ` | draw=${deployment.draw}\n`,
    );
  } finally {
    await stopKeeper?.();
    provider?.destroy();
    node.stop();
  }
});

/** A plain full-price entry: the keeper journey does not re-test the quote path, which the client e2e owns. */
async function buy(
  ctx: ReadContext,
  deployment: ReadContext["deployment"],
  signer: JsonRpcSigner,
  roundId: bigint,
): Promise<void> {
  const snapshot = await readRound(ctx, roundId);
  await send(
    signer,
    prepareBuy(deployment, {
      roundId,
      asset: snapshot.value.asset,
      gross: ENTRY_GROSS,
      minNetContribution: 0n,
      deadline: snapshot.timestamp + 300n,
    }),
  );
}

/** Moves anvil to one second past `closesAt` and mines, so the next read sees a closed window. */
async function warpPast(provider: JsonRpcProvider, closesAt: bigint): Promise<void> {
  const head = await provider.getBlock("latest");
  const current = BigInt(head?.timestamp ?? 0);
  const target = closesAt > current ? closesAt + 1n : current + 1n;
  await provider.send("evm_setNextBlockTimestamp", [Number(target)]);
  await provider.send("evm_mine", []);
}

/**
 * Re-publishes the mock feed at the new chain time.
 *
 * Time travel makes the frozen mock answer older than the pool's `maxPriceAge`, and SPEC §3.2 makes a stale
 * price a refusal, so without this the next `buy` would revert `PriceStale`. The answer is unchanged: only
 * its `updatedAt` moves.
 */
async function refreshFeed(ctx: ReadContext, deployer: JsonRpcSigner, feed: Address): Promise<void> {
  const reading = await readFeed(ctx, feed);
  const observation = reading.value.observation;
  if (observation === null) throw new Error(`the mock feed ${feed} returned no observation`);
  await deployer.sendTransaction({
    to: feed,
    data: feedInterface.encodeFunctionData("set", [
      observation.roundId + 1n,
      observation.answer,
      reading.timestamp,
    ]),
  });
}
