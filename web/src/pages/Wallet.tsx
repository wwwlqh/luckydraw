// `/wallet` (SPEC §9.4 route row, §9.5 deposit and withdraw paragraphs, §4.2, §10.1).
//
// The page owns three things and delegates everything else:
//
//   1. one snapshot. Every balance, allowance and deposit switch on the page comes from `readWalletOverview`
//      at one block, so no two cards can disagree about the state of the chain (SPEC §10.1);
//   2. one transaction. `useTransaction` is one-at-a-time by construction, which is the right shape for a
//      page whose controls all move the same money; the live region and the toast are rendered once here,
//      near the root of the surface that owns the transaction (SPEC §9.7);
//   3. the top-up entry point of SPEC §9.5: `/wallet?asset=&amount=&intent=` preselects an asset and
//      prefills an amount, and after a deposit receipt is included offers exactly one way back to the round.
//      It never buys anything: "Never auto-buy into a successor or auto-sign."

import type {ManifestAsset} from "@luckydraw/client";
import {useCallback, useMemo} from "react";
import {Link, useSearchParams} from "react-router";
import {Card, EmptyState, ErrorState, Skeleton, TxLiveRegion, TxToast} from "../components/index.ts";
import {
  BalanceCard,
  type CommittedState,
  DepositPanel,
  UnclaimedBadgeSlot,
  WithdrawPanel,
} from "../components/wallet/index.ts";
import {useSnapshot} from "../lib/data/useSnapshot.ts";
import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {committedByAsset} from "../lib/positions/classify.ts";
import type {AccountProbeProvider} from "../lib/positions/tokenReads.ts";
import {readWalletOverview} from "../lib/positions/tokenReads.ts";
import {usePositions} from "../lib/positions/usePositions.ts";
import type {TxRuntime} from "../lib/tx/machine.ts";
import {useTransaction} from "../lib/tx/useTransaction.tsx";
import {useWallet} from "../lib/wallet/WalletProvider.tsx";
import {en} from "../strings/en.ts";
import {walletEn} from "../strings/wallet.ts";

/** The `?asset=`, `?amount=` and `?intent=` triple of SPEC §9.5, already validated against the manifest. */
type TopUp = {
  asset: ManifestAsset | null;
  /** Raw decimal text; the deposit panel parses and validates it like any typed input. */
  amount: string | null;
  /** The round to offer a way back to. Kept as text: it is only ever put back into a URL. */
  intent: string | null;
  /** True when the link named an asset this deployment does not have. */
  unknownAsset: boolean;
};

function readTopUp(params: URLSearchParams, assets: readonly ManifestAsset[]): TopUp {
  const assetParam = params.get("asset");
  const amount = params.get("amount");
  const intent = params.get("intent");
  const validIntent = intent !== null && /^[0-9]+$/.test(intent) ? intent : null;
  const validAmount = amount !== null && /^[0-9]*\.?[0-9]*$/.test(amount) && amount !== "" ? amount : null;
  if (assetParam === null) {
    return {asset: null, amount: validAmount, intent: validIntent, unknownAsset: false};
  }
  const wanted = assetParam.toLowerCase();
  const asset = assets.find((entry) => entry.asset === wanted) ?? null;
  return {asset, amount: validAmount, intent: validIntent, unknownAsset: asset === null};
}

/** The router renders this with no props; `txRuntime` is the same tests-only seam `useTransaction` has. */
export type WalletPageProps = {txRuntime?: TxRuntime};

