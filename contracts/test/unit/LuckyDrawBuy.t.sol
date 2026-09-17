// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {Kind, NATIVE_ASSET, PricingConfig, QuoteReason, Range} from "../../src/Types.sol";
import {
    BelowMinimum,
    BuysPaused,
    DeadlineExpired,
    EntryWindowClosed,
    InsufficientBalance,
    InvalidAmount,
    InvalidId,
    NetContributionTooLow,
    PriceDecimalsChanged,
    PriceInvalid,
    PriceStale,
    PriceUnavailable
} from "../../src/Errors.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";

/// @notice Purchase validation, fee arithmetic and ownership ranges
///         (SPEC §3.2, §5.2, §5.3; ACCEPTANCE A02, A03, A08–A13, A32, A40).
contract LuckyDrawBuyTest is LuckyDrawBase {
    // ---- Fee arithmetic and ranges (A02, A03) -------------------------------

    function test_Buy_SplitsGrossIntoPrizeAndReservedFee() public {
        _depositToken(alice, 100);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 100, 97, uint64(block.timestamp + 300));

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(round.grossTotal, 100, "gross");
        assertEq(round.feeReserved, 3, "fee");
        assertEq(round.prizePot, 97, "prize");
        assertEq(round.playerCount, 1, "players");
        assertEq(vault.getEscrow(TOKEN_DAY).amount, 100, "escrow holds full gross");
        assertEq(vault.balanceOf(feeAcc, address(tkn2)), 0, "fee not credited while open");
    }

    function test_Buy_ThreeEntriesReproduceSpecWorkedExample() public {
        _depositToken(alice, 100);
        _depositToken(bob, 200);
        _depositToken(carol, 700);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
        vm.prank(bob);
        draw.buy(TOKEN_DAY, 200, 0, uint64(block.timestamp + 300));
        vm.prank(carol);
        draw.buy(TOKEN_DAY, 700, 0, uint64(block.timestamp + 300));

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(round.grossTotal, 1000, "gross 10.00");
        assertEq(round.feeReserved, 30, "fee 0.30");
        assertEq(round.prizePot, 970, "prize 9.70");
        assertEq(round.playerCount, 3, "three addresses");
        assertEq(round.rangeCount, 3, "three ranges");

        (uint256 aliceGross,, uint256 num, uint256 den) = draw.getPosition(TOKEN_DAY, alice);
        assertEq(aliceGross, 100);
        assertEq(num * 100 / den, 10, "10 percent");
        (,, uint256 bobNum,) = draw.getPosition(TOKEN_DAY, bob);
        assertEq(bobNum * 100 / den, 20, "20 percent");
        (,, uint256 carolNum,) = draw.getPosition(TOKEN_DAY, carol);
        assertEq(carolNum * 100 / den, 70, "70 percent");
    }

    function test_Buy_RepeatedBuyerKeepsOnePlayerAndAppendsRanges() public {
        _depositToken(alice, 500);
        vm.startPrank(alice);
        draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
        draw.buy(TOKEN_DAY, 400, 0, uint64(block.timestamp + 300));
        vm.stopPrank();

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(round.playerCount, 1, "one distinct address");
        assertEq(round.rangeCount, 2, "two ranges");
        (Range[] memory page,) = draw.getRanges(TOKEN_DAY, 0, 10);
        assertEq(page[0].cumulativeGross, 100);
        assertEq(page[1].cumulativeGross, 500);
        assertEq(page[0].buyer, alice);
        assertEq(page[1].buyer, alice);
    }

    // ---- Fee partition invariance (A11) -------------------------------------

    function test_Buy_SplittingAcrossBuysAndWalletsKeepsTheSameTotalFee() public {
        _depositToken(alice, 999);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 999, 0, uint64(block.timestamp + 300));
        uint256 singleFee = draw.getRound(TOKEN_DAY).feeReserved;

        // Same total, split across three buys and two wallets, in the weekly round of the same pool.
        _depositToken(bob, 333);
        _depositToken(carol, 666);
        vm.prank(bob);
        draw.buy(TOKEN_WEEK, 333, 0, uint64(block.timestamp + 300));
        vm.prank(carol);
        draw.buy(TOKEN_WEEK, 333, 0, uint64(block.timestamp + 300));
        vm.prank(carol);
        draw.buy(TOKEN_WEEK, 333, 0, uint64(block.timestamp + 300));

        assertEq(draw.getRound(TOKEN_WEEK).feeReserved, singleFee, "cumulative fee is split-invariant");
        assertEq(draw.getRound(TOKEN_WEEK).grossTotal, 999);
    }

    function test_Buy_PerPurchaseFeeDeltaNeverDiffersFromItsOwnFloorByMoreThanOneUnit() public {
        uint256[6] memory amounts = [uint256(101), 137, 100, 199, 100, 263];
        _depositToken(alice, 1_000_000);
        uint256 previousFee;
        for (uint256 i = 0; i < amounts.length; ++i) {
            vm.prank(alice);
            draw.buy(TOKEN_DAY, amounts[i], 0, uint64(block.timestamp + 300));
            uint256 fee = draw.getRound(TOKEN_DAY).feeReserved;
            uint256 feeDelta = fee - previousFee;
            uint256 isolated = _fee(amounts[i]);
            assertLe(feeDelta > isolated ? feeDelta - isolated : isolated - feeDelta, 1, "within one raw unit");
            previousFee = fee;
        }
        assertEq(draw.getRound(TOKEN_DAY).feeReserved, _fee(draw.getRound(TOKEN_DAY).grossTotal), "cumulative floor");
    }

    function test_Buy_RevertWhen_NetContributionBelowGuard() public {
        _depositToken(alice, 100);
        vm.prank(alice);
        vm.expectRevert(NetContributionTooLow.selector);
        draw.buy(TOKEN_DAY, 100, 98, uint64(block.timestamp + 300));
    }

    // ---- USD 1 minimum (A08, A09, A12) --------------------------------------

    function test_Buy_MinimumBoundaryAtSpecExamplePrice() public {
        _depositNative(alice, 10 ether);
        vm.prank(alice);
        vm.expectRevert(BelowMinimum.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE - 1, 0, uint64(block.timestamp + 300));

        vm.prank(alice);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertEq(draw.getRound(NATIVE_DAY).grossTotal, MIN_NATIVE, "exact minimum accepted");
    }

    function test_Buy_RevalidatesMinimumAfterAPriceFall() public {
        _depositNative(alice, 10 ether);
        uint256 quoted = draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).minGross;
        assertEq(quoted, MIN_NATIVE, "quote at USD 600");

        // The reference price halves between preview and execution: the same amount is now below USD 1.
        feed.set(2, PRICE_600 / 2, block.timestamp);
        uint256 balanceBefore = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(alice);
        vm.expectRevert(BelowMinimum.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        assertEq(vault.balanceOf(alice, NATIVE_ASSET), balanceBefore, "nothing debited");
        assertEq(draw.getRound(NATIVE_DAY).grossTotal, 0, "no partial state");
        // ceil(10^26 / 300e8): the doubled minimum, rounded up.
        assertEq(draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).minGross, 3_333_333_333_333_334, "new minimum shown");
    }

    function test_Buy_AcceptsAmountsAboveTheOldUint96Range() public {
        uint256 huge = uint256(type(uint96).max) + 1 ether;
        vm.deal(alice, huge);
        _depositNative(alice, huge);
        vm.prank(alice);
        draw.buy(NATIVE_DAY, huge, 0, uint64(block.timestamp + 300));

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.grossTotal, huge, "no artificial cap");
        assertEq(round.feeReserved, _fee(huge));
        assertEq(round.prizePot, huge - _fee(huge));
        (Range[] memory page,) = draw.getRanges(NATIVE_DAY, 0, 1);
        assertEq(page[0].cumulativeGross, huge);
    }

    // ---- Window, deadline, amount and pauses (A13, A25, A32) ----------------

    function test_Buy_RevertWhen_RoundUnknown() public {
        vm.prank(alice);
        vm.expectRevert(InvalidId.selector);
        draw.buy(9999, 100, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_AtOrAfterCutoff() public {
        _depositNative(alice, 10 ether);
        _warp(DAY_CUTOFF - 1);
        vm.prank(alice);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        _warp(DAY_CUTOFF);
        vm.prank(alice);
        vm.expectRevert(EntryWindowClosed.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_RoundAlreadyClosed() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);
        _buy(bob, NATIVE_DAY, MIN_NATIVE);
        _closeAtCutoff(NATIVE_DAY);

        // A closed round reports EntryWindowClosed, never WrongState (SPEC §5.3).
        vm.prank(alice);
        vm.expectRevert(EntryWindowClosed.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_DeadlinePassed() public {
        _depositNative(alice, 10 ether);
        vm.prank(alice);
        vm.expectRevert(DeadlineExpired.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp - 1));
    }

    function test_Buy_RevertWhen_AmountZero() public {
        vm.prank(alice);
        vm.expectRevert(InvalidAmount.selector);
        draw.buy(NATIVE_DAY, 0, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_GloballyOrPoolPaused() public {
        _depositNative(alice, 10 ether);
        vm.prank(owner);
        draw.setBuysPaused(true);
        vm.prank(alice);
        vm.expectRevert(BuysPaused.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        vm.startPrank(owner);
        draw.setBuysPaused(false);
        draw.setPoolBuysPaused(NATIVE_POOL, true);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(BuysPaused.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        // The other pool is unaffected.
        _depositToken(alice, 100);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_VaultBalanceShort() public {
        _depositNative(alice, MIN_NATIVE);
        vm.prank(alice);
        vm.expectRevert(InsufficientBalance.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE * 2, 0, uint64(block.timestamp + 300));
    }

    // ---- Price failure matrix (A10, A40) ------------------------------------

    function test_Buy_RevertWhen_FeedReverts() public {
        _depositNative(alice, 10 ether);
        feed.setRevert(true, false);
        _expectBuyRevert(PriceUnavailable.selector, QuoteReason.PriceUnavailable);

        feed.setRevert(false, true);
        _expectBuyRevert(PriceUnavailable.selector, QuoteReason.PriceUnavailable);
    }

    function test_Buy_RevertWhen_AnswerInvalid() public {
        _depositNative(alice, 10 ether);

        feed.set(0, PRICE_600, block.timestamp); // roundId 0
        _expectBuyRevert(PriceInvalid.selector, QuoteReason.PriceInvalid);

        feed.set(3, 0, block.timestamp); // zero answer
        _expectBuyRevert(PriceInvalid.selector, QuoteReason.PriceInvalid);

        feed.set(3, -1, block.timestamp); // negative answer
        _expectBuyRevert(PriceInvalid.selector, QuoteReason.PriceInvalid);

        feed.set(3, PRICE_600, 0); // updatedAt 0
        _expectBuyRevert(PriceInvalid.selector, QuoteReason.PriceInvalid);

        feed.set(3, PRICE_600, block.timestamp + 1); // future timestamp
        _expectBuyRevert(PriceInvalid.selector, QuoteReason.PriceInvalid);
    }

    function test_Buy_RevertWhen_AnswerAtCircuitBreakerBound() public {
        _depositNative(alice, 10 ether);
        vm.prank(owner);
        draw.setNextPricing(NATIVE_POOL, _bounded(100e8, 1000e8));
        _closeAtCutoff(NATIVE_DAY);
        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);

        feed.set(4, 100e8, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(PriceInvalid.selector);
        draw.buy(successor, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertEq(uint8(draw.quoteBuy(successor, alice, MIN_NATIVE).reason), uint8(QuoteReason.PriceInvalid));

        feed.set(4, 1000e8, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(PriceInvalid.selector);
        draw.buy(successor, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }

    function test_Buy_RevertWhen_AnswerStale() public {
        _depositNative(alice, 10 ether);
        feed.set(5, PRICE_600, block.timestamp);
        vm.warp(block.timestamp + MAX_AGE); // exactly at the limit is still fresh
        vm.prank(alice);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        vm.warp(block.timestamp + 1);
        _expectBuyRevert(PriceStale.selector, QuoteReason.PriceStale);
    }

    function test_Buy_RevertWhen_FeedDecimalsChanged() public {
        _depositNative(alice, 10 ether);
        feed.setDecimals(10);
        _expectBuyRevert(PriceDecimalsChanged.selector, QuoteReason.PriceDecimalsChanged);
    }

    function _expectBuyRevert(bytes4 expected, QuoteReason reason) private {
        vm.prank(alice);
        vm.expectRevert(expected);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).reason), uint8(reason), "quote agrees");
    }

    /// @dev The native pool's pricing configuration with aggregator circuit-breaker bounds recorded.
    function _bounded(int256 minAnswer, int256 maxAnswer) private view returns (PricingConfig memory cfg) {
        cfg = _pricing(address(feed));
        cfg.minAnswer = minAnswer;
        cfg.maxAnswer = maxAnswer;
    }
}
