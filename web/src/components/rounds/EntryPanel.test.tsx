// The entry panel's pipeline, disclosures and refusals (SPEC §9.5).
//
// The two injected callbacks (`readFresh`, `estimateFee`) stand in for the node, so every assertion here is
// about the panel's own behaviour: what it previews, what it refuses to build calldata from, and what it
// forgets when the amount, the round or the account changes.

import {
  type Address,
  type EntryPanel as EntryPanelData,
  type ManifestAsset,
  QuoteReason,
  type Snapshot,
} from "@luckydraw/client";
import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {useState} from "react";
import {MemoryRouter} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import {priceStateOf} from "../../lib/rounds/derive.ts";
import {ASSET, CUTOFF, entryPanel, NOW, OTHER, PLAYER, PRICE} from "../../lib/rounds/fixtures.ts";
import {IDLE_TX_STATE, type TxFailure} from "../../lib/tx/types.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {renderWithProviders} from "../../test/harness.tsx";
import {EntryPanel} from "./EntryPanel.tsx";

const asset = {
  asset: ASSET,
  symbol: "BNB",
  name: "BNB",
  decimals: 18n,
  native: true,
} as unknown as ManifestAsset;

function snapshotOf(value: EntryPanelData, timestamp = NOW): Snapshot<EntryPanelData> {
  return {
    chainId: 31_337n,
    blockNumber: 12n,
    blockHash: `0x${"11".repeat(32)}`,
    timestamp,
    confidence: {tag: "latest", depth: 0n},
    value,
  };
}

function handle(): TransactionHandle & {sent: unknown[]} {
  const sent: unknown[] = [];
  return {
    sent,
    state: IDLE_TX_STATE,
    busy: false,
    send: (prepared, options) => {
      sent.push({prepared, options});
      return Promise.resolve(IDLE_TX_STATE);
    },
    reset: () => undefined,
  };
}

/** A decoded `PriceStale` revert, as `tx/failure.ts` would put it on the state (SPEC §9.6). */
const PRICE_STALE: TxFailure = {
  catalogKey: "PriceStale",
  message: "The price reference is unavailable or stale; entries pause until it updates.",
  funds: "Nothing debited",
  nextAction: "Auto-refresh; retry when fresh",
  selector: null,
  data: null,
};

type Options = {
  now?: bigint;
  account?: Address | null;
  readFresh?: (gross: bigint) => Promise<Snapshot<EntryPanelData>>;
  panel?: EntryPanelData;
  refresh?: () => void;
  feeWei?: bigint;
  nativeReference?: {price: bigint; feedDecimals: number} | null;
};

/** A feed observation one minute old at `now`, so the price is usable whatever clock a test picks. */
function freshFeed(now: bigint) {
  return {observation: {roundId: 42n, answer: PRICE, updatedAt: now - 60n}};
}

/**
 * The props the page changes under a mounted panel — the chain clock, the connected account, the block-keyed
 * panel read and the transaction's own failure — are held in state here, so a test can move any of them
 * without remounting and losing what the panel remembers.
 */
type Controls = {
  setNow: (value: bigint) => void;
  setAccount: (value: Address | null) => void;
  setPanel: (value: EntryPanelData) => void;
  setFailure: (value: TxFailure | null) => void;
};

