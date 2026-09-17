// Holders of a round, aggregated by account (SPEC §9.4 "holders (top ten plus pagination)", §9.5, §9.8).
//
// The operator seed is one row labelled "Operator seed", never an anonymous address (SPEC §9.5). That label
// is the row's name; the address is still shown in monospace next to it, because §9.1 X8 says a page shows
// the on-chain fact rather than asking to be believed.
//
// The table scrolls inside its own container and pages beyond ten rows (§9.6).

import type {Address} from "@luckydraw/client";
import {useState} from "react";
import {credit, formatShare} from "../../lib/rounds/format.ts";
import type {HolderRow} from "../../lib/rounds/round.ts";
import {rounds} from "../../strings/rounds.ts";
import {EmptyState, truncateAddress} from "../index.ts";
import {Pagination} from "./Pagination.tsx";
import "./rounds.css";

/** SPEC §9.4: "holders (top ten plus pagination)". */
export const HOLDERS_PAGE_SIZE = 10;

export type HoldersTableProps = {
  holders: readonly HolderRow[];
  /** Round gross, the denominator of every share. */
  grossTotal: bigint;
  decimals: bigint;
  symbol: string;
  /** The connected account, marked "You" where it appears. */
  account: Address | null;
};

export function HoldersTable({holders, grossTotal, decimals, symbol, account}: HoldersTableProps) {
  const [page, setPage] = useState(0);
  if (holders.length === 0) return <EmptyState title={rounds.holders.empty} body="" />;
  const start = page * HOLDERS_PAGE_SIZE;
  const rows = holders.slice(start, start + HOLDERS_PAGE_SIZE);

  return (
    <>
      <div className="round-table-scroll">
        <table className="round-table">
          <caption className="visually-hidden">{rounds.round.holdersTop}</caption>
          <thead>
            <tr>
              <th scope="col">{rounds.holders.rank}</th>
              <th scope="col">{rounds.holders.account}</th>
              <th scope="col" className="amount">
                {rounds.holders.entered}
              </th>
              <th scope="col" className="amount">
                {rounds.holders.share}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.account}>
                <td className="amount">{start + index + 1}</td>
                <th scope="row">
                  {row.isSeed ? <span>{rounds.holders.seedRow}</span> : null}
                  {!row.isSeed && account !== null && row.account === account ? (
                    <span>{rounds.holders.you}</span>
                  ) : null}{" "}
                  <span className="mono smallest muted">{truncateAddress(row.account)}</span>
                </th>
                <td className="amount">{credit(row.gross, decimals, symbol)}</td>
                <td className="amount">{formatShare(row.gross, grossTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={HOLDERS_PAGE_SIZE}
        total={holders.length}
        onPage={setPage}
        label={rounds.round.holdersHeading}
      />
    </>
  );
}
