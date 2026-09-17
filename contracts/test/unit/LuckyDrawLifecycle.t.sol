// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {CallbackIgnoreReason, Kind, NATIVE_ASSET, RefundReason, REQUEST_WINDOW, State} from "../../src/Types.sol";
import {
    AlreadyClaimed,
    InvalidAmount,
    InvalidId,
    InvalidRequestId,
    KeyHashUnsupported,
    PoolDisabled,
    RequestWindowClosed,
    RequestWindowStillOpen,
    RoundNotClosed,
    SubscriptionUnderfunded,
    Unauthorized,
    WrongState
} from "../../src/Errors.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";

/// @notice Close, request, expiry, callback and successor rules
///         (SPEC §6.1, §6.2, §7.1; ACCEPTANCE A05, A06, A13, A15–A18, A20–A22, A25, A26, A41, A42).
contract LuckyDrawLifecycleTest is LuckyDrawBase {
    // ---- Closing branches ---------------------------------------------------

    function test_Close_RevertWhen_BeforeCutoff() public {
        vm.warp(DAY_CUTOFF - 1);
        vm.prank(keeper);
        vm.expectRevert(RoundNotClosed.selector);
        draw.closeRound(NATIVE_DAY);
    }

    function test_Close_EmptyRoundGoesVoidAndOpensOneSuccessor() public {
        _closeAtCutoff(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.Void));
        assertEq(round.closedAt, DAY_CUTOFF);
        assertEq(round.requestDeadline, DAY_CUTOFF + REQUEST_WINDOW, "D8 holds even where no request is possible");
        assertTrue(vault.getEscrow(NATIVE_DAY).closed, "escrow closed");

        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);
        assertEq(successor, 2 * ROUNDS_PER_POOL + 1, "exactly one successor created");
        ILuckyDraw.RoundView memory next = draw.getRound(successor);
        assertEq(next.sequence, 2, "sequence increments");
        assertEq(next.opensAt, DAY_CUTOFF);
        assertEq(next.closesAt, DAY_CUTOFF + 86_400, "strictly later cutoff");

        vm.prank(keeper);
        vm.expectRevert(WrongState.selector);
        draw.closeRound(NATIVE_DAY);
    }

    function test_Close_SinglePlayerRefunds() public {
        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);
        _buy(alice, NATIVE_DAY, MIN_NATIVE * 3);
        _closeAtCutoff(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.Refunding));
        assertEq(uint8(round.refundReason), uint8(RefundReason.InsufficientPlayers));

        uint256 before = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        assertEq(vault.balanceOf(alice, NATIVE_ASSET) - before, MIN_NATIVE * 4, "full gross including fee");
        assertEq(draw.getRound(NATIVE_DAY).refundedGross, MIN_NATIVE * 4);
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0, "escrow emptied");
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0, "operator earns zero");

        vm.prank(keeper);
        vm.expectRevert(AlreadyClaimed.selector);
        draw.claimRefund(NATIVE_DAY, alice);
    }

    function test_ClaimRefund_RevertWhen_AccountHasNoEntry() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_DAY);

        vm.prank(keeper);
        vm.expectRevert(InvalidAmount.selector);
        draw.claimRefund(NATIVE_DAY, dave);
    }

    function test_ClaimRefund_CreditsOnlyTheNamedBuyer() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_DAY);

        uint256 keeperBefore = vault.balanceOf(keeper, NATIVE_ASSET);
        uint256 aliceBefore = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(dave); // a stranger pays the gas
        draw.claimRefund(NATIVE_DAY, alice);
        assertEq(vault.balanceOf(keeper, NATIVE_ASSET), keeperBefore, "caller receives nothing");
        assertEq(vault.balanceOf(alice, NATIVE_ASSET) - aliceBefore, MIN_NATIVE, "named buyer credited");
        assertEq(vault.balanceOf(dave, NATIVE_ASSET), 0, "stranger receives nothing");
    }

    function test_Close_TwoPlayersAwaitRequestWithin24Hours() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.AwaitingRequest));
        assertEq(uint8(round.closeReason), 0, "Cutoff");
        assertEq(round.requestDeadline, uint64(round.closedAt) + REQUEST_WINDOW);
    }

    function test_Close_LateCloseSkipsTheRequestWindow() public {
        _twoPlayers(NATIVE_DAY);
        _warp(DAY_CUTOFF + REQUEST_WINDOW); // nobody closed for a full day
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.Refunding));
        assertEq(uint8(round.refundReason), uint8(RefundReason.RequestDeadlineExpired));
        assertEq(
            draw.getCurrent(NATIVE_POOL, Kind.Day100), 2 * ROUNDS_PER_POOL + 1, "exactly one successor, no backfill"
        );
    }

    function test_Close_AfterSeveralMissedPeriodsCreatesOneSuccessor() public {
        _warp(DAY_CUTOFF + 3 * 86_400 + 100);
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);
        assertEq(draw.getRound(successor).sequence, 2, "no fake sequence backfill");
        assertEq(draw.getRound(successor).closesAt, DAY_CUTOFF + 4 * 86_400, "next midnight from now");
        assertEq(draw.roundCount(), 2 * ROUNDS_PER_POOL + 1, "one new round only");
    }

    // ---- Calendar cutoffs (A41) ---------------------------------------------

    function test_Cutoffs_WeeklyAndMonthlyFollowTheUtcCalendar() public {
        assertEq(draw.getRound(NATIVE_WEEK).closesAt, WEEK_CUTOFF, "next Monday 00:00 UTC");
        assertEq(draw.getRound(NATIVE_MONTH).closesAt, MONTH_CUTOFF, "next 1st 00:00 UTC");

        // A weekly round opened exactly on a Monday at 00:00 closes the following Monday, never the same instant.
        _warp(WEEK_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_WEEK);
        uint256 weekly = draw.getCurrent(NATIVE_POOL, Kind.Week1k);
        assertEq(draw.getRound(weekly).opensAt, WEEK_CUTOFF);
        assertEq(draw.getRound(weekly).closesAt, WEEK_CUTOFF + 604_800, "the following Monday");

        // A monthly round opened mid-month closes at the next month start.
        _warp(1_790_942_400); // 2026-10-02 12:00 UTC
        vm.prank(keeper);
        draw.closeRound(NATIVE_MONTH);
        uint256 monthly = draw.getCurrent(NATIVE_POOL, Kind.Month100k);
        assertEq(draw.getRound(monthly).opensAt, 1_790_942_400);
        assertEq(draw.getRound(monthly).closesAt, 1_793_491_200, "2026-11-01 00:00 UTC");
    }

    // ---- Request pre-checks and failures (A16, A18, A42) --------------------

    function test_Request_RevertWhen_StateOrWindowWrong() public {
        vm.prank(keeper);
        vm.expectRevert(WrongState.selector);
        draw.requestDraw(NATIVE_DAY);

        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        vm.expectRevert(RequestWindowClosed.selector);
        draw.requestDraw(NATIVE_DAY);

        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Refunding));
    }

    function test_Expire_RevertWhen_WindowStillOpen() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(block.timestamp + REQUEST_WINDOW - 1);
        vm.prank(keeper);
        vm.expectRevert(RequestWindowStillOpen.selector);
        draw.expireUnrequested(NATIVE_DAY);
    }

    function test_Request_RevertWhen_KeyHashDeregisteredThenExpiresIntoRefunds() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        coordinator.deregisterKey(KEY_HASH);

        vm.prank(keeper);
        vm.expectRevert(KeyHashUnsupported.selector);
        draw.requestDraw(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest), "unchanged");

        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_DAY);
        vm.prank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        assertEq(draw.getRound(NATIVE_DAY).refundedGross, MIN_NATIVE);
    }

    function test_Request_RevertWhen_SubscriptionCannotCoverPendingPlusOne() public {
        _twoPlayers(NATIVE_DAY);
        _twoPlayers(NATIVE_WEEK);
        _closeAtCutoff(NATIVE_DAY);

        coordinator.fundNative(subId, uint96(MAX_REQUEST_COST - 1));
        vm.prank(keeper);
        vm.expectRevert(SubscriptionUnderfunded.selector);
        draw.requestDraw(NATIVE_DAY);

        // Exactly one request's worth is enough for the first, but not for a second while it is pending.
        coordinator.fundNative(subId, uint96(MAX_REQUEST_COST + MAX_REQUEST_COST / 2));
        uint256 requestId = _request(NATIVE_DAY);
        assertEq(draw.pendingRequests(), 1);

        _warp(WEEK_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_WEEK);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionUnderfunded.selector);
        draw.requestDraw(NATIVE_WEEK);

        // Delivering the first request frees the pending slot.
        assertTrue(_fulfill(requestId, 1, 2));
        assertEq(draw.pendingRequests(), 0, "callback decrements");
        vm.prank(keeper);
        draw.requestDraw(NATIVE_WEEK);
        assertEq(uint8(_state(NATIVE_WEEK)), uint8(State.Drawing));
    }

    function test_Request_CoordinatorFailureLeavesAwaitingRequestAndSuccessorUntouched() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);

        coordinator.removeConsumer(subId, address(draw));
        vm.prank(keeper);
        vm.expectRevert();
        draw.requestDraw(NATIVE_DAY);

        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest), "rolled back");
        assertEq(draw.getRound(NATIVE_DAY).requestId, 0);
        assertEq(draw.pendingRequests(), 0);
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), successor, "successor untouched");
        assertEq(uint8(_state(successor)), uint8(State.Open));

        // A retry before the deadline succeeds.
        coordinator.addConsumer(subId, address(draw));
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Drawing));
    }

    function test_Request_RevertWhen_CoordinatorReturnsAnAlreadyUsedId() public {
        _twoPlayers(NATIVE_DAY);
        _twoPlayers(NATIVE_WEEK);
        _closeAtCutoff(NATIVE_DAY);
        _request(NATIVE_DAY);

        // Force the mock to hand out the same identifier again.
        assertEq(uint256(vm.load(address(coordinator), bytes32(uint256(0)))), coordinator.nextRequestId());
        vm.store(address(coordinator), bytes32(uint256(0)), bytes32(uint256(1)));

        _warp(WEEK_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_WEEK);
        vm.prank(keeper);
        vm.expectRevert(InvalidRequestId.selector);
        draw.requestDraw(NATIVE_WEEK);
        assertEq(uint8(_state(NATIVE_WEEK)), uint8(State.AwaitingRequest), "rolled back");
    }

    function test_Request_LateDeliveryAfterDeadlineStillSettles() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(draw.getRound(NATIVE_DAY).requestDeadline - 1);
        uint256 requestId = _request(NATIVE_DAY);

        vm.warp(block.timestamp + 5 days); // delivery long after the deadline
        assertTrue(_fulfill(requestId, 7, 9));
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Ready), "no refund path once accepted");

        vm.prank(keeper);
        draw.settle(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Settled));

        vm.prank(keeper);
        vm.expectRevert(WrongState.selector);
        draw.expireUnrequested(NATIVE_DAY);
    }

    // ---- Callback handling (A20, A21, A22) ----------------------------------

    function test_Callback_RevertWhen_CallerIsNotTheCoordinator() public {
        uint256[] memory words = new uint256[](2);
        vm.prank(alice);
        vm.expectRevert(Unauthorized.selector);
        draw.rawFulfillRandomWords(1, words);
    }

    function test_Callback_IgnoresUnknownDuplicateAndMalformedDeliveries() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        uint256 requestId = _request(NATIVE_DAY);

        uint256[] memory two = new uint256[](2);
        two[0] = 11;
        two[1] = 22;
        uint256[] memory one = new uint256[](1);
        uint256[] memory three = new uint256[](3);

        vm.startPrank(address(coordinator));
        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.CallbackIgnored(99, CallbackIgnoreReason.UnknownRequest);
        draw.rawFulfillRandomWords(99, two);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.CallbackIgnored(requestId, CallbackIgnoreReason.Malformed);
        draw.rawFulfillRandomWords(requestId, one);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.CallbackIgnored(requestId, CallbackIgnoreReason.Malformed);
        draw.rawFulfillRandomWords(requestId, three);

        draw.rawFulfillRandomWords(requestId, two); // the valid delivery
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Ready));

        uint256[] memory other = new uint256[](2);
        other[0] = 33;
        other[1] = 44;
        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.CallbackIgnored(requestId, CallbackIgnoreReason.DuplicateOrWrongState);
        draw.rawFulfillRandomWords(requestId, other);
        vm.stopPrank();

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.word0, 11, "stored words are immutable");
        assertEq(round.word1, 22);
        assertEq(draw.pendingRequests(), 0, "counted down exactly once");
    }

    function test_Callback_ZeroWordsAreValid() public {
        _twoPlayers(NATIVE_DAY);
        _closeAtCutoff(NATIVE_DAY);
        uint256 requestId = _request(NATIVE_DAY);
        assertTrue(_fulfill(requestId, 0, 0));

        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Ready), "zero is not a missing-word marker");
        vm.prank(keeper);
        draw.settle(NATIVE_DAY);
        assertEq(draw.getRound(NATIVE_DAY).winningIndex, 0);
        assertEq(draw.getRound(NATIVE_DAY).winner, alice, "index 0 belongs to the first range");
    }

    function test_Callback_SwappedDeliveriesStayWithTheirOwnRounds() public {
        _twoPlayers(NATIVE_DAY);
        _twoPlayers(NATIVE_WEEK);
        _closeAtCutoff(NATIVE_DAY);
        uint256 requestA = _request(NATIVE_DAY);
        _warp(WEEK_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_WEEK);
        uint256 requestB = _request(NATIVE_WEEK);

        // Delivered out of order: B first, then A.
        assertTrue(_fulfill(requestB, 100, 200));
        assertTrue(_fulfill(requestA, 300, 400));

        assertEq(draw.getRequest(requestA), NATIVE_DAY);
        assertEq(draw.getRequest(requestB), NATIVE_WEEK);
        assertEq(draw.getRound(NATIVE_DAY).word0, 300);
        assertEq(draw.getRound(NATIVE_WEEK).word0, 100);
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), 2 * ROUNDS_PER_POOL + 1, "pointer untouched by callbacks");
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Week1k), 2 * ROUNDS_PER_POOL + 2);
    }

    // ---- Pool enablement and current pointer (A26) --------------------------

    function test_EnsureCurrent_ReturnsTheSamePointerAndRejectsDisabledPools() public {
        vm.prank(keeper);
        assertEq(draw.ensureCurrent(NATIVE_POOL, Kind.Day100), NATIVE_DAY);
        vm.prank(keeper);
        assertEq(draw.ensureCurrent(NATIVE_POOL, Kind.Day100), NATIVE_DAY, "idempotent");

        vm.prank(owner);
        draw.setPoolEnabled(NATIVE_POOL, false);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Open), "existing round finishes normally");

        _closeAtCutoff(NATIVE_DAY);
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), 0, "no successor while disabled");
        vm.prank(keeper);
        vm.expectRevert(PoolDisabled.selector);
        draw.ensureCurrent(NATIVE_POOL, Kind.Day100);

        vm.prank(owner);
        draw.setPoolEnabled(NATIVE_POOL, true);
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), 0, "re-enable creates nothing implicitly");
        vm.prank(keeper);
        uint256 created = draw.ensureCurrent(NATIVE_POOL, Kind.Day100);
        assertEq(draw.getRound(created).sequence, 2, "sequence continues across disablement");
        vm.prank(keeper);
        assertEq(draw.ensureCurrent(NATIVE_POOL, Kind.Day100), created, "no duplicate successor");
    }

    function test_EnsureCurrent_RevertWhen_PoolUnknown() public {
        vm.prank(keeper);
        vm.expectRevert(InvalidId.selector);
        draw.ensureCurrent(42, Kind.Day100);
    }

    // ---- Pauses never block exits or lifecycle (A25) -------------------------

    function test_Pauses_NeverBlockLifecycleOrExits() public {
        _twoPlayers(NATIVE_DAY);
        _twoPlayers(NATIVE_WEEK);

        vm.startPrank(owner);
        draw.setBuysPaused(true);
        draw.setPoolBuysPaused(NATIVE_POOL, true);
        vault.setDepositsPaused(true);
        vault.setDepositsEnabled(NATIVE_ASSET, false);
        vm.stopPrank();

        _closeAtCutoff(NATIVE_DAY);
        uint256 requestId = _request(NATIVE_DAY);
        assertTrue(_fulfill(requestId, 5, 6));
        vm.prank(keeper);
        draw.settle(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Settled));

        _warp(WEEK_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_WEEK);
        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_WEEK);
        vm.prank(keeper);
        draw.claimRefund(NATIVE_WEEK, alice);

        uint256 balance = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(alice);
        vault.withdraw(NATIVE_ASSET, balance);
        assertEq(vault.balanceOf(alice, NATIVE_ASSET), 0, "withdrawal never gated");
    }

    // ---- Helpers ------------------------------------------------------------

    function _twoPlayers(uint256 roundId) private {
        _depositNative(alice, MIN_NATIVE);
        _depositNative(bob, MIN_NATIVE);
        _buy(alice, roundId, MIN_NATIVE);
        _buy(bob, roundId, MIN_NATIVE);
    }
}
