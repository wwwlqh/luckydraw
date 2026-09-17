// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";
import {PriceReader} from "../../src/lib/PriceReader.sol";
import {PricingConfig, QuoteReason, ReferenceKind, MIN_PRICE_AGE, MAX_PRICE_AGE} from "../../src/Types.sol";
import {InvalidConfig, PriceInvalid} from "../../src/Errors.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";

/// @notice External wrapper so revert expectations target a real call frame.
contract PriceReaderHarness {
    function read(PricingConfig memory cfg)
        external
        view
        returns (QuoteReason reason, PriceReader.Observation memory obs)
    {
        return PriceReader.read(cfg);
    }

    function minGrossRaw(uint8 tokenDecimals, uint8 feedDecimals, uint256 price) external pure returns (uint256) {
        return PriceReader.minGrossRaw(tokenDecimals, feedDecimals, price);
    }

    function usdValue(uint256 gross, uint8 tokenDecimals, uint8 feedDecimals, uint256 price)
        external
        pure
        returns (uint256)
    {
        return PriceReader.usdValue(gross, tokenDecimals, feedDecimals, price);
    }

    function minGrossForTarget(uint8 tokenDecimals, uint8 feedDecimals, uint256 price, uint256 targetUsd)
        external
        pure
        returns (uint256)
    {
        return PriceReader.minGrossForTarget(tokenDecimals, feedDecimals, price, targetUsd);
    }

    function tryUsdValue(uint256 gross, uint8 tokenDecimals, uint8 feedDecimals, uint256 price)
        external
        pure
        returns (bool, uint256)
    {
        return PriceReader.tryUsdValue(gross, tokenDecimals, feedDecimals, price);
    }

    function validateConfig(PricingConfig memory cfg) external view {
        PriceReader.validateConfig(cfg);
    }
}

/// @notice Reads one `minimum[]` or `targetGross[]` row from the reference vector file.
/// @dev One external call per row, so the 148 KB document is loaded and discarded inside this contract's own
///      frame instead of accumulating in the test's memory (EVM memory gas is quadratic). Fields are read
///      individually because the generator writes large integers as JSON strings and small ones as numbers;
///      `parseJsonUint` coerces both, while a single struct decode would not.
contract PriceVectors {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant FILE = "./test/vectors/spec_vectors.json";

    /// @param i Row index.
    /// @return found False once the index is past the end of the array.
    /// @return tokenDecimals Token decimals d.
    /// @return feedDecimals Feed decimals f.
    /// @return price Feed answer p.
    /// @return minGrossRaw Expected USD 1 threshold.
    function minimumAt(uint256 i)
        external
        view
        returns (bool found, uint256 tokenDecimals, uint256 feedDecimals, uint256 price, uint256 minGrossRaw)
    {
        string memory json = VM.readFile(FILE);
        string memory element = string.concat(".minimum[", VM.toString(i), "]");
        if (!stdJson.keyExists(json, string.concat(element, ".price"))) return (false, 0, 0, 0, 0);
        found = true;
        tokenDecimals = stdJson.readUint(json, string.concat(element, ".tokenDecimals"));
        feedDecimals = stdJson.readUint(json, string.concat(element, ".feedDecimals"));
        price = stdJson.readUint(json, string.concat(element, ".price"));
        minGrossRaw = stdJson.readUint(json, string.concat(element, ".minGrossRaw"));
    }

    /// @param i Row index.
    /// @return found False once the index is past the end of the array.
    /// @return tokenDecimals Token decimals d.
    /// @return feedDecimals Feed decimals f.
    /// @return price Feed answer p.
    /// @return targetUsd Whole-USD round target.
    /// @return minGrossToReach Expected smallest gross reaching the target.
    function targetAt(uint256 i)
        external
        view
        returns (
            bool found,
            uint256 tokenDecimals,
            uint256 feedDecimals,
            uint256 price,
            uint256 targetUsd,
            uint256 minGrossToReach
        )
    {
        string memory json = VM.readFile(FILE);
        string memory element = string.concat(".targetGross[", VM.toString(i), "]");
        if (!stdJson.keyExists(json, string.concat(element, ".price"))) return (false, 0, 0, 0, 0, 0);
        found = true;
        tokenDecimals = stdJson.readUint(json, string.concat(element, ".tokenDecimals"));
        feedDecimals = stdJson.readUint(json, string.concat(element, ".feedDecimals"));
        price = stdJson.readUint(json, string.concat(element, ".price"));
        targetUsd = stdJson.readUint(json, string.concat(element, ".targetUsd"));
        minGrossToReach = stdJson.readUint(json, string.concat(element, ".minGrossToReach"));
    }
}

