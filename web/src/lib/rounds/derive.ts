// Derived state for the pools page and the round page (SPEC §6.2, §9.4, §9.6).
//
// Everything here is a pure function of one snapshot: a round, its pool, one feed reading and the chain
// timestamp that snapshot carried. No component computes any of it inline, so the §9.6 state table and the
// §9.4 card states are decided in one place and tested without a DOM.
//
// Two rules hold throughout: the arithmetic is bigint (SPEC §9.7 forbids floating-point money math), and the
// clock is always the snapshot's chain timestamp advanced by the app's monotonic ticker, never `Date.now()`
// (SPEC §9.6: "the client clock never authorizes an entry").

import {
  classifyObservation,
  type FeedReading,
  type Kind,
  type ObservationClass,
  type ObservationInput,
  type PoolView,
  type PreviewRound,
  type RoundView,
  State,
  type StateCatalogKey,
  scaleOf,
  stateCatalogKeyFor,
  stateName,
  toObservationInput,
  tryUsdValueUint256,
} from "@luckydraw/client";

/** Kinds in `Kind` order, so a pool's seven tiers are always built and shown in the same order. */
export const KINDS: readonly Kind[] = [0, 1, 2, 3, 4, 5, 6];

/** What a pool/kind card can be in, per SPEC §9.4 ("active, closed awaiting action, disabled, unavailable"). */
export type CardState = "active" | "awaitingAction" | "disabled" | "unavailable";

/** The price reference for one round at one block: the class the contract would report and its answer. */
export type PriceState = {
  /** `"ok"`, or the `QuoteReason` the contract would report for this observation. */
  class: ObservationClass;
  /** The feed answer when the class is `"ok"`, zero otherwise: an unusable answer must not reach a display. */
  price: bigint;
  /** Age of the observation against the round's frozen `maxPriceAge`, in seconds. */
  ageSeconds: bigint;
  maxPriceAge: bigint;
};

/** Classifies one feed reading against a round's frozen pricing, exactly as `quoteBuy` would. */
export function priceStateOf(round: RoundView, feed: FeedReading, now: bigint): PriceState {
  const observation = toObservationInput(round, feed, now);
  const observationClass = classifyObservation(observation);
  const updatedAt = feed.observation?.updatedAt ?? 0n;
  const age = updatedAt === 0n || now < updatedAt ? 0n : now - updatedAt;
  return {
    class: observationClass,
    price: observationClass === "ok" ? observation.answer : 0n,
    ageSeconds: age,
    maxPriceAge: round.pricing.maxPriceAge,
  };
}

/** The frozen pricing terms a feed reading is judged against. A round carries them; so does a manifest asset. */
export type PricingTerms = {
  feedDecimals: bigint;
  maxPriceAge: bigint;
  minAnswer: bigint;
  maxAnswer: bigint;
};

/** The native asset's usable reference price, for converting a gas estimate to USD (SPEC §9.5). */
export type NativeReference = {price: bigint; feedDecimals: number};

/**
 * The native asset's reference price, or null when its own feed would not price anything.
 *
 * The gas figure is money on the screen and drives the 25%-of-gross warning, so the native feed gets exactly
 * the classification a round's feed gets (`priceStateOf`): a missing, decimals-changed, invalid, clamped or
 * stale observation yields null and the panel says the estimate is unavailable rather than printing a
 * confident "≈ USD" from an answer the contract itself would reject (§9.1 X2). The terms come from the
 * manifest, because the native asset need not be the round's asset and has no frozen `PricingConfig` here.
 */
export function nativeReferenceOf(
  pricing: PricingTerms,
  feed: FeedReading,
  now: bigint,
): NativeReference | null {
  const observation: ObservationInput = {
    available: feed.available,
    decimals: feed.decimals === null ? undefined : Number(feed.decimals),
    expectedDecimals: Number(pricing.feedDecimals),
    roundId: feed.observation?.roundId ?? 0n,
    answer: feed.observation?.answer ?? 0n,
    updatedAt: feed.observation?.updatedAt ?? 0n,
    now,
    maxPriceAge: pricing.maxPriceAge,
    minAnswer: pricing.minAnswer,
    maxAnswer: pricing.maxAnswer,
  };
  if (classifyObservation(observation) !== "ok") return null;
  return {price: observation.answer, feedDecimals: Number(pricing.feedDecimals)};
}

/** The whole-USD reference value of a raw amount, or null when the price is unusable or the value overflows. */
export function usdWhole(round: RoundView, price: bigint, raw: bigint): bigint | null {
  if (price <= 0n) return null;
  const value = tryUsdValueUint256(
    raw,
    Number(round.tokenDecimals),
    Number(round.pricing.feedDecimals),
    price,
  );
  return value.ok ? value.value : null;
}

/**
 * The reference value of a raw amount in USD cents.
 *
 * Whole USD is too coarse for a network fee or a small entry, and the 25%-of-gross comparison of SPEC §9.5
 * needs both sides at the same resolution. `floor(raw * price * 100 / 10^(tokenDecimals + feedDecimals))`,
 * all bigint.
 */
