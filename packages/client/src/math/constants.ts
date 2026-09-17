/// Chain-width and protocol constants, all `bigint` (SPEC §5.1, §6.1, §6.2, Types.sol).

/// Largest uint256 (one binding for the whole package: `src/types/common.ts`). Used for the 2^256 mod W step
/// (SPEC §7.2) and for every overflow guard.
export {MAX_UINT256} from "../types/common.ts";

/// Largest uint64. `opensAt`, `closesAt`, `closedAt` and `requestDeadline` are uint64 (SPEC §5.1).
export const MAX_UINT64 = (1n << 64n) - 1n;

/// Largest uint80; Chainlink aggregator round ids are uint80 (SPEC §8.2).
export const MAX_UINT80 = (1n << 80n) - 1n;

/// Largest int256, the width of a feed answer.
export const MAX_INT256 = (1n << 255n) - 1n;

/// Smallest int256.
export const MIN_INT256 = -(1n << 255n);

/// Entry fee in basis points: 3% (`FEE_BPS` in Types.sol, SPEC §5.2).
export const FEE_BPS = 300n;

/// Basis-point denominator (`BPS` in Types.sol, SPEC §5.2).
export const BPS = 10_000n;

/// Seconds per UTC day (`Schedule.DAY`, SPEC §6.1).
export const SECONDS_PER_DAY = 86_400n;

/// Seconds per week (`Schedule.WEEK`, SPEC §6.1).
export const SECONDS_PER_WEEK = 604_800n;

/// 1970-01-01 was a Thursday; shifting by three days makes each week start on Monday 00:00 UTC
/// (`Schedule.WEEK_OFFSET`, SPEC §6.1).
export const WEEK_OFFSET = 259_200n;

/// Days from 0000-03-01 (the civil algorithm's internal epoch) to 1970-01-01 (`Schedule.DAYS_SHIFT`).
export const DAYS_SHIFT = 719_468n;

/// Days in a 400-year Gregorian era (`Schedule.ERA_DAYS`).
export const ERA_DAYS = 146_097n;

/// `requestDeadline = closedAt + REQUEST_WINDOW` (`REQUEST_WINDOW` in Types.sol, SPEC §6.2).
export const REQUEST_WINDOW = 86_400n;

/// Lower bound on `PricingConfig.maxPriceAge` (`MIN_PRICE_AGE` in Types.sol, SPEC §3.1).
export const MIN_PRICE_AGE = 60n;

/// Upper bound on `PricingConfig.maxPriceAge` (`MAX_PRICE_AGE` in Types.sol, SPEC §3.1).
export const MAX_PRICE_AGE = 172_800n;

/// Floor of the price-age policy: `max(2H, 3600)` (SPEC §3.1, `spec_reference.max_price_age`).
export const PRICE_AGE_FLOOR = 3_600n;

/// Highest supported token or feed decimal count (`PriceReader.MAX_DECIMALS`, SPEC §3.1).
export const MAX_DECIMALS = 18;
