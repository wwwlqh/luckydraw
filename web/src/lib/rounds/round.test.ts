// The two derived tables of the round page: holders by account and the entry ledger (SPEC §9.4, §9.8).

import {ZERO_ADDRESS} from "@luckydraw/client";
import {describe, expect, it} from "vitest";
import {OTHER, PLAYER, ranges, SEED_ACCOUNT} from "./fixtures.ts";
import {aggregateHolders, ledgerOf} from "./round.ts";

describe("ledgerOf", () => {
  it("turns cumulative ranges back into each entry's own gross, in order", () => {
    const rows = ledgerOf(ranges(), SEED_ACCOUNT);
    expect(rows.map((row) => [row.index, row.buyer, row.gross, row.isSeed])).toEqual([
      [0, SEED_ACCOUNT, 10_000_000_000_000_000n, true],
      [1, PLAYER, 990_000_000_000_000_000n, false],
    ]);
  });

  it("marks nothing as the seed when the round was never seeded", () => {
    expect(ledgerOf(ranges(), ZERO_ADDRESS).some((row) => row.isSeed)).toBe(false);
  });
});

describe("aggregateHolders", () => {
  it("sums an account's ranges and sorts largest first", () => {
    const rows = aggregateHolders(
      [
        {buyer: PLAYER, cumulativeGross: 10n},
        {buyer: OTHER, cumulativeGross: 40n},
        {buyer: PLAYER, cumulativeGross: 100n},
      ],
      SEED_ACCOUNT,
    );
    expect(rows).toEqual([
      {account: PLAYER, gross: 70n, isSeed: false},
      {account: OTHER, gross: 30n, isSeed: false},
    ]);
  });

  it("keeps the operator seed as one labelled row, aggregated like any account", () => {
    const rows = aggregateHolders(ranges(), SEED_ACCOUNT);
    const seed = rows.find((row) => row.isSeed);
    expect(seed).toEqual({account: SEED_ACCOUNT, gross: 10_000_000_000_000_000n, isSeed: true});
    expect(rows.filter((row) => row.isSeed)).toHaveLength(1);
  });
});
