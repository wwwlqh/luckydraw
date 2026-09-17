// Building, sorting and filtering the `/` list, and the filter's local persistence (SPEC §9.4).

import type {Address, FeedReading, ManifestAsset, PoolView, RoundView} from "@luckydraw/client";
import {beforeEach, describe, expect, it} from "vitest";
import {KINDS} from "./derive.ts";
import {ASSET, CUTOFF, FEED, feedReading, NOW, PLAYER, pool, position, round, TOKEN} from "./fixtures.ts";
import {buildCards, cardKey, filterCards, sortByClosingSoonest} from "./list.ts";
import {parseFilter, serializeFilter, toggleValue} from "./prefs.ts";

const assets = [
  {asset: ASSET, symbol: "BNB", decimals: 18n, native: true, name: "BNB"},
  {asset: TOKEN, symbol: "TEST2", decimals: 2n, native: false, name: "Test token"},
] as unknown as readonly ManifestAsset[];

function scenario(): {
  pools: readonly PoolView[];
  rounds: Map<string, RoundView | null>;
  feeds: Map<Address, FeedReading>;
} {
  const bnb = pool();
  const token = pool({id: 2n, asset: TOKEN});
  // Seven sequences per pool (ADR 036). Every tier has a card; only three of them have an open round.
  const rounds = new Map<string, RoundView | null>();
  for (const poolId of [1n, 2n]) {
    for (const kind of KINDS) rounds.set(cardKey(poolId, kind), null);
  }
  // The BNB Day100 round closes soonest, then the TEST2 Day100 one, then the BNB Week1k one.
  rounds.set(cardKey(1n, 0), round({id: 1n, kind: 0, closesAt: CUTOFF}));
  rounds.set(cardKey(1n, 3), round({id: 2n, kind: 3, closesAt: CUTOFF + 600_000n, targetUsd: 1_000n}));
  rounds.set(cardKey(2n, 0), round({id: 4n, poolId: 2n, kind: 0, asset: TOKEN, closesAt: CUTOFF + 10n}));
  return {pools: [bnb, token], rounds, feeds: new Map([[FEED, feedReading()]])};
}

describe("buildCards", () => {
  it("builds one card per pool and kind and keeps the tier's own target", () => {
    const {pools, rounds, feeds} = scenario();
    const cards = buildCards({pools, rounds, feeds, assets, buysPaused: false, now: NOW});
    expect(cards).toHaveLength(14);
    expect(cards.map((card) => card.key)).toContain("1:2");
    // A tier with no open round falls back to the pool's configured target for that kind.
    expect(cards.find((card) => card.key === "1:2")?.targetUsd).toBe(10_000n);
    expect(cards.find((card) => card.key === "1:5")?.targetUsd).toBe(100_000n);
    expect(cards.find((card) => card.key === "1:6")?.targetUsd).toBe(100_000n);
    expect(cards.find((card) => card.key === "1:3")?.targetUsd).toBe(1_000n);
  });

  it("attaches the manifest asset, the price state and the connected account's position", () => {
    const {pools, rounds, feeds} = scenario();
    const positions = new Map([[cardKey(1n, 0), position({gross: 5n})]]);
    const cards = buildCards({pools, rounds, feeds, assets, buysPaused: false, now: NOW, positions});
    const daily = cards.find((card) => card.key === "1:0");
    expect(daily?.asset?.symbol).toBe("BNB");
    expect(daily?.price?.class).toBe("ok");
    expect(daily?.position?.gross).toBe(5n);
    expect(daily?.state).toBe("active");
  });

  it("marks every card unavailable while the global buy stop is set", () => {
    const {pools, rounds, feeds} = scenario();
    const cards = buildCards({pools, rounds, feeds, assets, buysPaused: true, now: NOW});
    expect(cards.filter((card) => card.round !== null).every((card) => card.state === "unavailable")).toBe(
      true,
    );
  });
});

describe("sortByClosingSoonest", () => {
  it("sorts by cutoff and puts tiers without an open round last", () => {
    const {pools, rounds, feeds} = scenario();
    const cards = sortByClosingSoonest(
      buildCards({pools, rounds, feeds, assets, buysPaused: false, now: NOW}),
    );
    expect(cards.map((card) => card.key)).toEqual([
      "1:0",
      "2:0",
      "1:3",
      "1:1",
      "1:2",
      "1:4",
      "1:5",
      "1:6",
      "2:1",
      "2:2",
      "2:3",
      "2:4",
      "2:5",
      "2:6",
    ]);
  });
});

describe("filterCards", () => {
  it("filters by asset, by tier, and by both, with an empty set meaning all", () => {
    const {pools, rounds, feeds} = scenario();
    const cards = buildCards({pools, rounds, feeds, assets, buysPaused: false, now: NOW});
    expect(filterCards(cards, {assets: [], kinds: []})).toHaveLength(14);
    expect(filterCards(cards, {assets: [TOKEN], kinds: []})).toHaveLength(7);
    expect(filterCards(cards, {assets: [], kinds: [0]})).toHaveLength(2);
    expect(filterCards(cards, {assets: [ASSET], kinds: [3]}).map((card) => card.key)).toEqual(["1:3"]);
  });
});

describe("the filter's local persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips through local storage", () => {
    const filter = {assets: [TOKEN], kinds: [1 as const]};
    const text = serializeFilter(filter);
    window.localStorage.setItem("luckydraw.pools.filter.v1", text);
    expect(parseFilter(window.localStorage.getItem("luckydraw.pools.filter.v1"))).toEqual(filter);
  });

  it("treats anything unexpected as no filter rather than throwing", () => {
    expect(parseFilter(null)).toEqual({assets: [], kinds: []});
    expect(parseFilter("not json")).toEqual({assets: [], kinds: []});
    expect(parseFilter('{"assets":["nope",7],"kinds":[9,"x"]}')).toEqual({assets: [], kinds: []});
  });

  it("toggles one chip at a time", () => {
    expect(toggleValue([], PLAYER)).toEqual([PLAYER]);
    expect(toggleValue([PLAYER], PLAYER)).toEqual([]);
  });
});
