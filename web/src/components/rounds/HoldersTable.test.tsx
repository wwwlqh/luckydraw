// Holders: the seed is one labelled row, the table shows ten at a time, and it pages beyond that (§9.4, §9.5).

import type {Address} from "@luckydraw/client";
import {fireEvent, render, screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {PLAYER, SEED_ACCOUNT} from "../../lib/rounds/fixtures.ts";
import type {HolderRow} from "../../lib/rounds/round.ts";
import {HoldersTable} from "./HoldersTable.tsx";

function holders(count: number): readonly HolderRow[] {
  const rows: HolderRow[] = [
    {account: SEED_ACCOUNT, gross: 1_000n, isSeed: true},
    {account: PLAYER, gross: 900n, isSeed: false},
  ];
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(40, "0");
    rows.push({account: `0x${suffix}` as Address, gross: BigInt(100 - index), isSeed: false});
  }
  return rows;
}

function renderTable(count: number) {
  const rows = holders(count);
  const total = rows.reduce((sum, row) => sum + row.gross, 0n);
  return render(
    <HoldersTable holders={rows} grossTotal={total} decimals={2n} symbol="TEST2" account={PLAYER} />,
  );
}

describe("HoldersTable", () => {
  it("names the operator seed instead of showing it as an anonymous address", () => {
    renderTable(0);
    const seedRow = screen.getByText("Operator seed").closest("tr");
    expect(seedRow).not.toBeNull();
    expect(within(seedRow as HTMLElement).getByText(/0x3c44…93bc/)).toBeInTheDocument();
  });

  it("marks the connected account's own row", () => {
    renderTable(0);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("shows ten rows and pages beyond them", () => {
    renderTable(15);
    expect(screen.getAllByRole("row")).toHaveLength(11); // ten holders plus the header row
    fireEvent.click(screen.getByRole("button", {name: "Next"}));
    expect(screen.getAllByRole("row")).toHaveLength(8);
    expect(screen.getByText(/Showing 11–17 of 17/)).toBeInTheDocument();
  });

  it("shows no pagination when everyone fits on one page", () => {
    renderTable(3);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
