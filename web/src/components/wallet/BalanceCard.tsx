// One asset's two columns on `/wallet` (SPEC §9.4).
//
// "Per asset, two columns: 'In your wallet' and 'In LuckyDraw balance', with Deposit and Withdraw, committed
// amounts shown separately, history, asset and network details and gas needs."
//
// Committed is shown as its own line and never folded into available, because they are different money:
// available can leave at any time (§4.3 V3), committed is escrow that belongs to a round until it settles,
// refunds or voids. The committed figure comes from the position scan, so it carries its own state — an
// amount the app has not finished reading is labelled as such rather than shown as zero.
//
// History is deferred with `/activity` (it needs the indexer); the card links to the per-round history the
// entries page already has rather than inventing a partial ledger here.

import {type Address, formatAmount, type ManifestAsset, type Snapshot} from "@luckydraw/client";
import type {ReactNode} from "react";
import type {ChainRecord} from "../../lib/deployment/records.ts";
import {fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {Card} from "../Card.tsx";
import {DataFreshness} from "../DataFreshness.tsx";
import {AssetBadge, StateBadge} from "../StateBadge.tsx";

/** How far the committed figure has got. `unknown` is "not read yet", never "zero". */
export type CommittedState = "ready" | "scanning" | "error" | "unknown";

export type BalanceCardProps = {
  asset: ManifestAsset;
  chain: ChainRecord;
  vault: Address;
  /** The account's own balance of this asset. */
  walletBalance: bigint | null;
  /** The account's available LuckyDraw balance. */
  vaultBalance: bigint | null;
  committed: bigint | null;
  committedState: CommittedState;
  /** The account's native balance, for the gas-needs line. */
  nativeWalletBalance: bigint | null;
  /** The live `Vault.getAsset` switch, or null while it is being read. */
  depositsEnabled: boolean | null;
  snapshot: Snapshot<unknown> | null;
  /** The Deposit and Withdraw panels. */
  children?: ReactNode;
};

function amountOrDash(raw: bigint | null, decimals: number, symbol: string): string {
  // Balances round down: showing more than the chain holds is never acceptable (SPEC §9.7).
  return raw === null ? "—" : formatAmount(raw, decimals, {rounding: "down", symbol});
}

export function BalanceCard({
  asset,
  chain,
  vault,
  walletBalance,
  vaultBalance,
  committed,
  committedState,
  nativeWalletBalance,
  depositsEnabled,
  snapshot,
  children,
}: BalanceCardProps) {
  const decimals = Number(asset.decimals);
  const symbol = asset.symbol;
  const nativeSymbol = chain.nativeSymbol;

  let committedText: string;
  if (committedState === "ready") committedText = amountOrDash(committed ?? 0n, decimals, symbol);
  else if (committedState === "scanning") committedText = walletEn.wallet.committedScanning;
  else if (committedState === "error") committedText = walletEn.wallet.committedError;
  else committedText = walletEn.wallet.committedUnknown;

  return (
    <Card title={<AssetBadge asset={asset} showName />} aside={<DataFreshness snapshot={snapshot} />} raised>
      <dl className="definition-list">
        <dt>{walletEn.wallet.columnWallet}</dt>
        <dd className="amount">{amountOrDash(walletBalance, decimals, symbol)}</dd>
        <dt>{walletEn.wallet.columnLuckyDraw}</dt>
        <dd className="amount">{amountOrDash(vaultBalance, decimals, symbol)}</dd>
        <dt>{walletEn.wallet.committed}</dt>
        <dd className={committedState === "ready" ? "amount" : "small muted"}>{committedText}</dd>
      </dl>
      <p className="small muted">{walletEn.wallet.committedHint}</p>

      {children}

      <details>
        <summary>{walletEn.wallet.detailsHeading}</summary>
        <dl className="definition-list">
          <dt>{walletEn.wallet.detailContract}</dt>
          <dd className="mono">{asset.native ? walletEn.wallet.detailNative : asset.asset}</dd>
          <dt>{walletEn.wallet.detailDecimals}</dt>
          <dd className="amount">{asset.decimals.toString()}</dd>
          <dt>{walletEn.wallet.detailNetwork}</dt>
          <dd>
            {chain.displayName} <span className="amount">({chain.chainId.toString()})</span>
          </dd>
          <dt>{walletEn.wallet.detailVault}</dt>
          <dd className="mono">{vault}</dd>
        </dl>
        <StateBadge
          tone={depositsEnabled === false ? "pending" : "positive"}
          label={
            depositsEnabled === false ? walletEn.wallet.detailDepositsOff : walletEn.wallet.detailDepositsOn
          }
        />
      </details>

      <div className="stack">
        <p className="card__title">{walletEn.wallet.gasHeading}</p>
        <p className="small muted">{fill(walletEn.wallet.gasBody, {symbol: nativeSymbol})}</p>
        {nativeWalletBalance !== null && nativeWalletBalance <= 0n ? (
          <p className="notice notice--warning small">
            {fill(walletEn.wallet.gasMissing, {symbol: nativeSymbol})}
          </p>
        ) : null}
      </div>

      {asset.listed ? null : <p className="notice notice--warning small">{walletEn.wallet.unlistedNotice}</p>}
    </Card>
  );
}
