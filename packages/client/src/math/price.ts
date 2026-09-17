/// Reference-price math and feed-observation classification (SPEC §3.1, §3.2, §8.1).
///
/// Mirrors `contracts/src/lib/PriceReader.sol` (`read`, `minGrossRaw`, `usdValue`, `tryUsdValue`,
/// `minGrossForTarget`) and `spec_reference.py` (`minimum`, `usd_value`, `target_gross`, `valid_price`,
/// `max_price_age`). The price gates only the USD 1 admission minimum and the whole-USD target check; it
/// never touches weights, the pot or payouts.

import {MAX_DECIMALS, MAX_PRICE_AGE, MAX_UINT256, MIN_PRICE_AGE, PRICE_AGE_FLOOR} from "./constants.ts";
import {require_} from "./mathError.ts";

/// Result of classifying one feed observation. Anything but `"ok"` is the `QuoteReason` of the same name.
export type ObservationClass =
  | "ok"
  | "PriceUnavailable"
  | "PriceDecimalsChanged"
  | "PriceInvalid"
  | "PriceStale";

/// One `latestRoundData()` reading plus everything `PriceReader.read` needs to classify it.
export interface ObservationInput {
  /// False when `feed.code.length == 0` or `latestRoundData()` reverted: PriceUnavailable (SPEC §3.2).
  readonly available: boolean;
  /// The live `decimals()` result, or `undefined` when that call reverted (also PriceUnavailable).
  readonly decimals: number | undefined;
  /// The round's frozen `PricingConfig.feedDecimals`.
  readonly expectedDecimals: number;
  /// Aggregator round id (uint80).
  readonly roundId: bigint;
  /// Reported answer in feed decimals (int256).
  readonly answer: bigint;
  /// Timestamp of the answer.
  readonly updatedAt: bigint;
  /// The block timestamp the quote is evaluated against.
  readonly now: bigint;
  /// The round's frozen `PricingConfig.maxPriceAge`.
  readonly maxPriceAge: bigint;
  /// Frozen aggregator circuit-breaker floor; zero when the aggregator has none. Required, because the frozen
  /// `PricingConfig` always carries it and an omitted bound would silently admit a clamped answer.
  readonly minAnswer: bigint;
  /// Frozen aggregator circuit-breaker ceiling; zero when the aggregator has none. Required, as above.
  readonly maxAnswer: bigint;
}

/// Classifies a feed observation in the precedence SPEC §3.2 and `PriceReader.read` define:
///
/// 1. missing or reverting feed -> `PriceUnavailable`
/// 2. a `decimals()` result different from the frozen value -> `PriceDecimalsChanged`
/// 3. `roundId == 0`, `answer <= 0`, `updatedAt == 0`, `updatedAt > now`, or an answer at or beyond a nonzero
///    frozen bound -> `PriceInvalid`
/// 4. `now - updatedAt > maxPriceAge` -> `PriceStale`
/// 5. otherwise `"ok"`.
///
/// The decimals check runs before the answer checks, so a feed that changed decimals reports
/// `PriceDecimalsChanged` even when its answer is also stale or invalid. `spec_reference.valid_price` folds
/// steps 3 and 4 into one boolean; this function keeps them apart because `quoteBuy` reports which one failed.
export function classifyObservation(input: ObservationInput): ObservationClass {
  const {minAnswer, maxAnswer} = input;

  if (!input.available || input.decimals === undefined) return "PriceUnavailable";
  if (input.decimals !== input.expectedDecimals) return "PriceDecimalsChanged";

  if (input.roundId === 0n || input.answer <= 0n || input.updatedAt === 0n || input.updatedAt > input.now) {
    return "PriceInvalid";
  }
  // An answer clamped at an aggregator circuit breaker is not a market price (SPEC §3.1).
  if (minAnswer !== 0n && input.answer <= minAnswer) return "PriceInvalid";
  if (maxAnswer !== 0n && input.answer >= maxAnswer) return "PriceInvalid";

  if (input.now - input.updatedAt > input.maxPriceAge) return "PriceStale";

  return "ok";
}

