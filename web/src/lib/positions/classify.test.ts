// The §6.2 state table mapped onto the five tabs of SPEC §9.4, and the rule that nothing unsettled is lost.

import {type Address, State} from "@luckydraw/client";
import {describe, expect, it} from "vitest";
import {positionFixture, roundFixture} from "../../components/wallet/testKit.tsx";
import {committedByAsset, type EntryTab, outcomeOf, rowOf, tabsOf} from "./classify.ts";

const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const SOMEONE_ELSE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;

function tabsFor(state: State, overrides: Parameters<typeof roundFixture>[1] = {}, refunded = false) {
  const round = roundFixture(1n, {state, ...overrides});
  const position = positionFixture({refunded});
  return {row: rowOf(round, position, ME), tabs: tabsOf(outcomeOf(round, position, ME), round)};
}

describe("tab classification", () => {
  it("puts an Open round in Active and nowhere else", () => {
    const {tabs, row} = tabsFor(State.Open);
    expect(tabs).toEqual<EntryTab[]>(["active"]);
    expect(row.outcome).toBe("pending");
    expect(row.shareStillMoving).toBe(true);
  });

  it("puts AwaitingRequest, Drawing and Ready in Awaiting result", () => {
    for (const state of [State.AwaitingRequest, State.Drawing, State.Ready]) {
      const {tabs, row} = tabsFor(state);
      expect(tabs).toEqual<EntryTab[]>(["awaiting"]);
      expect(row.outcome).toBe("pending");
      expect(row.shareStillMoving).toBe(false);
    }
  });

  it("puts a Settled round this account won in Won and in Past", () => {
    const {tabs, row} = tabsFor(State.Settled, {winner: ME});
    expect(tabs).toEqual<EntryTab[]>(["won", "past"]);
    expect(row.outcome).toBe("won");
  });

  it("puts a Settled round another account won in Past only, and never calls it lost before Settled", () => {
    const {tabs, row} = tabsFor(State.Settled, {winner: SOMEONE_ELSE});
    expect(tabs).toEqual<EntryTab[]>(["past"]);
    expect(row.outcome).toBe("notSelected");

    // The same round in every pre-Settled state is `pending`: there is no value that means lost.
    for (const state of [State.Open, State.AwaitingRequest, State.Drawing, State.Ready]) {
      expect(tabsFor(state, {winner: SOMEONE_ELSE}).row.outcome).toBe("pending");
    }
  });

  it("puts a Refunding round in Refunds, and adds Past once the refund is credited", () => {
    const open = tabsFor(State.Refunding, {}, false);
    expect(open.tabs).toEqual<EntryTab[]>(["refunds"]);
    expect(open.row.outcome).toBe("refundClaimable");

    const credited = tabsFor(State.Refunding, {}, true);
    expect(credited.tabs).toEqual<EntryTab[]>(["refunds", "past"]);
    expect(credited.row.outcome).toBe("refunded");
  });

  it("puts a Void round in Past", () => {
    const {tabs, row} = tabsFor(State.Void);
    expect(tabs).toEqual<EntryTab[]>(["past"]);
    expect(row.outcome).toBe("void");
  });

  it("counts as committed only what a round still holds for this account", () => {
    const committed = [
      rowOf(roundFixture(1n, {state: State.Open}), positionFixture({gross: 100n}), ME),
      rowOf(roundFixture(2n, {state: State.Drawing}), positionFixture({gross: 200n}), ME),
      rowOf(roundFixture(3n, {state: State.Refunding}), positionFixture({gross: 400n}), ME),
    ];
    const released = [
      rowOf(roundFixture(4n, {state: State.Settled, winner: ME}), positionFixture({gross: 800n}), ME),
      rowOf(roundFixture(5n, {state: State.Refunding}), positionFixture({gross: 1_600n, refunded: true}), ME),
      rowOf(roundFixture(6n, {state: State.Void}), positionFixture({gross: 3_200n}), ME),
    ];

    const totals = committedByAsset([...committed, ...released]);
    expect(totals.get(roundFixture(1n).asset)).toBe(700n);
  });
});
