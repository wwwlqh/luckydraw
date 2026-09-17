// A recording fake `ReadProvider` for the read tests, and the fixtures they answer with.
//
// Excluded from the published build by tsconfig.build.json ("src/**/testing/**"). It exists so the two batch
// paths can be compared against each other: the same call table is served both through one `aggregate3` and
// through one `eth_call` per item, and every call it receives is recorded with the block tag it carried, so a
// test can assert the SPEC §10.1 "one blockTag" rule directly rather than trusting the implementation.

import {Interface} from "ethers";
import {luckyDrawAbi} from "../../abi/generated/luckyDraw.ts";
import {luckyVaultAbi} from "../../abi/generated/luckyVault.ts";
import {multicall3Abi} from "../../abi/generated/multicall3.ts";
import type {DeploymentManifest} from "../../deployments/manifest.ts";
import type {VerifiedDeployment} from "../../deployments/verify.ts";
import {type Address, asAddress} from "../../types/common.ts";
import type {BlockSummary, ReadProvider} from "../provider.ts";

export const MULTICALL3: Address = asAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

export const drawInterface = new Interface(luckyDrawAbi);
export const vaultInterface = new Interface(luckyVaultAbi);
export const multicallInterface = new Interface(multicall3Abi);

/** One recorded `eth_call`. */
export type RecordedCall = {to: string; data: string; blockTag: string | number | undefined};

/** What the fake answers for one `to + selector`. */
export type Answer = {ok: true; data: string} | {ok: false; revertData: string};

export type FakeBlock = {number: number; hash: string; timestamp: number};

export type FakeOptions = {
  chainId?: bigint;
  /** Blocks by tag. A missing `finalized`/`safe` entry makes that tag fail, as an unsupporting node does. */
  blocks?: Partial<Record<"finalized" | "safe" | "latest", FakeBlock>>;
  /** Blocks by number, for the fixed-depth fallback. */
  byNumber?: Readonly<Record<string, FakeBlock>>;
  /** `finalized` and `safe` throw instead of returning null, which is what most nodes actually do. */
  throwOnUnknownTag?: boolean;
};

export type FakeProvider = ReadProvider & {
  calls: RecordedCall[];
  /** Registers the answer for one target and calldata. */
  answer(to: Address, data: string, answer: Answer): void;
};

function key(to: string, data: string): string {
  return `${to.toLowerCase()}:${data.slice(0, 10).toLowerCase()}:${data.toLowerCase()}`;
}

/** An error shaped like the ethers `CallExceptionError` a reverting `eth_call` produces. */
export class FakeCallError extends Error {
  readonly data: string;

  constructor(data: string) {
    super("execution reverted");
    this.name = "FakeCallError";
    this.data = data;
  }
}

export function fakeProvider(options: FakeOptions = {}): FakeProvider {
  const calls: RecordedCall[] = [];
  const table = new Map<string, Answer>();
  const blocks = options.blocks ?? {};
  const byNumber = options.byNumber ?? {};

  const lookup = (to: string, data: string): Answer => {
    const found = table.get(key(to, data));
    if (found !== undefined) return found;
    throw new Error(`fake provider has no answer for ${to} ${data.slice(0, 10)}`);
  };

  const serveMulticall = (data: string): string => {
    const [items] = multicallInterface.decodeFunctionData("aggregate3", data);
    const results = (items as readonly (readonly unknown[])[]).map((item) => {
      const target = String(item[0]);
      const callData = String(item[2]);
      const answer = lookup(target, callData);
      return answer.ok ? [true, answer.data] : [false, answer.revertData];
    });
    return multicallInterface.encodeFunctionResult("aggregate3", [results]);
  };

  return {
    calls,
    answer(to: Address, data: string, answer: Answer) {
      table.set(key(to, data), answer);
    },
    async call(tx: {to: string; data: string; blockTag?: string | number}) {
      calls.push({to: tx.to.toLowerCase(), data: tx.data, blockTag: tx.blockTag});
      if (tx.to.toLowerCase() === MULTICALL3) return serveMulticall(tx.data);
      const answer = lookup(tx.to, tx.data);
      if (!answer.ok) throw new FakeCallError(answer.revertData);
      return answer.data;
    },
    async getBlock(tag: string | number): Promise<BlockSummary | null> {
      const wanted = String(tag);
      if (wanted === "finalized" || wanted === "safe" || wanted === "latest") {
        const block = blocks[wanted];
        if (block !== undefined) return block;
        if (options.throwOnUnknownTag === true) throw new Error(`unsupported block tag: ${wanted}`);
        return null;
      }
      return byNumber[wanted.toLowerCase()] ?? null;
    },
    async getBlockNumber() {
      const latest = blocks.latest;
      if (latest === undefined) throw new Error("fake provider has no latest block");
      return latest.number;
    },
    async getNetwork() {
      return {chainId: options.chainId ?? 31337n};
    },
  };
}

/** A `VerifiedDeployment` built straight from a manifest: the read tests do not re-run verification. */
export function verifiedFrom(manifest: DeploymentManifest): VerifiedDeployment {
  return {
    manifest,
    chainId: manifest.chain.chainId,
    verifiedAtBlock: null,
    vault: manifest.contracts.vault.address,
    draw: manifest.contracts.draw.address,
    checks: [],
  };
}
