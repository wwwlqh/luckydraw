// The §9.6 state table, the §9.4 card states and the §9.7 countdown thresholds, as pure functions.

import {State} from "@luckydraw/client";
import {describe, expect, it} from "vitest";
import {
  announceOn,
  cardStateOf,
  coarseRemaining,
  countdownBucket,
  entriesOpen,
  lifecycleOf,
  nativeReferenceOf,
  playersExcludingSeed,
  priceStateOf,
  remainingSeconds,
  shortCutoffLabel,
  targetProgressOf,
  timelineOf,
} from "./derive.ts";
import {CUTOFF, feedReading, NOW, PRICE, pool, round} from "./fixtures.ts";

describe("lifecycleOf", () => {
  it("offers Enter while the round is open before its cutoff", () => {
    const life = lifecycleOf(round(), NOW);
    expect(life.catalogKey).toBe("Open");
    expect(life.action).toBe("enter");
  });

  it("offers Close round once the cutoff has passed", () => {
    const life = lifecycleOf(round(), CUTOFF);
    expect(life.catalogKey).toBe("OpenAfterCutoff");
    expect(life.action).toBe("close");
  });

  it("offers Request draw before the request deadline", () => {
    const life = lifecycleOf(
      round({state: State.AwaitingRequest, closedAt: NOW, requestDeadline: NOW + 86_400n}),
      NOW + 60n,
    );
    expect(life.catalogKey).toBe("AwaitingRequest");
    expect(life.action).toBe("request");
  });

  it("offers expiry into refunds at the deadline", () => {
    const life = lifecycleOf(
      round({state: State.AwaitingRequest, closedAt: NOW, requestDeadline: NOW + 86_400n}),
      NOW + 86_400n,
    );
    expect(life.catalogKey).toBe("AwaitingRequestExpired");
    expect(life.action).toBe("expire");
  });

  it("offers no action while drawing, and switches to the waiting notice after 24 hours", () => {
    const drawing = round({state: State.Drawing, requestedAt: NOW});
    expect(lifecycleOf(drawing, NOW + 600n)).toMatchObject({
      catalogKey: "Drawing",
      action: null,
      delayed: false,
    });
    const late = lifecycleOf(drawing, NOW + 86_400n);
    expect(late.catalogKey).toBe("DrawingDelayed");
    expect(late.delayed).toBe(true);
    expect(late.requestAgeSeconds).toBe(86_400n);
  });

  it("offers Settle when ready and nothing once settled", () => {
    expect(lifecycleOf(round({state: State.Ready}), NOW).action).toBe("settle");
    expect(lifecycleOf(round({state: State.Settled}), NOW).action).toBeNull();
  });

  it("offers Claim refund only to an unrefunded buyer", () => {
    const refunding = round({state: State.Refunding});
    expect(lifecycleOf(refunding, NOW, {hasPosition: true, refunded: false}).action).toBe("claim");
    expect(lifecycleOf(refunding, NOW, {hasPosition: true, refunded: true}).action).toBeNull();
    expect(lifecycleOf(refunding, NOW, {hasPosition: false, refunded: false}).action).toBeNull();
  });

  it("offers nothing on a void round", () => {
    expect(lifecycleOf(round({state: State.Void}), NOW)).toMatchObject({catalogKey: "Void", action: null});
  });
});

