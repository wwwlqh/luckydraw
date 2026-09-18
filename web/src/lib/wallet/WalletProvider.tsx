// Wallet connection, session and the network guard (SPEC §9.2, §9.6).
//
// Session rule, verbatim from §9.2: "Remember only the last connector id in local storage, reconnect silently
// on return, and offer an explicit Disconnect. An account or chain change re-validates within one second,
// clears account-scoped caches and never signs with a stale account." The re-validation is a fresh
// `eth_accounts` / `eth_chainId` read on every provider event rather than trust in the event payload, and
// `accountEpoch` is the counter every account-scoped cache keys on: it increases on connect, on disconnect,
// on an account change and on a chain change, so a stale row cannot survive any of them.

import {type Address, asAddress} from "@luckydraw/client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {en} from "../../strings/en.ts";
import {clearIntent} from "../tx/intent.ts";
import {buildConnectors, type ConnectorEnvironment, parseChainId, readSession} from "./connectors.ts";
import {discoverProviders, type Eip6963ProviderDetail} from "./eip6963.ts";
import {toWalletError, WalletError} from "./errors.ts";
import type {Connector, Eip1193Provider} from "./types.ts";

export const CONNECTOR_STORAGE_KEY = "luckydraw.wallet.connectorId";

export type WalletStatus = "disconnected" | "connecting" | "connected";

/** The chain this build's deployment lives on, and the parameters `wallet_addEthereumChain` needs. */
export type WalletTarget = {
  chainId: bigint;
  chainName: string;
  nativeSymbol: string;
  rpcUrls: readonly string[];
  explorerUrl: string | null;
};

