// The filter chips and the "How it works" steps: both remember their state locally (SPEC §9.4).

import type {ManifestAsset} from "@luckydraw/client";
import {fireEvent, render, screen} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";
import {ASSET, TOKEN} from "../../lib/rounds/fixtures.ts";
import {useHowItWorks, useStoredFilter} from "../../lib/rounds/prefs.ts";
import {FilterChips, HowItWorks} from "./HowItWorks.tsx";

const assets = [
  {asset: ASSET, symbol: "BNB", name: "BNB", decimals: 18n, native: true},
  {asset: TOKEN, symbol: "TEST2", name: "Test token", decimals: 2n, native: false},
] as unknown as readonly ManifestAsset[];

/** The page's own wiring in miniature: the stored filter plus the chips that write it. */
function Filters() {
  const {filter, setFilter} = useStoredFilter();
  return (
    <>
      <FilterChips assets={assets} filter={filter} onChange={setFilter} />
      <p data-testid="state">{`${filter.assets.join(",")}|${filter.kinds.join(",")}`}</p>
    </>
  );
}

function Steps() {
  const howItWorks = useHowItWorks();
  return howItWorks.shown ? <HowItWorks onDismiss={howItWorks.dismiss} /> : <p>dismissed</p>;
}

describe("filter chips", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts with everything selected", () => {
    render(<Filters />);
    expect(screen.getByTestId("state")).toHaveTextContent("|");
    expect(screen.getAllByRole("button", {name: "All", pressed: true})).toHaveLength(2);
  });

  it("toggles an asset and a tier, and says so through aria-pressed", () => {
    render(<Filters />);
    fireEvent.click(screen.getByRole("button", {name: "TEST2"}));
    fireEvent.click(screen.getByRole("button", {name: "Weekly · USD 1,000"}));
    expect(screen.getByTestId("state")).toHaveTextContent(`${TOKEN}|3`);
    expect(screen.getByRole("button", {name: "TEST2"})).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", {name: "TEST2"}));
    expect(screen.getByTestId("state")).toHaveTextContent("|3");
  });

  // ADR 036: seven tiers. One flat row of eight chips wrapped to five or six lines at 375 px, so the tier
  // chips are grouped into three labelled cadence rows and each chip shows only its target.
  it("groups the seven tier chips into three labelled cadence rows", () => {
    render(<Filters />);
    for (const cadence of ["Daily · USD", "Weekly · USD", "Monthly · USD"]) {
      expect(screen.getByText(cadence)).toBeInTheDocument();
    }
    // Visible text is the bare target; the accessible name still carries the cadence and the unit.
    expect(screen.getAllByText("1,000")).toHaveLength(2);
    expect(screen.getByRole("button", {name: "Daily · USD 1,000"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Monthly · USD 100,000"})).toBeInTheDocument();
  });

  it("keeps the two tiers that share a target independently selectable", () => {
    render(<Filters />);
    fireEvent.click(screen.getByRole("button", {name: "Daily · USD 1,000"}));
    expect(screen.getByTestId("state")).toHaveTextContent("|1");
    fireEvent.click(screen.getByRole("button", {name: "Weekly · USD 1,000"}));
    expect(screen.getByTestId("state")).toHaveTextContent("|1,3");
    expect(screen.getByRole("button", {name: "Weekly · USD 10,000"})).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("persists the choice and restores it on the next visit", () => {
    const first = render(<Filters />);
    fireEvent.click(screen.getByRole("button", {name: "BNB"}));
    fireEvent.click(screen.getByRole("button", {name: "Daily · USD 100"}));
    first.unmount();

    render(<Filters />);
    expect(screen.getByTestId("state")).toHaveTextContent(`${ASSET}|0`);
    expect(screen.getByRole("button", {name: "Daily · USD 100"})).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the how it works steps", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows three steps on a first visit and stays dismissed afterwards", () => {
    const first = render(<Steps />);
    expect(screen.getByText("1. Deposit")).toBeInTheDocument();
    expect(screen.getByText("2. Enter before the cutoff")).toBeInTheDocument();
    expect(screen.getByText("3. Winnings are credited")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {name: "Dismiss the how it works steps"}));
    expect(screen.getByText("dismissed")).toBeInTheDocument();
    first.unmount();

    render(<Steps />);
    expect(screen.getByText("dismissed")).toBeInTheDocument();
  });
});