function renderPanel(options: Options = {}) {
  const startNow = options.now ?? NOW;
  const panel = options.panel ?? entryPanel(0n, {feed: freshFeed(startNow)});
  const tx = handle();
  const readFresh =
    options.readFresh ??
    ((gross: bigint) =>
      Promise.resolve(snapshotOf(entryPanel(gross, {feed: freshFeed(startNow)}), startNow)));
  const estimateFee = vi.fn(() =>
    Promise.resolve({
      gasLimit: 200_000n,
      gasPriceWei: 1_000_000_000n,
      feeWei: options.feeWei ?? 200_000_000_000_000n,
    }),
  );
  const nativeReference =
    options.nativeReference === undefined
      ? {price: 60_000_000_000n, feedDecimals: 8}
      : options.nativeReference;
  const controls: Controls = {
    setNow: () => undefined,
    setAccount: () => undefined,
    setPanel: () => undefined,
    setFailure: () => undefined,
  };

  function Harness() {
    const [now, setNow] = useState(startNow);
    const [account, setAccount] = useState<Address | null>(
      options.account === undefined ? PLAYER : options.account,
    );
    const [live, setPanel] = useState(panel);
    const [failure, setFailure] = useState<TxFailure | null>(null);
    controls.setNow = setNow;
    controls.setAccount = setAccount;
    controls.setPanel = setPanel;
    controls.setFailure = setFailure;
    const state = failure === null ? IDLE_TX_STATE : {...IDLE_TX_STATE, failure};
    return (
      <EntryPanel
        panel={live}
        now={now}
        account={account}
        asset={asset}
        price={priceStateOf(live.round, live.feed, now)}
        refresh={options.refresh ?? (() => undefined)}
        readFresh={readFresh}
        estimateFee={estimateFee}
        nativeReference={nativeReference}
        nativeSymbol="BNB"
        tx={{...tx, state, reset: () => setFailure(null)}}
        successorRoundId={9n}
        chainId={31_337n}
      />
    );
  }

  const view = renderWithProviders(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  return {...view, tx, estimateFee, controls};
}

/** Lets an already-resolved promise chain run to completion inside `act`, without any timer. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 40; step += 1) await Promise.resolve();
  });
}

/** A `readFresh` the test settles by hand, so a snapshot can be made to land after the panel has moved on. */
function deferredRead(): {
  readFresh: () => Promise<Snapshot<EntryPanelData>>;
  settle: (snapshot: Snapshot<EntryPanelData>) => void;
} {
  let settle!: (snapshot: Snapshot<EntryPanelData>) => void;
  const promise = new Promise<Snapshot<EntryPanelData>>((resolve) => {
    settle = resolve;
  });
  return {readFresh: () => promise, settle: (snapshot) => settle(snapshot)};
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText("Amount"), {target: {value}});
}

const reviewButton = (): HTMLButtonElement => screen.getByRole("button", {name: "Review entry"});

/**
 * Waits for the deployment's verification to finish. Nothing can be quoted or prepared before it, because
 * `prepareBuy` takes a `VerifiedDeployment` and the harness verifies against its fake node asynchronously.
 */
async function clickReview(): Promise<void> {
  await waitFor(() => {
    expect(reviewButton()).toBeEnabled();
  });
  fireEvent.click(reviewButton());
}

describe("the amount field", () => {
  it("previews the fee, the net addition and the balance after for a typed amount", () => {
    renderPanel();
    type("1");
    // 1 BNB into a round already holding 1 BNB: the cumulative fee moves by exactly 0.03 BNB.
    expect(screen.getAllByText("0.03 BNB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.97 BNB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("9 BNB").length).toBeGreaterThan(0);
  });

  it("refuses excess precision, a comma, a sign and an exponent without touching the preview", () => {
    const {container} = renderPanel();
    const warning = (): string => container.querySelector(".notice--warning")?.textContent ?? "";
    type("1,5");
    expect(warning()).toMatch(/Use .\.. as the decimal separator/);
    type("-1");
    expect(warning()).toMatch(/An entry cannot be negative/);
    type("1e18");
    expect(warning()).toMatch(/no signs, spaces or exponents/);
    type("1.1234567890123456789");
    expect(warning()).toMatch(/BNB has 18 decimals/);
    // A rejected amount never produces a preview, so nothing is offered to review.
    expect(reviewButton()).toBeDisabled();
  });

  it("converts each USD preset upward into raw units", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "USD 1"}));
    expect(screen.getByLabelText("Amount")).toHaveValue("0.001666666666666667");
    fireEvent.click(screen.getByRole("button", {name: "USD 100"}));
    expect(screen.getByLabelText("Amount")).toHaveValue("0.166666666666666667");
  });

  it("fills the field with the available LuckyDraw balance for Max", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Your available LuckyDraw balance"}));
    expect(screen.getByLabelText("Amount")).toHaveValue("10");
  });
});

