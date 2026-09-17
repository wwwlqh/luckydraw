// The money lines shown before an entry is signed (SPEC §9.1 X1, §9.5).
//
// "Any control that moves funds shows the exact asset amount, the 3% reserved fee, the balance afterwards and
// the next step before the wallet opens." All four are here, in that order, and the fee expands to full raw
// precision because §9.5 requires the raw-precision disclosure and §9.7 requires it on expand rather than by
// default.
//
// Rounding directions follow §9.7 and are not interchangeable: the debit and the fee round up, the prize
// contribution and the balance afterwards round down. A user never sees a debit smaller, or a balance larger,
// than the chain will produce.

import {useId, useState} from "react";
import {credit, debit, formatAmountFull} from "../../lib/rounds/format.ts";
import {rounds} from "../../strings/rounds.ts";
import "./rounds.css";

export type FeeBreakdownProps = {
  gross: bigint;
  feeDelta: bigint;
  netDelta: bigint;
  balanceAfter: bigint;
  decimals: bigint;
  symbol: string;
};

export function FeeBreakdown({gross, feeDelta, netDelta, balanceAfter, decimals, symbol}: FeeBreakdownProps) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return (
    <>
      <dl className="entry-disclosures">
        <dt>{rounds.entry.grossDebit}</dt>
        <dd className="amount">{debit(gross, decimals, symbol)}</dd>
        <dt>{rounds.entry.feeReserved}</dt>
        <dd className="amount">{debit(feeDelta, decimals, symbol)}</dd>
        <dt>{rounds.entry.netAddition}</dt>
        <dd className="amount">{credit(netDelta, decimals, symbol)}</dd>
        <dt>{rounds.entry.balanceAfter}</dt>
        <dd className="amount">{credit(balanceAfter, decimals, symbol)}</dd>
      </dl>
      <button
        type="button"
        className="button button--ghost"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? rounds.entry.feeCollapse : rounds.entry.feeExpand}
      </button>
      <p id={detailId} className="mono smallest muted" hidden={!expanded}>
        {rounds.entry.grossDebit}: {formatAmountFull(gross, Number(decimals))} {symbol} ·{" "}
        {rounds.entry.feeReserved}: {formatAmountFull(feeDelta, Number(decimals))} {symbol} ·{" "}
        {rounds.entry.netAddition}: {formatAmountFull(netDelta, Number(decimals))} {symbol}
      </p>
    </>
  );
}
