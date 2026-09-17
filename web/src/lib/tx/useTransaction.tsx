// `useTransaction()`: the React face of the state machine (SPEC §9.6).
//
// The hook owns three things the machine deliberately does not: where the runtime comes from (the verified
// deployment's provider and the signer for the quoted account), when a persisted intent is reattached (once,
// on mount), and the guarantee that a run that has been superseded cannot write back into state.
//
// It never resends. `send` is the only thing that signs, it is only ever called from a user gesture, and the
// resume path tracks a hash without touching the wallet.

import type {Address, PreparedWrite} from "@luckydraw/client";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useDeployment} from "../deployment/DeploymentProvider.tsx";
import {toWalletError, WalletError} from "../wallet/errors.ts";
import {useSigner} from "../wallet/useSigner.ts";
import {useWallet} from "../wallet/WalletProvider.tsx";
import {toTxSigner, toTxWatcher} from "./ethersAdapters.ts";
import {failureFromWalletError, type RevertParamFormatter} from "./failure.ts";
import {clearIntentFor, intentTargetsDeployment, loadIntent} from "./intent.ts";
import {resumeIntent, runWrite, type SendOptions, type TxRuntime} from "./machine.ts";
import {IDLE_TX_STATE, type TxSignerLike, type TxState} from "./types.ts";

/** Receipt polling interval. SPEC §10.1 keeps an idle tab under 30 RPC requests a minute. */
export const RECEIPT_POLL_MS = 3_000;
/** No receipt, no replacement and no nonce movement for this long is reported as dropped, never resent. */
export const DROP_AFTER_MS = 5 * 60_000;

const NO_SIGNER: TxSignerLike = {
  estimateGas() {
    return Promise.reject(new WalletError("Disconnected", "No wallet is connected."));
  },
  sendTransaction() {
    return Promise.reject(new WalletError("Disconnected", "No wallet is connected."));
  },
};

export type UseTransactionOptions = {
  /** Replaces the derived runtime wholesale. Tests pass a fake signer and watcher through this. */
  runtime?: TxRuntime;
  /** Reattach to a persisted intent on mount. Default true. */
  resume?: boolean;
  /** Supplies already-formatted values for a catalog message's placeholders. */
  formatParams?: RevertParamFormatter;
};

export type TransactionHandle = {
  state: TxState;
  /** True while a run is in flight. One transaction at a time per hook instance. */
  busy: boolean;
  send: (prepared: PreparedWrite, options: SendOptions) => Promise<TxState>;
  /** Returns to idle. Does not cancel anything on chain; nothing on chain can be cancelled from here. */
  reset: () => void;
};

