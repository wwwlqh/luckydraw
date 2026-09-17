// Simulate, then send. One place, so no code path can send a transaction that was not estimated first.
//
// SPEC §10.2: "Before each send the keeper simulates the call with eth_call at `latest` and skips it on
// revert". `eth_estimateGas` is that simulation here: it executes the call at the head and reverts with the
// same data, so one round trip both proves the call would succeed and sizes the gas limit. A revert is
// decoded with the client's `decodeRevert` under the write's own emitter and method hints, so the skip
// reason in the log is the contract's custom error name, not a hex blob.
//
// Keys: `createSender` reads the key exactly once - from the systemd credential when one was passed, from
// `KEEPER_PRIVATE_KEY` otherwise (`credentials.ts`) - hands it straight to `new Wallet(...)`, and keeps no
// other reference. The returned `Sender` exposes only a public address. In unlocked mode nothing resembling
// a key exists at all: the node signs for `eth_sendTransaction`.

import {type Provider, Wallet} from "ethers";
import {
  type Address,
  asAddress,
  asHex,
  type DecodedRevert,
  decodeOptionsForWrite,
  decodeRevert,
  type Hex,
  type PreparedWrite,
} from "./client.ts";
import {ConfigError, type Environment, type KeeperConfig} from "./config.ts";
import {type CredentialIo, readPrivateKey} from "./credentials.ts";

/** SPEC §10.2: "gasLimit = estimateGas x 1.3 capped at 600,000". */
export const GAS_LIMIT_CAP = 600_000n;

export function gasLimitFor(estimate: bigint): bigint {
  const padded = (estimate * 13n) / 10n;
  return padded > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : padded;
}

/** The provider surface a dispatch needs. An ethers `JsonRpcProvider` satisfies it structurally. */
export type SendProvider = {
  estimateGas(tx: {from: string; to: string; data: string; value?: bigint}): Promise<bigint>;
  send(method: string, params: readonly unknown[]): Promise<unknown>;
};

export type Sender = {
  kind: "unlocked" | "privateKey";
  address: Address;
  sendTransaction(tx: {to: Address; data: Hex; gasLimit: bigint}): Promise<Hex>;
};

/** The node-held account of `anvil --unlocked`: the keeper never sees a key. */
export function unlockedSender(provider: SendProvider, address: Address): Sender {
  return {
    kind: "unlocked",
    address,
    async sendTransaction(tx) {
      const hash = await provider.send("eth_sendTransaction", [
        {from: address, to: tx.to, data: tx.data, gas: `0x${tx.gasLimit.toString(16)}`},
      ]);
      return asHex(hash);
    },
  };
}

/**
 * Builds the sender for the configured mode.
 *
 * The key is read here and nowhere else, is never returned, logged or stored on the sender, and the error
 * raised for an unusable key quotes neither the value nor its length.
 */
export function createSender(
  config: KeeperConfig,
  provider: SendProvider & Provider,
  env: Environment,
  io: CredentialIo = {},
): Sender {
  if (config.signing.kind === "unlocked") return unlockedSender(provider, config.signing.address);
  const secret = readPrivateKey(env, io);
  if (secret === null) {
    throw new ConfigError(
      "no signing key: set KEEPER_PRIVATE_KEY, or pass the keeper-private-key systemd credential",
    );
  }
  let wallet: Wallet;
  try {
    wallet = new Wallet(secret, provider);
  } catch {
    throw new ConfigError(`the signing key from the ${config.signing.source} is not a usable private key`);
  }
  const address = asAddress(wallet.address.toLowerCase());
  return {
    kind: "privateKey",
    address,
    async sendTransaction(tx) {
      const sent = await wallet.sendTransaction({to: tx.to, data: tx.data, gasLimit: tx.gasLimit});
      return asHex(sent.hash);
    },
  };
}

export type DispatchResult =
  | {status: "sent"; hash: Hex; gasLimit: bigint}
  | {status: "dryRun"; gasLimit: bigint}
  | {status: "skipped"; reason: string};

