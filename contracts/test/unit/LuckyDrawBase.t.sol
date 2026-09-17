// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {
    BPS,
    FEE_BPS,
    Kind,
    NATIVE_ASSET,
    PricingConfig,
    Range,
    ReferenceKind,
    REQUEST_WINDOW,
    State
} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @notice Exposes LuckyDraw's internal selection helpers so the reference vectors can be checked directly.
/// @dev Labeled test harness: it adds functions and a probe array but changes no inherited behaviour.
contract LuckyDrawHarness is LuckyDraw {
    Range[] private _probe;

    constructor(
        address vault_,
        address coordinator,
        uint256 subscriptionId,
        bytes32 keyHash,
        uint16 requestConfirmations,
        uint32 callbackGasLimit,
        uint256 maxRequestCostNative,
        address initialFeeAccount,
        address initialOwner
    )
        LuckyDraw(
            vault_,
            coordinator,
            subscriptionId,
            keyHash,
            requestConfirmations,
            callbackGasLimit,
            maxRequestCostNative,
            initialFeeAccount,
            initialOwner
        )
    {}

    /// @notice Appends a probe range used only by `findRange`.
    function pushRange(address buyer, uint256 cumulativeGross) external {
        _probe.push(Range({buyer: buyer, cumulativeGross: cumulativeGross}));
    }

    /// @notice Appends `count` evenly sized probe ranges in one call, for search-depth measurements.
    function pushRanges(address buyer, uint256 count, uint256 step) external {
        uint256 cumulative = _probe.length == 0 ? 0 : _probe[_probe.length - 1].cumulativeGross;
        for (uint256 i = 0; i < count; ++i) {
            cumulative += step;
            _probe.push(Range({buyer: buyer, cumulativeGross: cumulative}));
        }
    }

    /// @notice Number of probe ranges.
    function rangeCount() external view returns (uint256) {
        return _probe.length;
    }

    /// @notice Clears the probe ranges.
    function clearRanges() external {
        delete _probe;
    }

    /// @notice Runs the production binary search over the probe ranges.
    function findRange(uint256 index) external view returns (address) {
        return _findRange(_probe, index);
    }

    /// @notice Runs the production cumulative fee split.
    function feeSplit(uint256 grossTotal, uint256 feeReserved, uint256 gross)
        external
        pure
        returns (uint256 feeDelta, uint256 netDelta)
    {
        return _feeSplit(grossTotal, feeReserved, gross);
    }

    /// @notice Runs the production 512-bit modulo reduction.
    function winningIndexOf(uint256 word0, uint256 word1, uint256 weight) external pure returns (uint256) {
        return _winningIndexOf(word0, word1, weight);
    }
}