export function WalletPage({txRuntime}: WalletPageProps = {}) {
  const {manifest, chain, provider, verified, status, verifyFailureText, retryVerification} = useDeployment();
  const {account} = useWallet();
  const [searchParams] = useSearchParams();
  const tx = useTransaction(txRuntime === undefined ? undefined : {runtime: txRuntime, resume: false});
  const positions = usePositions();

  const topUp = useMemo(() => readTopUp(searchParams, manifest.assets), [searchParams, manifest.assets]);

  const probe = useMemo<AccountProbeProvider>(
    () => ({
      getBalance: (address, blockTag) =>
        provider.getBalance(address, blockTag === undefined ? "latest" : blockTag),
      getCode: (address, blockTag) => provider.getCode(address, blockTag === undefined ? "latest" : blockTag),
    }),
    [provider],
  );

  const assetKeys = manifest.assets.map((entry) => entry.asset).join(",");
  const overview = useSnapshot(
    `wallet:${account ?? "none"}`,
    (ctx) =>
      account === null
        ? Promise.reject(new Error("no account is connected"))
        : readWalletOverview(ctx, probe, account, manifest.assets),
    {deps: [account ?? "none", assetKeys], enabled: account !== null && verified !== null},
  );

  const refresh = useCallback(() => {
    overview.refresh();
    positions.refresh();
  }, [overview.refresh, positions.refresh]);

  const committed = useMemo(() => committedByAsset(positions.rows ?? []), [positions.rows]);
  const committedState: CommittedState =
    positions.status === "error"
      ? "error"
      : positions.status === "scanning" || positions.status === "loading"
        ? "scanning"
        : positions.rows === null
          ? "unknown"
          : "ready";

  // Ordered so the asset a top-up link named is the first card on the page (SPEC §9.5 "preselect the asset").
  const ordered = useMemo(() => {
    if (topUp.asset === null) return manifest.assets;
    const target = topUp.asset;
    return [target, ...manifest.assets.filter((entry) => entry.asset !== target.asset)];
  }, [manifest.assets, topUp.asset]);

  const backToRound =
    topUp.intent === null ? null : (
      <Link className="button button--secondary" to={`/round/${chain.chainId.toString()}/${topUp.intent}`}>
        {walletEn.wallet.topUpBack}
      </Link>
    );

  if (status === "failed") {
    return (
      <>
        <h1>{walletEn.wallet.title}</h1>
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
        <h1>{walletEn.wallet.title}</h1>
        <UnclaimedBadgeSlot
          count={(positions.rows ?? []).filter((row) => row.outcome === "refundClaimable").length}
        />
      </div>
      <p className="muted">{walletEn.wallet.intro}</p>
      <TxLiveRegion state={tx.state} />

      {topUp.unknownAsset ? (
        <p className="notice notice--warning">{walletEn.wallet.topUpUnknownAsset}</p>
      ) : null}
      {topUp.asset === null ? null : (
        <Card title={walletEn.wallet.topUpHeading}>
          <p className="small muted">{walletEn.wallet.topUpBody}</p>
        </Card>
      )}

      {account === null ? (
        <EmptyState title={walletEn.wallet.title} body={walletEn.wallet.connectPrompt} />
      ) : (
        <div className="stack">
          {overview.status === "error" && overview.error !== null ? (
            <ErrorState body={overview.error.message} onRetry={overview.refresh} />
          ) : null}
          {ordered.map((asset) => {
            const index = manifest.assets.findIndex((entry) => entry.asset === asset.asset);
            const state = overview.value?.assets[index] ?? null;
            const isTarget = topUp.asset !== null && topUp.asset.asset === asset.asset;
            return (
              <BalanceCard
                key={asset.asset}
                asset={asset}
                chain={chain}
                vault={manifest.contracts.vault.address}
                walletBalance={state?.walletBalance ?? null}
                vaultBalance={state?.vaultBalance ?? null}
                committed={committed.get(asset.asset) ?? 0n}
                committedState={committedState}
                nativeWalletBalance={overview.value?.nativeBalance ?? null}
                depositsEnabled={state?.record.depositsEnabled ?? null}
                snapshot={overview.snapshot}
              >
                {overview.value === null ? (
                  <Skeleton height="6rem" label={en.app.loading} />
                ) : (
                  <div className="stack">
                    <DepositPanel
                      asset={asset}
                      account={account}
                      walletBalance={state?.walletBalance ?? null}
                      vaultBalance={state?.vaultBalance ?? null}
                      allowance={state?.allowance ?? 0n}
                      onRefresh={refresh}
                      tx={tx}
                      {...(isTarget && topUp.amount !== null ? {initialAmount: topUp.amount} : {})}
                      {...(isTarget && backToRound !== null ? {afterDeposit: backToRound} : {})}
                    />
                    <WithdrawPanel
                      asset={asset}
                      account={account}
                      vaultBalance={state?.vaultBalance ?? null}
                      accountHasCode={overview.value.accountHasCode}
                      onRefresh={refresh}
                      tx={tx}
                    />
                  </div>
                )}
              </BalanceCard>
            );
          })}
        </div>
      )}

      <TxToast state={tx.state} chain={chain} onDismiss={tx.reset} />
    </>
  );
}

export default WalletPage;
