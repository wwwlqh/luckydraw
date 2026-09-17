// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {
    CloseReason,
    Kind,
    NATIVE_ASSET,
    PricingConfig,
    RefundReason,
    REQUEST_WINDOW,
    ReferenceKind,
    State
} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @notice End-to-end money flows across the real LuckyVault, LuckyDraw and the labeled mocks
///         (SPEC §4.3 V1/V2, §5, §6, §7; ACCEPTANCE A04–A07, A38, A47, A51).
/// @dev Conservation is asserted after every step: actual custody equals available plus escrow, and the
///      Vault's escrow total equals the sum of the live rounds' escrows.
contract LifecycleTest is Test {
    LuckyVault internal vault;
    LuckyDraw internal draw;
    MockVRFCoordinatorV2Plus internal coordinator;
    MockAggregatorV3 internal bnbFeed; // USD 600
    MockAggregatorV3 internal usdFeed; // USD 1
    MockERC20 internal token; // 6 decimals

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal feeAcc = makeAddr("treasury");
    address internal seedSafe = makeAddr("seedSafe");
    address internal keeper = makeAddr("keeper");

    uint256 internal subId;
    uint256 internal nativePool;
    uint256 internal tokenPool;

    uint256 internal constant START = 1_789_128_000; // 2026-09-11 12:00 UTC
    uint64 internal constant DAY_CUTOFF = 1_789_171_200;
    bytes32 internal constant KEY_HASH = keccak256("luckydraw.integration.gaslane");
    uint256 internal constant MAX_REQUEST_COST = 0.01 ether;
    uint256 internal constant NATIVE_SEED = 0.02 ether;
    uint256 internal constant TOKEN_SEED = 5e6;
    uint256 internal constant MIN_NATIVE = 1_666_666_666_666_667;

    uint256[] internal live; // round ids whose escrow may be nonzero

    function setUp() public {
        vm.warp(START);

        vault = new LuckyVault(owner);
        coordinator = new MockVRFCoordinatorV2Plus();
        subId = coordinator.createSubscription();
        draw = new LuckyDraw(
            address(vault), address(coordinator), subId, KEY_HASH, 200, 300_000, MAX_REQUEST_COST, feeAcc, owner
        );
        coordinator.addConsumer(subId, address(draw));
        coordinator.registerKey(KEY_HASH, 100 gwei);
        coordinator.fundNative(subId, 10 ether);

        bnbFeed = new MockAggregatorV3(8);
        bnbFeed.set(1, 600e8, START);
        usdFeed = new MockAggregatorV3(8);
        usdFeed.set(1, 1e8, START);
        token = new MockERC20("Stable", "STBL", 6);

        vm.startPrank(owner);
        vault.setDraw(address(draw));
        vault.listAsset(NATIVE_ASSET, 18);
        vault.setDepositsEnabled(NATIVE_ASSET, true);
        vault.listAsset(address(token), 6);
        vault.setDepositsEnabled(address(token), true);
        draw.setSeedAccount(seedSafe);
        vm.stopPrank();

        // The seed Safe consents in its own transaction before the owner may point at it, once per asset
        // and in that asset's raw units (SPEC §5.4).
        vm.startPrank(seedSafe);
        vault.authorizeSeed(NATIVE_ASSET, 1 ether);
        vault.authorizeSeed(address(token), 10e6);
        vm.stopPrank();

        address[5] memory people = [alice, bob, carol, seedSafe, keeper];
        for (uint256 i = 0; i < people.length; ++i) {
            vm.deal(people[i], 1_000 ether);
            token.mint(people[i], 1_000_000e6);
            vm.prank(people[i]);
            token.approve(address(vault), type(uint256).max);
        }

        // The seed Safe funds its Vault balance before any pool exists, so creation-time seeding succeeds.
        vm.startPrank(seedSafe);
        vault.depositNative{value: 10 ether}();
        vault.deposit(address(token), 100_000e6);
        vm.stopPrank();
    }

    // ---- Full daily flow, native BNB ----------------------------------------

    function test_Native_DepositSeedBuyCloseRequestSettleWithdraw() public {
        uint256 roundId = _openNativePool();
        assertTrue(draw.getRound(roundId).seeded, "seeded before the first purchase");
        _assertConservation(NATIVE_ASSET);

        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _assertConservation(NATIVE_ASSET);

        _buy(alice, roundId, 0.03 ether);
        _assertConservation(NATIVE_ASSET);
        _buy(bob, roundId, 0.05 ether);
        _assertConservation(NATIVE_ASSET);

        ILuckyDraw.RoundView memory round = draw.getRound(roundId);
        assertEq(round.playerCount, 3, "seed plus two players");
        assertEq(round.grossTotal, NATIVE_SEED + 0.08 ether);
        assertEq(vault.getEscrow(roundId).amount, round.grossTotal, "D1: escrow equals gross while open");

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(roundId);
        live.push(draw.getCurrent(nativePool, Kind.Day100));
        assertEq(uint8(draw.getRound(roundId).state), uint8(State.AwaitingRequest));
        _assertConservation(NATIVE_ASSET);

        vm.prank(keeper);
        draw.requestDraw(roundId);
        uint256 requestId = draw.getRound(roundId).requestId;
        _assertConservation(NATIVE_ASSET);

        // word0 = 0, word1 picks an index inside bob's range [seed + 0.03, seed + 0.08).
        assertTrue(_fulfill(requestId, 0, NATIVE_SEED + 0.04 ether), "callback succeeded");
        assertEq(uint8(draw.getRound(roundId).state), uint8(State.Ready));
        _assertConservation(NATIVE_ASSET);

        uint256 prize = draw.getRound(roundId).prizePot;
        uint256 fee = draw.getRound(roundId).feeReserved;
        vm.prank(keeper);
        draw.settle(roundId);

        assertEq(draw.getRound(roundId).winner, bob, "gross weight decided the winner");
        assertEq(vault.balanceOf(bob, NATIVE_ASSET), 1 ether - 0.05 ether + prize);
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), fee, "earned fee credited only at settlement");
        assertEq(vault.getEscrow(roundId).amount, 0, "D1: zero escrow in Settled");
        assertEq(prize + fee, draw.getRound(roundId).grossTotal, "D3: releases sum to gross");
        _assertConservation(NATIVE_ASSET);

        uint256 walletBefore = bob.balance;
        uint256 credited = vault.balanceOf(bob, NATIVE_ASSET);
        vm.prank(bob);
        vault.withdraw(NATIVE_ASSET, credited);
        assertEq(bob.balance - walletBefore, credited, "the winner withdraws to their own address");
        assertEq(vault.balanceOf(bob, NATIVE_ASSET), 0);
        _assertConservation(NATIVE_ASSET);
    }

    // ---- Full daily flow, ERC-20 --------------------------------------------

    function test_Erc20_DepositSeedBuyCloseRequestSettleWithdraw() public {
        uint256 roundId = _openTokenPool();
        assertTrue(draw.getRound(roundId).seeded);
        _assertConservation(address(token));

        _depositToken(alice, 100e6);
        _depositToken(bob, 100e6);
        _buyToken(alice, roundId, 20e6);
        _buyToken(bob, roundId, 10e6);
        _assertConservation(address(token));

        ILuckyDraw.RoundView memory round = draw.getRound(roundId);
        assertEq(round.grossTotal, TOKEN_SEED + 30e6);
        assertEq(round.feeReserved, (TOKEN_SEED + 30e6) * 300 / 10000);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(roundId);
        live.push(draw.getCurrent(tokenPool, Kind.Day100));
        vm.prank(keeper);
        draw.requestDraw(roundId);
        assertTrue(_fulfill(draw.getRound(roundId).requestId, 0, 1));
        vm.prank(keeper);
        draw.settle(roundId);

        assertEq(draw.getRound(roundId).winner, seedSafe, "index 1 lies in the seed's own range");
        assertEq(vault.getEscrow(roundId).amount, 0);
        _assertConservation(address(token));

        uint256 walletBefore = token.balanceOf(seedSafe);
        uint256 credited = vault.balanceOf(seedSafe, address(token));
        vm.prank(seedSafe);
        vault.withdraw(address(token), credited);
        assertEq(token.balanceOf(seedSafe) - walletBefore, credited, "exact ERC-20 delta");
        _assertConservation(address(token));
    }

    // ---- Target-triggered close ---------------------------------------------

    function test_Target_ClosesInsideThePurchaseAndOpensTheSuccessor() public {
        uint256 roundId = _openTokenPool();
        _depositToken(alice, 200e6);
        _depositToken(bob, 200e6);

        _buyToken(alice, roundId, 50e6); // seed 5 + 50 = USD 55
        assertEq(uint8(draw.getRound(roundId).state), uint8(State.Open));
        assertTrue(draw.quoteBuy(roundId, bob, 45e6).reachesTarget, "quote predicts the close");

        _buyToken(bob, roundId, 45e6); // USD 100 reaches the daily target
        ILuckyDraw.RoundView memory round = draw.getRound(roundId);
        assertEq(uint8(round.state), uint8(State.AwaitingRequest));
        assertEq(uint8(round.closeReason), uint8(CloseReason.TargetReached));
        assertEq(round.requestDeadline, uint64(block.timestamp) + REQUEST_WINDOW);

        uint256 successor = draw.getCurrent(tokenPool, Kind.Day100);
        live.push(successor);
        assertFalse(draw.getRound(successor).seeded, "creation does not seed");
        vm.prank(keeper); // the keeper seeds the new round in its next cycle (SPEC §5.4)
        draw.seedRound(successor);
        assertTrue(draw.getRound(successor).seeded);
        _assertConservation(address(token));

        vm.prank(keeper);
        draw.requestDraw(roundId);
        assertTrue(_fulfill(draw.getRound(roundId).requestId, 0, TOKEN_SEED + 10e6));
        vm.prank(keeper);
        draw.settle(roundId);
        assertEq(draw.getRound(roundId).winner, alice);
        _assertConservation(address(token));
    }

    // ---- Void with a seed ----------------------------------------------------

    function test_Void_ReturnsTheSeedInTheClosingTransaction() public {
        uint256 roundId = _openNativePool();
        uint256 seedBefore = vault.balanceOf(seedSafe, NATIVE_ASSET);
        _assertConservation(NATIVE_ASSET);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(roundId);
        live.push(draw.getCurrent(nativePool, Kind.Day100));

        ILuckyDraw.RoundView memory round = draw.getRound(roundId);
        assertEq(uint8(round.state), uint8(State.Void));
        assertEq(round.refundedGross, NATIVE_SEED);
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET) - seedBefore, NATIVE_SEED, "seed returned in full");
        assertFalse(draw.getRound(live[live.length - 1]).seeded, "the successor waits for the keeper");
        assertEq(vault.getEscrow(roundId).amount, 0);
        assertEq(draw.getRound(roundId).requestId, 0, "no randomness request");
        _assertConservation(NATIVE_ASSET);
    }

    // ---- Unseeded single player refunds --------------------------------------

    function test_Unseeded_SinglePlayerRefundsInFull() public {
        vm.prank(owner);
        nativePool = draw.addPool(NATIVE_ASSET, _pricing(address(bnbFeed))); // seedAmount stays 0
        uint256 roundId = draw.getCurrent(nativePool, Kind.Day100);
        live.push(roundId);
        assertFalse(draw.getRound(roundId).seeded, "SeedSkipped(NotConfigured)");

        _depositNative(alice, 1 ether);
        _buy(alice, roundId, 0.01 ether);
        _buy(alice, roundId, 0.02 ether);
        _assertConservation(NATIVE_ASSET);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(roundId);
        live.push(draw.getCurrent(nativePool, Kind.Day100));

        assertEq(uint8(draw.getRound(roundId).state), uint8(State.Refunding));
        assertEq(uint8(draw.getRound(roundId).refundReason), uint8(RefundReason.InsufficientPlayers));

        vm.prank(keeper); // anyone may credit the buyer
        draw.claimRefund(roundId, alice);
        assertEq(vault.balanceOf(alice, NATIVE_ASSET), 1 ether, "full gross including the reserved fee");
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0, "operator earns zero on a cancelled round");
        assertEq(vault.getEscrow(roundId).amount, 0);
        _assertConservation(NATIVE_ASSET);
    }

    // ---- Expiration ----------------------------------------------------------

    function test_Expiration_AfterTheRequestWindowRefundsEveryBuyer() public {
        uint256 roundId = _openNativePool();
        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _buy(alice, roundId, 0.03 ether);
        _buy(bob, roundId, 0.05 ether);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(roundId);
        live.push(draw.getCurrent(nativePool, Kind.Day100));

        vm.warp(draw.getRound(roundId).requestDeadline);
        vm.prank(keeper);
        draw.expireUnrequested(roundId);
        assertEq(uint8(draw.getRound(roundId).state), uint8(State.Refunding));

        vm.startPrank(keeper);
        draw.claimRefund(roundId, alice);
        draw.claimRefund(roundId, bob);
        draw.claimRefund(roundId, seedSafe);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice, NATIVE_ASSET), 1 ether);
        assertEq(vault.balanceOf(bob, NATIVE_ASSET), 1 ether);
        assertEq(draw.getRound(roundId).refundedGross, draw.getRound(roundId).grossTotal, "D3");
        assertEq(vault.getEscrow(roundId).amount, 0);
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0);
        _assertConservation(NATIVE_ASSET);
    }

    // ---- Helpers -------------------------------------------------------------

    function _openNativePool() private returns (uint256 roundId) {
        vm.startPrank(owner);
        nativePool = draw.addPool(NATIVE_ASSET, _pricing(address(bnbFeed)));
        draw.setSeedAmount(nativePool, NATIVE_SEED);
        vm.stopPrank();

        roundId = draw.getCurrent(nativePool, Kind.Day100);
        vm.prank(keeper);
        draw.seedRound(roundId);
        live.push(roundId);
        live.push(draw.getCurrent(nativePool, Kind.Week1k));
        live.push(draw.getCurrent(nativePool, Kind.Month100k));
    }

    function _openTokenPool() private returns (uint256 roundId) {
        vm.startPrank(owner);
        tokenPool = draw.addPool(address(token), _pricing(address(usdFeed)));
        draw.setSeedAmount(tokenPool, TOKEN_SEED);
        vm.stopPrank();

        roundId = draw.getCurrent(tokenPool, Kind.Day100);
        vm.prank(keeper);
        draw.seedRound(roundId);
        live.push(roundId);
        live.push(draw.getCurrent(tokenPool, Kind.Week1k));
        live.push(draw.getCurrent(tokenPool, Kind.Month100k));
    }

    function _pricing(address feed_) private pure returns (PricingConfig memory) {
        return PricingConfig({
            feed: feed_,
            feedDecimals: 8,
            maxPriceAge: 3600,
            referenceKind: ReferenceKind.ExactToken,
            minAnswer: 0,
            maxAnswer: 0
        });
    }

    function _warp(uint256 when) private {
        vm.warp(when);
        bnbFeed.set(uint80(when), 600e8, when);
        usdFeed.set(uint80(when), 1e8, when);
    }

    function _depositNative(address who, uint256 amount) private {
        vm.prank(who);
        vault.depositNative{value: amount}();
    }

    function _depositToken(address who, uint256 amount) private {
        vm.prank(who);
        vault.deposit(address(token), amount);
    }

    function _buy(address who, uint256 roundId, uint256 gross) private {
        vm.prank(who);
        draw.buy(roundId, gross, 0, uint64(block.timestamp + 300));
    }

    function _buyToken(address who, uint256 roundId, uint256 gross) private {
        vm.prank(who);
        draw.buy(roundId, gross, 0, uint64(block.timestamp + 300));
    }

    function _fulfill(uint256 requestId, uint256 word0, uint256 word1) private returns (bool) {
        uint256[] memory words = new uint256[](2);
        words[0] = word0;
        words[1] = word1;
        return coordinator.fulfill(requestId, words);
    }

    /// @dev V1: custody covers available plus escrow. V2: the escrow total is exactly the live rounds' sum.
    function _assertConservation(address asset) private view {
        uint256 actual = asset == NATIVE_ASSET ? address(vault).balance : IERC20(asset).balanceOf(address(vault));
        uint256 available = vault.totalAvailable(asset);
        uint256 escrow = vault.totalEscrow(asset);
        assertEq(actual, available + escrow, "V1: custody != available + escrow");

        uint256 summed;
        for (uint256 i = 0; i < live.length; ++i) {
            if (draw.getRound(live[i]).asset == asset) summed += vault.getEscrow(live[i]).amount;
        }
        assertEq(escrow, summed, "V2: totalEscrow != summed round escrows");
    }
}