export function usdCents(
  tokenDecimals: number,
  feedDecimals: number,
  price: bigint,
  raw: bigint,
): bigint | null {
  if (price <= 0n || raw < 0n) return null;
  return (raw * price * 100n) / scaleOf(tokenDecimals, feedDecimals);
}

/** Progress of a round's pot toward its whole-USD target (SPEC §9.4 progress meter). */
export type TargetProgress = {
  /** Reference value of the pot in whole USD, or null when the price is unusable. */
  usd: bigint | null;
  target: bigint;
  /** 0-10000; null when `usd` is null. Capped at 10000 so a target-reaching pot never reads above full. */
  filledBps: bigint | null;
};

export function targetProgressOf(round: RoundView, price: bigint): TargetProgress {
  const usd = usdWhole(round, price, round.grossTotal);
  if (usd === null || round.targetUsd === 0n) {
    return {usd, target: round.targetUsd, filledBps: null};
  }
  const bps = (usd * 10_000n) / round.targetUsd;
  return {usd, target: round.targetUsd, filledBps: bps > 10_000n ? 10_000n : bps};
}

/** Distinct player addresses, with the operator seed counted separately (SPEC §9.4, §9.8). */
export function playersExcludingSeed(round: RoundView): bigint {
  const players = round.seeded ? round.playerCount - 1n : round.playerCount;
  return players > 0n ? players : 0n;
}

/** `previewEntry`'s view of a round (`math/quote.ts`), from one `getRound` snapshot. */
export function previewRoundOf(round: RoundView): PreviewRound {
  return {
    id: round.id,
    state: round.state,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    tokenDecimals: Number(round.tokenDecimals),
    feedDecimals: Number(round.pricing.feedDecimals),
    targetUsd: round.targetUsd,
    grossTotal: round.grossTotal,
    feeReserved: round.feeReserved,
    playerCount: round.playerCount,
    seeded: round.seeded,
  };
}

/** True while a purchase is possible: Open, inside the window, not paused and priced (SPEC §5.3). */
export function entriesOpen(
  round: RoundView,
  pool: PoolView,
  price: PriceState,
  buysPaused: boolean,
  now: bigint,
): boolean {
  if (round.state !== State.Open) return false;
  if (now < round.opensAt || now >= round.closesAt) return false;
  if (buysPaused || pool.buysPaused || !pool.enabled) return false;
  return price.class === "ok";
}

/** The §9.4 card state for one pool/kind. `round` is null when the pool has no current round of that kind. */
export function cardStateOf(
  round: RoundView | null,
  pool: PoolView,
  price: PriceState | null,
  buysPaused: boolean,
  now: bigint,
): CardState {
  if (!pool.enabled) return "disabled";
  if (round === null) return "awaitingAction";
  if (round.state !== State.Open) return "awaitingAction";
  if (now >= round.closesAt) return "awaitingAction";
  if (buysPaused || pool.buysPaused) return "unavailable";
  if (price === null || price.class !== "ok") return "unavailable";
  return "active";
}

// ---------------------------------------------------------------------------
// The SPEC §9.6 state table
// ---------------------------------------------------------------------------

/** The single control a round state offers, or `null` where the table offers none. */
export type LifecycleAction = "enter" | "close" | "request" | "expire" | "settle" | "claim" | null;

export type Lifecycle = {
  /** The row of the client's `stateCatalog` that applies (`states.ts`). */
  catalogKey: StateCatalogKey;
  /** The one primary action of this state (SPEC §9.1 X3). */
  action: LifecycleAction;
  /** Seconds an accepted randomness request has been outstanding, for the Drawing rows. */
  requestAgeSeconds: bigint | null;
  /** True once the §7.3 waiting notice replaces the ten-minute estimate. */
  delayed: boolean;
};

/**
 * The row and the single control for a round, from the state table of SPEC §6.2 and §9.6.
 *
 * `refunded` is this account's `getPosition(...).refunded` and `hasPosition` its `gross > 0`: Refunding shows
 * "Refund credited" once the position says so, a Claim control while it does not, and no control at all to an
 * account with no entry, because `claimRefund` reverts `InvalidAmount` for one.
 */
