// Fixtures for the `/wallet` and `/entries` tests: a fake node that answers the calls these surfaces make,
// a fake transaction runtime, and a render helper that mounts a subtree inside a router.
//
// The node is deliberately an `eth_call` dispatcher rather than a set of stubbed adapters: the tests then
// exercise the real encoders, the real `readBatch`, the real snapshot walk and the real revert path, and a
// change to any of them shows up here instead of passing silently.

import {
  type Address,
  type AssetRecord,
  CloseReason,
  Kind,
  luckyDrawAbi,
  luckyVaultAbi,
  type Position,
  RefundReason,
  type RoundView,
  State,
} from "@luckydraw/client";
import {act, fireEvent, type RenderResult, render, screen, waitFor} from "@testing-library/react";
import {Interface, type JsonRpcProvider} from "ethers";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {expect} from "vitest";
import {BlockProvider} from "../../lib/data/BlockProvider.tsx";
import {type DeploymentBase, DeploymentProvider} from "../../lib/deployment/DeploymentProvider.tsx";
import {loadChainRecord} from "../../lib/deployment/records.ts";
import {ThemeProvider} from "../../lib/theme/ThemeProvider.tsx";
import type {TxRuntime} from "../../lib/tx/machine.ts";
import type {TxReceiptLike, TxRequest} from "../../lib/tx/types.ts";
import {useWallet, WalletProvider, type WalletTarget} from "../../lib/wallet/WalletProvider.tsx";
import {
  announce,
  DRAW_CODE,
  FakeWallet,
  fakeNode,
  testManifest,
  VAULT_CODE,
  waitForWalletListeners,
} from "../../test/harness.tsx";

export const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
export const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
export const TX_HASH = `0x${"cd".repeat(32)}`;

const vaultInterface = new Interface(luckyVaultAbi);
const drawInterface = new Interface(luckyDrawAbi);
const erc20Interface = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A `RoundView` with every field set, so `encodeFunctionResult` has a complete tuple to encode. */
export function roundFixture(id: bigint, overrides: Partial<RoundView> = {}): RoundView {
  return {
    id,
    poolId: 1n,
    kind: Kind.Day100,
    sequence: 1n,
    asset: NATIVE,
    tokenDecimals: 18n,
    pricing: {
      feed: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" as Address,
      feedDecimals: 8n,
      maxPriceAge: 3600n,
      referenceKind: 0,
      minAnswer: 0n,
      maxAnswer: 0n,
    },
    feeAccount: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address,
    opensAt: 1_760_000_000n,
    closesAt: 1_760_086_400n,
    targetUsd: 100n,
    state: State.Open,
    grossTotal: 3_000n,
    feeReserved: 90n,
    prizePot: 2_910n,
    playerCount: 2n,
    seeded: false,
    seedAccount: ZERO_ADDRESS as Address,
    seedGross: 0n,
    closedAt: 0n,
    closeReason: CloseReason.Cutoff,
    requestDeadline: 0n,
    requestId: 0n,
    requestedAt: 0n,
    word0: 0n,
    word1: 0n,
    winningIndex: 0n,
    winner: ZERO_ADDRESS as Address,
    settledAt: 0n,
    refundedGross: 0n,
    refundReason: RefundReason.InsufficientPlayers,
    rangeCount: 2n,
    ...overrides,
  };
}

export function positionFixture(overrides: Partial<Position> = {}): Position {
  return {gross: 1_000n, refunded: false, shareNumerator: 1_000n, shareDenominator: 3_000n, ...overrides};
}

export type ChainScript = {
  /** `Vault.balanceOf(account, asset)`, keyed by lowercase asset. */
  vaultBalances?: Record<string, bigint>;
  /** `Vault.getAsset(asset)`, keyed by lowercase asset. Defaults to listed with deposits on. */
  assetRecords?: Record<string, AssetRecord>;
  /** `Vault.depositsPaused()`, the global switch of SPEC §4.2. Defaults to false. */
  depositsPaused?: boolean;
  /** ERC-20 `balanceOf(account)`, keyed by lowercase token. */
  tokenBalances?: Record<string, bigint>;
  /** ERC-20 `allowance(account, vault)`, keyed by lowercase token. */
  allowances?: Record<string, bigint>;
  nativeBalance?: bigint;
  /** Runtime code at the connected address, for the SPEC §9.4 contract-wallet warning. */
  accountCode?: string;
  /** `Draw.getRound(id)`, keyed by decimal round id. */
  rounds?: Record<string, RoundView>;
  /** `Draw.getPosition(id, account)`, keyed by decimal round id. */
  positions?: Record<string, Position>;
  /** Called for every `eth_getLogs`; returns that window's logs. */
  getLogs?: (filter: {fromBlock: string; toBlock: string; topics: readonly unknown[]}) => unknown[];
  blockNumber?: number;
};

