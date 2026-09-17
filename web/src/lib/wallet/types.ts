// The wallet layer's own vocabulary (SPEC §9.2).
//
// Everything the app does with a wallet goes through `Connector`. Nothing above this file imports ethers for
// wallet purposes and nothing reads `window.ethereum` directly, which is what keeps WalletConnect v2 (§17,
// deferred) addable later as one more `Connector` with no change to any money flow.

/** The EIP-1193 request shape. `params` stays loose because every method defines its own. */
export type Eip1193RequestArgs = {
  readonly method: string;
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>;
};

/** The EIP-1193 surface the app uses. `on`/`removeListener` are optional: not every injector ships them. */
export type Eip1193Provider = {
  request(args: Eip1193RequestArgs): Promise<unknown>;
  on?(event: string, listener: (...args: readonly unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): void;
};

/**
 * `injected` is a provider that is present in the page (announced through EIP-6963, or the single
 * `window.ethereum` fallback). `install` is the entry offered when a recommended wallet is not present: it
 * has no provider and its `connect()` always refuses, because installing is the user's action, not the app's.
 */
export type ConnectorKind = "injected" | "install";

/** What a successful connection reports. Both values are re-read from the provider, never assumed. */
export type ConnectResult = {
  /** Lowercase account addresses in the wallet's own order; the first is the active one. */
  accounts: readonly string[];
  chainId: bigint;
};

export type Connector = {
  /** Stable across reloads: the EIP-6963 `rdns` for an announced wallet. Only this is persisted. */
  readonly id: string;
  readonly name: string;
  /** Data URI supplied by the wallet through EIP-6963, or null. Never fetched from a third party. */
  readonly icon: string | null;
  /** MetaMask carries the "Recommended" badge (SPEC §9.2). */
  readonly recommended: boolean;
  /** A wallet actually present in this page carries the "detected" badge. */
  readonly detected: boolean;
  readonly kind: ConnectorKind;
  /** Where to get this wallet, for an `install` entry. Null for an injected connector. */
  readonly installUrl: string | null;
  /** Null for an `install` entry. */
  readonly provider: Eip1193Provider | null;
  connect(): Promise<ConnectResult>;
  disconnect(): Promise<void>;
};
