// One row of `/entries` (SPEC §9.4).
//
// "Each row shows asset, round, gross entered, current share, state badge and the available action. Never
// mark unsettled positions lost."
//
// The last sentence is a structural property here, not a habit: the row's outcome comes from `classify.ts`,
// whose `PositionOutcome` has no value meaning "lost" before the round is Settled, and the only sentence
// that says an entry was not drawn is reachable from `notSelected`, which only Settled can produce.
//
// The share label follows SPEC §9.5: "Every share figure is labelled 'current share, changes until cutoff as
// others enter'" while the round can still take entries, and reads as the share at the draw once it cannot.

import {formatShare, type ManifestAsset} from "@luckydraw/client";
import type {ReactNode} from "react";
import {Link} from "react-router";
import type {PositionRow} from "../../lib/positions/classify.ts";
import {fill} from "../../strings/en.ts";
import {walletEn} from "../../strings/wallet.ts";
import {AssetBadge, StateBadge, type StateTone} from "../StateBadge.tsx";
import {amountText} from "./format.ts";

const STATE_TONES: Readonly<Record<keyof typeof walletEn.entries.stateLabels, StateTone>> = {
  Open: "accent",
  AwaitingRequest: "pending",
  Drawing: "pending",
  Ready: "info",
  Settled: "neutral",
  Refunding: "info",
  Void: "neutral",
};

/** The one sentence that says what happened, with no verdict before Settled. */
export function outcomeText(row: PositionRow): string {
  switch (row.outcome) {
    case "won":
      return walletEn.entries.rowPrize;
    case "notSelected":
      return walletEn.entries.rowNotSelected;
    case "refunded":
      return walletEn.entries.rowClaimed;
    case "refundClaimable":
      return walletEn.entries.refundNoFee;
    case "void":
      // A Void round took no player entry at all, so "no result yet" would be a wait that never ends
      // (SPEC §9.6 Void).
      return walletEn.entries.rowVoid;
    default:
      return walletEn.entries.rowUnsettled;
  }
}

/**
 * The amount this round put into the account's LuckyDraw balance, or null when it credited nothing.
 *
 * A prize is the round's pot as the contract settled it; a refund is the account's own gross, fee included
 * (SPEC §5.2: "each buyer receives exactly grossByUser once, including their fee portion").
 */
export function creditedAmount(row: PositionRow): {label: string; amount: bigint} | null {
  if (row.outcome === "won") return {label: walletEn.entries.rowPrizeAmount, amount: row.round.prizePot};
  if (row.outcome === "refunded") {
    return {label: walletEn.entries.rowRefundCredited, amount: row.position.gross};
  }
  return null;
}

export type EntryRowProps = {
  row: PositionRow;
  /** The manifest record for `row.round.asset`, or null when the deployment no longer lists it. */
  asset: ManifestAsset | null;
  chainId: bigint;
  /** The available action for this row, if any. */
  action?: ReactNode;
};

export function EntryRow({row, asset, chainId, action}: EntryRowProps) {
  const decimals = asset === null ? 0 : Number(asset.decimals);
  const symbol = asset?.symbol ?? "";
  const shareLabel = row.shareStillMoving ? walletEn.entries.rowShareOpen : walletEn.entries.rowShareFinal;
  const credited = creditedAmount(row);

  return (
    <li className="card">
      <div className="page-heading">
        {asset === null ? (
          <span className="mono smallest">{row.round.asset}</span>
        ) : (
          <AssetBadge asset={asset} />
        )}
        <StateBadge tone={STATE_TONES[row.state]} label={walletEn.entries.stateLabels[row.state]} />
      </div>
      <dl className="definition-list">
        <dt>{fill(walletEn.entries.rowRound, {roundId: row.roundId.toString()})}</dt>
        <dd>
          <Link to={`/round/${chainId.toString()}/${row.roundId.toString()}`}>
            {walletEn.entries.rowView}
          </Link>
        </dd>
        <dt>{walletEn.entries.rowGross}</dt>
        <dd className="amount">{amountText(row.position.gross, decimals, symbol)}</dd>
        <dt>{walletEn.entries.rowShare}</dt>
        <dd className="amount">
          {formatShare(row.position.shareNumerator, row.position.shareDenominator)}{" "}
          <span className="small muted">({shareLabel})</span>
        </dd>
        {credited === null ? null : (
          <>
            <dt>{credited.label}</dt>
            <dd className="amount">{amountText(credited.amount, decimals, symbol)}</dd>
          </>
        )}
      </dl>
      <p className="small">{outcomeText(row)}</p>
      {action}
    </li>
  );
}