export type FakeChain = ReturnType<typeof fakeChain>;

/** A node that answers verification, the block poller and every read these two surfaces make. */
export function fakeChain(script: ChainScript = {}) {
  const manifest = testManifest();
  const vault = manifest.contracts.vault.address;
  const draw = manifest.contracts.draw.address;
  const base = fakeNode(manifest, {blockNumber: script.blockNumber ?? 12});
  const logCalls: {fromBlock: string; toBlock: string}[] = [];
  const state = {
    vaultBalances: {...script.vaultBalances},
    allowances: {...script.allowances},
    tokenBalances: {...script.tokenBalances},
    assetRecords: {...script.assetRecords},
    depositsPaused: script.depositsPaused ?? false,
  };

  function assetRecord(asset: string): AssetRecord {
    return state.assetRecords[asset] ?? {listed: true, tokenDecimals: 18n, depositsEnabled: true};
  }

  const node = {
    ...base,
    getBalance: () => Promise.resolve(script.nativeBalance ?? 5_000_000_000_000_000_000n),
    getCode: (address: string) => {
      const lower = address.toLowerCase();
      if (lower === vault) return Promise.resolve(VAULT_CODE);
      if (lower === draw) return Promise.resolve(DRAW_CODE);
      if (lower === ACCOUNT) return Promise.resolve(script.accountCode ?? "0x");
      return Promise.resolve("0x");
    },
    getLogs: (filter: {fromBlock: string; toBlock: string; topics: readonly unknown[]}) => {
      logCalls.push({fromBlock: filter.fromBlock, toBlock: filter.toBlock});
      return Promise.resolve(script.getLogs?.(filter) ?? []);
    },
    call: (tx: {to?: string | null; data?: string}) => {
      const to = (tx.to ?? "").toLowerCase();
      const data = tx.data ?? "0x";
      if (to === vault) {
        const parsed = vaultInterface.parseTransaction({data});
        if (parsed === null) return Promise.reject(new Error(`unknown vault call ${data.slice(0, 10)}`));
        switch (parsed.name) {
          case "draw":
            return Promise.resolve(vaultInterface.encodeFunctionResult("draw", [draw]));
          case "balanceOf": {
            const asset = String(parsed.args[1]).toLowerCase();
            return Promise.resolve(
              vaultInterface.encodeFunctionResult("balanceOf", [state.vaultBalances[asset] ?? 0n]),
            );
          }
          case "depositsPaused":
            return Promise.resolve(
              vaultInterface.encodeFunctionResult("depositsPaused", [state.depositsPaused]),
            );
          case "getAsset": {
            const asset = String(parsed.args[0]).toLowerCase();
            const record = assetRecord(asset);
            return Promise.resolve(
              vaultInterface.encodeFunctionResult("getAsset", [
                [record.listed, record.tokenDecimals, record.depositsEnabled],
              ]),
            );
          }
          default:
            return Promise.reject(new Error(`unscripted vault call ${parsed.name}`));
        }
      }
      if (to === draw) {
        const parsed = drawInterface.parseTransaction({data});
        if (parsed === null) return Promise.reject(new Error(`unknown draw call ${data.slice(0, 10)}`));
        switch (parsed.name) {
          case "VAULT":
            return Promise.resolve(drawInterface.encodeFunctionResult("VAULT", [vault]));
          case "getRound": {
            const id = String(parsed.args[0]);
            const round = script.rounds?.[id];
            if (round === undefined) return Promise.reject(new Error(`unscripted round ${id}`));
            return Promise.resolve(drawInterface.encodeFunctionResult("getRound", [round]));
          }
          case "getPosition": {
            const id = String(parsed.args[0]);
            const position = script.positions?.[id] ?? positionFixture({gross: 0n});
            // `getPosition` returns four values, not a struct.
            return Promise.resolve(
              drawInterface.encodeFunctionResult("getPosition", [
                position.gross,
                position.refunded,
                position.shareNumerator,
                position.shareDenominator,
              ]),
            );
          }
          default:
            return Promise.reject(new Error(`unscripted draw call ${parsed.name}`));
        }
      }
      // Anything else is a token.
      const parsed = erc20Interface.parseTransaction({data});
      if (parsed === null) return Promise.reject(new Error(`unknown token call ${data.slice(0, 10)}`));
      if (parsed.name === "allowance") {
        return Promise.resolve(
          erc20Interface.encodeFunctionResult("allowance", [state.allowances[to] ?? 0n]),
        );
      }
      if (parsed.name === "balanceOf") {
        return Promise.resolve(
          erc20Interface.encodeFunctionResult("balanceOf", [state.tokenBalances[to] ?? 0n]),
        );
      }
      return Promise.reject(new Error(`unscripted token call ${parsed.name}`));
    },
  };

  const chain = loadChainRecord("31337");
  const deploymentBase: DeploymentBase = {
    env: {
      chainIdText: "31337",
      chainId: 31_337n,
      drawAddress: draw,
      rpcUrls: ["http://127.0.0.1:8545"],
      blockPollMs: 100_000,
      // Local: no jurisdiction sentence. Only a chain 56 build is required to carry one (SPEC §14).
      jurisdictionNotice: "",
    },
    manifest,
    chain,
    provider: node as unknown as JsonRpcProvider,
    rpcUrl: "http://127.0.0.1:8545",
  };

  return {manifest, node, base: deploymentBase, logCalls, state};
}

