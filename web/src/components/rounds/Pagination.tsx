// Pagination for the holders table and the entry ledger (SPEC §9.3 components, §9.6 "Tables paginate and
// scroll within their container").
//
// A `nav` with its own accessible name, two real buttons and a live-region count, so the page change is
// announced and the control is completable with the keyboard alone (§9.7).

import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {Button} from "../index.ts";
import "./rounds.css";

export type PaginationProps = {
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  label?: string;
};

export function pageCount(total: number, pageSize: number): number {
  return total <= 0 ? 1 : Math.ceil(total / pageSize);
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  label = rounds.pagination.label,
}: PaginationProps) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pagination" aria-label={label}>
      <Button variant="ghost" onClick={() => onPage(page - 1)} disabled={page <= 0}>
        {rounds.pagination.previous}
      </Button>
      <span className="small muted" role="status" aria-live="polite">
        {fill(rounds.pagination.page, {page: String(page + 1), pages: String(pages)})} ·{" "}
        {fill(rounds.pagination.showing, {from: String(from), to: String(to), total: String(total)})}
      </span>
      <Button variant="ghost" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
        {rounds.pagination.next}
      </Button>
    </nav>
  );
}
