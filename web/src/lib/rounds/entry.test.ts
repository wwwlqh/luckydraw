// The entry pipeline's arithmetic and its two refusals (SPEC §9.5).

import {previewEntry, QuoteReason, toObservationInput} from "@luckydraw/client";
import {describe, expect, it} from "vitest";
import {previewRoundOf} from "./derive.ts";
import {
  entryKey,
  gasExceedsShare,
  inFinalSeconds,
  needsFreshPrice,
  parseEntryAmount,
  planFrom,
  presetGross,
  previewFor,
  USD_PRESETS,
} from "./entry.ts";
import {CUTOFF, entryPanel, NOW, OTHER, PLAYER, PRICE, round, TOKEN} from "./fixtures.ts";

const SHAPE = {tokenDecimals: 18, feedDecimals: 8};

describe("parseEntryAmount", () => {
  it("parses an asset amount exactly and rejects what SPEC §9.5 says it must", () => {
    expect(parseEntryAmount("1.5", "asset", SHAPE, PRICE)).toEqual({
      ok: true,
      raw: 1_500_000_000_000_000_000n,
    });
    expect(parseEntryAmount("-1", "asset", SHAPE, PRICE)).toEqual({ok: false, reason: "negative"});
    expect(parseEntryAmount("1,5", "asset", SHAPE, PRICE)).toEqual({ok: false, reason: "commaSeparator"});
    expect(parseEntryAmount("1e18", "asset", SHAPE, PRICE)).toEqual({ok: false, reason: "invalidCharacter"});
    expect(parseEntryAmount("1.2.3", "asset", SHAPE, PRICE)).toEqual({ok: false, reason: "multipleDots"});
    // Two decimals is all a 2-decimal token has.
    expect(parseEntryAmount("1.234", "asset", {tokenDecimals: 2, feedDecimals: 8}, PRICE)).toEqual({
      ok: false,
      reason: "tooManyFractionDigits",
    });
  });

  it("converts a USD amount upward into raw units", () => {
    // USD 1 at USD 600 per unit is 1/600 of a unit, rounded up to the next raw unit.
    const parsed = parseEntryAmount("1", "usd", SHAPE, PRICE);
    expect(parsed).toEqual({ok: true, raw: 1_666_666_666_666_667n});
    // One raw unit less is worth less than USD 1, which is what "upward" has to mean.
    expect((1_666_666_666_666_667n * PRICE) / 10n ** 26n).toBe(1n);
    expect((1_666_666_666_666_666n * PRICE) / 10n ** 26n).toBe(0n);
    expect(parseEntryAmount("1.234", "usd", SHAPE, PRICE)).toEqual({ok: false, reason: "usdPrecision"});
    expect(parseEntryAmount("1", "usd", SHAPE, 0n)).toEqual({ok: false, reason: "noPrice"});
  });
});

describe("presetGross", () => {
  it("converts USD 1, 5, 20 and 100 upward to raw units", () => {
    const raws = USD_PRESETS.map((usd) => presetGross(SHAPE, PRICE, usd));
    expect(raws).toEqual([
      1_666_666_666_666_667n,
      8_333_333_333_333_334n,
      33_333_333_333_333_334n,
      166_666_666_666_666_667n,
    ]);
    for (const [index, raw] of raws.entries()) {
      const usd = USD_PRESETS[index] as bigint;
      expect(((raw as bigint) * PRICE) / 10n ** 26n).toBeGreaterThanOrEqual(usd);
      expect((((raw as bigint) - 1n) * PRICE) / 10n ** 26n).toBeLessThan(usd);
    }
    expect(presetGross(SHAPE, 0n, 1n)).toBeNull();
  });
});

describe("previewFor", () => {
  const inputs = [1_000_000_000_000_000_000n, 2_500_000_000_000_000n, 40_000_000_000_000_000n];

  it("matches previewEntry over the panel for three amounts", () => {
    for (const gross of inputs) {
      const panel = entryPanel(gross);
      const expected = previewEntry({
        now: NOW,
        round: previewRoundOf(panel.round),
        grossAmount: gross,
        observation: toObservationInput(panel.round, panel.feed, NOW),
        buyer: {
          grossByUser: panel.position.gross,
          availableBalance: panel.balance,
          seedMaxPerRound: panel.seedMaxPerRound,
        },
        buysPaused: panel.buysPaused,
        poolBuysPaused: panel.pool.buysPaused,
        seed: panel.seed ?? undefined,
      });
      expect(previewFor(panel, gross, NOW)).toEqual(expected);
    }
  });

  it("reports the contract's own reason rather than approving what quoteBuy would reject", () => {
    const panel = entryPanel(1n, {balance: 0n});
    expect(previewFor(panel, 1_000_000_000_000_000_000n, NOW).reason).toBe(QuoteReason.InsufficientBalance);
    const tiny = previewFor(entryPanel(1n), 1n, NOW);
    expect(tiny.reason).toBe(QuoteReason.BelowMinimum);
    expect(tiny.minGross).toBeGreaterThan(0n);
    const closed = previewFor(entryPanel(1n), 1_000_000_000_000_000_000n, CUTOFF);
    expect(closed.reason).toBe(QuoteReason.EntryWindowClosed);
  });

  it("says when an entry reaches the target", () => {
    // 1 BNB already in the pot at USD 600 against a USD 100 target, with the seed as the second address.
    const preview = previewFor(entryPanel(1_000_000_000_000_000_000n), 1_000_000_000_000_000_000n, NOW);
    expect(preview.reason).toBe(QuoteReason.None);
    expect(preview.reachesTarget).toBe(true);
  });
});