export type FakeTx = {
  runtime: TxRuntime;
  sent: (TxRequest & {gasLimit: bigint})[];
};

/** A runtime whose every transaction is included in one poll. Nothing here touches a wallet. */
export function fakeTxRuntime(): FakeTx {
  const sent: (TxRequest & {gasLimit: bigint})[] = [];
  let clock = 1_000;
  const receipt: TxReceiptLike = {hash: TX_HASH, status: 1, blockNumber: 500};
  const runtime: TxRuntime = {
    signer: {
      estimateGas: () => Promise.resolve(100_000n),
      sendTransaction: (tx) => {
        sent.push(tx);
        return Promise.resolve({hash: TX_HASH, nonce: sent.length});
      },
    },
    watcher: {
      getTransactionReceipt: () => Promise.resolve(receipt),
      getTransaction: () => Promise.resolve({blockNumber: 500}),
      getTransactionCount: () => Promise.resolve(7),
      // No finality tag, so the §10.1 policy falls back to the fixed depth: the head is far enough past the
      // receipt for `confirmed` to be reached in one poll and the run to terminate.
      getBlockNumber: () => Promise.resolve(5_000),
      getFinalityHead: () => Promise.resolve(null),
      call: () => Promise.resolve("0x"),
    },
    chainId: 31_337n,
    finalityTag: null,
    confirmationDepth: 200n,
    storage: null,
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    receiptPollMs: 1,
    dropAfterMs: 5_000,
  };
  return {runtime, sent};
}

/** Mounts a subtree inside the theme, deployment, block, wallet and router providers. */
export function renderSurface(
  ui: ReactNode,
  base: DeploymentBase,
  options: {initialEntries?: string[]} = {},
): RenderResult {
  const target: WalletTarget = {
    chainId: base.chain.chainId,
    chainName: base.chain.displayName,
    nativeSymbol: base.chain.nativeSymbol,
    rpcUrls: base.env.rpcUrls,
    explorerUrl: base.chain.explorerUrl,
  };
  return render(
    <ThemeProvider>
      <DeploymentProvider base={base}>
        <BlockProvider provider={base.provider} pollMs={base.env.blockPollMs}>
          <WalletProvider
            target={target}
            environment={{
              injected: null,
              userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
              location: {host: "app.example", pathname: "/"},
            }}
          >
            <MemoryRouter initialEntries={options.initialEntries ?? ["/wallet"]}>{ui}</MemoryRouter>
          </WalletProvider>
        </BlockProvider>
      </DeploymentProvider>
    </ThemeProvider>,
  );
}

/** A button the tests click to connect the announced fake wallet. */
export function ConnectButton() {
  const wallet = useWallet();
  return (
    <button type="button" onClick={() => void wallet.connect("io.metamask")}>
      test-connect
    </button>
  );
}

/**
 * Announces a fake wallet, waits for the deployment to verify, then connects it.
 *
 * Verification has to finish first: `useWriteGate` refuses every write while it is running, so a click
 * before it returns would be testing the gate rather than the panel.
 */
export async function connectTestWallet(accounts: readonly string[] = [ACCOUNT]): Promise<FakeWallet> {
  const wallet = new FakeWallet([...accounts]);
  await act(async () => {
    announce("MetaMask", "io.metamask", wallet);
  });
  await waitFor(() => expect(screen.getByText("test-connect")).toBeInTheDocument());
  fireEvent.click(screen.getByText("test-connect"));
  await waitFor(() => expect(screen.queryByText("test-connect")).not.toBeNull());
  // Not cosmetic: a caller that fires `setAccounts` the moment this returns would otherwise race the passive
  // effect that subscribes to the wallet, and lose the event (see `waitForWalletListeners`).
  await waitForWalletListeners(wallet);
  return wallet;
}

export {announce, FakeWallet};
