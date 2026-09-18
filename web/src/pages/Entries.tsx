// `/entries` (SPEC §9.4 route row, §9.6 state controls, §10.1 reads).
//
// "Tabs Active, Awaiting result, Won, Refunds and Past. Each row shows asset, round, gross entered, current
// share, state badge and the available action. Never mark unsettled positions lost."
//
// The four states of SPEC §9.6 ("Loading, empty, unavailable and partial-history states are distinct") are
// four distinct renders here, and the partial one is the interesting one: without an indexer the history
// comes from a paged log scan, so a list can be correct and incomplete at the same time. That is said out
// loud rather than papered over with a spinner, because a user who sees four of their five rounds and no
// notice would reasonably conclude the fifth is gone.
//
// Partial history has two causes and they need different sentences. A scan still running is temporary and
// the list only grows, so that notice is informational and goes away by itself. A provider that has *pruned*
// the old logs is permanent on that endpoint: the scan finished, and the missing rounds will never arrive
// however long the reader waits. The second notice therefore names the block below which nothing can be
// read and stays put, with no retry offered, because retrying is not the fix — an archive RPC or the indexer
// is (SPEC §10.1, and the §14 mainnet gate).
//
// Everything about which row belongs in which tab is `lib/positions/classify.ts`, which is a pure function of
// the round and the position and is tested directly against the §6.2 state table.

import {catalogEntryFor} from "@luckydraw/client";
import {useCallback, useMemo, useState} from "react";
import {Link} from "react-router";
import {EmptyState, ErrorState, Skeleton, TxLiveRegion, TxToast} from "../components/index.ts";
import {EntryRow, RefundCard, UnclaimedBadgeSlot} from "../components/wallet/index.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {ENTRY_TABS, type EntryTab} from "../lib/positions/classify.ts";
import {isRpcUnreachableScanError, providerDetail} from "../lib/positions/discovery.ts";
import {usePositions} from "../lib/positions/usePositions.ts";
import type {TxRuntime} from "../lib/tx/machine.ts";
import {useTransaction} from "../lib/tx/useTransaction.tsx";
import {providerSaid} from "../lib/wallet/errors.ts";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en, fill} from "../strings/en.ts";
import {walletEn} from "../strings/wallet.ts";

const TAB_LABELS: Readonly<Record<EntryTab, string>> = {
  active: walletEn.entries.tabActive,
  awaiting: walletEn.entries.tabAwaiting,
  won: walletEn.entries.tabWon,
  refunds: walletEn.entries.tabRefunds,
  past: walletEn.entries.tabPast,
};

const TAB_EMPTY: Readonly<Record<EntryTab, string>> = {
  active: walletEn.entries.emptyActive,
  awaiting: walletEn.entries.emptyAwaiting,
  won: walletEn.entries.emptyWon,
  refunds: walletEn.entries.emptyRefunds,
  past: walletEn.entries.emptyPast,
};

/** The router renders this with no props; `txRuntime` is the same tests-only seam `useTransaction` has. */
export type EntriesPageProps = {txRuntime?: TxRuntime};

export type ScanFailureView = {
  body: string;
  funds: string | null;
  nextAction: string | null;
  detail: string | null;
};

/**
 * What the reader is told when the history scan fails (SPEC §9.6 catalog, §9.7 language).
 *
 * The alert body is always one of the app's own catalog sentences. It used to be `error.message`, which on
 * the live chain 97 build meant a page of ethers text ("could not coalesce error (error={ "code": -32005
 * ... }") in a red panel: third-party words presented as the app's own, and nothing the reader could act on.
 * A throttled or unreachable node is the §9.6 `RpcUnavailable` row and says so; anything else keeps the
 * generic failure sentence. The node's own words survive once, capped and under the "Detail" label, so a
 * report to support still carries them.
 */
export function scanFailureView(error: Error | null): ScanFailureView | null {
  if (error === null) return null;
  const entry = isRpcUnreachableScanError(error) ? catalogEntryFor("RpcUnavailable") : null;
  return {
    body: entry?.message ?? en.error.body,
    funds: entry?.funds ?? null,
    nextAction: entry?.nextAction ?? null,
    detail: providerSaid(providerDetail(error)),
  };
}