/// @notice Shared fixture for the LuckyDraw unit suites (SPEC §11.2 "Lifecycle").
/// @dev Abstract: no test cases run from this file. Two pools exist from `setUp`:
///      pool 1 is native BNB (18 decimals) against a USD 600 feed, pool 2 is a 2-decimal token against a
///      USD 1 feed, which is the worked example of SPEC §5.2 (entries 1.00, 2.00 and 7.00).
abstract contract LuckyDrawBase is Test {
    LuckyVault internal vault;
    LuckyDraw internal draw;
    MockVRFCoordinatorV2Plus internal coordinator;
    MockAggregatorV3 internal feed; // 8 decimals, USD 600 (native)
    MockAggregatorV3 internal feed2; // 8 decimals, USD 1 (2-decimal token)
    MockERC20 internal tkn2; // 2 decimals, exact transfer

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal feeAcc = makeAddr("feeAccount");
    address internal seedSafe = makeAddr("seedSafe");
    address internal keeper = makeAddr("keeper");

    uint256 internal subId;

    /// @dev 2026-09-11 12:00:00 UTC, a Friday: every cutoff below is a partial period.
    uint256 internal constant START = 1_789_128_000;
    uint64 internal constant DAY_CUTOFF = 1_789_171_200; // Sat 2026-09-12 00:00 UTC
    uint64 internal constant WEEK_CUTOFF = 1_789_344_000; // Mon 2026-09-14 00:00 UTC
    uint64 internal constant MONTH_CUTOFF = 1_790_812_800; // Thu 2026-10-01 00:00 UTC

    bytes32 internal constant KEY_HASH = keccak256("luckydraw.test.gaslane");
    uint16 internal constant CONFIRMATIONS = 200;
    uint32 internal constant CALLBACK_GAS = 300_000;
    uint256 internal constant MAX_REQUEST_COST = 0.01 ether;
    uint8 internal constant FEED_DECIMALS = 8;
    uint32 internal constant MAX_AGE = 3600;
    int256 internal constant PRICE_600 = 600e8;
    int256 internal constant PRICE_1 = 1e8;

    // Round identifiers created by `setUp`. `addPool` opens one round per `Kind`, in enum order
    // (Day100, Day1k, Day10k, Week1k, Week10k, Week100k, Month100k), so each pool takes seven ids.
    uint256 internal constant NATIVE_POOL = 1;
    uint256 internal constant TOKEN_POOL = 2;
    uint256 internal constant ROUNDS_PER_POOL = 7;
    uint256 internal constant NATIVE_DAY = 1; // Day100
    uint256 internal constant NATIVE_DAY_1K = 2;
    uint256 internal constant NATIVE_DAY_10K = 3;
    uint256 internal constant NATIVE_WEEK = 4; // Week1k
    uint256 internal constant NATIVE_WEEK_10K = 5;
    uint256 internal constant NATIVE_WEEK_100K = 6;
    uint256 internal constant NATIVE_MONTH = 7; // Month100k
    uint256 internal constant TOKEN_DAY = 8; // Day100
    uint256 internal constant TOKEN_DAY_1K = 9;
    uint256 internal constant TOKEN_DAY_10K = 10;
    uint256 internal constant TOKEN_WEEK = 11; // Week1k
    uint256 internal constant TOKEN_WEEK_10K = 12;
    uint256 internal constant TOKEN_WEEK_100K = 13;
    uint256 internal constant TOKEN_MONTH = 14; // Month100k

    /// @dev USD 1 at USD 600 with 18/8 decimals: SPEC §3.2's worked example.
    uint256 internal constant MIN_NATIVE = 1_666_666_666_666_667;
    /// @dev Smallest native pot worth USD 100 at USD 600 (the default daily target).
    uint256 internal constant TARGET_NATIVE_100 = 166_666_666_666_666_667;

    function setUp() public virtual {
        vm.warp(START);

        vault = new LuckyVault(owner);
        coordinator = new MockVRFCoordinatorV2Plus();
        subId = coordinator.createSubscription();

        draw = new LuckyDraw(
            address(vault),
            address(coordinator),
            subId,
            KEY_HASH,
            CONFIRMATIONS,
            CALLBACK_GAS,
            MAX_REQUEST_COST,
            feeAcc,
            owner
        );

        coordinator.addConsumer(subId, address(draw));
        coordinator.registerKey(KEY_HASH, 100 gwei);
        coordinator.fundNative(subId, 10 ether);

        feed = new MockAggregatorV3(FEED_DECIMALS);
        feed.set(1, PRICE_600, START);
        feed2 = new MockAggregatorV3(FEED_DECIMALS);
        feed2.set(1, PRICE_1, START);
        tkn2 = new MockERC20("Two", "TWO", 2);

        vm.startPrank(owner);
        vault.setDraw(address(draw));
        vault.listAsset(NATIVE_ASSET, 18);
        vault.setDepositsEnabled(NATIVE_ASSET, true);
        vault.listAsset(address(tkn2), 2);
        vault.setDepositsEnabled(address(tkn2), true);
        draw.addPool(NATIVE_ASSET, _pricing(address(feed)));
        draw.addPool(address(tkn2), _pricing(address(feed2)));
        vm.stopPrank();

        address[6] memory funded = [alice, bob, carol, dave, seedSafe, feeAcc];
        for (uint256 i = 0; i < funded.length; ++i) {
            vm.deal(funded[i], 10_000 ether);
            tkn2.mint(funded[i], 1_000_000_00);
            vm.startPrank(funded[i]);
            tkn2.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
        vm.deal(keeper, 1 ether);
    }

    // ---- Configuration helpers ----------------------------------------------

    function _pricing(address feed_) internal pure returns (PricingConfig memory) {
        return PricingConfig({
            feed: feed_,
            feedDecimals: FEED_DECIMALS,
            maxPriceAge: MAX_AGE,
            referenceKind: ReferenceKind.ExactToken,
            minAnswer: 0,
            maxAnswer: 0
        });
    }

    /// @dev Points the seed at `seedSafe` and records its own Vault consent for that pool's asset, in that
    ///      asset's raw units (SPEC §5.4).
    function _configureSeed(uint256 poolId, uint256 amount, uint256 cap) internal {
        address asset = draw.getPool(poolId).asset;
        vm.prank(seedSafe);
        vault.authorizeSeed(asset, cap);
        vm.startPrank(owner);
        draw.setSeedAccount(seedSafe);
        draw.setSeedAmount(poolId, amount);
        vm.stopPrank();
    }

    // ---- Money helpers ------------------------------------------------------

    function _depositNative(address who, uint256 amount) internal {
        vm.prank(who);
        vault.depositNative{value: amount}();
    }

    function _depositToken(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(address(tkn2), amount);
    }

    function _buy(address who, uint256 roundId, uint256 gross) internal {
        vm.prank(who);
        draw.buy(roundId, gross, 0, uint64(block.timestamp + 300));
    }

    function _fundAndBuy(address who, uint256 roundId, uint256 gross) internal {
        _depositNative(who, gross);
        _buy(who, roundId, gross);
    }

    // ---- Lifecycle helpers --------------------------------------------------

    function _refreshFeeds() internal {
        feed.set(uint80(block.timestamp), PRICE_600, block.timestamp);
        feed2.set(uint80(block.timestamp), PRICE_1, block.timestamp);
    }

    /// @dev Moves to `when` and republishes both feeds so prices stay fresh.
    function _warp(uint256 when) internal {
        vm.warp(when);
        _refreshFeeds();
    }

    function _closeAtCutoff(uint256 roundId) internal {
        _warp(draw.getRound(roundId).closesAt);
        vm.prank(keeper);
        draw.closeRound(roundId);
    }

    function _request(uint256 roundId) internal returns (uint256 requestId) {
        vm.prank(keeper);
        draw.requestDraw(roundId);
        return draw.getRound(roundId).requestId;
    }

    function _fulfill(uint256 requestId, uint256 word0, uint256 word1) internal returns (bool) {
        uint256[] memory words = new uint256[](2);
        words[0] = word0;
        words[1] = word1;
        return coordinator.fulfill(requestId, words);
    }

    /// @dev Closes at the cutoff, requests and delivers two words, leaving the round Ready.
    function _driveToReady(uint256 roundId, uint256 word0, uint256 word1) internal {
        _closeAtCutoff(roundId);
        uint256 requestId = _request(roundId);
        assertTrue(_fulfill(requestId, word0, word1), "callback failed");
    }

    // ---- Assertions ---------------------------------------------------------

    function _state(uint256 roundId) internal view returns (State) {
        return draw.getRound(roundId).state;
    }

    function _fee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / BPS;
    }

    /// @dev V1/V2 conservation for one asset: actual custody covers available plus escrow, and the Vault's
    ///      escrow total matches the sum of the named rounds' outstanding escrow (SPEC §4.3).
    function _assertConservation(address asset, uint256[] memory roundIds) internal view {
        uint256 actual = asset == NATIVE_ASSET ? address(vault).balance : MockERC20(asset).balanceOf(address(vault));
        uint256 available = vault.totalAvailable(asset);
        uint256 escrow = vault.totalEscrow(asset);
        assertEq(actual, available + escrow, "V1: custody != available + escrow");

        uint256 summed;
        for (uint256 i = 0; i < roundIds.length; ++i) {
            summed += vault.getEscrow(roundIds[i]).amount;
        }
        assertEq(escrow, summed, "V2: totalEscrow != summed round escrows");
    }

    /// @dev A harness wired to the same mocks, for the internal selection helpers.
    function _harness() internal returns (LuckyDrawHarness) {
        return new LuckyDrawHarness(
            address(vault),
            address(coordinator),
            subId,
            KEY_HASH,
            CONFIRMATIONS,
            CALLBACK_GAS,
            MAX_REQUEST_COST,
            feeAcc,
            owner
        );
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }
}
