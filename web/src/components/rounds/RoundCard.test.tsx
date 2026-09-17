// What one pools card puts next to the money labels (SPEC §9.4, §5.2).
//
// The card shows two different totals on purpose, and the only way to keep them straight is to assert both:
// the prize is `prizePot` (gross minus the 3% reserve, §5.2) and the progress meter is the reference value of
// `grossTotal`, because §6.2 tests the gross against the target.

import type {ManifestAsset} from "@luckydraw/client";
import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {priceStateOf, targetProgressOf} from "../../lib/rounds/derive.ts";
import {ASSET, CUTOFF, feedReading, NOW, PRICE, pool, round} from "../../lib/rounds/fixtures.ts";
import type {PoolCard} from "../../lib/rounds/list.ts";
import {RoundCard} from "./RoundCard.tsx";

const asset = {
  asset: ASSET,
  symbol: "BNB",
  name: "BNB",
  decimals: 18n,
  native: true,
} as unknown as ManifestAsset;

/** The fixture round: 1 BNB gross, 0.03 BNB reserved, 0.97 BNB prize, priced at USD 600. */
function card(): PoolCard {
  const view = round();
  const feed = feedReading();
  return {
    key: "1:0",
    poolId: 1n,
    kind: 0,
    pool: pool(),
    asset,
    round: view,
    price: priceStateOf(view, feed, NOW),
    state: "active",
    targetUsd: view.targetUsd,
    progress: targetProgressOf(view, PRICE),
    closesAt: CUTOFF,
    position: null,
  };
}

function renderCard(overrides: Partial<PoolCard> = {}) {
  return render(
    <MemoryRouter>
      <RoundCard card={{...card(), ...overrides}} now={NOW} chainId={31_337n} />
    </MemoryRouter>,
  );
}

describe("the pools card's money labels", () => {
  it("shows the prize pot, not the gross, under the prize label", () => {
    renderCard();
    // prizePot = 1 BNB - 0.03 BNB. The gross never appears as an asset amount on the card.
    expect(screen.getByText("Prize pot")).toBeInTheDocument();
    expect(screen.getByText("0.97 BNB")).toBeInTheDocument();
    expect(screen.queryByText("1 BNB")).not.toBeInTheDocument();
  });

  it("converts the prize, not the gross, for the ≈ USD line", () => {
    renderCard();
    // 0.97 BNB at USD 600 is USD 582; the gross would have said 600.
    expect(screen.getByText("≈ USD 582")).toBeInTheDocument();
  });

  it("keeps the progress meter on the gross, which is what the target test uses", () => {
    renderCard();
    const meter = screen.getByRole("progressbar", {name: "Progress toward the USD 100 target"});
    expect(meter).toHaveAttribute("aria-valuetext", "≈ USD 600 of USD 100");
  });

  it("says the USD estimate is unavailable when the price reference is not usable", () => {
    renderCard({price: null, progress: null});
    expect(screen.getByText("0.97 BNB")).toBeInTheDocument();
    expect(screen.getByText(/USD estimate unavailable/)).toBeInTheDocument();
  });
});