export function EntriesPage({txRuntime}: EntriesPageProps = {}) {
  const {manifest, chain, status, verifyFailureText, retryVerification} = useDeployment();
  const {account} = useWallet();
  const tx = useTransaction(txRuntime === undefined ? undefined : {runtime: txRuntime, resume: false});
  const positions = usePositions();
  const [tab, setTab] = useState<EntryTab>("active");

  const assetsByAddress = useMemo(
    () => new Map(manifest.assets.map((entry) => [entry.asset, entry] as const)),
    [manifest.assets],
  );

  const rows = positions.rows ?? [];
  const counts = useMemo(() => {
    const totals = new Map<EntryTab, number>();
    for (const entry of ENTRY_TABS) totals.set(entry, 0);
    for (const row of rows) {
      for (const entry of row.tabs) totals.set(entry, (totals.get(entry) ?? 0) + 1);
    }
    return totals;
  }, [rows]);

  const visible = useMemo(() => rows.filter((row) => row.tabs.includes(tab)), [rows, tab]);
  const claimable = useMemo(() => rows.filter((row) => row.outcome === "refundClaimable").length, [rows]);
  const onClaimed = useCallback(() => positions.refresh(), [positions.refresh]);

  const scanFailure = useMemo(() => scanFailureView(positions.error), [positions.error]);

  if (status === "failed") {
    return (
      <>
        <h1>{walletEn.entries.title}</h1>
        <ErrorState
          title={en.gate.verifyFailedTitle}
          body={verifyFailureText ?? en.error.body}
          onRetry={retryVerification}
          retryLabel={en.gate.recheck}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <h1>{walletEn.entries.title}</h1>
        <UnclaimedBadgeSlot count={claimable} />
      </div>
      <p className="muted">{walletEn.entries.intro}</p>
      <TxLiveRegion state={tx.state} />

      {account === null ? (
        <EmptyState title={walletEn.entries.title} body={walletEn.entries.connectPrompt} />
      ) : (
        <>
          <div className="row" role="tablist" aria-label={walletEn.entries.tabsLabel}>
            {ENTRY_TABS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                id={`entries-tab-${entry}`}
                aria-selected={entry === tab}
                aria-controls="entries-panel"
                className="navlink"
                aria-current={entry === tab ? "page" : undefined}
                onClick={() => setTab(entry)}
              >
                {fill(walletEn.entries.tabCount, {
                  label: TAB_LABELS[entry],
                  count: (counts.get(entry) ?? 0).toString(),
                })}
              </button>
            ))}
          </div>

          {positions.status === "error" && scanFailure !== null ? (
            <ErrorState
              title={walletEn.entries.errorTitle}
              body={scanFailure.body}
              funds={scanFailure.funds}
              nextAction={scanFailure.nextAction}
              detail={scanFailure.detail}
              onRetry={positions.refresh}
              retryLabel={walletEn.entries.errorRetry}
            />
          ) : null}

          {positions.historyUnavailableBelow !== null ? (
            <div className="notice notice--warning">
              <p className="notice__title">{walletEn.entries.prunedTitle}</p>
              <p className="small">
                {fill(walletEn.entries.prunedBody, {
                  block: positions.historyUnavailableBelow.toString(),
                })}
              </p>
            </div>
          ) : null}

          {positions.partial && positions.scan !== null ? (
            <div className="notice notice--info">
              <p className="notice__title">{walletEn.entries.partialTitle}</p>
              <p className="small">{walletEn.entries.partialBody}</p>
              <p className="small muted">
                {fill(walletEn.entries.scanning, {
                  done: (positions.scan.scannedTo - positions.scan.fromBlock + 1n).toString(),
                  total: (positions.scan.toBlock - positions.scan.fromBlock + 1n).toString(),
                })}
              </p>
            </div>
          ) : null}

          <div id="entries-panel" role="tabpanel" aria-labelledby={`entries-tab-${tab}`}>
            {positions.status === "loading" ? (
              <Skeleton height="6rem" label={walletEn.entries.loading} />
            ) : visible.length === 0 ? (
              <EmptyState
                title={walletEn.entries.title}
                body={rows.length === 0 ? walletEn.entries.emptyAll : TAB_EMPTY[tab]}
              />
            ) : (
              <ul className="stack">
                {visible.map((row) =>
                  row.tabs.includes("refunds") && tab === "refunds" ? (
                    <RefundCard
                      key={row.roundId.toString()}
                      row={row}
                      asset={assetsByAddress.get(row.round.asset) ?? null}
                      chainId={chain.chainId}
                      account={account}
                      tx={tx}
                      onClaimed={onClaimed}
                    />
                  ) : (
                    <EntryRow
                      key={row.roundId.toString()}
                      row={row}
                      asset={assetsByAddress.get(row.round.asset) ?? null}
                      chainId={chain.chainId}
                      // Money that has already landed in the LuckyDraw balance needs a route to it from
                      // wherever the row appears, not only from the Refunds tab (SPEC §9.4: "Each row shows
                      // … the available action", §9.6 Settled: "receipt and available-balance action").
                      {...(row.outcome === "won" || row.outcome === "refunded"
                        ? {action: <Link to="/wallet">{walletEn.entries.rowGoToWallet}</Link>}
                        : {})}
                    />
                  ),
                )}
              </ul>
            )}
          </div>
        </>
      )}

      <TxToast state={tx.state} chain={chain} onDismiss={tx.reset} />
    </>
  );
}

export default EntriesPage;
