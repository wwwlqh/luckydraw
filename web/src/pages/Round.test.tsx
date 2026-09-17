// The round page's wiring: which snapshot each surface reads its clock from (SPEC §10.1, §9.5).
//
// The page holds two reads at two different blocks on purpose. The display reads (the header, the pot, the
// timeline, the freshness label) share one pinned block; the entry panel's read opts out of that pin because
// a quote must come from the head ("buy, withdraw and claim act on the latest on-chain state", §9.6). Each
// therefore needs its own chain clock: judging the panel's price age or its remaining time by the display
// block's timestamp mixes two blocks inside one set of disclosures, and at any real lag it can call an
// observation fresh that the contract would already reject.
//
// `useSnapshot` is the seam this test replaces, because the question is which snapshot reaches which surface,
// not how a snapshot is fetched — the read adapters have their own tests in `@luckydraw/client`.

import type {Snapshot} from "@luckydraw/client";
import {screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {entryPanel, feedReading, NOW, pool, ranges, round, SEED_ACCOUNT} from "../lib/rounds/fixtures.ts";
import type {RoundData} from "../lib/rounds/round.ts";
import {renderWithProviders} from "../test/harness.tsx";

/** Snapshots keyed exactly as `Round.tsx` keys its reads; a missing key answers as an idle read. */
const scripted = new Map<string, Snapshot<unknown>>();

function snapshotOf<T>(value: T, timestamp: bigint, blockNumber: bigint): Snapshot<T> {
  return {
    chainId: 31_337n,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    timestamp,
    confidence: {tag: "latest", depth: 0n},
    value,
  };
}

vi.mock("../lib/data/useSnapshot.ts", () => ({
  useSnapshot: (key: string) => {
    const snapshot = scripted.get(key) ?? null;
    return {
      status: snapshot === null ? "idle" : "ready",
      snapshot,
      value: snapshot?.value ?? null,
      error: null,
      refresh: () => undefined,
    };
  },
}));

const {default: Round} = await import("./Round.tsx");

/** The cutoff is one minute after the panel's block and eleven minutes after the display block. */
const CLOSES_AT = NOW + 60n;
/** Older than both clocks, so the observation is usable at either and only its *age* differs. */
const UPDATED_AT = NOW - 900n;

function script(): void {
  const view = round({closesAt: CLOSES_AT});
  const feed = feedReading({observation: {roundId: 42n, answer: 60_000_000_000n, updatedAt: UPDATED_AT}});
  const data: RoundData = {
    round: view,
    pool: pool(),
    feed,
    buysPaused: false,
    seedAccount: SEED_ACCOUNT,
    currentRoundId: 1n,
  };
  scripted.clear();
  // The display block is ten minutes behind the head the panel reads at.
  scripted.set("round", snapshotOf(data, NOW - 600n, 100n));
  scripted.set("round:ranges", snapshotOf(ranges(), NOW - 600n, 100n));
  scripted.set(
    "round:entry",
    snapshotOf(
      entryPanel(0n, {round: {closesAt: CLOSES_AT}, feed: {observation: feed.observation}}),
      NOW,
      140n,
    ),
  );
}

function renderRound(path = "/round/31337/1") {
  return renderWithProviders(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/round/:chainId/:roundId" element={<Round />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the round page's two clocks", () => {
  beforeEach(() => script());

  it("dates the entry panel's price against the block the panel itself was read at", () => {
    renderRound();
    // 900 seconds against the panel's block; the display block would date the same observation at 300.
    expect(screen.getByText(/Reference price is 900 s old/)).toBeInTheDocument();
    expect(screen.queryByText(/Reference price is 300 s old/)).toBeNull();
  });

  it("counts the panel's remaining time from the panel's block", () => {
    renderRound();
    // One minute to the cutoff at the panel's block, eleven at the display block: only the panel's clock
    // raises the final-120-seconds warning of SPEC §9.5.
    expect(screen.getByText(/A transaction included after the cutoff reverts/)).toBeInTheDocument();
  });
});

describe("a link for another chain", () => {
  beforeEach(() => script());

  it("names the pinned chain the way a player would recognise it, not by its slug", () => {
    // The build under test is the local one, so a /round/56/... link is for another chain entirely. The
    // sentence must call the pinned chain what the app calls it everywhere else (`displayName`); the slug
    // is an internal identifier and would read as a different network to a player.
    renderRound("/round/56/1");
    const body = document.body.textContent ?? "";
    expect(screen.getByText(/This link is for chain 56/)).toBeInTheDocument();
    expect(body).toContain("Local anvil");
    expect(body).not.toContain("anvil-local");
  });
});
