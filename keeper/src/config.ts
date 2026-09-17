// Environment configuration and the start-up refusals that depend on it alone (SPEC §12).
//
// Two signing modes, selected by environment and mutually exclusive:
//
//   KEEPER_UNLOCKED_ADDRESS   anvil `--unlocked`: the node holds the account and signs; no key exists here.
//   KEEPER_PRIVATE_KEY        an ethers `Wallet`, read once in `sender.ts` and never echoed. Under systemd
//                             the same mode is selected by the `keeper-private-key` credential instead
//                             (`credentials.ts`), which keeps the key out of the unit's environment.
//
// The key itself never enters `KeeperConfig`. `loadConfig` records only *that* the private-key mode was
// selected and which of the two places holds it; `createSender` reads the value once, at the moment it
// constructs the wallet. Nothing that a log line, an error message or a test snapshot can reach ever holds
// the value.

import {join} from "node:path";
import {type Address, isAddress} from "./client.ts";
import {type KeySource, privateKeySource} from "./credentials.ts";

/** Every rejection that can be decided from the environment alone. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type SigningMode =
  | {kind: "unlocked"; address: Address}
  /** The value lives in the environment or in the systemd credential, never in this object. */
  | {kind: "privateKey"; source: KeySource};

/** Where a healthy cycle checks in. `method` exists because dead-man's-switch endpoints differ. */
export type HeartbeatConfig = {url: string; method: "GET" | "POST"};

export type KeeperConfig = {
  rpcUrl: string;
  chainId: bigint;
  drawAddress: Address;
  intervalMs: number;
  /** Blocks per `eth_getLogs` query. BSC public RPCs cap the range; 2,000 is inside every cap seen. */
  logWindow: bigint;
  dryRun: boolean;
  signing: SigningMode;
  /** Root of the manifest tree, `<dir>/<chainId>/<draw address>.json`. Defaults to repository `config/deployments`. */
  deploymentsDir: string;
  /** Root of the chain records, `<dir>/<chainId>.json`; where Multicall3 comes from. Defaults to `config/chains`. */
  chainsDir: string;
  /** `KEEPER_HEARTBEAT_URL`; null means no heartbeat is ever sent (SPEC §14: nothing is sent unset). */
  heartbeat: HeartbeatConfig | null;
  /** `KEEPER_ALERT_WEBHOOK`; null means no alert is ever posted. */
  alertWebhook: string | null;
};

export type Environment = Readonly<Record<string, string | undefined>>;

/** Repository root, two levels above `keeper/src`. */
export const REPO_ROOT = join(import.meta.dirname, "..", "..");

export const DEFAULT_INTERVAL_MS = 15_000;
export const DEFAULT_LOG_WINDOW = 2_000n;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required`);
  }
  return value.trim();
}

function positiveInteger(raw: string, name: string): number {
  if (!/^[0-9]+$/.test(raw))
    throw new ConfigError(`${name} must be a positive integer (received ${raw.length} characters)`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer (received ${raw.length} characters)`);
  }
  return value;
}

function positiveBigint(raw: string, name: string): bigint {
  if (!/^[0-9]+$/.test(raw))
    throw new ConfigError(`${name} must be a positive integer (received ${raw.length} characters)`);
  const value = BigInt(raw);
  if (value <= 0n)
    throw new ConfigError(`${name} must be a positive integer (received ${raw.length} characters)`);
  return value;
}

/**
 * A rejection that names the variable and how long its value was, and never the value itself.
 *
 * `KEEPER_UNLOCKED_ADDRESS` and `KEEPER_DRAW_ADDRESS` are the two variables a mistyped `export` line puts a
 * private key into - they sit next to `KEEPER_PRIVATE_KEY` in every command in the README - and `main` prints
 * whatever this says as `refused_to_start`, to a terminal and often to a log file. A 66-character value is the
 * one shape an operator has to be told about without it being echoed back at them.
 */
function describeBadValue(name: string, expectation: string, value: string): string {
  return `${name} must be ${expectation}; received ${value.length} characters (the value is not shown)`;
}

/**
 * Which absolute `http(s)` URL a notification variable holds, or null when it is unset.
 *
 * A dead-man's-switch ping URL and a chat webhook are both bearer credentials - the secret is the path - so
 * a rejection says how long the value was and never what it was, exactly as the address variables do.
 */
function optionalUrl(env: Environment, name: string): string | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(describeBadValue(name, "an absolute http(s) URL", raw));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(describeBadValue(name, "an absolute http(s) URL", raw));
  }
  return raw;
}

