// Every row of the SPEC §9.6 state table, rendered, with the one primary action it offers (§9.1 X3).

import {type ManifestAsset, type Position, type RoundView, State} from "@luckydraw/client";
import {screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {priceStateOf} from "../../lib/rounds/derive.ts";
import {
  ASSET,
  CUTOFF,
  feedReading,
  NOW,
  PLAYER,
  pool,
  position,
  ranges,
  round,
  SEED_ACCOUNT,
} from "../../lib/rounds/fixtures.ts";
import type {RoundData} from "../../lib/rounds/round.ts";
import {IDLE_TX_STATE} from "../../lib/tx/types.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {renderWithProviders} from "../../test/harness.tsx";
import {RoundDetail} from "./RoundDetail.tsx";

const asset = {
  asset: ASSET,
  symbol: "BNB",
  name: "BNB",
  decimals: 18n,
  native: true,
} as unknown as ManifestAsset;

const tx: TransactionHandle = {
  state: IDLE_TX_STATE,
  busy: false,
  send: () => Promise.resolve(IDLE_TX_STATE),
  reset: () => undefined,
};

function dataFor(overrides: Partial<RoundView>): RoundData {
  return {
    round: round(overrides),
    pool: pool(),
    feed: feedReading(),
    buysPaused: false,
    seedAccount: SEED_ACCOUNT,
    currentRoundId: 9n,
  };
}

function renderAt(
  overrides: Partial<RoundView>,
  options: {now?: bigint; position?: Position | null; entryPanel?: React.ReactNode} = {},
) {
  const data = dataFor(overrides);
  const now = options.now ?? NOW;
  const view = renderWithProviders(
    <MemoryRouter>
      <RoundDetail
        data={data}
        price={priceStateOf(data.round, data.feed, now)}
        now={now}
        account={PLAYER}
        position={
          options.position === undefined ? position({gross: 990_000_000_000_000_000n}) : options.position
        }
        asset={asset}
        ranges={ranges()}
        rangesError={null}
        lifecycleTx={tx}
        chainId={31_337n}
        explorerUrl={null}
        drawAddress="0x610178da211fef7d417bc0e6fed39f05609ad788"
        {...(options.entryPanel === undefined ? {} : {entryPanel: options.entryPanel})}
      />
    </MemoryRouter>,
  );
  return view;
}

/** The labels of every highlighted control on the page. SPEC §9.1 X3 allows exactly one. */
function primaryActions(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".button--primary")].map((node) => node.textContent?.trim() ?? "");
}

describe("the §9.6 state table", () => {
  it("Open before the cutoff: the entry panel is the only primary action", () => {
    const {container} = renderAt({}, {entryPanel: <p>entry panel</p>});
    expect(screen.getByText("entry panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Close round"})).not.toBeInTheDocument();
    // The mobile sheet's open control is the page's single primary; the panel supplies its own inside.
    expect(primaryActions(container)).toEqual(["Enter"]);
  });

  it("Open after the cutoff: Closing… with one Close round action", () => {
    const {container} = renderAt({}, {now: CUTOFF});
    expect(screen.getByText(/Closing…/)).toBeInTheDocument();
    expect(primaryActions(container)).toEqual(["Close round"]);
  });

  it("AwaitingRequest before the deadline: Request draw", () => {
    const {container} = renderAt(
      {state: State.AwaitingRequest, closedAt: NOW, requestDeadline: NOW + 86_400n},
      {now: NOW + 60n},
    );
    expect(primaryActions(container)).toEqual(["Request draw"]);
  });

  it("AwaitingRequest at the deadline: refunds are enabled instead", () => {
    const {container} = renderAt(
      {state: State.AwaitingRequest, closedAt: NOW, requestDeadline: NOW + 86_400n},
      {now: NOW + 86_400n},
    );
    expect(primaryActions(container)).toEqual(["Enable refunds"]);
    expect(screen.getByText(/24-hour request window has passed/)).toBeInTheDocument();
  });

  it("Drawing: the waiting copy with the request age and no action at all", () => {
    const {container} = renderAt({state: State.Drawing, requestedAt: NOW}, {now: NOW + 600n});
    expect(screen.getByText(/Waiting for verified randomness/)).toBeInTheDocument();
    expect(screen.getByText(/00:10:00 ago/)).toBeInTheDocument();
    expect(primaryActions(container)).toEqual([]);
  });

  it("Drawing after 24 hours: the §7.3 notice replaces the estimate", () => {
    renderAt({state: State.Drawing, requestedAt: NOW}, {now: NOW + 86_400n});
    expect(screen.getByText(/no result has arrived, so there is no estimate to give/)).toBeInTheDocument();
    // The client catalog's own DrawingDelayed note, not the page's standing §14 disclosures below it —
    // both mention the 7-day make-whole commitment, so this matches the sentence only the notice carries.
    expect(screen.getByText(/still waiting after 7 days/)).toBeInTheDocument();
  });

  it("Ready: Settle, with the verified calculation shown", () => {
    const {container} = renderAt({state: State.Ready, word0: 7n, word1: 9n});
    expect(primaryActions(container)).toEqual(["Settle round"]);
    expect(screen.getByText(/Balance credit pending settlement/)).toBeInTheDocument();
  });

  it("Settled: the winner, the prize and the fee, with no action", () => {
    const {container} = renderAt({
      state: State.Settled,
      winner: PLAYER,
      winningIndex: 5n,
      word0: 11n,
      word1: 12n,
    });
    expect(screen.getByText(/You won this round/)).toBeInTheDocument();
    expect(screen.getByText(/Prize credited to your LuckyDraw balance/)).toBeInTheDocument();
    expect(primaryActions(container)).toEqual([]);
  });

  it("Settled for someone else: Not selected with this account's share, never 'lost'", () => {
    renderAt({state: State.Settled, winner: SEED_ACCOUNT, winningIndex: 1n});
    expect(screen.getByText("Not selected")).toBeInTheDocument();
    expect(screen.getByText(/Your share was 99%/)).toBeInTheDocument();
    expect(screen.queryByText(/lost/i)).not.toBeInTheDocument();
  });

  it("Refunding: a Claim refund control while this account is not yet credited", () => {
    const {container} = renderAt({state: State.Refunding});
    expect(primaryActions(container)).toEqual(["Claim refund"]);
  });

  it("Refunding: 'Refund credited' and no control once the position says refunded", () => {
    const {container} = renderAt(
      {state: State.Refunding},
      {position: position({gross: 990_000_000_000_000_000n, refunded: true})},
    );
    expect(primaryActions(container)).toEqual([]);
    expect(screen.getAllByText(/Refund credited to your balance/).length).toBeGreaterThan(0);
  });

  it("Void: the seed-returned copy and no action", () => {
    const {container} = renderAt({state: State.Void, grossTotal: 10_000_000_000_000_000n}, {position: null});
    expect(screen.getAllByText(/operator seed was returned to the seed account/).length).toBeGreaterThan(0);
    expect(primaryActions(container)).toEqual([]);
  });
});