describe("entryKey", () => {
  it("changes with the amount, the round and the account", () => {
    const base = entryKey(1n, PLAYER, 10n);
    expect(entryKey(1n, PLAYER, 10n)).toBe(base);
    expect(entryKey(1n, PLAYER, 11n)).not.toBe(base);
    expect(entryKey(2n, PLAYER, 10n)).not.toBe(base);
    expect(entryKey(1n, OTHER, 10n)).not.toBe(base);
    expect(entryKey(1n, null, 10n)).not.toBe(base);
  });
});

describe("planFrom", () => {
  const gross = 100_000_000_000_000_000n;
  const request = {roundId: 1n, user: PLAYER, gross, chainTimestamp: NOW};

  it("builds the buy parameters from a quote for this round, buyer, asset and amount", () => {
    const panel = entryPanel(gross);
    const outcome = planFrom(panel, request);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.params.roundId).toBe(1n);
    expect(outcome.params.gross).toBe(gross);
    // SPEC §9.5: minNetContribution = max(0, quotedNetDelta - 1 raw unit).
    expect(outcome.params.minNetContribution).toBe(panel.quote.netDelta - 1n);
    // SPEC §9.5: deadline = min(now + 300, closesAt - 1).
    expect(outcome.params.deadline).toBe(NOW + 300n);
  });

  it("refuses a quote read for another round", () => {
    const panel = entryPanel(gross);
    const outcome = planFrom(panel, {...request, roundId: 2n});
    expect(outcome).toMatchObject({ok: false, kind: "QuoteContextMismatch", field: "roundId"});
  });

  it("refuses a quote read for another buyer", () => {
    const panel = entryPanel(gross, {user: OTHER});
    expect(planFrom(panel, request)).toMatchObject({ok: false, kind: "QuoteContextMismatch", field: "user"});
  });

  it("refuses a quote read for another asset", () => {
    const panel = entryPanel(gross, {round: {asset: TOKEN}});
    // The panel stamps the quote with the round's asset, so a mismatch is a mismatch of the round itself.
    const outcome = planFrom({...panel, quotedFor: {...panel.quotedFor, asset: TOKEN}}, request);
    expect(outcome.ok).toBe(true);
    const crossed = planFrom({...panel, round: round()}, request);
    expect(crossed).toMatchObject({ok: false, kind: "QuoteContextMismatch", field: "asset"});
  });

  it("refuses a quote for another amount", () => {
    const panel = entryPanel(gross);
    expect(planFrom(panel, {...request, gross: gross + 1n})).toMatchObject({
      ok: false,
      kind: "QuoteAmountMismatch",
    });
  });

  it("refuses when no deadline shorter than the cutoff remains", () => {
    const panel = entryPanel(gross);
    expect(planFrom(panel, {...request, chainTimestamp: CUTOFF - 1n})).toMatchObject({
      ok: false,
      kind: "NoTimeRemaining",
    });
  });

  it("clamps the deadline to one second before the cutoff", () => {
    const panel = entryPanel(gross);
    const outcome = planFrom(panel, {...request, chainTimestamp: CUTOFF - 100n});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.params.deadline).toBe(CUTOFF - 1n);
  });

  it("refuses a rejected quote outright", () => {
    const panel = entryPanel(gross, {quote: {reason: QuoteReason.PriceStale}});
    expect(planFrom(panel, request)).toMatchObject({ok: false, kind: "QuoteRejected"});
  });
});

describe("the §9.5 warnings", () => {
  it("waits for a fresh price within 15 seconds of the age limit", () => {
    expect(needsFreshPrice(3_500n, 3_600n)).toBe(false);
    expect(needsFreshPrice(3_585n, 3_600n)).toBe(true);
    expect(needsFreshPrice(3_600n, 3_600n)).toBe(true);
  });

  it("warns inside the final 120 seconds, and not after the cutoff", () => {
    expect(inFinalSeconds(121n)).toBe(false);
    expect(inFinalSeconds(120n)).toBe(true);
    expect(inFinalSeconds(0n)).toBe(false);
  });

  it("warns when the network fee is more than a quarter of the gross", () => {
    expect(gasExceedsShare(24n, 100n)).toBe(false);
    expect(gasExceedsShare(25n, 100n)).toBe(false);
    expect(gasExceedsShare(26n, 100n)).toBe(true);
    expect(gasExceedsShare(null, 100n)).toBe(false);
    expect(gasExceedsShare(10n, null)).toBe(false);
  });
});
