// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PricingConfig, QuoteReason, MIN_PRICE_AGE, MAX_PRICE_AGE} from "../Types.sol";
import {InvalidConfig, PriceInvalid} from "../Errors.sol";

/// @title PriceReader
/// @notice Reads and validates a Chainlink AggregatorV3 feed and derives the USD 1 admission minimum, the
///         whole-USD value of a pot and the gross needed to reach a round's target (SPEC §3.1, §3.2, §8.1).
/// @dev The library never supplies a fallback price and never writes state. `read` classifies a failure
///      instead of reverting so that `quoteBuy` can report it (SPEC §8.1); `buy` turns a nonzero
///      `QuoteReason` into the matching custom error from Errors.sol. Only new entries depend on a price:
///      close, request, settlement and refunds never call this library.
library PriceReader {
    /// @dev Highest supported token or feed decimal count (SPEC §3.1); keeps 10^(d+f) within uint256.
    uint8 internal constant MAX_DECIMALS = 18;

    /// @notice One feed observation, recorded with the entry that used it (SPEC §3.2, §8.2).
    /// @param roundId Aggregator round identifier.
    /// @param answer Reported answer in feed decimals.
    /// @param updatedAt Timestamp of the answer.
    struct Observation {
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
    }

    /// @notice Reads the frozen feed and classifies the result.
    /// @dev Calls `decimals()` and `latestRoundData()` exactly once each, both through try/catch. Precedence
    ///      (SPEC §3.2): a missing or reverting feed is PriceUnavailable, then a changed decimal count is
    ///      PriceDecimalsChanged, then roundId==0 / answer<=0 / updatedAt==0 / updatedAt in the future / an
    ///      answer at or beyond a nonzero circuit-breaker bound is PriceInvalid, then age above maxPriceAge is
    ///      PriceStale. An observation is returned whenever `latestRoundData()` succeeded, including on a
    ///      rejected quote, so callers can surface the offending round.
    /// @param cfg The round's frozen pricing configuration.
    /// @return reason QuoteReason.None when the answer is usable, otherwise the first failing check.
    /// @return obs The observation read from the feed; zeroed when the feed could not be read.
    function read(PricingConfig memory cfg) internal view returns (QuoteReason reason, Observation memory obs) {
        if (cfg.feed.code.length == 0) return (QuoteReason.PriceUnavailable, obs);

        uint8 liveDecimals;
        try AggregatorV3Interface(cfg.feed).decimals() returns (uint8 d) {
            liveDecimals = d;
        } catch {
            return (QuoteReason.PriceUnavailable, obs);
        }

        try AggregatorV3Interface(cfg.feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            obs = Observation({roundId: roundId, answer: answer, updatedAt: updatedAt});
        } catch {
            return (QuoteReason.PriceUnavailable, obs);
        }

        if (liveDecimals != cfg.feedDecimals) return (QuoteReason.PriceDecimalsChanged, obs);

        if (obs.roundId == 0 || obs.answer <= 0 || obs.updatedAt == 0 || obs.updatedAt > block.timestamp) {
            return (QuoteReason.PriceInvalid, obs);
        }
        // An answer clamped at an aggregator circuit breaker is not a market price (SPEC §3.1).
        if (cfg.minAnswer != 0 && obs.answer <= cfg.minAnswer) return (QuoteReason.PriceInvalid, obs);
        if (cfg.maxAnswer != 0 && obs.answer >= cfg.maxAnswer) return (QuoteReason.PriceInvalid, obs);

        if (block.timestamp - obs.updatedAt > cfg.maxPriceAge) return (QuoteReason.PriceStale, obs);

        return (QuoteReason.None, obs);
    }

    /// @notice Smallest gross raw amount worth at least USD 1 at `price` (SPEC §3.2).
    /// @dev `ceil(10^(d+f) / price)`, so `usdValue(minGrossRaw) >= 1` and one raw unit less is below USD 1.
    /// @param tokenDecimals Token decimals d, 0-18.
    /// @param feedDecimals Feed decimals f, 0-18.
    /// @param price Feed answer p, strictly positive, in feed decimals.
    /// @return The USD 1 admission threshold in raw token units.
    function minGrossRaw(uint8 tokenDecimals, uint8 feedDecimals, uint256 price) internal pure returns (uint256) {
        uint256 scale = _scale(tokenDecimals, feedDecimals);
        if (price == 0) revert PriceInvalid();
        return Math.ceilDiv(scale, price);
    }

    /// @notice Whole-USD reference value of a gross raw amount (SPEC §3.2).
    /// @dev `floor(gross * price / 10^(d+f))` at full precision; the intermediate product never overflows.
    ///      Used for the round target check, never for weights or payouts.
    /// @param gross Gross raw token units.
    /// @param tokenDecimals Token decimals d, 0-18.
    /// @param feedDecimals Feed decimals f, 0-18.
    /// @param price Feed answer p in feed decimals.
    /// @return Whole USD, rounded down.
    function usdValue(uint256 gross, uint8 tokenDecimals, uint8 feedDecimals, uint256 price)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(gross, price, _scale(tokenDecimals, feedDecimals));
    }

    /// @notice Whole-USD value for an advisory quote, or false when the result cannot fit in uint256.
    /// @dev Split gross into quotient and remainder: floor(g*p/s) = (g/s)*p + floor((g%s)*p/s).
    ///      The fractional term is always below price; checked multiply/add report overflow without reverting.
    function tryUsdValue(uint256 gross, uint8 tokenDecimals, uint8 feedDecimals, uint256 price)
        internal
        pure
        returns (bool success, uint256 value)
    {
        uint256 scale = _scale(tokenDecimals, feedDecimals);
        (bool fits, uint256 whole) = Math.tryMul(gross / scale, price);
        if (!fits) return (false, 0);
        return Math.tryAdd(whole, Math.mulDiv(gross % scale, price, scale));
    }

    /// @notice Smallest gross raw amount whose reference value reaches `targetUsd` (SPEC §3.2, §6.1).
    /// @dev `ceil(targetUsd * 10^(d+f) / price)` at full precision, so `usdValue` of the result is at least
    ///      `targetUsd` and one raw unit less is below it.
    /// @param tokenDecimals Token decimals d, 0-18.
    /// @param feedDecimals Feed decimals f, 0-18.
    /// @param price Feed answer p, strictly positive, in feed decimals.
    /// @param targetUsd The round's frozen whole-USD target.
    /// @return The smallest pot in raw token units that reaches the target at this price.
    function minGrossForTarget(uint8 tokenDecimals, uint8 feedDecimals, uint256 price, uint256 targetUsd)
        internal
        pure
        returns (uint256)
    {
        uint256 scale = _scale(tokenDecimals, feedDecimals);
        if (price == 0) revert PriceInvalid();
        return Math.mulDiv(targetUsd, scale, price, Math.Rounding.Ceil);
    }

    /// @notice Validates a PricingConfig for pool admission and for the next round's frozen copy (SPEC §8.1).
    /// @dev Requires feed code, a `decimals()` result equal to the frozen value, feedDecimals <= 18,
    ///      MIN_PRICE_AGE <= maxPriceAge <= MAX_PRICE_AGE, non-negative answer bounds, and minAnswer < maxAnswer
    ///      whenever both bounds are nonzero (a lone bound is accepted). It deliberately does not require a fresh positive answer: an oracle outage must not block
    ///      configuration, closing or advancing. Reverts InvalidConfig on any failure.
    /// @param cfg The candidate configuration.
    function validateConfig(PricingConfig memory cfg) internal view {
        if (cfg.feedDecimals > MAX_DECIMALS) revert InvalidConfig();
        if (cfg.maxPriceAge < MIN_PRICE_AGE || cfg.maxPriceAge > MAX_PRICE_AGE) revert InvalidConfig();
        if (cfg.minAnswer < 0 || cfg.maxAnswer < 0) revert InvalidConfig();
        if (cfg.minAnswer != 0 && cfg.maxAnswer != 0 && cfg.minAnswer >= cfg.maxAnswer) revert InvalidConfig();
        if (cfg.feed.code.length == 0) revert InvalidConfig();
        try AggregatorV3Interface(cfg.feed).decimals() returns (uint8 d) {
            if (d != cfg.feedDecimals) revert InvalidConfig();
        } catch {
            revert InvalidConfig();
        }
    }

    /// @notice 10^(d+f), the raw-unit-to-USD scale (SPEC §3.2).
    /// @dev The exponent is at most 36, so the power always fits in uint256.
    /// @param tokenDecimals Token decimals d, 0-18.
    /// @param feedDecimals Feed decimals f, 0-18.
    /// @return The scale factor.
    function _scale(uint8 tokenDecimals, uint8 feedDecimals) private pure returns (uint256) {
        if (tokenDecimals > MAX_DECIMALS || feedDecimals > MAX_DECIMALS) revert InvalidConfig();
        return 10 ** (uint256(tokenDecimals) + uint256(feedDecimals));
    }
}