describe("the route to the round that is open now", () => {
  // SPEC §9.5: when another purchase reaches the target first "the app offers the new round". A player who
  // lost that race lands in AwaitingRequest, Ready or Refunding — every one of which offers a lifecycle
  // action — so the link has to survive alongside an action, not instead of it.
  const closedStates: readonly (readonly [string, Partial<RoundView>])[] = [
    [
      "AwaitingRequest before the deadline",
      {state: State.AwaitingRequest, requestDeadline: CUTOFF + 86_400n},
    ],
    ["AwaitingRequest at the deadline", {state: State.AwaitingRequest, requestDeadline: CUTOFF}],
    ["Drawing", {state: State.Drawing, requestedAt: NOW}],
    ["Ready", {state: State.Ready, word0: 7n, word1: 9n}],
    ["Settled", {state: State.Settled, winner: SEED_ACCOUNT, winningIndex: 1n}],
    ["Refunding", {state: State.Refunding}],
    ["Void", {state: State.Void}],
  ];

  for (const [name, overrides] of closedStates) {
    it(`offers the successor round in ${name}`, () => {
      renderAt({closedAt: CUTOFF, ...overrides}, {now: CUTOFF});
      expect(screen.getByRole("link", {name: "Go to the round that is open now"})).toHaveAttribute(
        "href",
        "/round/31337/9",
      );
    });
  }

  it("offers nothing while this round is itself the one that is open now", () => {
    renderAt({id: 9n, state: State.Refunding});
    expect(screen.queryByRole("link", {name: "Go to the round that is open now"})).not.toBeInTheDocument();
  });

  it("offers nothing while this round is Open", () => {
    renderAt({});
    expect(screen.queryByRole("link", {name: "Go to the round that is open now"})).not.toBeInTheDocument();
  });
});

describe("the round page's fixed content", () => {
  it("shows the pot, the 3% reserve and the prize that is the difference", () => {
    renderAt({});
    expect(screen.getByText("Pot entered")).toBeInTheDocument();
    expect(screen.getByText("3% fee reserve")).toBeInTheDocument();
    expect(screen.getByText("0.03 BNB")).toBeInTheDocument();
    expect(screen.getByText("0.97 BNB")).toBeInTheDocument();
  });

  it("labels the operator seed as one holders row, never an anonymous address", () => {
    renderAt({});
    expect(screen.getAllByText("Operator seed").length).toBeGreaterThan(0);
  });

  it("says a lone player's round still draws when it is seeded", () => {
    renderAt({});
    expect(
      screen.getByText(/No other player yet; the operator seed guarantees the draw/),
    ).toBeInTheDocument();
  });

  it("shows the four-step status timeline", () => {
    renderAt({});
    const timeline = screen.getByRole("list", {name: "Round status"});
    expect(timeline.querySelectorAll("li")).toHaveLength(4);
  });
});