function heartbeatOf(env: Environment): HeartbeatConfig | null {
  const url = optionalUrl(env, "KEEPER_HEARTBEAT_URL");
  if (url === null) return null;
  const raw = env.KEEPER_HEARTBEAT_METHOD?.trim().toUpperCase();
  if (raw === undefined || raw === "") return {url, method: "GET"};
  if (raw !== "GET" && raw !== "POST") {
    // Not echoed, for the same reason the address variables are not: this sits in the same `export` block as
    // `KEEPER_PRIVATE_KEY` and `KEEPER_HEARTBEAT_URL` in every README command, a line that lands one variable
    // short puts a secret here, and `main` prints this message as `refused_to_start` (F7).
    throw new ConfigError(describeBadValue("KEEPER_HEARTBEAT_METHOD", "GET or POST", raw));
  }
  return {url, method: raw};
}

function signingModeOf(env: Environment): SigningMode {
  const unlocked = env.KEEPER_UNLOCKED_ADDRESS?.trim();
  const keySource = privateKeySource(env);
  const hasUnlocked = unlocked !== undefined && unlocked !== "";
  const hasKey = keySource !== null;
  if (hasUnlocked && hasKey) {
    throw new ConfigError(
      "KEEPER_UNLOCKED_ADDRESS and KEEPER_PRIVATE_KEY are mutually exclusive; set exactly one",
    );
  }
  if (!hasUnlocked && !hasKey) {
    throw new ConfigError(
      "set exactly one of KEEPER_UNLOCKED_ADDRESS (a node-held account) or KEEPER_PRIVATE_KEY (a wallet, " +
        "from the environment or from the systemd credential keeper-private-key)",
    );
  }
  if (keySource !== null) return {kind: "privateKey", source: keySource};
  const address = (unlocked ?? "").toLowerCase();
  if (!isAddress(address)) {
    // The value is never echoed: the commonest way this check fires is a private key pasted into the wrong
    // variable, and `main` prints this message as `refused_to_start`. The length is enough to diagnose it.
    throw new ConfigError(describeBadValue("KEEPER_UNLOCKED_ADDRESS", "an address", address));
  }
  return {kind: "unlocked", address};
}

/**
 * Reads the whole configuration, or throws the first `ConfigError`.
 *
 * `KEEPER_DEPLOYMENTS_DIR` is an addition to the documented set, for tests and for an operator running
 * against a manifest that is not in the repository's own `config/deployments` tree (the anvil journey writes
 * one under `contracts/test/script/tmp/`). It changes only where the manifest is read from; every check it
 * then has to pass is unchanged.
 */
export function loadConfig(env: Environment): KeeperConfig {
  const signing = signingModeOf(env);
  const rpcUrl = required(env, "KEEPER_RPC_URL");
  const chainId = positiveBigint(required(env, "KEEPER_CHAIN_ID"), "KEEPER_CHAIN_ID");
  const rawDraw = required(env, "KEEPER_DRAW_ADDRESS");
  if (!isAddress(rawDraw) || rawDraw !== rawDraw.toLowerCase()) {
    throw new ConfigError(describeBadValue("KEEPER_DRAW_ADDRESS", "a lowercase address", rawDraw));
  }
  const intervalRaw = env.KEEPER_INTERVAL_MS?.trim();
  const windowRaw = env.KEEPER_LOG_WINDOW?.trim();
  return {
    rpcUrl,
    chainId,
    drawAddress: rawDraw,
    intervalMs:
      intervalRaw === undefined || intervalRaw === ""
        ? DEFAULT_INTERVAL_MS
        : positiveInteger(intervalRaw, "KEEPER_INTERVAL_MS"),
    logWindow:
      windowRaw === undefined || windowRaw === ""
        ? DEFAULT_LOG_WINDOW
        : positiveBigint(windowRaw, "KEEPER_LOG_WINDOW"),
    dryRun: env.KEEPER_DRY_RUN?.trim() === "1",
    signing,
    deploymentsDir: env.KEEPER_DEPLOYMENTS_DIR?.trim() || join(REPO_ROOT, "config", "deployments"),
    chainsDir: env.KEEPER_CHAINS_DIR?.trim() || join(REPO_ROOT, "config", "chains"),
    heartbeat: heartbeatOf(env),
    alertWebhook: optionalUrl(env, "KEEPER_ALERT_WEBHOOK"),
  };
}

/** `<deploymentsDir>/<chainId>/<lowercase draw address>.json` (SPEC §12 manifest naming). */
export function manifestPathOf(config: KeeperConfig): string {
  return join(config.deploymentsDir, config.chainId.toString(), `${config.drawAddress}.json`);
}

/** `<chainsDir>/<chainId>.json` (SPEC §10.3 chain record). */
export function chainRecordPathOf(config: KeeperConfig): string {
  return join(config.chainsDir, `${config.chainId}.json`);
}