export type Dispatcher = {
  address: Address;
  dispatch(write: PreparedWrite): Promise<DispatchResult>;
};

/** The decoded custom error name, panic name or reason string of a failed simulation. */
export function skipReason(write: PreparedWrite, error: unknown): string {
  return reasonOf(decodeRevert(error, decodeOptionsForWrite(write)), error);
}

function reasonOf(revert: DecodedRevert, error: unknown): string {
  switch (revert.kind) {
    case "custom":
      return revert.name;
    case "panic":
      return `Panic:${revert.name}`;
    case "reason":
      return revert.message;
    case "unknown":
      return `UndecodedRevert:${revert.selector}`;
    case "none":
      return error instanceof Error ? error.message : String(error);
  }
}

/** The skip reason for a send that threw: the simulation had already passed, so this is not a revert. */
export function sendFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `SendFailed:${message}`;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function hashLike(value: unknown): Hex | undefined {
  return typeof value === "string" && TX_HASH.test(value) ? (value as Hex) : undefined;
}

/**
 * The transaction hash carried by a send error, when the raw transaction is already out.
 *
 * Not every `sendTransaction` rejection means nothing was broadcast. ethers broadcasts, then resolves the
 * block number and compares the node's hash with the signed transaction's, so a `BAD_DATA` "returned hash did
 * not match" (whose `value` is the node's hash) and a failed block-number read both throw *after* the
 * transaction is on the wire. Treating those as "nothing happened" is what would make the keeper re-send the
 * same action next cycle; a recovered hash lets the caller record it in flight instead.
 */
export function recoverSentHash(error: unknown): Hex | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const source = error as Record<string, unknown>;
  const nested = (key: string, field: string): unknown => {
    const value = source[key];
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  };
  const candidates: readonly unknown[] = [
    source.value, // BAD_DATA from the post-broadcast hash comparison: the node's own hash.
    source.hash,
    source.transactionHash,
    nested("transaction", "hash"),
    nested("receipt", "hash"),
    nested("info", "hash"),
  ];
  for (const candidate of candidates) {
    const hash = hashLike(candidate);
    if (hash !== undefined) return hash;
  }
  return undefined;
}

/**
 * Estimate, then send unless `KEEPER_DRY_RUN=1`.
 *
 * An estimate that *reverted* is a skip with the decoded reason; an estimate that could not be made at all
 * is rethrown, so the caller treats an unreachable node as the send failure it is (F2).
 */
export function createDispatcher(
  provider: SendProvider,
  sender: Sender,
  options: {dryRun: boolean},
): Dispatcher {
  return {
    address: sender.address,
    async dispatch(write: PreparedWrite): Promise<DispatchResult> {
      let estimate: bigint;
      try {
        estimate = await provider.estimateGas({
          from: sender.address,
          to: write.to,
          data: write.data,
          value: write.value,
        });
      } catch (error) {
        // Only a *revert* is a skip. `decodeRevert` returns `none` when the failure carried no revert bytes
        // anywhere in it - a socket reset, a 429, a timeout - and that is the node being unreachable, not the
        // chain answering "this call would fail". Reporting it as a skip made `act` file an
        // `eth_estimateGas` transport failure as a `requestDraw` pre-check failure: it paged the operator
        // about a key hash and a subscription that were never asked about, and silenced the round for 60
        // seconds. Rethrown, it is a send failure like any other (`SendFailed:<message>`, F2). A revert with
        // empty data still decodes as `unknown`, so an out-of-gas or invalid-opcode revert stays a skip.
        const revert = decodeRevert(error, decodeOptionsForWrite(write));
        if (revert.kind === "none") throw error;
        return {status: "skipped", reason: reasonOf(revert, error)};
      }
      const gasLimit = gasLimitFor(estimate);
      if (options.dryRun) return {status: "dryRun", gasLimit};
      const hash = await sender.sendTransaction({to: write.to, data: write.data, gasLimit});
      return {status: "sent", hash, gasLimit};
    },
  };
}
