// Entry point: `node src/main.ts`.
//
// Order is deliberate. Configuration is read first, because the mutually exclusive signing modes and a bad
// interval are refusals that need no network at all; then the manifest, the chain id, `verifyDeployment` and
// the Multicall3 probe (SPEC §12, §15); only then is a sender built, which is the first moment
// `KEEPER_PRIVATE_KEY` is read.
//
// Every one of those steps is inside the one `try`, so every refusal - a missing variable included - leaves
// the process through the same `refused_to_start` line and the same exit code 1 (F7).

import {pathToFileURL} from "node:url";
import {JsonRpcProvider} from "ethers";
import type {Hex, Hex32, RawLog} from "./client.ts";
import {loadConfig, manifestPathOf} from "./config.ts";
import {type CoordinatorLogQuery, createCostMeter, parseReceipt, type ReceiptReader} from "./costs.ts";
import {createKeeper} from "./keeper.ts";
import {createLogger} from "./log.ts";
import {createNotifier} from "./notify.ts";
import type {LogQuery} from "./refunds.ts";
import {createDispatcher, createSender} from "./sender.ts";
import {prepare} from "./startup.ts";
import {installNodeHttpTransport} from "./transport.ts";

export async function main(): Promise<number> {
  const logger = createLogger();
  // Before anything can send a request. Every `FetchRequest` in the process - the provider's, the
  // heartbeat's - then goes over `node:https` instead of whichever of ethers' two implementations this
  // install resolved, which is what makes the keeper work under `node --jitless` (transport.ts).
  installNodeHttpTransport();
  // Inside the `try`, not before it. `loadConfig` throws `ConfigError` for the commonest operator mistake
  // there is - a variable that is missing, misspelled or holds the wrong thing - and outside the `try` that
  // arrived as an uncaught stack trace on stderr instead of the one `refused_to_start` line the runbook and
  // `journalctl` are written around. `new JsonRpcProvider` is in here for the same reason: an unparseable
  // URL throws in the constructor (F7). `provider` is therefore only defined from that point on, which is
  // what the optional call in the `catch` reflects.
  let connected: JsonRpcProvider | undefined;
  try {
    const config = loadConfig(process.env);
    // `cacheTimeout: -1` disables ethers' 250 ms response cache: a keeper that reads the head must not be
    // answered from the block before its own last transaction (SPEC §9.6, and the client's e2e note).
    const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId), {
      staticNetwork: true,
      cacheTimeout: -1,
    });
    connected = provider;
    // Resolved once, by the gates: the chain record does not change while the process runs, and a per-cycle
    // read of it would be a file system call in the hot path for an address fixed at deployment.
    const {manifest, deployment, multicall3} = await prepare(config, provider);
    const sender = createSender(config, provider, process.env);
    const dispatcher = createDispatcher(provider, sender, {dryRun: config.dryRun});
    const logQuery: LogQuery = async (range) => {
      const logs = await provider.getLogs({
        address: deployment.draw,
        topics: [[...range.topics] as Hex32[]],
        fromBlock: Number(range.fromBlock),
        toBlock: Number(range.toBlock),
      });
      return logs as unknown as readonly RawLog[];
    };
    // The cost meter's own two provider calls. They are separate from `logQuery` because they ask a
    // different contract (the VRF coordinator, not the Draw) with a positional topic filter.
    const coordinatorLogs: CoordinatorLogQuery = async (filter) => {
      const logs = await provider.getLogs({
        address: filter.address,
        topics: [...filter.topics],
        fromBlock: Number(filter.fromBlock),
        toBlock: Number(filter.toBlock),
      });
      return logs as unknown as readonly RawLog[];
    };
    const receipt: ReceiptReader = async (hash: Hex) =>
      parseReceipt(await provider.send("eth_getTransactionReceipt", [hash]));
    const notify = createNotifier({
      heartbeat: config.heartbeat,
      alertWebhook: config.alertWebhook,
      logger,
    });
    const costMeter = createCostMeter({
      deployment,
      logger,
      receipt,
      logs: coordinatorLogs,
      window: config.logWindow,
    });

    logger.info("started", {
      chain: manifest.chain.chainId,
      environment: manifest.environment,
      draw: deployment.draw,
      vault: deployment.vault,
      manifest: manifestPathOf(config),
      // Verified by gate 6, so this address answered an `aggregate3` at start-up. `none` means the cycle's
      // three grouped batches go out as individual `eth_call`s; on chain 56 that is what a public RPC
      // throttles.
      multicall3: multicall3 ?? "none",
      signer: sender.address,
      mode: sender.kind,
      // Which of the two places held the key, never the key. `credential` means systemd passed it in.
      keySource: config.signing.kind === "privateKey" ? config.signing.source : undefined,
      intervalMs: config.intervalMs,
      logWindow: config.logWindow,
      dryRun: config.dryRun,
      // Whether each signal is armed. The URLs themselves are credentials and are never printed.
      heartbeat: config.heartbeat === null ? "off" : config.heartbeat.method,
      alerts: config.alertWebhook === null ? "off" : "on",
    });

    let exitCode = 0;
    const keeper = createKeeper({
      config,
      deployment,
      provider,
      dispatcher,
      logQuery,
      logger,
      multicall3,
      notify,
      costMeter,
      onFatal: (error) => {
        exitCode = 1;
        logger.error("fatal", {
          error: error instanceof Error ? error.message : String(error),
          note: "ten consecutive cycles failed",
        });
        // `keeper.ts` has already called `notify.alert`; draining is what puts it on the wire before the
        // process is gone. `drain` never rejects and every request inside it carries its own timeout.
        void keeper
          .stop()
          .then(() => notify.drain())
          .then(() => {
            provider.destroy();
            process.exit(1);
          });
      },
    });

    // systemd stops the unit with SIGTERM, so the line has to name the signal it actually received.
    const shutdown = (signal: NodeJS.Signals): void => {
      logger.info("stopping", {signal});
      void keeper
        .stop()
        .then(() => notify.drain())
        .then(() => {
          provider.destroy();
          process.exit(exitCode);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    keeper.start();
    return exitCode;
  } catch (error) {
    // `ConfigError`, `StartupError` and anything else all print the same line: from the operator's side
    // there is one outcome - the keeper refused to start - and one place to read why. `redactUrls` in
    // `log.ts` keeps the RPC endpoint out of the reason, which is what `main.test.ts` asserts.
    logger.error("refused_to_start", {reason: error instanceof Error ? error.message : String(error)});
    // Only if the constructor got that far; a `ConfigError` is raised before there is anything to destroy.
    connected?.destroy();
    return 1;
  }
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
