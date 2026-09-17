// Typed log decoding with the emitter filter (SPEC §10.1).
//
// "Indexer, keeper and client accept only logs whose emitter address equals the manifest Vault or Draw
// address for that chainId, correlate FundsLocked/EntryBought pairs by transaction hash, and ignore
// look-alike emitters." A log from any other address returns null here, whatever its topics say.
//
// The unique key of an event is (chainId, txHash, logIndex), with blockHash retained.

import {Interface} from "ethers";
import {luckyDrawAbi} from "../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../abi/generated/luckyVault.ts";
import {type AbiEntryLike, indexEventInputs, normalizeAbiStruct, toBigInt} from "../abi/normalize.ts";
import type {DeploymentManifest} from "../deployments/manifest.ts";
import {manifestOf, type VerifiedDeployment} from "../deployments/verify.ts";
import {type Address, asAddress, asHex32, type Hex32} from "../types/common.ts";
import {
  type DrawEventArgsByName,
  type DrawEventName,
  drawEventTopics,
  type VaultEventArgsByName,
  type VaultEventName,
  vaultEventTopics,
} from "../types/generated.ts";

export type Emitter = "vault" | "draw";

/** An ethers `Log` satisfies this, and so does a plain `eth_getLogs` entry with hex-string numbers. */
export type RawLog = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: bigint | number | string;
  blockHash: string;
  transactionHash: string;
  /** ethers calls it `index`; JSON-RPC calls it `logIndex`. Either is accepted. */
  index?: bigint | number | string;
  logIndex?: bigint | number | string;
  transactionIndex?: bigint | number | string;
};

export type DecodedEvent<TEmitter extends Emitter, TName extends string, TArgs> = {
  emitter: TEmitter;
  name: TName;
  args: TArgs;
  /** The emitting address, lowercase; always the manifest Vault or Draw. */
  address: Address;
  blockNumber: bigint;
  blockHash: Hex32;
  txHash: Hex32;
  logIndex: bigint;
  /** Null when the source log did not carry a transaction index. */
  txIndex: bigint | null;
};

export type VaultEvent = {
  [K in VaultEventName]: DecodedEvent<"vault", K, VaultEventArgsByName[K]>;
}[VaultEventName];

export type DrawEvent = {
  [K in DrawEventName]: DecodedEvent<"draw", K, DrawEventArgsByName[K]>;
}[DrawEventName];

export type LuckyDrawEvent = VaultEvent | DrawEvent;

const vaultInterface = new Interface(luckyVaultAbi);
const drawInterface = new Interface(luckyDrawAbi);
const vaultEventInputs = indexEventInputs(luckyVaultAbi as readonly AbiEntryLike[]);
const drawEventInputs = indexEventInputs(luckyDrawAbi as readonly AbiEntryLike[]);

const VAULT_TOPICS: readonly Hex32[] = Object.values(vaultEventTopics) as readonly Hex32[];
const DRAW_TOPICS: readonly Hex32[] = Object.values(drawEventTopics) as readonly Hex32[];

/** A block number, log index or transaction index: a non-negative chain integer, whatever shape it came in. */
function chainIndex(value: bigint | number | string, label: string): bigint {
  const parsed = toBigInt(value);
  if (parsed < 0n) throw new RangeError(`${label} must not be negative: ${parsed}`);
  return parsed;
}

function logIndexOf(log: RawLog): bigint {
  const raw = log.index ?? log.logIndex;
  if (raw === undefined) throw new TypeError("log has neither index nor logIndex");
  return chainIndex(raw, "logIndex");
}

/**
 * Decodes one log against the manifest's Vault and Draw.
 *
 * Returns null when the log's address is neither of them (a look-alike emitter, SPEC §10.1) or when the
 * topic belongs to no event of that contract. Never throws on a malformed log: an undecodable log is
 * indistinguishable from an unknown one for the caller's purposes.
 */
export function decodeLog(
  source: DeploymentManifest | VerifiedDeployment,
  log: RawLog,
): LuckyDrawEvent | null {
  const manifest = manifestOf(source);
  let address: Address;
  try {
    address = asAddress(log.address);
  } catch {
    return null;
  }

  let emitter: Emitter;
  if (address === manifest.contracts.vault.address) {
    emitter = "vault";
  } else if (address === manifest.contracts.draw.address) {
    emitter = "draw";
  } else {
    return null;
  }

  const iface = emitter === "vault" ? vaultInterface : drawInterface;
  const inputsByName = emitter === "vault" ? vaultEventInputs : drawEventInputs;

  try {
    const parsed = iface.parseLog({topics: [...log.topics], data: log.data});
    if (parsed === null) return null;
    const inputs = inputsByName.get(parsed.name);
    if (inputs === undefined) return null;
    const decoded = {
      emitter,
      name: parsed.name,
      args: normalizeAbiStruct(inputs, parsed.args),
      address,
      blockNumber: chainIndex(log.blockNumber, "blockNumber"),
      blockHash: asHex32(log.blockHash),
      txHash: asHex32(log.transactionHash),
      logIndex: logIndexOf(log),
      txIndex:
        log.transactionIndex === undefined ? null : chainIndex(log.transactionIndex, "transactionIndex"),
    };
    // The name comes from the same ABI that produced `inputs`, and `normalizeAbiStruct` maps every field by
    // the rules scripts/generate.ts used to write the `<Name>Args` interfaces, so the runtime shape matches
    // the union member for that name. TypeScript cannot follow that correspondence through a string name.
    return decoded as unknown as LuckyDrawEvent;
  } catch {
    return null;
  }
}

/** The event unique key of SPEC §10.1: (chainId, txHash, logIndex). */
export function eventKey(chainId: bigint, txHash: string, logIndex: bigint): string {
  return `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}

/**
 * Pairs the Vault's FundsLocked with the Draw's EntryBought (or SeedEntered) from the same transaction.
 * SPEC §10.1: "correlate FundsLocked/EntryBought pairs by transaction hash". The round id and the account
 * are part of the key because one purchase transaction can lock twice for the same round (the fallback
 * operator seed and then the buyer, SPEC §5.4) and can touch the successor round when it closes on target.
 *
 * The key is not unique when one account locks twice for one round in one transaction, which a contract
 * wallet that batches two `buy` calls can do (the seed account cannot: `buy` refuses an account with a
 * nonzero seed cap, and the seed needs one). The indexer must pair the n-th FundsLocked with the n-th
 * EntryBought or SeedEntered of the same key in log order, not by key alone.
 */
export function entryCorrelationKey(txHash: string, roundId: bigint, account: string): string {
  return `${txHash.toLowerCase()}:${roundId}:${account.toLowerCase()}`;
}

export type EventFilter = {
  emitter: Emitter;
  address: Address;
  /** One `eth_getLogs` topic filter: position 0 is the set of every event topic of that contract. */
  topics: readonly [readonly Hex32[]];
};

/** The `eth_getLogs` filters for a deployment: one per contract, covering every event it declares. */
export function eventFilters(source: DeploymentManifest | VerifiedDeployment): readonly EventFilter[] {
  const manifest = manifestOf(source);
  return [
    {emitter: "vault", address: manifest.contracts.vault.address, topics: [VAULT_TOPICS]},
    {emitter: "draw", address: manifest.contracts.draw.address, topics: [DRAW_TOPICS]},
  ];
}

/** Every topic0 the Vault can emit. */
export function vaultTopics(): readonly Hex32[] {
  return VAULT_TOPICS;
}

/** Every topic0 the Draw can emit. */
export function drawTopics(): readonly Hex32[] {
  return DRAW_TOPICS;
}