export type WalletContextValue = {
  status: WalletStatus;
  /** Lowercase, or null when disconnected. */
  account: Address | null;
  /** The wallet's chain, which is not necessarily the deployment's. Reads never depend on it. */
  chainId: bigint | null;
  connector: Connector | null;
  connectors: readonly Connector[];
  /** Increases whenever the account or chain changes. Account-scoped caches key on it. */
  accountEpoch: number;
  error: WalletError | null;
  target: WalletTarget;
  /** True when the wallet is connected and on the deployment's chain. */
  onDeploymentChain: boolean;
  connect: (connectorId: string) => Promise<void>;
  disconnect: () => void;
  switchToDeploymentChain: () => Promise<void>;
  clearError: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function hexChainId(chainId: bigint): string {
  return `0x${chainId.toString(16)}`;
}

function defaultEnvironment(): ConnectorEnvironment {
  const injected = (window as {ethereum?: Eip1193Provider}).ethereum;
  return {
    injected: injected ?? null,
    userAgent: navigator.userAgent,
    location: {host: window.location.host, pathname: window.location.pathname},
  };
}

export type WalletProviderProps = {
  children: ReactNode;
  target: WalletTarget;
  /** Injected by tests. Production reads `window.ethereum`, the user agent and the location. */
  environment?: ConnectorEnvironment;
  /** Injected by tests. Only the last connector id is ever stored, never a key or a signature. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /**
   * Injected by tests. Where the pending transaction intent lives (`window.sessionStorage` in the app): a
   * disconnect and an account change both clear it, because it names an account (SPEC §9.2 "Disconnect
   * clears account-sensitive caches").
   */
  intentStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

export function WalletProvider({children, target, environment, storage, intentStorage}: WalletProviderProps) {
  const [details, setDetails] = useState<readonly Eip6963ProviderDetail[]>([]);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [connectorId, setConnectorId] = useState<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const [error, setError] = useState<WalletError | null>(null);
  const reconnectTried = useRef(false);
  /** The provider object the live session was established with. Nothing else may be signed through. */
  const sessionProvider = useRef<Eip1193Provider | null>(null);
  const lastAccount = useRef<Address | null>(null);
  /** True while a provider-event re-validation is in flight, so a re-subscription can tell it was dropped. */
  const revalidating = useRef(false);
  /** True when a re-validation is owed: one was dropped, and no live listener will ever answer it. */
  const revalidationOwed = useRef(false);

  const store = useMemo<WalletProviderProps["storage"]>(
    () => storage ?? (typeof window === "undefined" ? undefined : window.localStorage),
    [storage],
  );
  const intents = useMemo<WalletProviderProps["intentStorage"]>(
    () => intentStorage ?? (typeof window === "undefined" ? undefined : window.sessionStorage),
    [intentStorage],
  );
  const env = useMemo(() => environment ?? defaultEnvironment(), [environment]);

  useEffect(() => discoverProviders(setDetails), []);

  const connectors = useMemo(() => buildConnectors(details, env), [details, env]);
  const connector = useMemo(
    () => connectors.find((entry) => entry.id === connectorId) ?? null,
    [connectors, connectorId],
  );

  const clearSession = useCallback(() => {
    sessionProvider.current = null;
    lastAccount.current = null;
    // Nothing is owed to a session that no longer exists.
    revalidating.current = false;
    revalidationOwed.current = false;
    clearIntent(intents ?? null);
    setStatus("disconnected");
    setAccount(null);
    setChainId(null);
    setConnectorId(null);
    setAccountEpoch((epoch) => epoch + 1);
  }, [intents]);

  /** Applies a freshly read session. Returns false when the wallet has no authorized account any more. */
  const applySession = useCallback(
    (
      session: {accounts: readonly string[]; chainId: bigint},
      id: string,
      provider: Eip1193Provider | null,
    ): boolean => {
      const first = session.accounts[0];
      if (first === undefined) {
        clearSession();
        return false;
      }
      const next = asAddress(first);
      // A different address is a different owner of the pending intent, so the intent goes with it
      // (SPEC §9.2 "Disconnect clears account-sensitive caches and queries").
      if (lastAccount.current !== null && lastAccount.current !== next) clearIntent(intents ?? null);
      lastAccount.current = next;
      if (provider !== null) sessionProvider.current = provider;
      setConnectorId(id);
      setAccount(next);
      setChainId(session.chainId);
      setStatus("connected");
      setAccountEpoch((epoch) => epoch + 1);
      return true;
    },
    [clearSession, intents],
  );

  // Silent reconnect on return: only the stored connector id is used, and only `eth_accounts`, which never
  // prompts. A wallet that has forgotten the permission simply answers with no accounts.
  useEffect(() => {
    if (reconnectTried.current || status !== "disconnected" || connectors.length === 0) return;
    const storedId = store?.getItem(CONNECTOR_STORAGE_KEY) ?? null;
    if (storedId === null) return;
    const candidate = connectors.find((entry) => entry.id === storedId && entry.provider !== null);
    if (candidate === undefined) return;
    reconnectTried.current = true;
    let live = true;
    void readSession(candidate.provider as Eip1193Provider)
      .then((session) => {
        if (!live) return;
        if (!applySession(session, candidate.id, candidate.provider)) {
          store?.removeItem(CONNECTOR_STORAGE_KEY);
        }
      })
      .catch(() => {
        // A silent reconnect that fails is not an error the user asked for; the Connect button stays.
      });
    return () => {
      live = false;
    };
  }, [connectors, status, store, applySession]);

  const connect = useCallback(
    async (id: string): Promise<void> => {
      const candidate = connectors.find((entry) => entry.id === id);
      if (candidate === undefined) {
        setError(new WalletError("WalletNotInstalled", `No wallet with id ${id} is available.`));
        return;
      }
      setError(null);
      setStatus("connecting");
      try {
        const session = await candidate.connect();
        if (!applySession(session, candidate.id, candidate.provider)) {
          throw new WalletError("NoAccounts", `${candidate.name} did not return an account.`);
        }
        store?.setItem(CONNECTOR_STORAGE_KEY, candidate.id);
        reconnectTried.current = true;
      } catch (caught) {
        setStatus("disconnected");
        setError(toWalletError(caught));
      }
    },
    [connectors, applySession, store],
  );

  const disconnect = useCallback(() => {
    void connector?.disconnect().catch(() => undefined);
    store?.removeItem(CONNECTOR_STORAGE_KEY);
    reconnectTried.current = true;
    setError(null);
    clearSession();
  }, [connector, store, clearSession]);

  // Provider events. The payload is never trusted: every event triggers a fresh read, which is what
  // "re-validates within one second" means in practice.
  //
  // This effect re-subscribes whenever its connector's identity changes, and the connector list is rebuilt by
  // anything that changes `details` or the environment — a wallet announcing itself a moment later, a
  // re-rendered provider stack. When that happened while a re-validation was in flight, the cleanup's `live`
  // flag discarded the answer and nothing ever re-read: the account chip kept the previous address with no
  // error, which is exactly the stale account §9.2 forbids. So a dropped read is remembered in a ref and
  // re-run by the next subscription rather than lost.
  useEffect(() => {
    const provider = connector?.provider ?? null;
    if (provider === null || provider.on === undefined || provider.removeListener === undefined) return;
    const id = connector?.id ?? "";
    let live = true;

    const revalidate = (): void => {
      revalidating.current = true;
      revalidationOwed.current = false;
      void readSession(provider)
        .then((session) => {
          if (!live) return;
          revalidating.current = false;
          applySession(session, id, provider);
        })
        .catch(() => {
          if (!live) return;
          revalidating.current = false;
          clearSession();
        });
    };
    const onAccountsChanged = (...args: readonly unknown[]): void => {
      const accounts = args[0];
      if (Array.isArray(accounts) && accounts.length === 0) {
        store?.removeItem(CONNECTOR_STORAGE_KEY);
        clearSession();
        return;
      }
      revalidate();
    };
    const onChainChanged = (...args: readonly unknown[]): void => {
      // Apply the reported chain immediately so the write gate closes in the same tick, then re-read.
      try {
        setChainId(parseChainId(args[0]));
        setAccountEpoch((epoch) => epoch + 1);
      } catch {
        // An unusable payload just means the re-read below decides.
      }
      revalidate();
    };
    const onDisconnect = (): void => {
      clearSession();
    };

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    provider.on("disconnect", onDisconnect);
    // A read the previous subscription started and could no longer apply is re-run here, once.
    if (revalidationOwed.current) revalidate();
    return () => {
      live = false;
      if (revalidating.current) revalidationOwed.current = true;
      revalidating.current = false;
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [connector, applySession, clearSession, store]);

  // The provider object behind the connected id must stay the one the session was established with. A page
  // can re-announce a wallet, and `window.ethereum` can be reassigned; either would otherwise swap the object
  // `useSigner` signs through while the chip still says "connected". A swap ends the session instead
  // (SPEC §9.2: an account or chain change "never signs with a stale account" — the same holds for the
  // provider itself).
  //
  // A connector that has *vanished* from the list ends the session for the same reason, not for a weaker
  // one. The real case is the generic `window.ethereum` entry: it exists only while nothing has announced
  // itself, so a wallet that announces a moment after the user connected through it removes the connected
  // connector from the list. Returning early there left `status` at "connected" with a null connector, which
  // means no event listeners, no signer and an account chip that keeps showing an address nothing is
  // watching any more. Ending the session with the same "reconnect before signing" error is the honest
  // outcome, and the user's next click reconnects through the announced wallet.
  useEffect(() => {
    if (status !== "connected" || connectorId === null) return;
    const remembered = sessionProvider.current;
    if (remembered === null) return;
    const current = connectors.find((entry) => entry.id === connectorId)?.provider ?? null;
    if (current === remembered) return;
    store?.removeItem(CONNECTOR_STORAGE_KEY);
    clearSession();
    setError(new WalletError("Disconnected", en.wallet.providerChanged));
  }, [connectors, connectorId, status, store, clearSession]);

  const switchToDeploymentChain = useCallback(async (): Promise<void> => {
    const provider = connector?.provider ?? null;
    if (provider === null) {
      const failure = new WalletError("Disconnected", "No wallet is connected.");
      setError(failure);
      throw failure;
    }
    const hex = hexChainId(target.chainId);
    setError(null);
    try {
      await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: hex}]});
    } catch (caught) {
      const walletError = toWalletError(caught);
      if (walletError.code !== "ChainNotAdded") {
        setError(walletError);
        throw walletError;
      }
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hex,
              chainName: target.chainName,
              // SPEC §9.2 pins the currency: BNB with 18 decimals.
              nativeCurrency: {name: target.nativeSymbol, symbol: target.nativeSymbol, decimals: 18},
              rpcUrls: [...target.rpcUrls],
              blockExplorerUrls: target.explorerUrl === null ? [] : [target.explorerUrl],
            },
          ],
        });
      } catch (addFailure) {
        const walletAddError = toWalletError(addFailure);
        setError(walletAddError);
        throw walletAddError;
      }
    }
    try {
      setChainId(parseChainId(await provider.request({method: "eth_chainId"})));
      setAccountEpoch((epoch) => epoch + 1);
    } catch (caught) {
      const walletError = toWalletError(caught);
      setError(walletError);
      throw walletError;
    }
  }, [connector, target]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      account,
      chainId,
      connector,
      connectors,
      accountEpoch,
      error,
      target,
      onDeploymentChain: status === "connected" && chainId === target.chainId,
      connect,
      disconnect,
      switchToDeploymentChain,
      clearError,
    }),
    [
      status,
      account,
      chainId,
      connector,
      connectors,
      accountEpoch,
      error,
      target,
      connect,
      disconnect,
      switchToDeploymentChain,
      clearError,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The wallet session. Throws outside the provider. */
export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (value === null) throw new Error("useWallet must be used inside <WalletProvider>.");
  return value;
}
