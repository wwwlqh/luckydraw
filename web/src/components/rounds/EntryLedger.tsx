// The entry ledger: every range in the order the contract recorded it (SPEC §9.4, §5.1).
//
// The ranges are the round's weights, so this table is the evidence behind the winner: each row shows what
// that entry added and the cumulative total it produced, which is the number `winningIndex` is compared
// against (§7.2). The operator seed is labelled, exactly as in the holders table (§9.5).

import type {Address} from "@luckydraw/client";
import {useState} from "react";
import {credit} from "../../lib/rounds/format.ts";
import type {LedgerRow} from "../../lib/rounds/round.ts";
import {rounds} from "../../strings/rounds.ts";
import {EmptyState, truncateAddress} from "../index.ts";
import {Pagination} from "./Pagination.tsx";
import "./rounds.css";

export const LEDGER_PAGE_SIZE = 10;

export type EntryLedgerProps = {
  ledger: readonly LedgerRow[];
  decimals: bigint;
  symbol: string;
  account: Address | null;
};

export function EntryLedger({ledger, decimals, symbol, account}: EntryLedgerProps) {
  const [page, setPage] = useState(0);
  if (ledger.length === 0) return <EmptyState title={rounds.ledger.empty} body="" />;
  const start = page * LEDGER_PAGE_SIZE;
  const rows = ledger.slice(start, start + LEDGER_PAGE_SIZE);

  return (
    <>
      <div className="round-table-scroll">
        <table className="round-table">
          <caption className="visually-hidden">{rounds.round.ledgerNote}</caption>
          <thead>
            <tr>
              <th scope="col">{rounds.ledger.index}</th>
              <th scope="col">{rounds.ledger.buyer}</th>
              <th scope="col" className="amount">
                {rounds.ledger.amount}
              </th>
              <th scope="col" className="amount">
                {rounds.ledger.cumulative}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.index}:${row.cumulativeGross}`}>
                <td className="amount">{row.index + 1}</td>
                <th scope="row">
                  {row.isSeed ? <span>{rounds.holders.seedRow}</span> : null}
                  {!row.isSeed && account !== null && row.buyer === account ? (
                    <span>{rounds.holders.you}</span>
                  ) : null}{" "}
                  <span className="mono smallest muted">{truncateAddress(row.buyer)}</span>
                </th>
                <td className="amount">{credit(row.gross, decimals, symbol)}</td>
                <td className="amount">{credit(row.cumulativeGross, decimals, symbol)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={LEDGER_PAGE_SIZE}
        total={ledger.length}
        onPage={setPage}
        label={rounds.round.ledgerHeading}
      />
    </>
  );
}