/// @notice Unit tests for feed reading, the USD 1 minimum and the whole-USD target math
///         (SPEC §3.1, §3.2, §8.1; ACCEPTANCE A08, A10, A40, A44).
contract PriceReaderTest is Test {
    uint8 internal constant FEED_DECIMALS = 8;
    uint32 internal constant MAX_AGE = 3600;
    uint256 internal constant NOW = 1789084800; // 2026-09-11 00:00 UTC
    int256 internal constant PRICE_600 = 600e8;

    PriceReaderHarness internal harness;
    PriceVectors internal vectors;
    MockAggregatorV3 internal feed;

    function setUp() public {
        harness = new PriceReaderHarness();
        vectors = new PriceVectors();
        feed = new MockAggregatorV3(FEED_DECIMALS);
        vm.warp(NOW);
        feed.set(1, PRICE_600, NOW);
    }

    // --- Reference vectors -------------------------------------------------------------------------------

    /// @notice Every USD 1 minimum vector must match, and the threshold must be the exact boundary.
    function test_Minimum_MatchesAllVectors() public view {
        uint256 checked;
        for (uint256 i = 0;; ++i) {
            (bool found, uint256 d, uint256 f, uint256 price, uint256 expected) = vectors.minimumAt(i);
            if (!found) break;
            checked += 1;

            string memory at = string.concat(
                " at vector ", vm.toString(i), " d=", vm.toString(d), " f=", vm.toString(f), " p=", vm.toString(price)
            );
            uint256 minimum = PriceReader.minGrossRaw(uint8(d), uint8(f), price);
            assertEq(minimum, expected, string.concat("minGrossRaw", at));
            assertGe(PriceReader.usdValue(minimum, uint8(d), uint8(f), price), 1, string.concat("reaches USD 1", at));
            assertEq(
                PriceReader.usdValue(minimum - 1, uint8(d), uint8(f), price),
                0,
                string.concat("one raw unit below is under USD 1", at)
            );
        }
        assertGt(checked, 100, "minimum vector set unexpectedly small");
    }

    /// @notice Every target vector must match, and the result must be the exact target boundary.
    function test_TargetGross_MatchesAllVectors() public view {
        uint256 checked;
        for (uint256 i = 0;; ++i) {
            (bool found, uint256 d, uint256 f, uint256 price, uint256 target, uint256 expected) = vectors.targetAt(i);
            if (!found) break;
            checked += 1;

            string memory at = string.concat(
                " at vector ",
                vm.toString(i),
                " d=",
                vm.toString(d),
                " f=",
                vm.toString(f),
                " target=",
                vm.toString(target)
            );
            uint256 gross = PriceReader.minGrossForTarget(uint8(d), uint8(f), price, target);
            assertEq(gross, expected, string.concat("minGrossForTarget", at));
            assertGe(PriceReader.usdValue(gross, uint8(d), uint8(f), price), target, string.concat("reaches", at));
            assertLt(PriceReader.usdValue(gross - 1, uint8(d), uint8(f), price), target, string.concat("one below", at));
            assertGe(
                gross, PriceReader.minGrossRaw(uint8(d), uint8(f), price), string.concat("at least the minimum", at)
            );
        }
        assertGt(checked, 50, "target vector set unexpectedly small");
    }

    // --- Documented examples (SPEC §3.2) -----------------------------------------------------------------

    /// @notice d=18, f=8, p=600e8: the USD 1 minimum is 1,666,666,666,666,667 wei and one wei less fails.
    function test_DocumentedMinimumExample() public pure {
        uint256 minimum = PriceReader.minGrossRaw(18, FEED_DECIMALS, uint256(PRICE_600));
        assertEq(minimum, 1666666666666667, "documented BNB minimum");
        assertEq(PriceReader.usdValue(minimum, 18, FEED_DECIMALS, uint256(PRICE_600)), 1, "values at USD 1");
        assertEq(PriceReader.usdValue(minimum - 1, 18, FEED_DECIMALS, uint256(PRICE_600)), 0, "one wei less is USD 0");
    }

    /// @notice The same price makes 1,666,666,666,666,666,667 wei the smallest pot worth USD 1,000.
    function test_DocumentedTargetExample() public pure {
        uint256 gross = PriceReader.minGrossForTarget(18, FEED_DECIMALS, uint256(PRICE_600), 1000);
        assertEq(gross, 1666666666666666667, "documented USD 1,000 target gross");
        assertEq(PriceReader.usdValue(gross, 18, FEED_DECIMALS, uint256(PRICE_600)), 1000, "values at USD 1,000");
        assertEq(PriceReader.usdValue(gross - 1, 18, FEED_DECIMALS, uint256(PRICE_600)), 999, "one wei less is USD 999");
    }

    // --- Math properties ---------------------------------------------------------------------------------

    /// @notice The minimum is the exact USD 1 boundary for every supported decimal pair and price.
    function testFuzz_MinimumIsTheUsdOneBoundary(uint8 rawD, uint8 rawF, uint256 price) public pure {
        uint8 d = uint8(bound(rawD, 0, 18));
        uint8 f = uint8(bound(rawF, 0, 18));
        price = bound(price, 1, type(uint256).max);

        uint256 minimum = PriceReader.minGrossRaw(d, f, price);
        assertGe(minimum, 1, "minimum is at least one raw unit");
        assertGe(PriceReader.usdValue(minimum, d, f, price), 1, "minimum reaches USD 1");
        assertEq(PriceReader.usdValue(minimum - 1, d, f, price), 0, "one raw unit below is under USD 1");
    }

    /// @notice The target gross is the exact whole-USD boundary and never below the USD 1 minimum.
    function testFuzz_TargetGrossIsTheTargetBoundary(uint8 rawD, uint8 rawF, uint256 price, uint32 rawTarget)
        public
        pure
    {
        uint8 d = uint8(bound(rawD, 0, 18));
        uint8 f = uint8(bound(rawF, 0, 18));
        price = bound(price, 1, type(uint256).max);
        uint256 target = bound(rawTarget, 1, type(uint32).max);

        uint256 gross = PriceReader.minGrossForTarget(d, f, price, target);
        assertGe(PriceReader.usdValue(gross, d, f, price), target, "target gross reaches the target");
        assertLt(PriceReader.usdValue(gross - 1, d, f, price), target, "one raw unit below misses the target");
        assertGe(gross, PriceReader.minGrossRaw(d, f, price), "target gross is at least the USD 1 minimum");
    }

    /// @notice usdValue never decreases as the pot grows, and a target of USD 1 is the minimum itself.
    function testFuzz_UsdValueIsMonotonic(uint8 rawD, uint8 rawF, uint256 price, uint256 gross, uint256 delta)
        public
        pure
    {
        uint8 d = uint8(bound(rawD, 0, 18));
        uint8 f = uint8(bound(rawF, 0, 18));
        price = bound(price, 1, 1e30);
        gross = bound(gross, 0, 1e30);
        delta = bound(delta, 0, 1e30);

        assertLe(
            PriceReader.usdValue(gross, d, f, price),
            PriceReader.usdValue(gross + delta, d, f, price),
            "usdValue is nondecreasing in gross"
        );
        assertEq(
            PriceReader.minGrossForTarget(d, f, price, 1),
            PriceReader.minGrossRaw(d, f, price),
            "a USD 1 target is the USD 1 minimum"
        );
    }

    /// @notice A zero price and out-of-range decimals are rejected rather than silently dividing by zero.
    function test_RevertWhen_MathInputsAreOutOfRange() public {
        vm.expectRevert(PriceInvalid.selector);
        harness.minGrossRaw(18, FEED_DECIMALS, 0);

        vm.expectRevert(PriceInvalid.selector);
        harness.minGrossForTarget(18, FEED_DECIMALS, 0, 100);

        vm.expectRevert(InvalidConfig.selector);
        harness.minGrossRaw(19, FEED_DECIMALS, uint256(PRICE_600));

        vm.expectRevert(InvalidConfig.selector);
        harness.usdValue(1e18, 18, 19, uint256(PRICE_600));

        vm.expectRevert(InvalidConfig.selector);
        harness.minGrossForTarget(19, FEED_DECIMALS, uint256(PRICE_600), 100);
    }

    // --- read(): success ---------------------------------------------------------------------------------

    /// @notice A fresh in-bounds answer is accepted and reported verbatim.
    function test_Read_AcceptsFreshAnswer() public view {
        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.None), "reason");
        assertEq(uint256(obs.roundId), 1, "roundId");
        assertEq(obs.answer, PRICE_600, "answer");
        assertEq(obs.updatedAt, NOW, "updatedAt");
    }

    /// @notice The feed is consulted exactly once per read (SPEC §3.2: validate the feed once per buy).
    function test_Read_CallsFeedOncePerFunction() public {
        vm.expectCall(address(feed), abi.encodeWithSignature("decimals()"), 1);
        vm.expectCall(address(feed), abi.encodeWithSignature("latestRoundData()"), 1);
        harness.read(_cfg());
    }

    // --- read(): PriceUnavailable ------------------------------------------------------------------------

    /// @notice An address with no code is unavailable, not merely invalid.
    function test_Read_UnavailableWhenFeedHasNoCode() public view {
        PricingConfig memory cfg = _cfg();
        cfg.feed = address(0xBEEF);

        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(cfg);
        assertEq(uint256(reason), uint256(QuoteReason.PriceUnavailable), "reason");
        assertEq(uint256(obs.roundId), 0, "no observation");
        assertEq(obs.answer, 0, "no answer");
        assertEq(obs.updatedAt, 0, "no timestamp");
    }

    /// @notice A reverting decimals() call is unavailable.
    function test_Read_UnavailableWhenDecimalsReverts() public {
        feed.setRevert(false, true);

        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceUnavailable), "reason");
        assertEq(uint256(obs.roundId), 0, "no observation");
    }

    /// @notice A reverting latestRoundData() call is unavailable and yields no observation.
    function test_Read_UnavailableWhenLatestRoundDataReverts() public {
        feed.setRevert(true, false);

        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceUnavailable), "reason");
        assertEq(uint256(obs.roundId), 0, "no observation");
        assertEq(obs.answer, 0, "no answer");
    }

    /// @notice Unavailable outranks a changed decimal count.
    function test_Read_UnavailableOutranksDecimalsChanged() public {
        feed.setDecimals(18);
        feed.setRevert(true, false);

        (QuoteReason reason,) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceUnavailable), "reason");
    }

    // --- read(): PriceDecimalsChanged --------------------------------------------------------------------

    /// @notice A decimal count different from the frozen one blocks the quote but still reports the round.
    function test_Read_DecimalsChanged() public {
        feed.setDecimals(FEED_DECIMALS + 1);

        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceDecimalsChanged), "reason");
        assertEq(obs.answer, PRICE_600, "observation still reported");
    }

    /// @notice A changed decimal count outranks an invalid answer.
    function test_Read_DecimalsChangedOutranksInvalid() public {
        feed.setDecimals(FEED_DECIMALS + 1);
        feed.set(0, 0, 0);

        (QuoteReason reason,) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceDecimalsChanged), "reason");
    }

    // --- read(): PriceInvalid ----------------------------------------------------------------------------

    /// @notice Round zero is invalid.
    function test_Read_InvalidWhenRoundIdIsZero() public {
        feed.set(0, PRICE_600, NOW);
        _assertReason(QuoteReason.PriceInvalid);
    }

    /// @notice A zero or negative answer is invalid.
    function test_Read_InvalidWhenAnswerIsNotPositive() public {
        feed.set(1, 0, NOW);
        _assertReason(QuoteReason.PriceInvalid);

        feed.set(1, -1, NOW);
        _assertReason(QuoteReason.PriceInvalid);
    }

    /// @notice A zero timestamp is invalid regardless of the age tolerance.
    function test_Read_InvalidWhenUpdatedAtIsZero() public {
        feed.set(1, PRICE_600, 0);
        _assertReason(QuoteReason.PriceInvalid);
    }

    /// @notice A timestamp in the future is invalid; the current block timestamp is not.
    function test_Read_InvalidWhenUpdatedAtIsInTheFuture() public {
        feed.set(1, PRICE_600, NOW + 1);
        _assertReason(QuoteReason.PriceInvalid);

        feed.set(1, PRICE_600, NOW);
        _assertReason(QuoteReason.None);
    }

    /// @notice An answer at or below a nonzero minAnswer is a clamped circuit breaker, not a market price.
    function test_Read_InvalidAtMinAnswerBound() public {
        PricingConfig memory cfg = _cfg();
        cfg.minAnswer = 100e8;
        cfg.maxAnswer = 1000e8;

        feed.set(1, 100e8, NOW);
        _assertReasonFor(cfg, QuoteReason.PriceInvalid);

        feed.set(1, 100e8 - 1, NOW);
        _assertReasonFor(cfg, QuoteReason.PriceInvalid);

        feed.set(1, 100e8 + 1, NOW);
        _assertReasonFor(cfg, QuoteReason.None);
    }

    /// @notice An answer at or above a nonzero maxAnswer is a clamped circuit breaker.
    function test_Read_InvalidAtMaxAnswerBound() public {
        PricingConfig memory cfg = _cfg();
        cfg.minAnswer = 100e8;
        cfg.maxAnswer = 1000e8;

        feed.set(1, 1000e8, NOW);
        _assertReasonFor(cfg, QuoteReason.PriceInvalid);

        feed.set(1, 1000e8 + 1, NOW);
        _assertReasonFor(cfg, QuoteReason.PriceInvalid);

        feed.set(1, 1000e8 - 1, NOW);
        _assertReasonFor(cfg, QuoteReason.None);
    }

    /// @notice Zero bounds mean "no aggregator circuit breaker" and never reject an answer.
    function test_Read_ZeroBoundsAreNotEnforced() public {
        feed.set(1, 1, NOW);
        _assertReason(QuoteReason.None);

        feed.set(1, type(int256).max, NOW);
        _assertReason(QuoteReason.None);
    }

    /// @notice An invalid answer outranks staleness.
    function test_Read_InvalidOutranksStale() public {
        feed.set(1, 0, NOW - MAX_AGE - 1000);
        _assertReason(QuoteReason.PriceInvalid);
    }

    // --- read(): PriceStale ------------------------------------------------------------------------------

    /// @notice An age exactly equal to maxPriceAge is still fresh; one second more is stale.
    function test_Read_StalenessBoundary() public {
        feed.set(1, PRICE_600, NOW - MAX_AGE);
        _assertReason(QuoteReason.None);

        feed.set(1, PRICE_600, NOW - MAX_AGE - 1);
        _assertReason(QuoteReason.PriceStale);
    }

    /// @notice A stale answer is still reported so the caller can show the offending round.
    function test_Read_StaleStillReportsObservation() public {
        feed.set(7, PRICE_600, NOW - MAX_AGE - 1);

        (QuoteReason reason, PriceReader.Observation memory obs) = PriceReader.read(_cfg());
        assertEq(uint256(reason), uint256(QuoteReason.PriceStale), "reason");
        assertEq(uint256(obs.roundId), 7, "roundId");
        assertEq(obs.updatedAt, NOW - MAX_AGE - 1, "updatedAt");
    }

    // --- validateConfig ----------------------------------------------------------------------------------

    /// @notice A well-formed configuration is accepted even while the feed has never published an answer,
    ///         so an oracle outage cannot block admission or the next round (SPEC §8.1).
    function test_ValidateConfig_AcceptsDuringOracleOutage() public {
        feed.set(0, 0, 0);
        harness.validateConfig(_cfg());

        feed.setRevert(true, false); // latestRoundData() unusable, decimals() still answers
        harness.validateConfig(_cfg());
    }

    /// @notice Both aggregator bound conventions are accepted: absent (0,0) or ordered min < max.
    function test_ValidateConfig_AcceptsBoundConventions() public view {
        PricingConfig memory cfg = _cfg();
        harness.validateConfig(cfg);

        cfg.minAnswer = 1;
        cfg.maxAnswer = type(int256).max;
        harness.validateConfig(cfg);

        cfg.minAnswer = 5;
        cfg.maxAnswer = 10;
        harness.validateConfig(cfg);
    }

    /// @notice The age policy window is inclusive at both ends (SPEC §3.1, ADR 020).
    function test_ValidateConfig_AgeWindowIsInclusive() public {
        PricingConfig memory cfg = _cfg();

        cfg.maxPriceAge = MIN_PRICE_AGE;
        harness.validateConfig(cfg);

        cfg.maxPriceAge = MAX_PRICE_AGE;
        harness.validateConfig(cfg);

        cfg.maxPriceAge = MIN_PRICE_AGE - 1;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        cfg.maxPriceAge = MAX_PRICE_AGE + 1;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);
    }

    /// @notice A missing feed, an unreadable feed and a mismatched decimal count are all rejected.
    function test_RevertWhen_ValidateConfigCannotConfirmTheFeed() public {
        PricingConfig memory cfg = _cfg();
        cfg.feed = address(0);
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        cfg.feed = address(0xBEEF); // no code
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        feed.setDecimals(FEED_DECIMALS + 1);
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(_cfg());

        feed.setDecimals(FEED_DECIMALS);
        feed.setRevert(false, true);
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(_cfg());
    }

    /// @notice Feed decimals above 18 are rejected even when the feed agrees with the frozen value.
    function test_RevertWhen_ValidateConfigDecimalsAboveEighteen() public {
        MockAggregatorV3 wide = new MockAggregatorV3(19);
        PricingConfig memory cfg = _cfg();
        cfg.feed = address(wide);
        cfg.feedDecimals = 19;

        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);
    }

    /// @notice Unordered, degenerate or negative bounds are rejected; a lone bound is accepted (SPEC §8.1).
    function test_RevertWhen_ValidateConfigBoundsAreUnordered() public {
        PricingConfig memory cfg = _cfg();

        cfg.minAnswer = 10;
        cfg.maxAnswer = 10;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        cfg.minAnswer = 100;
        cfg.maxAnswer = 10;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        cfg.minAnswer = -1;
        cfg.maxAnswer = 0;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        cfg.minAnswer = 0;
        cfg.maxAnswer = -1;
        vm.expectRevert(InvalidConfig.selector);
        harness.validateConfig(cfg);

        // A feed with only a lower or only an upper bound is valid.
        cfg.minAnswer = 10;
        cfg.maxAnswer = 0;
        harness.validateConfig(cfg);
        cfg.minAnswer = 0;
        cfg.maxAnswer = 10;
        harness.validateConfig(cfg);
    }

    // --- helpers -----------------------------------------------------------------------------------------

    function test_TryUsdValue_ExactOverflowBoundaryAndFractionalCarry() public view {
        uint256 max = type(uint256).max;
        uint256 boundary = max / 6;
        (bool fits, uint256 value) = harness.tryUsdValue(boundary, 2, 8, 600e8);
        assertTrue(fits);
        assertEq(value, boundary * 6);
        (fits, value) = harness.tryUsdValue(boundary + 1, 2, 8, 600e8);
        assertFalse(fits);
        assertEq(value, 0);
        (fits, value) = harness.tryUsdValue(max, 2, 0, 100);
        assertTrue(fits);
        assertEq(value, max, "exact maximum is representable");
        (fits, value) = harness.tryUsdValue((max / 101) * 100 + 99, 2, 0, 101);
        assertFalse(fits, "fractional term can overflow an otherwise fitting whole term");
        assertEq(value, 0);
    }

    function testFuzz_TryUsdValueMatchesFullPrecision(uint256 gross, uint128 price, uint8 d, uint8 f) public view {
        d = uint8(bound(d, 0, 18));
        f = uint8(bound(f, 0, 18));
        (bool fits, uint256 value) = harness.tryUsdValue(gross, d, f, price);
        try harness.usdValue(gross, d, f, price) returns (uint256 expected) {
            assertTrue(fits);
            assertEq(value, expected);
        } catch {
            assertFalse(fits);
            assertEq(value, 0);
        }
    }

    function _cfg() internal view returns (PricingConfig memory) {
        return PricingConfig({
            feed: address(feed),
            feedDecimals: FEED_DECIMALS,
            maxPriceAge: MAX_AGE,
            referenceKind: ReferenceKind.ExactToken,
            minAnswer: 0,
            maxAnswer: 0
        });
    }

    function _assertReason(QuoteReason expected) internal view {
        _assertReasonFor(_cfg(), expected);
    }

    function _assertReasonFor(PricingConfig memory cfg, QuoteReason expected) internal view {
        (QuoteReason reason,) = PriceReader.read(cfg);
        assertEq(uint256(reason), uint256(expected), "quote reason");
    }
}