/// `10^(d + f)`, the raw-unit-to-USD scale (SPEC §3.2, `PriceReader._scale`).
///
/// Both decimal counts are 0-18, so the exponent never exceeds 36 and the scale always fits in uint256.
export function scaleOf(tokenDecimals: number, feedDecimals: number): bigint {
  requireDecimals(tokenDecimals, "tokenDecimals");
  requireDecimals(feedDecimals, "feedDecimals");
  return 10n ** BigInt(tokenDecimals + feedDecimals);
}

/// `ceil(scale / price)`: the smallest gross raw amount worth at least USD 1 (SPEC §3.2,
/// `PriceReader.minGrossRaw`, `spec_reference.minimum`).
///
/// `usdValue(minGrossRaw) >= 1` and one raw unit less is below USD 1.
export function minGrossRaw(tokenDecimals: number, feedDecimals: number, price: bigint): bigint {
  const scale = scaleOf(tokenDecimals, feedDecimals);
  requirePrice(price);
  return ceilDiv(scale, price);
}

/// `floor(gross * price / scale)`: the whole-USD reference value of a gross amount (SPEC §3.2,
/// `PriceReader.usdValue`, `spec_reference.usd_value`).
///
/// Returned as an unbounded bigint. The Solidity `Math.mulDiv` reverts when the true quotient exceeds
/// uint256; `tryUsdValueUint256` is the checked form that reports that case instead.
export function usdValue(gross: bigint, tokenDecimals: number, feedDecimals: number, price: bigint): bigint {
  const scale = scaleOf(tokenDecimals, feedDecimals);
  require_(gross >= 0n && gross <= MAX_UINT256, "InvalidInput", `gross out of uint256 range: ${gross}`);
  require_(price >= 0n && price <= MAX_UINT256, "InvalidInput", `price out of uint256 range: ${price}`);
  return (gross * price) / scale;
}

/// A uint256-checked USD projection: `{ ok: true, value }`, or `{ ok: false }` where the Solidity reports
/// `QuoteReason.ArithmeticOverflow`.
export type TryUsdValue = {readonly ok: true; readonly value: bigint} | {readonly ok: false};

/// The advisory USD projection of SPEC §8.1, with the exact checked steps of `PriceReader.tryUsdValue`:
///
/// ```text
/// floor(gross/scale) * price + floor((gross % scale) * price / scale)
/// ```
///
/// The first product is a checked multiply (`Math.tryMul`) and the sum is a checked add (`Math.tryAdd`); the
/// fractional term is always below `price`, so it never overflows on its own and is computed at full
/// precision. `{ ok: false }` is returned exactly where one of those two checked steps fails, which is what
/// makes `quoteBuy` report `ArithmeticOverflow` rather than reverting or clamping.
export function tryUsdValueUint256(
  gross: bigint,
  tokenDecimals: number,
  feedDecimals: number,
  price: bigint,
): TryUsdValue {
  const scale = scaleOf(tokenDecimals, feedDecimals);
  require_(gross >= 0n && gross <= MAX_UINT256, "InvalidInput", `gross out of uint256 range: ${gross}`);
  require_(price >= 0n && price <= MAX_UINT256, "InvalidInput", `price out of uint256 range: ${price}`);

  const whole = (gross / scale) * price;
  if (whole > MAX_UINT256) return {ok: false};
  const fraction = ((gross % scale) * price) / scale;
  const total = whole + fraction;
  if (total > MAX_UINT256) return {ok: false};
  return {ok: true, value: total};
}

