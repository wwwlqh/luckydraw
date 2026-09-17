// Test fixtures: a verifiable synthetic deployment, a scriptable EIP-1193 wallet and a render helper.
//
// The manifest is the repo's real local one with the two code hashes replaced by the hashes of the synthetic
// runtime code the fake node serves, so `verifyDeployment` runs its real checks — chain id, code present,
// code hash, both bindings — against a node that is entirely under the test's control.

import {type DeploymentManifest, parseManifest} from "@luckydraw/client";
import {type RenderResult, render} from "@testing-library/react";
import {AbiCoder, type JsonRpcProvider, keccak256} from "ethers";
import type {ReactNode} from "react";
import localManifestJson from "../../../config/deployments/31337/0x610178da211fef7d417bc0e6fed39f05609ad788.json";
import {BlockProvider} from "../lib/data/BlockProvider.tsx";
import {type DeploymentBase, DeploymentProvider} from "../lib/deployment/DeploymentProvider.tsx";
import {loadChainRecord} from "../lib/deployment/records.ts";
import {ThemeProvider} from "../lib/theme/ThemeProvider.tsx";
import type {ConnectorEnvironment} from "../lib/wallet/connectors.ts";
import type {Eip1193Provider, Eip1193RequestArgs} from "../lib/wallet/types.ts";
import {WalletProvider, type WalletTarget} from "../lib/wallet/WalletProvider.tsx";

export const VAULT_CODE = "0x60016002600360046005";
export const DRAW_CODE = "0x60066007600860096010";

export function testManifest(): DeploymentManifest {
  const raw = structuredClone(localManifestJson) as unknown as Record<string, unknown>;
  const contracts = raw.contracts as Record<string, Record<string, unknown>>;
  (contracts.vault as Record<string, unknown>).codeHash = keccak256(VAULT_CODE);
  (contracts.draw as Record<string, unknown>).codeHash = keccak256(DRAW_CODE);
  return parseManifest(raw);
}

export type FakeNodeOptions = {
  chainId?: bigint;
  blockNumber?: number;
  /** Returns "0x" for a contract, which makes verification fail with MissingCode. */
  emptyCode?: boolean;
};

/** A node that answers exactly the calls `verifyDeployment` and the block poller make. */
export function fakeNode(manifest: DeploymentManifest, options: FakeNodeOptions = {}) {
  const coder = AbiCoder.defaultAbiCoder();
  const vault = manifest.contracts.vault.address;
  const draw = manifest.contracts.draw.address;
  let blockNumber = options.blockNumber ?? 12;
  /** Every `getBlock` tag, in order. The snapshot-block tests count how often one epoch resolves a block. */
  const blockTags: (string | number)[] = [];
  const chainId = options.chainId ?? manifest.chain.chainId;
  const node = {
    // No `getNetwork`. The chain id is only available the way the real provider must ask for it — over the
    // wire — so a double cannot let an adapter answer the SPEC §12 assertion out of its own pinned network
    // and have the test pass anyway.
    send: (method: string) => {
      if (method === "eth_chainId") return Promise.resolve(`0x${chainId.toString(16)}`);
      return Promise.reject(new Error(`unexpected send ${method}`));
    },
    getCode: (address: string) => {
      if (options.emptyCode === true) return Promise.resolve("0x");
      const lower = address.toLowerCase();
      if (lower === vault) return Promise.resolve(VAULT_CODE);
      if (lower === draw) return Promise.resolve(DRAW_CODE);
      return Promise.resolve("0x");
    },
    call: (tx: {to?: string | null}) => {
      const lower = (tx.to ?? "").toLowerCase();
      if (lower === draw) return Promise.resolve(coder.encode(["address"], [vault]));
      if (lower === vault) return Promise.resolve(coder.encode(["address"], [draw]));
      return Promise.reject(new Error(`unexpected call to ${lower}`));
    },
    getBlockNumber: () => Promise.resolve(blockNumber),
    getBlock: (tag: string | number) => {
      blockTags.push(tag);
      return Promise.resolve({
        number: typeof tag === "number" ? tag : blockNumber,
        hash: `0x${"11".repeat(32)}`,
        timestamp: 1_760_000_000,
      });
    },
    advance: (by = 1) => {
      blockNumber += by;
    },
    blockTags,
  };
  return node;
}

