// The decoded summary shown before every wallet prompt (SPEC §9.6, client security).
//
// "a decoded summary (function, round, asset, amount and, for approvals, the spender) is shown before every
// wallet prompt". The summary is not assembled here from a transaction the page already built: it comes out
// of the client's `prepare*` builders, from the same arguments that were encoded, so the two cannot disagree.
// This component only renders it.

import {type Address, formatAmount, type WriteSummary} from "@luckydraw/client";

const CONTRACT_LABELS: Readonly<Record<WriteSummary["contract"], string>> = {
  vault: "LuckyVault",
  draw: "LuckyDraw",
  erc20: "Token contract",
};

export type WriteSummaryViewProps = {
  summary: WriteSummary;
  to: Address;
  /** Decimals and symbol for `summary.asset`, so the amount is rendered as money and not as raw units. */
  decimals: number;
  symbol: string;
};

export function WriteSummaryView({summary, to, decimals, symbol}: WriteSummaryViewProps) {
  return (
    <dl className="definition-list">
      <dt>Contract</dt>
      <dd>
        {CONTRACT_LABELS[summary.contract]} <span className="mono smallest">{to}</span>
      </dd>
      <dt>Function</dt>
      <dd className="mono">{summary.function}</dd>
      {summary.asset === null ? null : (
        <>
          <dt>Asset</dt>
          <dd>
            {symbol} <span className="mono smallest">{summary.asset}</span>
          </dd>
        </>
      )}
      {summary.amount === null ? null : (
        <>
          <dt>Amount</dt>
          <dd className="amount">{formatAmount(summary.amount, decimals, {rounding: "up", symbol})}</dd>
        </>
      )}
      {summary.roundId === null ? null : (
        <>
          <dt>Round</dt>
          <dd className="amount">{summary.roundId.toString()}</dd>
        </>
      )}
      {summary.spender === null ? null : (
        <>
          <dt>Spender</dt>
          <dd className="mono">{summary.spender}</dd>
        </>
      )}
      {summary.account === null ? null : (
        <>
          <dt>Credits</dt>
          <dd className="mono">{summary.account}</dd>
        </>
      )}
    </dl>
  );
}