export function useTransaction(options?: UseTransactionOptions): TransactionHandle {
  const deployment = useDeployment();
  const wallet = useWallet();
  const {requestSigner} = useSigner();
  const [state, setState] = useState<TxState>(IDLE_TX_STATE);
  const [busy, setBusy] = useState(false);
  const runId = useRef(0);
  /**
   * Aborts whatever run is currently tracking. One hook instance runs one transaction at a time, but a
   * superseded run's `track` loop keeps polling — and keeps being able to write a verdict into the shared
   * intent slot — until something tells it to stop. This is that something.
   */
  const abort = useRef<AbortController | null>(null);
  const injected = options?.runtime;
  const resume = options?.resume ?? true;
  const formatParams = options?.formatParams;

  const chainId = deployment.chain.chainId;
  const finalityTag = deployment.chain.finalityTag;
  const confirmationDepth = deployment.chain.confirmationDepth;
  const provider = deployment.provider;

  /** Everything except the signer, which only exists once an account has been asked for. */
  const baseRuntime = useMemo<TxRuntime>(
    () =>
      injected ?? {
        signer: NO_SIGNER,
        watcher: toTxWatcher(provider),
        chainId,
        finalityTag,
        confirmationDepth,
        storage: typeof window === "undefined" ? null : window.sessionStorage,
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
        receiptPollMs: RECEIPT_POLL_MS,
        dropAfterMs: DROP_AFTER_MS,
      },
    [injected, provider, chainId, finalityTag, confirmationDepth],
  );

  /** Only the newest run may write into state: a stale run's emissions are dropped. */
  const emitterFor = useCallback((id: number) => {
    return (next: TxState): void => {
      if (runId.current === id) setState(next);
    };
  }, []);

  const send = useCallback(
    async (prepared: PreparedWrite, sendOptions: SendOptions): Promise<TxState> => {
      const id = runId.current + 1;
      runId.current = id;
      const emit = emitterFor(id);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      try {
        let runtime: TxRuntime = {...baseRuntime, signal: controller.signal};
        if (injected === undefined) {
          const signer = await requestSigner(sendOptions.account);
          runtime = {...runtime, signer: toTxSigner(signer, chainId)};
        }
        return await runWrite(prepared, sendOptions, runtime, emit);
      } catch (error) {
        // Only the signer handshake can land here; `runWrite` turns everything else into a state.
        const walletError = error instanceof WalletError ? error : toWalletError(error);
        const failure = failureFromWalletError(walletError);
        const next: TxState = {
          ...IDLE_TX_STATE,
          phase: walletError.code === "UserRejected" ? "rejected" : "walletUnreachable",
          summary: prepared.summary,
          label: sendOptions.label,
          account: sendOptions.account,
          chainId,
          failure,
        };
        emit(next);
        return next;
      } finally {
        if (runId.current === id) setBusy(false);
      }
    },
    [baseRuntime, injected, requestSigner, emitterFor, chainId],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    abort.current?.abort();
    abort.current = null;
    setState(IDLE_TX_STATE);
    setBusy(false);
  }, []);

  // Unmount ends the run's tracking too: a component that goes away must not leave a loop polling the node
  // and holding an opinion about the intent slot.
  useEffect(() => {
    return () => {
      abort.current?.abort();
      abort.current = null;
    };
  }, []);

  // Reattach once to a transaction this tab had in progress (SPEC §9.6 deep-link and tab restore).
  //
  // Not on mount: on the first settled session. The silent reconnect of §9.2 resolves an account one or two
  // ticks after mount, and an intent is account-scoped, so resuming while the account is still null would
  // reattach whatever this tab last sent to whoever connects next.
  const resumed = useRef(false);
  const account: Address | null = wallet.account;
  const settled = wallet.status === "connected" && account !== null;
  const manifest = deployment.manifest;
  /** Everything this build is allowed to have sent a transaction to (SPEC §15 "only listed assets"). */
  const allowedTargets = useMemo(
    () => [
      manifest.contracts.vault.address,
      manifest.contracts.draw.address,
      ...manifest.assets.map((asset) => asset.asset),
    ],
    [manifest],
  );
  useEffect(() => {
    if (!resume || resumed.current || !settled) return;
    const intent = loadIntent(baseRuntime.storage, chainId, account);
    if (intent === null || intent.hash === null) return;
    // Session storage is writable by anything in this origin. An intent pointing anywhere but this
    // deployment's own contracts was not written by this app, so it is removed rather than resumed: the
    // alternative is showing a stranger's address under this app's transaction UI.
    if (!intentTargetsDeployment(intent, allowedTargets)) {
      clearIntentFor(baseRuntime.storage, intent.hash);
      resumed.current = true;
      return;
    }
    resumed.current = true;
    const id = runId.current + 1;
    runId.current = id;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    const hash = intent.hash;
    void resumeIntent(intent, {...baseRuntime, signal: controller.signal}, emitterFor(id), formatParams)
      .catch(() => {
        // A resume that throws would otherwise throw again on the next mount, forever, because the intent
        // that caused it is still stored. Drop it and return to idle; nothing on chain is affected.
        clearIntentFor(baseRuntime.storage, hash);
        if (runId.current === id) setState(IDLE_TX_STATE);
      })
      .finally(() => {
        if (runId.current === id) setBusy(false);
      });
  }, [resume, settled, baseRuntime, chainId, account, emitterFor, formatParams, allowedTargets]);

  return {state, busy, send, reset};
}