export function testDeploymentBase(options: FakeNodeOptions = {}): DeploymentBase {
  const manifest = testManifest();
  const chain = loadChainRecord("31337");
  const node = fakeNode(manifest, options);
  return {
    env: {
      chainIdText: "31337",
      chainId: 31_337n,
      drawAddress: manifest.contracts.draw.address,
      rpcUrls: ["http://127.0.0.1:8545"],
      blockPollMs: 100_000,
      // A local build carries no jurisdiction sentence; the chain 56 tests pass their own base.
      jurisdictionNotice: "",
    },
    manifest,
    chain,
    provider: node as unknown as JsonRpcProvider,
    rpcUrl: "http://127.0.0.1:8545",
  };
}

// ---------------------------------------------------------------------------
// A scriptable EIP-1193 wallet
// ---------------------------------------------------------------------------

type Listener = (...args: readonly unknown[]) => void;

export class FakeWallet implements Eip1193Provider {
  accounts: string[];
  chainId: bigint;
  readonly calls: Eip1193RequestArgs[] = [];
  /** Queued failures, keyed by method; the first matching request throws and the entry is consumed. */
  readonly failures: {method: string; error: unknown}[] = [];
  /** Chain ids this wallet already knows. A switch to any other throws 4902. */
  known: Set<string>;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(accounts: string[] = ["0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266"], chainId = 31_337n) {
    this.accounts = accounts;
    this.chainId = chainId;
    this.known = new Set([`0x${chainId.toString(16)}`]);
  }

  request(args: Eip1193RequestArgs): Promise<unknown> {
    this.calls.push(args);
    const queued = this.failures.findIndex((entry) => entry.method === args.method);
    if (queued >= 0) {
      const [failure] = this.failures.splice(queued, 1);
      return Promise.reject(failure?.error);
    }
    switch (args.method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return Promise.resolve([...this.accounts]);
      case "eth_chainId":
        return Promise.resolve(`0x${this.chainId.toString(16)}`);
      case "wallet_switchEthereumChain": {
        const target = (args.params as [{chainId: string}])[0].chainId;
        if (!this.known.has(target)) {
          return Promise.reject(Object.assign(new Error("Unrecognized chain ID."), {code: 4902}));
        }
        this.setChain(BigInt(target));
        return Promise.resolve(null);
      }
      case "wallet_addEthereumChain": {
        const target = (args.params as [{chainId: string}])[0].chainId;
        this.known.add(target);
        this.setChain(BigInt(target));
        return Promise.resolve(null);
      }
      default:
        return Promise.reject(new Error(`unexpected method ${args.method}`));
    }
  }

  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  /** Changes the account and fires the event, the way a wallet does. */
  setAccounts(accounts: string[]): void {
    this.accounts = accounts;
    this.emit("accountsChanged", accounts);
  }

  setChain(chainId: bigint): void {
    this.chainId = chainId;
    this.emit("chainChanged", `0x${chainId.toString(16)}`);
  }
}

/** Announces a wallet the way EIP-6963 does. */
export function announce(name: string, rdns: string, provider: Eip1193Provider, icon = "data:,"): void {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {info: {uuid: `uuid-${rdns}`, name, rdns, icon}, provider},
    }),
  );
}

export const NO_INJECTED: ConnectorEnvironment = {
  injected: null,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  location: {host: "app.example", pathname: "/"},
};

export type HarnessOptions = {
  base?: DeploymentBase;
  environment?: ConnectorEnvironment;
};

/**
 * The provider stack, as a component, so a test can `rerender` it with a different connector environment —
 * which is how "the provider behind the connected wallet was replaced" is reproduced. Pass the same `base`
 * object across rerenders; a new one re-runs verification.
 */
export function Providers({
  children,
  base,
  environment,
}: {
  children: ReactNode;
  base: DeploymentBase;
  environment?: ConnectorEnvironment;
}) {
  const target: WalletTarget = {
    chainId: base.chain.chainId,
    chainName: base.chain.displayName,
    nativeSymbol: base.chain.nativeSymbol,
    rpcUrls: base.env.rpcUrls,
    explorerUrl: base.chain.explorerUrl,
  };
  return (
    <ThemeProvider>
      <DeploymentProvider base={base}>
        <BlockProvider provider={base.provider} pollMs={base.env.blockPollMs}>
          <WalletProvider target={target} environment={environment ?? NO_INJECTED}>
            {children}
          </WalletProvider>
        </BlockProvider>
      </DeploymentProvider>
    </ThemeProvider>
  );
}

/** Mounts the deployment, block and wallet providers around a subtree, with no router and no polling. */
export function renderWithProviders(ui: ReactNode, options: HarnessOptions = {}): RenderResult {
  const base = options.base ?? testDeploymentBase();
  return render(
    <Providers base={base} {...(options.environment === undefined ? {} : {environment: options.environment})}>
      {ui}
    </Providers>,
  );
}