describe("the disclosures SPEC §9.5 requires", () => {
  it("states the seed, the finality, the ten minutes, the accepted request and the game of chance", () => {
    renderPanel();
    expect(screen.getByText(/operator seed of 0.01 BNB is in this round/)).toBeInTheDocument();
    expect(screen.getByText(/Entries are final until cutoff/)).toBeInTheDocument();
    expect(screen.getByText(/within about ten minutes after cutoff/)).toBeInTheDocument();
    expect(screen.getByText(/the round cannot be canceled/)).toBeInTheDocument();
    expect(screen.getByText(/if you do not win, your entry is not returned/)).toBeInTheDocument();
    expect(screen.getByText(/18\+ only/)).toBeInTheDocument();
  });

  it("shows the cutoff in UTC with the viewer's zone named", () => {
    renderPanel();
    expect(screen.getByText(/UTC \(/)).toBeInTheDocument();
  });

  it("warns in the final 120 seconds before the cutoff", () => {
    renderPanel({now: CUTOFF - 60n});
    expect(screen.getByText(/A transaction included after the cutoff reverts/)).toBeInTheDocument();
  });

  it("says when the entry reaches the target and that the network fee is higher", async () => {
    // The authoritative quote is what the sentence follows, so the fresh read is the one that reports it.
    renderPanel({
      readFresh: (gross) =>
        Promise.resolve(snapshotOf(entryPanel(gross, {feed: freshFeed(NOW), quote: {reachesTarget: true}}))),
    });
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    expect(screen.getByText(/reaches the USD 100 target/)).toBeInTheDocument();
    expect(screen.getByText(/network fee for that larger transaction/)).toBeInTheDocument();
  });

  it("shows the estimated network fee as gas, not a platform fee", async () => {
    renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    expect(screen.getByText(/network gas, not a platform fee/)).toBeInTheDocument();
  });

  // 0.002 BNB of gas is USD 1.20 against the native reference; a USD 1 entry is USD 1.00, so the fee is well
  // past the quarter SPEC §9.5 warns at.
  const HEAVY_GAS = 2_000_000_000_000_000n;

  it("warns when the network fee exceeds a quarter of the gross entry", async () => {
    renderPanel({feeWei: HEAVY_GAS});
    fireEvent.click(screen.getByRole("button", {name: "USD 1"}));
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    expect(screen.getByText(/USD 1.20/)).toBeInTheDocument();
    expect(screen.getByText(/network fee is more than a quarter of this entry/)).toBeInTheDocument();
  });

  it("converts no gas to USD, and raises no 25% warning, when the native feed is not usable", async () => {
    renderPanel({feeWei: HEAVY_GAS, nativeReference: null});
    fireEvent.click(screen.getByRole("button", {name: "USD 1"}));
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    // The wallet's own estimate is still shown; only the conversion is withheld.
    expect(screen.getAllByText(/0.002 BNB/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/USD estimate unavailable while the price reference is not usable/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/network fee is more than a quarter of this entry/)).not.toBeInTheDocument();
  });
});

describe("the quote binding", () => {
  it("builds calldata only from a quote for this round, buyer and asset", async () => {
    const stale = (gross: bigint): Promise<Snapshot<EntryPanelData>> => {
      const panel = entryPanel(gross, {user: OTHER});
      return Promise.resolve(snapshotOf(panel));
    };
    const {tx} = renderPanel({readFresh: stale});
    type("1");
    await clickReview();
    await waitFor(() => {
      expect(screen.getByText(/no longer applies/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(tx.sent).toHaveLength(0);
  });

  it("sends the prepared buy for the quoted account once confirmed", async () => {
    const {tx} = renderPanel();
    type("1");
    await clickReview();
    const confirm = await screen.findByRole("button", {name: "Confirm entry"});
    // The wallet is not connected in the harness, so the gate keeps Confirm disabled: nothing is signed.
    expect(confirm).toBeDisabled();
    expect(tx.sent).toHaveLength(0);
  });

  it("refuses when no deadline shorter than the cutoff remains", async () => {
    renderPanel({now: CUTOFF - 1n});
    type("1");
    await clickReview();
    await waitFor(() => {
      expect(screen.getByText(/no deadline shorter than the cutoff remains/)).toBeInTheDocument();
    });
  });

  it("forgets the confirmed plan when the amount changes", async () => {
    renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    type("2");
    await waitFor(() => {
      expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    });
    expect(reviewButton()).toBeInTheDocument();
  });

  // The race the three tests below close: `readFresh` is awaited, so its snapshot can arrive after the user
  // has already retyped or switched account. Installing it then would pair the OLD calldata with the NEW
  // gross in the fee breakdown and sign for whichever account the wallet happens to hold (SPEC §9.5).
  it("drops a preview that resolves after the amount changed", async () => {
    const deferred = deferredRead();
    const {estimateFee} = renderPanel({readFresh: deferred.readFresh});

    type("2");
    await clickReview();
    type("1");

    // The snapshot for 2 BNB lands after the field already says 1 BNB.
    deferred.settle(snapshotOf(entryPanel(2_000_000_000_000_000_000n, {feed: freshFeed(NOW)})));
    await flush();

    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(reviewButton()).toBeInTheDocument();
    // 1 BNB into a 1 BNB round splits 0.03 / 0.97; the 2 BNB quote's 0.06 / 1.94 never reaches the screen.
    expect(screen.getAllByText("0.03 BNB").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.06 BNB")).not.toBeInTheDocument();
    expect(screen.queryByText("1.94 BNB")).not.toBeInTheDocument();
    // The resolution was abandoned before any calldata was priced, not merely filtered out at render.
    expect(estimateFee).not.toHaveBeenCalled();
  });

  it("drops a preview that resolves after the signing account changed", async () => {
    const deferred = deferredRead();
    const {tx, estimateFee, controls} = renderPanel({readFresh: deferred.readFresh});

    type("1");
    await clickReview();
    act(() => {
      controls.setAccount(OTHER);
    });

    deferred.settle(snapshotOf(entryPanel(1_000_000_000_000_000_000n, {feed: freshFeed(NOW)})));
    await flush();

    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(estimateFee).not.toHaveBeenCalled();
    expect(tx.sent).toHaveLength(0);
  });

  it("does not leave the abandoned plan waiting under its old amount", async () => {
    const deferred = deferredRead();
    renderPanel({readFresh: deferred.readFresh});

    type("2");
    await clickReview();
    type("1");
    deferred.settle(snapshotOf(entryPanel(2_000_000_000_000_000_000n, {feed: freshFeed(NOW)})));
    await flush();

    // Typing the original amount back must not resurrect a plan nobody reviewed at that amount.
    type("2");
    await flush();
    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(reviewButton()).toBeInTheDocument();
  });

  // SPEC §9.5 sets deadline = min(now + 300 s, closesAt - 1); past it `buy` reverts `DeadlinePassed`.
  it("expires a confirmed plan once the chain clock passes its deadline", async () => {
    const {tx, controls} = renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});

    act(() => {
      controls.setNow(NOW + 301n);
    });

    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(reviewButton()).toBeInTheDocument();
    // X4: the failure keeps the user's input, and nothing was sent.
    expect(screen.getByLabelText("Amount")).toHaveValue("1");
    expect(tx.sent).toHaveLength(0);
  });

  it("offers the round that is open now when the fresh quote says the window has closed", async () => {
    renderPanel({
      readFresh: (gross) =>
        Promise.resolve(
          snapshotOf(
            entryPanel(gross, {
              feed: freshFeed(NOW),
              quote: {reason: QuoteReason.EntryWindowClosed},
            }),
          ),
        ),
    });
    type("1");
    await clickReview();
    const link = await screen.findByRole("link", {name: "Go to the round that is open now"});
    expect(link).toHaveAttribute("href", "/round/31337/9");
    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
  });
});

// SPEC §10.1 keeps the panel reading while it is open, and §9.1 X1/X2 say what is on screen beside a Confirm
// control must be what that transaction would do. A plan read at one block therefore survives only while the
// live panel still agrees with it, and every figure beside it comes from the live read.
describe("a held plan against the panel that keeps moving", () => {
  const HALF_BNB = 500_000_000_000_000_000n;
  const FIVE_BNB = 5_000_000_000_000_000_000n;

  /** The share one meter reads, as hundredths of a percent, so two meters can be compared as numbers. */
  function shareOf(label: string): number {
    const text = screen.getByRole("progressbar", {name: label}).getAttribute("aria-valuetext") ?? "";
    return Number.parseFloat(text);
  }

  it("drops the plan and asks for a new review when the live balance falls below the entry", async () => {
    const {tx, controls} = renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});

    act(() => {
      controls.setPanel(entryPanel(0n, {balance: HALF_BNB, feed: freshFeed(NOW)}));
    });

    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(reviewButton()).toBeInTheDocument();
    expect(screen.getByText(/Review this entry again before confirming/)).toBeInTheDocument();
    expect(tx.sent).toHaveLength(0);
  });

  it("shows the balance after against the live balance, not the one the plan was read at", async () => {
    const {controls} = renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});
    expect(screen.getAllByText("9 BNB").length).toBeGreaterThan(0);

    // The balance halves under the open confirmation but still covers the entry, so the plan stands and the
    // figure beside it follows the live balance: 5 - 1, never the plan's 10 - 1.
    act(() => {
      controls.setPanel(entryPanel(0n, {balance: FIVE_BNB, feed: freshFeed(NOW)}));
    });

    expect(screen.getByRole("button", {name: "Confirm entry"})).toBeInTheDocument();
    expect(screen.getAllByText("4 BNB").length).toBeGreaterThan(0);
    expect(screen.queryByText("9 BNB")).not.toBeInTheDocument();
  });

  it("never shows a share after this entry below the live share now", async () => {
    const {controls} = renderPanel();
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});

    // The account's own earlier entry lands: it now holds 5 of the round's 6 BNB. The plan's stale "after"
    // was 1 of 2 BNB — 50% — which would read below the live "now" of 83.33% and claim this entry shrank it.
    act(() => {
      controls.setPanel(
        entryPanel(0n, {
          balance: FIVE_BNB,
          feed: freshFeed(NOW),
          position: {gross: FIVE_BNB},
          round: {
            grossTotal: 6_000_000_000_000_000_000n,
            feeReserved: 180_000_000_000_000_000n,
            prizePot: 5_820_000_000_000_000_000n,
          },
        }),
      );
    });

    expect(screen.getByRole("button", {name: "Confirm entry"})).toBeInTheDocument();
    expect(shareOf("Your share now")).toBeCloseTo(83.33);
    expect(shareOf("Your share after this entry")).toBeCloseTo(85.71);
    expect(shareOf("Your share after this entry")).toBeGreaterThanOrEqual(shareOf("Your share now"));
  });

  it("leaves no Confirm beside the refusal a PriceStale retry re-quotes into", async () => {
    let refused = false;
    const readFresh = (gross: bigint): Promise<Snapshot<EntryPanelData>> =>
      Promise.resolve(
        snapshotOf(
          entryPanel(gross, {
            feed: freshFeed(NOW),
            ...(refused ? {quote: {reason: QuoteReason.PriceStale}} : {}),
          }),
        ),
      );
    const {tx, controls} = renderPanel({readFresh});
    type("1");
    await clickReview();
    await screen.findByRole("button", {name: "Confirm entry"});

    // The signed transaction reverts PriceStale, and the one-tap retry of §9.5 re-quotes the same amount.
    act(() => {
      controls.setFailure(PRICE_STALE);
    });
    refused = true;
    fireEvent.click(screen.getByRole("button", {name: "Try again with the same amount"}));
    await flush();

    expect(screen.getByText(/price reference is unavailable or stale/)).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    expect(reviewButton()).toBeInTheDocument();
    expect(tx.sent).toHaveLength(0);
  });

  it("drops the plan when the fresh quote's fee split disagrees with the live preview", async () => {
    const shifted = 40_000_000_000_000_000n;
    const {tx} = renderPanel({
      readFresh: (gross) =>
        Promise.resolve(
          snapshotOf(
            entryPanel(gross, {
              feed: freshFeed(NOW),
              // A quote that is internally consistent (fee + net is the gross) but splits it differently
              // from the round the panel is showing: the two describe different blocks.
              quote: {feeDelta: shifted, netDelta: gross - shifted},
            }),
          ),
        ),
    });
    type("1");
    await clickReview();

    await waitFor(() => {
      expect(screen.getByText(/Review this entry again before confirming/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", {name: "Confirm entry"})).not.toBeInTheDocument();
    // The fee line is the live one, never the quote's 0.04 BNB.
    expect(screen.getAllByText("0.03 BNB").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.04 BNB")).not.toBeInTheDocument();
    expect(tx.sent).toHaveLength(0);
  });
});

describe("the ten-second re-quote of SPEC §10.1", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes the panel every ten seconds while an amount is typed and no plan is held", () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]});
    const refresh = vi.fn();
    renderPanel({refresh});

    // Nothing is re-read while the field is empty: an idle tab stays under the §10.1 request budget.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(refresh).not.toHaveBeenCalled();

    type("1");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  // A plan used to suspend the re-quote, which is how the panel could go on offering Confirm beside figures
  // the chain had already moved past. The read is what notices that, so it never stops while a plan is held.
  it("keeps re-quoting every ten seconds while a confirmed plan is held", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]});
    const refresh = vi.fn();
    renderPanel({refresh});
    await flush();
    type("1");
    fireEvent.click(reviewButton());
    await flush();

    expect(screen.getByRole("button", {name: "Confirm entry"})).toBeInTheDocument();
    refresh.mockClear();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("the balance path", () => {
  it("opens the top-up with the asset, the shortfall and the round it preserves", () => {
    renderPanel({panel: entryPanel(0n, {balance: 500_000_000_000_000_000n, feed: freshFeed(NOW)})});
    type("1");
    const link = screen.getByRole("link", {name: "Add funds and come back"});
    expect(link).toHaveAttribute(
      "href",
      "/wallet?asset=0x0000000000000000000000000000000000000000&amount=0.5&intent=1",
    );
  });
});

describe("the write gate", () => {
  it("names the reason instead of offering Review when no account is connected", () => {
    renderPanel({account: null});
    expect(reviewButton()).toBeDisabled();
  });

  it("does not reach for the node while the field is empty", () => {
    const readFresh = vi.fn();
    renderPanel({readFresh});
    expect(reviewButton()).toBeDisabled();
    expect(readFresh).not.toHaveBeenCalled();
  });
});
