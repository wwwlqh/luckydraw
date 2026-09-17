// Opt-in end-to-end journey against a real local anvil, with no private key anywhere.
//
//   LUCKYDRAW_ANVIL=1 node --test src/e2e/anvil.test.ts
//
// Without `LUCKYDRAW_ANVIL=1` the test skips, so `node --test "src/**/*.test.ts"` stays hermetic and fast.
//
// What it proves that a fake provider cannot: that the manifest the repository's own deployment scripts write
// verifies against the node they deployed to (SPEC §15), that the adapters decode what the real contracts
// return, that `previewEntry` in `src/math` agrees with `quoteBuy` on real state (SPEC §5.1, §8.1), that the
// calldata the builders produce is accepted by the real `buy` and produces the events `src/events` decodes
// (SPEC §5.3, §8.2), and that a failed write decodes to the custom error the string catalog expects
// (SPEC §8.1, §9.6).
//
// Everything it writes lives under `contracts/test/script/tmp/client-e2e-<random>/`; `config/` is read and
// asserted unchanged.

import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {mkdirSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {JsonRpcProvider, type JsonRpcSigner, type TransactionReceipt} from "ethers";
import {type DeploymentManifest, parseManifest} from "../deployments/manifest.ts";
import {type VerifiedDeployment, verifyDeployment} from "../deployments/verify.ts";
import {decodeRevert} from "../errors/decode.ts";
import {decodeLog} from "../events/decode.ts";
import {feeOf} from "../math/fee.ts";
import {type EntryPreviewInput, previewEntry} from "../math/quote.ts";
import {nextCutoff} from "../math/schedule.ts";
import {
  type EntryPanel,
  quoteBuy,
  type ReadContext,
  readAllRanges,
  readBalance,
  readCurrent,
  readEntryPanel,
  readPools,
  readPosition,
  readRound,
  readSeedAccount,
  readSeedMaxPerRound,
  resolveSnapshotBlock,
  toObservationInput,
} from "../reads/index.ts";
import {type Address, asAddress, ZERO_ADDRESS} from "../types/common.ts";
import {Kind, KindNames, type Quote, QuoteReason, type RoundView, State} from "../types/generated.ts";
import {entryFromQuote} from "../writes/entry.ts";
import {
  type PreparedWrite,
  prepareAuthorizeSeed,
  prepareBuy,
  prepareCloseRound,
  prepareDepositNative,
  prepareWithdraw,
} from "../writes/prepare.ts";
import {
  CONTRACTS_DIR,
  DEPLOYER,
  findManifest,
  REPO_ROOT,
  runForgeScript,
  startAnvil,
} from "./testing/harness.ts";

const ENABLED = process.env.LUCKYDRAW_ANVIL === "1";

// anvil default accounts. Index 3 is the labeled seed Safe of `DeployLocal`; 5 and 6 are ordinary players.
const SEED_INDEX = 3;
const PLAYER_A_INDEX = 5;
const PLAYER_B_INDEX = 6;

const ONE_BNB = 1_000_000_000_000_000_000n;
const ENTRY_GROSS = 10_000_000_000_000_000n; // 0.01 BNB, USD 6 at the local mock price of USD 600.
const SEED_AMOUNT = 10_000_000_000_000_000n; // `DeployLocal` SEED_NATIVE, and its BNB seed cap.
const SEED_TOKEN_CAP = 500n; // `DeployLocal` SEED_AUTHORIZED_MAX_TEST2: 5.00 of a 2-decimal token.

let steps = 0;
let assertions = 0;

function step(name: string): void {
  steps += 1;
  process.stdout.write(`LDCLIENT_E2E step ${steps}: ${name}\n`);
}

function eq<T>(actual: T, expected: T, message: string): void {
  assertions += 1;
  assert.strictEqual(actual, expected, message);
}

function deep<T>(actual: T, expected: T, message: string): void {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}

function ok(value: unknown, message: string): asserts value {
  assertions += 1;
  assert.ok(value, message);
}

/** The generated-type round turned into the shape `previewEntry` reads (SPEC §10.1: one snapshot). */
function previewInput(panel: EntryPanel, now: bigint, gross: bigint): EntryPreviewInput {
  const round = panel.round;
  return {
    now,
    round: {
      id: round.id,
      state: round.state,
      opensAt: round.opensAt,
      closesAt: round.closesAt,
      // The one boundary where a chain integer becomes a JS number: PriceReader bounds decimals at 0-18.
      tokenDecimals: Number(round.tokenDecimals),
      feedDecimals: Number(round.pricing.feedDecimals),
      targetUsd: round.targetUsd,
      grossTotal: round.grossTotal,
      feeReserved: round.feeReserved,
      playerCount: round.playerCount,
      seeded: round.seeded,
    },
    grossAmount: gross,
    observation: toObservationInput(round, panel.feed, now),
    buyer: {
      grossByUser: panel.position.gross,
      availableBalance: panel.balance,
      seedMaxPerRound: panel.seedMaxPerRound,
    },
    buysPaused: panel.buysPaused,
    poolBuysPaused: panel.pool.buysPaused,
    seed:
      panel.seed === null
        ? undefined
        : {
            account: panel.seed.account,
            amount: panel.seed.amount,
            maxPerRound: panel.seed.maxPerRound,
            availableBalance: panel.seed.availableBalance,
            grossByUser: panel.seed.grossByUser,
          },
  };
}

/** Every field `previewEntry` and `quoteBuy` both produce, compared one by one so a failure names the field. */
function assertPreviewMatchesQuote(
  label: string,
  quote: Quote,
  panel: EntryPanel,
  now: bigint,
  gross: bigint,
): void {
  const preview = previewEntry(previewInput(panel, now, gross));
  eq(preview.reason, quote.reason, `${label}: reason`);
  eq(preview.minGross, quote.minGross, `${label}: minGross`);
  eq(preview.feeDelta, quote.feeDelta, `${label}: feeDelta`);
  eq(preview.netDelta, quote.netDelta, `${label}: netDelta`);
  eq(preview.shareNumeratorBefore, quote.shareNumeratorBefore, `${label}: shareNumeratorBefore`);
  eq(preview.shareDenominatorBefore, quote.shareDenominatorBefore, `${label}: shareDenominatorBefore`);
  eq(preview.shareNumeratorAfter, quote.shareNumeratorAfter, `${label}: shareNumeratorAfter`);
  eq(preview.shareDenominatorAfter, quote.shareDenominatorAfter, `${label}: shareDenominatorAfter`);
  eq(preview.usdValueBefore, quote.usdValueBefore, `${label}: usdValueBefore`);
  eq(preview.usdValueAfter, quote.usdValueAfter, `${label}: usdValueAfter`);
  eq(preview.reachesTarget, quote.reachesTarget, `${label}: reachesTarget`);
  eq(preview.closesAt, quote.closesAt, `${label}: closesAt`);
}

async function send(signer: JsonRpcSigner, write: PreparedWrite): Promise<TransactionReceipt> {
  const sent = await signer.sendTransaction({to: write.to, data: write.data, value: write.value});
  const receipt = await sent.wait();
  if (receipt === null) throw new Error(`${write.function} produced no receipt`);
  return receipt;
}

/** Decoded Vault and Draw logs of one receipt, in log order, with look-alike emitters dropped. */
function decodedLogs(deployment: VerifiedDeployment, receipt: TransactionReceipt) {
  return receipt.logs
    .map((log) =>
      decodeLog(deployment, {
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        index: log.index,
        transactionIndex: log.transactionIndex,
      }),
    )
    .filter((event) => event !== null);
}

function namedEvent(deployment: VerifiedDeployment, receipt: TransactionReceipt, name: string) {
  const found = decodedLogs(deployment, receipt).find((event) => event.name === name);
  ok(found !== undefined, `receipt carries a ${name} event`);
  return found;
}

test("client end-to-end against a local anvil deployment", {timeout: 600_000}, async (t: TestContext) => {
  if (!ENABLED) {
    t.skip("set LUCKYDRAW_ANVIL=1 to run the anvil end-to-end journey (it starts a node and runs forge)");
    return;
  }

  const runId = `client-e2e-${randomBytes(6).toString("hex")}`;
  const relativeDir = `test/script/tmp/${runId}`;
  const runDir = join(CONTRACTS_DIR, relativeDir);
  const deploymentsDir = join(runDir, "deployments");
  mkdirSync(deploymentsDir, {recursive: true});

  // Contents, not names: the local deployment is deterministic, so a dropped LUCKYDRAW_DEPLOYMENTS_DIR would
  // overwrite the committed fixture under its own file name and a directory listing would not notice.
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
  try {
    // The broadcast directory is per run as well, so two journeys (or this one and
    // scripts/test_deployment_live.py) cannot hand Finalize each other's receipts.
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

    step("parse and verify the written manifest");
    const manifest: DeploymentManifest = parseManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    eq(manifest.environment, "local", "DeployLocal writes a local manifest");
    // `cacheTimeout: -1` disables ethers' 250 ms response cache. SPEC §9.6: "Buy, withdraw and claim controls
    // act on the latest on-chain state as soon as the previous receipt is included" - with the cache on, a
    // `latest` snapshot taken straight after a receipt can still answer from the block before it.
    provider = new JsonRpcProvider(node.url, 31337, {staticNetwork: true, cacheTimeout: -1});
    const verification = await verifyDeployment(provider, manifest);
    ok(verification.ok, `verifyDeployment: ${verification.ok ? "ok" : JSON.stringify(verification.failure)}`);
    if (!verification.ok) return;
    const deployment = verification.verified;
    eq(deployment.chainId, 31337n, "verified chain id");
    eq(deployment.vault, manifest.contracts.vault.address, "verified Vault binding");
    eq(deployment.draw, manifest.contracts.draw.address, "verified Draw binding");

    // The default SPEC §10.1 policy must produce *some* block on this node; every state assertion below then
    // reads at the head, because anvil's finalized tag lags the writes this test has just made.
    const defaultBlock = await resolveSnapshotBlock(provider);
    ok(defaultBlock.blockNumber >= 0n, "the default snapshot policy resolved a block on this node");
    process.stdout.write(
      `LDCLIENT_E2E default snapshot confidence: ${defaultBlock.confidence.tag}` +
        ` depth=${String(defaultBlock.confidence.depth)} block=${defaultBlock.blockNumber}\n`,
    );
    const ctx: ReadContext = {provider, deployment, tag: "latest"};

    step("read the pools and the three first rounds of the native pool");
    const nativeAsset = manifest.assets[0];
    ok(nativeAsset?.native, "the first manifest asset is native BNB");
    const pools = await readPools(ctx, 0n, 100n);
    eq(pools.value.page.length, manifest.assets.length, "one pool per manifest asset");
    eq(pools.value.nextCursor, BigInt(manifest.assets.length), "end cursor");
    const nativePool = pools.value.page.find((pool) => pool.asset === nativeAsset.asset);
    ok(nativePool !== undefined, "the native pool is listed");
    eq(nativePool.id, nativeAsset.pool.poolId, "pool id agrees with the manifest");
    eq(nativePool.seedAmount, nativeAsset.pool.seedAmount, "seed amount agrees with the manifest");

    // One sequence per Kind, in Types.sol order (ADR 036).
    const targets = KindNames.map((name) => nativeAsset.pool.targetsUsd[name]);
    const kinds = [
      Kind.Day100,
      Kind.Day1k,
      Kind.Day10k,
      Kind.Week1k,
      Kind.Week10k,
      Kind.Week100k,
      Kind.Month100k,
    ] as const;
    let dailyRound: RoundView | null = null;
    for (let index = 0; index < kinds.length; index += 1) {
      const kind = kinds[index] ?? Kind.Day100;
      const roundId = nativeAsset.pool.firstRoundIds[index] ?? 0n;
      const round = (await readRound(ctx, roundId)).value;
      eq(round.id, roundId, `round ${roundId}: id`);
      eq(round.kind, kind, `round ${roundId}: kind`);
      eq(round.sequence, 1n, `round ${roundId}: first of its sequence`);
      eq(round.asset, nativeAsset.asset, `round ${roundId}: frozen asset`);
      eq(round.tokenDecimals, nativeAsset.decimals, `round ${roundId}: frozen token decimals`);
      eq(round.targetUsd, targets[index] ?? 0n, `round ${roundId}: frozen target`);
      eq(round.pricing.feed, nativeAsset.price.feed, `round ${roundId}: frozen pricing feed`);
      eq(
        round.pricing.feedDecimals,
        nativeAsset.price.feedDecimals,
        `round ${roundId}: frozen feed decimals`,
      );
      eq(round.pricing.maxPriceAge, nativeAsset.price.maxPriceAge, `round ${roundId}: frozen max price age`);
      eq(round.feeAccount, manifest.ownership.feeAccount, `round ${roundId}: frozen fee account`);
      eq(round.state, State.Open, `round ${roundId}: Open`);
      eq(round.closesAt, nextCutoff(round.opensAt, kind), `round ${roundId}: closesAt is the UTC cutoff`);
      eq(round.seeded, false, `round ${roundId}: creation does not seed (SPEC §5.4)`);
      if (index === 0) dailyRound = round;
    }
    ok(dailyRound !== null, "the daily round was read");
    const roundId = dailyRound.id;

    const seedAccount = (await readSeedAccount(ctx)).value;
    eq(seedAccount, manifest.ownership.seedAccount, "the Draw points at the manifest seed account");

    step("fund both players and the seed account through prepareDepositNative");
    const playerA = await provider.getSigner(PLAYER_A_INDEX);
    const playerB = await provider.getSigner(PLAYER_B_INDEX);
    const seedSigner = await provider.getSigner(SEED_INDEX);
    const addressA = asAddress(await playerA.getAddress());
    const addressB = asAddress(await playerB.getAddress());
    const addressSeed = asAddress(await seedSigner.getAddress());
    eq(addressSeed, seedAccount, "anvil account 3 is the local seed Safe");

    await send(playerA, prepareDepositNative(deployment, ONE_BNB / 2n));
    await send(playerB, prepareDepositNative(deployment, ONE_BNB / 2n));
    await send(seedSigner, prepareDepositNative(deployment, ONE_BNB / 20n));
    eq((await readBalance(ctx, addressA, ZERO_ADDRESS)).value, ONE_BNB / 2n, "player A balance");
    eq((await readBalance(ctx, addressB, ZERO_ADDRESS)).value, ONE_BNB / 2n, "player B balance");
    eq((await readBalance(ctx, addressSeed, ZERO_ADDRESS)).value, ONE_BNB / 20n, "seed account balance");

    step("the seed Safe's consent is per asset, and prepareAuthorizeSeed changes one asset at a time");
    // `DeployLocal` has the seed account authorize both assets itself, each in that asset's own raw units:
    // 0.01 BNB and 500 raw TEST2 (USD 5.00 at 2 decimals). SPEC §5.4: pointing is not consent, and consent
    // is per asset, so the two caps are independent records.
    const tokenAsset = manifest.assets[1];
    ok(tokenAsset !== undefined, "the local deployment has a second, ERC-20 asset");
    eq(tokenAsset.native, false, "the second asset is a token");
    eq(nativeAsset.pool.seedAuthorizedMaxPerRound, SEED_AMOUNT, "the manifest records the BNB cap");
    eq(tokenAsset.pool.seedAuthorizedMaxPerRound, SEED_TOKEN_CAP, "the manifest records the TEST2 cap");
    eq(
      (await readSeedMaxPerRound(ctx, addressSeed, ZERO_ADDRESS)).value,
      SEED_AMOUNT,
      "the Vault holds the BNB cap the manifest records",
    );
    eq(
      (await readSeedMaxPerRound(ctx, addressSeed, tokenAsset.asset)).value,
      SEED_TOKEN_CAP,
      "and the TEST2 cap, in that token's own raw units",
    );
    eq(
      (await readSeedMaxPerRound(ctx, addressA, ZERO_ADDRESS)).value,
      0n,
      "an ordinary player has authorized nothing",
    );

    // Revoking one asset is the seed account's own transaction and leaves the other asset's consent alone,
    // which is the whole point of the per-asset cap: a token pool can be stood down without disabling BNB.
    const revoke = prepareAuthorizeSeed(deployment, tokenAsset.asset, 0n);
    eq(revoke.summary.asset, tokenAsset.asset, "the wallet summary names the asset being revoked");
    eq(revoke.summary.amount, 0n, "and the new cap");
    const revokeReceipt = await send(seedSigner, revoke);
    const authorized = namedEvent(deployment, revokeReceipt, "SeedAuthorized");
    deep(
      authorized.args as {
        account: Address;
        asset: Address;
        oldMaxPerRound: bigint;
        newMaxPerRound: bigint;
      },
      {
        account: addressSeed,
        asset: tokenAsset.asset,
        oldMaxPerRound: SEED_TOKEN_CAP,
        newMaxPerRound: 0n,
      },
      "SeedAuthorized carries the account, the asset and both caps",
    );
    eq((await readSeedMaxPerRound(ctx, addressSeed, tokenAsset.asset)).value, 0n, "TEST2 consent is revoked");
    eq(
      (await readSeedMaxPerRound(ctx, addressSeed, ZERO_ADDRESS)).value,
      SEED_AMOUNT,
      "revoking one asset leaves the BNB consent untouched",
    );

    await send(seedSigner, prepareAuthorizeSeed(deployment, tokenAsset.asset, SEED_TOKEN_CAP));
    eq(
      (await readSeedMaxPerRound(ctx, addressSeed, tokenAsset.asset)).value,
      SEED_TOKEN_CAP,
      "and the Safe can restore it in the same way",
    );

    step("previewEntry agrees with quoteBuy on five cases");
    const cases: readonly {label: string; user: Address; gross: bigint; expected: QuoteReason}[] = [
      {label: "admissible", user: addressA, gross: ENTRY_GROSS, expected: QuoteReason.None},
      {label: "zero", user: addressA, gross: 0n, expected: QuoteReason.InvalidAmount},
      {label: "below minimum", user: addressA, gross: 1000n, expected: QuoteReason.BelowMinimum},
      {label: "unfunded", user: addressA, gross: ONE_BNB * 10n, expected: QuoteReason.InsufficientBalance},
      {
        label: "seed account",
        user: addressSeed,
        gross: ENTRY_GROSS,
        expected: QuoteReason.SeedAccountCannotBuy,
      },
    ];
    let admissible: {panel: EntryPanel; timestamp: bigint} | null = null;
    for (const entry of cases) {
      const snapshot = await readEntryPanel(ctx, roundId, entry.user, entry.gross);
      eq(snapshot.value.quote.reason, entry.expected, `${entry.label}: on-chain quote reason`);
      assertPreviewMatchesQuote(
        entry.label,
        snapshot.value.quote,
        snapshot.value,
        snapshot.timestamp,
        entry.gross,
      );
      if (entry.label === "admissible") admissible = {panel: snapshot.value, timestamp: snapshot.timestamp};
    }
    ok(admissible !== null, "the admissible case produced a panel");

    step("player A enters; the fallback operator seed enters first");
    const quote = admissible.panel.quote;
    const plan = entryFromQuote(
      {quote, quotedFor: admissible.panel.quotedFor},
      {
        roundId,
        user: addressA,
        asset: admissible.panel.round.asset,
        gross: ENTRY_GROSS,
        chainTimestamp: admissible.timestamp,
      },
    );
    ok(plan.ok, "entryFromQuote accepted the admissible quote");
    if (!plan.ok) return;
    eq(plan.params.minNetContribution, quote.netDelta - 1n, "guard is max(0, netDelta - 1)");
    eq(plan.params.deadline, admissible.timestamp + 300n, "deadline is chain time + 300 seconds");
    eq(plan.disclosures.paysFallbackSeed, true, "an unseeded round discloses the fallback seed");
    eq(plan.disclosures.reachesTarget, false, "USD 6 does not reach the USD 100 daily target");

    const buyReceipt = await send(playerA, prepareBuy(deployment, plan.params));
    const seedEntered = namedEvent(deployment, buyReceipt, "SeedEntered");
    const seedArgs = seedEntered.args as {
      roundId: bigint;
      seedAccount: Address;
      gross: bigint;
      feeDelta: bigint;
      netDelta: bigint;
      cumulativeGross: bigint;
    };
    eq(seedArgs.roundId, roundId, "SeedEntered: round");
    eq(seedArgs.seedAccount, seedAccount, "SeedEntered: account");
    eq(seedArgs.gross, SEED_AMOUNT, "SeedEntered: the pool's seed amount");
    eq(seedArgs.feeDelta, feeOf(SEED_AMOUNT), "SeedEntered: the seed pays the same 3% fee");
    eq(seedArgs.netDelta, SEED_AMOUNT - feeOf(SEED_AMOUNT), "SeedEntered: net");
    eq(seedArgs.cumulativeGross, SEED_AMOUNT, "SeedEntered: the seed enters first");

    const bought = namedEvent(deployment, buyReceipt, "EntryBought");
    const boughtArgs = bought.args as {
      roundId: bigint;
      buyer: Address;
      gross: bigint;
      feeDelta: bigint;
      netDelta: bigint;
      cumulativeGross: bigint;
      oracleRoundId: bigint;
      priceAnswer: bigint;
    };
    eq(boughtArgs.roundId, roundId, "EntryBought: round");
    eq(boughtArgs.buyer, addressA, "EntryBought: buyer");
    eq(boughtArgs.gross, ENTRY_GROSS, "EntryBought: gross");
    eq(boughtArgs.feeDelta, quote.feeDelta, "EntryBought: feeDelta matches the quote");
    eq(boughtArgs.netDelta, quote.netDelta, "EntryBought: netDelta matches the quote");
    eq(
      boughtArgs.cumulativeGross,
      quote.shareDenominatorAfter,
      "EntryBought: cumulative gross matches the quote",
    );
    eq(boughtArgs.priceAnswer, quote.observation.answer, "EntryBought: the frozen observation");

    const positionA = (await readPosition(ctx, roundId, addressA)).value;
    eq(positionA.gross, quote.shareNumeratorAfter, "position equals the quoted post-buy numerator");
    eq(positionA.shareDenominator, quote.shareDenominatorAfter, "round gross equals the quoted denominator");
    eq(positionA.refunded, false, "nothing refunded");

    step("player B enters the same round");
    const panelB = await readEntryPanel(ctx, roundId, addressB, ENTRY_GROSS);
    eq(panelB.value.quote.reason, QuoteReason.None, "player B quote accepted");
    eq(panelB.value.round.seeded, true, "the round is seeded now");
    assertPreviewMatchesQuote("player B", panelB.value.quote, panelB.value, panelB.timestamp, ENTRY_GROSS);
    const planB = entryFromQuote(
      {quote: panelB.value.quote, quotedFor: panelB.value.quotedFor},
      {
        roundId,
        user: addressB,
        asset: panelB.value.round.asset,
        gross: ENTRY_GROSS,
        chainTimestamp: panelB.timestamp,
      },
    );
    ok(planB.ok, "entryFromQuote accepted player B's quote");
    if (!planB.ok) return;
    eq(planB.disclosures.paysFallbackSeed, false, "a seeded round pays no fallback seed");
    // The quote answers for player B: another signer is refused before any calldata exists (types/quoted.ts).
    const switched = entryFromQuote(
      {quote: panelB.value.quote, quotedFor: panelB.value.quotedFor},
      {
        roundId,
        user: addressA,
        asset: panelB.value.round.asset,
        gross: ENTRY_GROSS,
        chainTimestamp: panelB.timestamp,
      },
    );
    eq(switched.ok, false, "a quote read for player B is refused for player A");
    eq(switched.ok ? "" : switched.kind, "QuoteContextMismatch", "the refusal names the context");
    await send(playerB, prepareBuy(deployment, planB.params));

    const afterB = (await readRound(ctx, roundId)).value;
    eq(afterB.grossTotal, SEED_AMOUNT + ENTRY_GROSS * 2n, "three entries in the round");
    eq(afterB.playerCount, 3n, "seed plus two players");
    eq(afterB.feeReserved, feeOf(afterB.grossTotal), "the reserve is the cumulative fee");
    eq(afterB.prizePot, afterB.grossTotal - afterB.feeReserved, "pot is gross minus reserve");
    eq(afterB.rangeCount, 3n, "one range per entry");

    const ranges = (await readAllRanges(ctx, roundId)).value;
    eq(ranges.length, 3, "readAllRanges paged every range");
    eq(ranges[0]?.buyer, seedAccount, "the seed holds the first range");
    eq(ranges[2]?.cumulativeGross, afterB.grossTotal, "the last range closes at the round's gross");

    step("an expired deadline and an oversized withdrawal decode to their custom errors");
    const expiredPanel = await readEntryPanel(ctx, roundId, addressA, ENTRY_GROSS);
    const expired = prepareBuy(deployment, {
      roundId,
      asset: ZERO_ADDRESS,
      gross: ENTRY_GROSS,
      minNetContribution: 0n,
      deadline: expiredPanel.timestamp - 60n,
    });
    await assert.rejects(
      () => send(playerA, expired),
      (error: unknown) => {
        const revert = decodeRevert(error);
        assertions += 1;
        assert.strictEqual(revert.kind, "custom", "a past deadline reverts with a custom error");
        assertions += 1;
        assert.strictEqual(revert.kind === "custom" ? revert.name : "", "DeadlineExpired");
        return true;
      },
    );

    const balanceA = (await readBalance(ctx, addressA, ZERO_ADDRESS)).value;
    const tooMuch = prepareWithdraw(deployment, ZERO_ADDRESS, balanceA + 1n);
    await assert.rejects(
      () => send(playerA, tooMuch),
      (error: unknown) => {
        const revert = decodeRevert(error, {emitter: "vault"});
        assertions += 1;
        assert.strictEqual(revert.kind, "custom", "an oversized withdrawal reverts with a custom error");
        assertions += 1;
        assert.strictEqual(revert.kind === "custom" ? revert.name : "", "InsufficientBalance");
        assertions += 1;
        assert.strictEqual(revert.kind === "custom" ? revert.contract : "", "vault");
        return true;
      },
    );

    step("travel past the cutoff, close the round and check its successor");
    const beforeClose = await resolveSnapshotBlock(provider, {tag: "latest"});
    const delta = afterB.closesAt - beforeClose.timestamp + 1n;
    ok(delta > 0n && delta < 8n * 86_400n, `the daily cutoff is ${delta} seconds away`);
    await provider.send("evm_increaseTime", [Number(delta)]);
    await provider.send("evm_mine", []);

    const closeReceipt = await send(playerA, prepareCloseRound(deployment, roundId));
    const closed = namedEvent(deployment, closeReceipt, "RoundClosed");
    eq((closed.args as {roundId: bigint}).roundId, roundId, "RoundClosed: round");

    const closedRound = (await readRound(ctx, roundId)).value;
    eq(closedRound.state, State.AwaitingRequest, "a two-player round awaits its randomness request");
    eq(closedRound.requestDeadline, closedRound.closedAt + 86_400n, "requestDeadline is closedAt + 86400");
    ok(closedRound.closedAt >= closedRound.closesAt, "closed at or after the cutoff");

    const successorId = (await readCurrent(ctx, nativePool.id, Kind.Day100)).value;
    ok(successorId !== roundId && successorId !== 0n, "current points at a new daily round");
    const successor = (await readRound(ctx, successorId)).value;
    eq(successor.sequence, 2n, "the successor is the second round of the sequence");
    eq(successor.kind, Kind.Day100, "the successor is a daily round");
    eq(successor.poolId, nativePool.id, "the successor belongs to the same pool");
    eq(successor.state, State.Open, "the successor is Open");
    eq(successor.seeded, false, "the successor is left unseeded for the keeper (SPEC §5.4)");

    // The successor race of SPEC §9.5 on a real chain: a quote read for the closed round shares the pool,
    // the asset and the cutoff calendar with its successor, so only the stamped context stops it from
    // becoming a successor entry with the old round's disclosures.
    const stale = entryFromQuote(
      {quote: panelB.value.quote, quotedFor: panelB.value.quotedFor},
      {
        roundId: successorId,
        user: addressB,
        asset: successor.asset,
        gross: ENTRY_GROSS,
        chainTimestamp: panelB.timestamp,
      },
    );
    eq(stale.ok, false, "a quote read for the closed round is refused for its successor");
    eq(stale.ok ? "" : stale.kind, "QuoteContextMismatch", "the refusal names the round context");
    const fresh = await quoteBuy(ctx, successorId, addressB, ENTRY_GROSS);
    eq(fresh.value.quotedFor.roundId, successorId, "a fresh quote is stamped with the successor");
    eq(fresh.value.quotedFor.seeded, false, "and with its unseeded state");
    // The price is stale after the time travel, so the quote's reason is not asserted here.
    eq(fresh.value.quotedFor.asset, successor.asset, "and with the successor's asset");

    deep(fingerprint(), configBefore, "config/deployments/31337 is untouched, byte for byte");

    process.stdout.write(
      `LDCLIENT_E2E | steps=${steps} | assertions=${assertions} | vault=${deployment.vault} | draw=${deployment.draw}\n`,
    );
  } finally {
    provider?.destroy();
    node.stop();
  }
});