/// `ceil(targetUsd * scale / price)`: the smallest gross whose `usdValue` reaches `targetUsd` (SPEC §3.2,
/// §6.1, `PriceReader.minGrossForTarget`, `spec_reference.target_gross`).
///
/// `usdValue` of the result is at least `targetUsd` and one raw unit less is below it. The result is an
/// unbounded bigint; the Solidity `Math.mulDiv(..., Ceil)` reverts when it would exceed uint256.
export function targetGross(
  tokenDecimals: number,
  feedDecimals: number,
  price: bigint,
  targetUsd: bigint,
): bigint {
  const scale = scaleOf(tokenDecimals, feedDecimals);
  requirePrice(price);
  require_(targetUsd >= 0n, "InvalidInput", `targetUsd must not be negative: ${targetUsd}`);
  return ceilDiv(targetUsd * scale, price);
}

/// The SPEC §3.2 `targetHit` predicate: `playerCountAfter >= 2 && usdValue(grossTotalAfter) >= targetUsd`.
///
/// `playerCountAfter` counts distinct addresses including this buyer; the operator seed counts as one address
/// (SPEC §3.2, §5.4). A lone player therefore never closes a round by target, and a seed entry never runs
/// this check at all (`LuckyDraw._applySeed`, D10).
///
/// Like `usdValue`, this is unbounded: where the true `gross * price / scale` exceeds uint256 the Solidity
/// `Math.mulDiv` reverts instead of answering. Use `tryUsdValueUint256` when the answer must match what the
/// chain would actually return; `previewEntry` does.
export function reachesTarget(
  grossTotalAfter: bigint,
  playerCountAfter: bigint,
  tokenDecimals: number,
  feedDecimals: number,
  price: bigint,
  targetUsd: bigint,
): boolean {
  if (playerCountAfter < 2n) return false;
  return usdValue(grossTotalAfter, tokenDecimals, feedDecimals, price) >= targetUsd;
}

/// The price-age policy of SPEC §3.1: `max(2H, 3600)` seconds, rejected outside 60-172,800
/// (`spec_reference.max_price_age`, `MIN_PRICE_AGE`/`MAX_PRICE_AGE` in Types.sol).
///
/// The floor already exceeds `MIN_PRICE_AGE`, so only a heartbeat above 86,400 seconds can fail; such a feed
/// is ineligible for v1 and the configuration must be rejected rather than silently clamped, which is why
/// this throws instead of returning a bounded value (`spec_reference` asserts the same range).
export function maxPriceAge(heartbeatSeconds: bigint): bigint {
  require_(heartbeatSeconds > 0n, "InvalidInput", `heartbeat must be positive: ${heartbeatSeconds}`);
  const doubled = 2n * heartbeatSeconds;
  const age = doubled > PRICE_AGE_FLOOR ? doubled : PRICE_AGE_FLOOR;
  require_(
    age >= MIN_PRICE_AGE && age <= MAX_PRICE_AGE,
    "InvalidInput",
    `maxPriceAge ${age} outside the ${MIN_PRICE_AGE}-${MAX_PRICE_AGE} second policy`,
  );
  return age;
}

/// Whether `maxPriceAge` would accept this heartbeat; a feed that fails is ineligible for v1 (SPEC §3.1).
export function isEligibleHeartbeat(heartbeatSeconds: bigint): boolean {
  if (heartbeatSeconds <= 0n) return false;
  const doubled = 2n * heartbeatSeconds;
  const age = doubled > PRICE_AGE_FLOOR ? doubled : PRICE_AGE_FLOOR;
  return age >= MIN_PRICE_AGE && age <= MAX_PRICE_AGE;
}

/// `ceil(a / b)` for non-negative bigints (`Math.ceilDiv`, `spec_reference`'s `q + bool(rem)`).
function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b === 0n ? q : q + 1n;
}

function requireDecimals(value: number, label: string): void {
  require_(
    Number.isInteger(value) && value >= 0 && value <= MAX_DECIMALS,
    "InvalidInput",
    `${label} must be an integer 0-${MAX_DECIMALS}: ${value}`,
  );
}

function requirePrice(price: bigint): void {
  require_(price > 0n, "InvalidInput", `price must be positive: ${price}`);
  require_(price <= MAX_UINT256, "InvalidInput", `price out of uint256 range: ${price}`);
}