describe("timelineOf", () => {
  it("marks open as current while the round is open", () => {
    expect(timelineOf(round()).map((step) => step.status)).toEqual([
      "current",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("marks the request as current while drawing", () => {
    const steps = timelineOf(round({state: State.Drawing}));
    expect(steps[0]?.status).toBe("done");
    expect(steps[2]?.status).toBe("current");
  });

  it("marks every step done once settled", () => {
    expect(timelineOf(round({state: State.Settled})).every((step) => step.status === "done")).toBe(true);
  });
});

describe("card state", () => {
  const price = priceStateOf(round(), feedReading(), NOW);

  it("is active for an open, priced, unpaused pool", () => {
    expect(cardStateOf(round(), pool(), price, false, NOW)).toBe("active");
  });

  it("is awaiting action past the cutoff, and when the pool has no current round", () => {
    expect(cardStateOf(round(), pool(), price, false, CUTOFF)).toBe("awaitingAction");
    expect(cardStateOf(null, pool(), null, false, NOW)).toBe("awaitingAction");
  });

  it("is disabled for a disabled pool, whatever the round says", () => {
    expect(cardStateOf(round(), pool({enabled: false}), price, false, NOW)).toBe("disabled");
  });

  it("is unavailable when buys are paused or the price reference is unusable", () => {
    expect(cardStateOf(round(), pool(), price, true, NOW)).toBe("unavailable");
    const stale = priceStateOf(round(), feedReading({observation: null, available: false}), NOW);
    expect(cardStateOf(round(), pool(), stale, false, NOW)).toBe("unavailable");
  });
});

describe("price and progress", () => {
  it("classifies a fresh observation as usable and a stale one as PriceStale", () => {
    expect(priceStateOf(round(), feedReading(), NOW).class).toBe("ok");
    const old = feedReading({observation: {roundId: 42n, answer: PRICE, updatedAt: NOW - 7_200n}});
    const state = priceStateOf(round(), old, NOW);
    expect(state.class).toBe("PriceStale");
    expect(state.price).toBe(0n);
  });

  it("reports the pot's USD value and its share of the target", () => {
    // 1 BNB at USD 600 against a USD 100 target: the meter is full, never above it.
    const progress = targetProgressOf(round(), PRICE);
    expect(progress.usd).toBe(600n);
    expect(progress.filledBps).toBe(10_000n);
  });

  it("reports no progress at all without a usable price", () => {
    expect(targetProgressOf(round(), 0n)).toMatchObject({usd: null, filledBps: null});
  });
});

describe("players and entries", () => {
  it("counts the operator seed separately from players", () => {
    expect(playersExcludingSeed(round())).toBe(1n);
    expect(playersExcludingSeed(round({seeded: false, playerCount: 2n}))).toBe(2n);
  });

  it("allows entries only inside the window of an unpaused, priced, enabled pool", () => {
    const price = priceStateOf(round(), feedReading(), NOW);
    expect(entriesOpen(round(), pool(), price, false, NOW)).toBe(true);
    expect(entriesOpen(round(), pool(), price, true, NOW)).toBe(false);
    expect(entriesOpen(round(), pool({enabled: false}), price, false, NOW)).toBe(false);
    expect(entriesOpen(round(), pool(), price, false, CUTOFF)).toBe(false);
  });
});

describe("countdown", () => {
  it("floors the remaining seconds at zero", () => {
    expect(remainingSeconds(CUTOFF, NOW)).toBe(86_400n);
    expect(remainingSeconds(CUTOFF, CUTOFF + 10n)).toBe(0n);
  });

  it("shows the two largest units", () => {
    expect(coarseRemaining(183_600n)).toBe("2 d 3 h");
    expect(coarseRemaining(3_900n)).toBe("1 h 5 m");
    expect(coarseRemaining(90n)).toBe("1 m 30 s");
    expect(coarseRemaining(0n)).toBe("0 s");
  });

  it("buckets only the four announced thresholds", () => {
    expect(countdownBucket(7_200n)).toBeNull();
    expect(countdownBucket(3_600n)).toBe("hour");
    expect(countdownBucket(600n)).toBe("tenMinutes");
    expect(countdownBucket(60n)).toBe("minute");
    expect(countdownBucket(0n)).toBe("closed");
  });

  it("announces only when a threshold is crossed", () => {
    expect(announceOn(3_602n, 3_601n)).toBeNull();
    expect(announceOn(3_601n, 3_600n)).toBe("hour");
    expect(announceOn(3_600n, 3_599n)).toBeNull();
    expect(announceOn(601n, 600n)).toBe("tenMinutes");
    expect(announceOn(61n, 60n)).toBe("minute");
    expect(announceOn(1n, 0n)).toBe("closed");
    expect(announceOn(null, 60n)).toBeNull();
  });
});

describe("shortCutoffLabel", () => {
  it("names the day for a weekly round and the date for a monthly one", () => {
    // 2026-10-05 00:00 UTC is a Monday.
    const monday = 1_791_158_400n;
    // Kinds 0-2 are the daily tiers, 3-5 the weekly tiers, 6 the monthly one (ADR 036).
    for (const kind of [0, 1, 2] as const) expect(shortCutoffLabel(kind, monday)).toBe("00:00 UTC");
    for (const kind of [3, 4, 5] as const) expect(shortCutoffLabel(kind, monday)).toBe("Mon 00:00 UTC");
    expect(shortCutoffLabel(6, monday)).toBe("Oct 5 00:00 UTC");
  });
});

describe("nativeReferenceOf", () => {
  // The manifest's frozen terms for the native asset, in the shape `ManifestPrice` carries them.
  const terms = {feedDecimals: 8n, maxPriceAge: 3_600n, minAnswer: 0n, maxAnswer: 0n};

  it("returns the answer and its decimals for a usable observation", () => {
    expect(nativeReferenceOf(terms, feedReading(), NOW)).toEqual({price: PRICE, feedDecimals: 8});
  });

  it("returns nothing for a stale observation, so no gas figure is converted from it", () => {
    const stale = feedReading({observation: {roundId: 42n, answer: PRICE, updatedAt: NOW - 3_601n}});
    expect(nativeReferenceOf(terms, stale, NOW)).toBeNull();
  });

  it("returns nothing for an answer clamped at a circuit breaker", () => {
    const clamped = {...terms, maxAnswer: PRICE};
    expect(nativeReferenceOf(clamped, feedReading(), NOW)).toBeNull();
  });

  it("returns nothing when the feed changed decimals or is unavailable", () => {
    expect(nativeReferenceOf(terms, feedReading({decimals: 18n}), NOW)).toBeNull();
    expect(
      nativeReferenceOf(terms, feedReading({available: false, decimals: null, observation: null}), NOW),
    ).toBeNull();
  });
});