export function lifecycleOf(
  round: RoundView,
  now: bigint,
  account: {hasPosition: boolean; refunded: boolean} = {hasPosition: false, refunded: false},
): Lifecycle {
  const name = stateName(round.state);
  switch (round.state) {
    case State.Open: {
      const pastCutoff = now >= round.closesAt;
      return {
        catalogKey: stateCatalogKeyFor(name, {pastBoundary: pastCutoff}),
        action: pastCutoff ? "close" : "enter",
        requestAgeSeconds: null,
        delayed: false,
      };
    }
    case State.AwaitingRequest: {
      const atDeadline = now >= round.requestDeadline;
      return {
        catalogKey: stateCatalogKeyFor(name, {pastBoundary: atDeadline}),
        action: atDeadline ? "expire" : "request",
        requestAgeSeconds: null,
        delayed: false,
      };
    }
    case State.Drawing: {
      const age = round.requestedAt === 0n || now < round.requestedAt ? 0n : now - round.requestedAt;
      const key = stateCatalogKeyFor(name, {requestAgeSeconds: age});
      return {catalogKey: key, action: null, requestAgeSeconds: age, delayed: key === "DrawingDelayed"};
    }
    case State.Ready:
      return {catalogKey: "Ready", action: "settle", requestAgeSeconds: null, delayed: false};
    case State.Settled:
      return {catalogKey: "Settled", action: null, requestAgeSeconds: null, delayed: false};
    case State.Refunding:
      return {
        catalogKey: "Refunding",
        action: account.hasPosition && !account.refunded ? "claim" : null,
        requestAgeSeconds: null,
        delayed: false,
      };
    default:
      return {catalogKey: "Void", action: null, requestAgeSeconds: null, delayed: false};
  }
}

/** The four steps of the §9.4 status timeline and how far a round has got through them. */
export type TimelineStep = {
  name: "open" | "closed" | "requested" | "result";
  status: "done" | "current" | "waiting";
};

export function timelineOf(round: RoundView): readonly TimelineStep[] {
  const closed = round.state !== State.Open;
  const requested =
    round.state === State.Drawing || round.state === State.Ready || round.state === State.Settled;
  const resulted =
    round.state === State.Settled || round.state === State.Refunding || round.state === State.Void;
  const step = (name: TimelineStep["name"], done: boolean, current: boolean): TimelineStep => ({
    name,
    status: done ? "done" : current ? "current" : "waiting",
  });
  return [
    step("open", closed, !closed),
    step("closed", requested || resulted, closed && !requested && !resulted),
    step(
      "requested",
      round.state === State.Ready || round.state === State.Settled,
      round.state === State.Drawing,
    ),
    step("result", resulted, round.state === State.Ready),
  ];
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Seconds until a cutoff, floored at zero. Never negative, so a countdown cannot run backwards. */
export function remainingSeconds(until: bigint, now: bigint): bigint {
  return now >= until ? 0n : until - now;
}

/**
 * The coarse "in 2 d 3 h" of the SPEC §9.4 tier label: the two largest non-zero units, never a ticking second.
 * The round page shows the exact `formatCountdown` clock; a card in a list does not need one.
 */
export function coarseRemaining(seconds: bigint): string {
  if (seconds <= 0n) return "0 s";
  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;
  const rest = seconds % 60n;
  if (days > 0n) return hours > 0n ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0n) return minutes > 0n ? `${hours} h ${minutes} m` : `${hours} h`;
  if (minutes > 0n) return rest > 0n ? `${minutes} m ${rest} s` : `${minutes} m`;
  return `${rest} s`;
}

/** The countdown announcement buckets of SPEC §9.7: one hour, ten minutes, one minute, closed. */
export type CountdownBucket = "hour" | "tenMinutes" | "minute" | "closed" | null;

export function countdownBucket(seconds: bigint): CountdownBucket {
  if (seconds <= 0n) return "closed";
  if (seconds <= 60n) return "minute";
  if (seconds <= 600n) return "tenMinutes";
  if (seconds <= 3_600n) return "hour";
  return null;
}

/**
 * Whether crossing from `previous` to `current` seconds should announce, and which bucket.
 *
 * Only a change into a bucket announces, so a screen reader hears four sentences over a whole round rather
 * than one a second (SPEC §9.7: "announce the countdown only at thresholds").
 */
export function announceOn(previous: bigint | null, current: bigint): CountdownBucket {
  const bucket = countdownBucket(current);
  if (bucket === null) return null;
  if (previous === null) return null;
  return countdownBucket(previous) === bucket ? null : bucket;
}

const UTC_WEEKDAY = new Intl.DateTimeFormat("en-US", {timeZone: "UTC", weekday: "short"});
const UTC_DAY_MONTH = new Intl.DateTimeFormat("en-US", {timeZone: "UTC", day: "numeric", month: "short"});

/**
 * The short cutoff of the §9.4 tier label: "00:00 UTC" daily, "Mon 00:00 UTC" weekly, "1 Oct 00:00 UTC"
 * monthly. The full "2026-10-01 00:00 UTC (08:00 your time)" form of §9.7 is on the round page and in each
 * card's accessible title; a list of twelve cards does not repeat it twelve times.
 */
export function shortCutoffLabel(kind: Kind, closesAt: bigint): string {
  const at = new Date(Number(closesAt) * 1000);
  const hh = at.getUTCHours().toString().padStart(2, "0");
  const mm = at.getUTCMinutes().toString().padStart(2, "0");
  const clock = `${hh}:${mm} UTC`;
  // Kind order (Types.sol): 0-2 are the daily tiers, 3-5 the weekly tiers, 6 the monthly one.
  if (kind >= 3 && kind <= 5) return `${UTC_WEEKDAY.format(at)} ${clock}`;
  if (kind === 6) return `${UTC_DAY_MONTH.format(at)} ${clock}`;
  return clock;
}
