// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {CloseReason, Kind, NATIVE_ASSET, QuoteReason, RefundReason, REQUEST_WINDOW, State} from "../../src/Types.sol";
import {
    AlreadyClaimed,
    KeyHashUnsupported,
    PriceInvalid,
    PriceStale,
    RequestWindowClosed,
    SubscriptionUnderfunded,
    WrongState
} from "../../src/Errors.sol";
import {LuckyDrawBase} from "../unit/LuckyDrawBase.t.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @notice D7 progress scenarios (SPEC §11.1, §11.2 "Progress"; ACCEPTANCE "Progress" evidence item).
/// @dev D7 is a statement about progress under assumptions, not an invariant checked at one instant, so
///      every scenario here fixes its assumptions explicitly and prints them:
///
///        D7 | <scenario> | steps=<vm.warp calls> | caller=<who> | vrf=<...> | oracle=<...> | reached=<State>
///
///      `steps` counts the time steps the scenario took, `caller` names the account that made the lifecycle
///      calls, `vrf` is the delivery assumption (delivered, never, late-after-deadline, zero-words,
///      malformed, or not-applicable when no request exists) and `oracle` is the price assumption at the
///      decisive moment (fresh, stale, invalid, unavailable, or not-applicable). The printed `reached`
///      state is asserted, not narrated: `_evidence` reads the round back before it logs the row.
///
///      Two rules are followed throughout, both required by SPEC §7.3:
///        - no scenario asserts Drawing -> Ready without stating a delivery assumption, and
///        - the scenarios in which delivery never arrives assert only that no transition is available from
///          the contract alone. They make no liveness claim, because none exists.
///      The owner is never a caller of a lifecycle transition in any scenario: every close, request, expiry,
///      settlement, seed and refund below is made by `keeper` or by `stranger`, an address with no role, no
///      balance and no authorization. `test_D7_NoOwnerIsRequired_...` additionally moves ownership to a
///      fresh address that then never acts at all.
contract ProgressTest is LuckyDrawBase {
    /// @dev An address with no role whatsoever: not the owner, not the keeper, not a buyer, not the seed.
    address internal stranger = makeAddr("stranger");
    /// @dev A fresh owner that accepts ownership once and then never acts again.
    address internal quietOwner = makeAddr("quietOwner");

    /// @dev Time steps taken by the scenario currently running; each test starts from zero.
    uint256 private _steps;

    // =====================================================================
    // Open -> Void
    // =====================================================================

    /// @notice An empty round at its cutoff goes Void, requests nothing and opens exactly one successor.
    /// @dev Oracle assumption: the frozen feed is stale at the closing instant (last update 12 hours old
    ///      against a 3,600-second maxPriceAge), which proves the close path reads no price at all (A10).
    function test_D7_OpenToVoid_EmptyRoundAtCutoff() public {
        _stepStale(DAY_CUTOFF); // step 1: reach the cutoff without republishing the feed

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.closeReason), uint8(CloseReason.Cutoff));
        assertEq(round.closedAt, DAY_CUTOFF, "D8: closedAt set once, at the closing transaction");
        assertEq(round.requestDeadline, DAY_CUTOFF + REQUEST_WINDOW, "D8: requestDeadline holds uniformly");
        assertEq(round.requestId, 0, "a Void round never requests randomness");
        assertEq(round.grossTotal, 0);
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0, "D1: zero escrow in Void");

        uint256 successor = _successor(NATIVE_DAY);
        assertEq(uint8(_state(successor)), uint8(State.Open));
        assertEq(draw.getRound(successor).sequence, round.sequence + 1, "D8: sequence advances by one");
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, successor));

        _evidence("Open->Void empty at cutoff", NATIVE_DAY, "keeper", "not-applicable", "stale", State.Void);
    }

    /// @notice A round whose only entry is the operator seed goes Void and returns the seed in the same
    ///         transaction, so an empty round never enters Refunding and never needs a claim (§5.4, D9).
    function test_D7_OpenToVoid_SeedOnlyReturnsTheSeedInTheClosingTransaction() public {
        _seedTheDailyRound();
        uint256 seedBefore = vault.balanceOf(seedSafe, NATIVE_ASSET);
        assertEq(draw.getRound(NATIVE_DAY).playerCount, 1, "the seed is the only entry");

        _step(DAY_CUTOFF); // step 1

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.refundedGross, round.seedGross, "the seed's gross is returned, not refunded later");
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET) - seedBefore, round.seedGross);
        assertEq(round.seedAccount, seedSafe, "D9: the round remembers the account that seeded it");
        assertEq(round.requestId, 0, "a seed-only round never requests randomness");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0, "D1: zero escrow in Void");

        uint256 successor = _successor(NATIVE_DAY);
        assertEq(uint8(_state(successor)), uint8(State.Open));
        assertFalse(draw.getRound(successor).seeded, "the successor is seeded separately by the keeper");
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, successor));

        _evidence("Open->Void seed only, pool enabled", NATIVE_DAY, "keeper", "not-applicable", "fresh", State.Void);
    }

    /// @notice The same close on a disabled pool opens no successor; re-enabling creates nothing implicitly
    ///         and a stranger's `ensureCurrent` then creates exactly one round (§6.1, D4).
    function test_D7_OpenToVoid_SeedOnlyWithADisabledPoolOpensNoSuccessor() public {
        _seedTheDailyRound();
        vm.prank(owner); // configuration, not a lifecycle transition
        draw.setPoolEnabled(NATIVE_POOL, false);

        _step(DAY_CUTOFF); // step 1

        uint256 roundsBefore = draw.roundCount();
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), 0, "a disabled pool has no current round");
        assertEq(draw.roundCount(), roundsBefore, "no successor was created");
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET), 1 ether, "the seed came back in full");

        vm.prank(owner); // configuration again; it creates nothing on its own
        draw.setPoolEnabled(NATIVE_POOL, true);
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), 0, "re-enabling does not create implicitly");

        vm.prank(stranger);
        uint256 created = draw.ensureCurrent(NATIVE_POOL, Kind.Day100);
        vm.prank(stranger);
        assertEq(draw.ensureCurrent(NATIVE_POOL, Kind.Day100), created, "D4: repeated ensure returns the same id");
        assertEq(draw.roundCount(), roundsBefore + 1, "exactly one round was created");
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, created));

        _evidence("Open->Void seed only, pool disabled", NATIVE_DAY, "keeper", "not-applicable", "fresh", State.Void);
    }

    // =====================================================================
    // Open -> Refunding
    // =====================================================================

    /// @notice One address at the cutoff in an unseeded pool refunds in full, credited by the keeper without
    ///         any action by the buyer, and a second claim reverts (A06, D9).
    function test_D7_OpenToRefunding_LonePlayerAtCutoffIsCreditedByTheKeeper() public {
        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(alice, NATIVE_DAY, 0.02 ether);
        assertFalse(draw.getRound(NATIVE_DAY).seeded, "unseeded pool: SeedSkipped(NotConfigured)");
        assertEq(draw.getRound(NATIVE_DAY).playerCount, 1);

        _step(DAY_CUTOFF); // step 1

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        assertEq(uint8(draw.getRound(NATIVE_DAY).refundReason), uint8(RefundReason.InsufficientPlayers));

        vm.prank(keeper); // anyone may credit the buyer; the caller is never paid
        draw.claimRefund(NATIVE_DAY, alice);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(vault.balanceOf(alice, NATIVE_ASSET), 1 ether, "full gross back, reserved fee included");
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0, "D3: the operator earns zero on a cancelled round");
        assertEq(vault.balanceOf(keeper, NATIVE_ASSET), 0, "the caller of claimRefund receives nothing");
        assertEq(round.refundedGross, round.grossTotal, "D3/D8: refundedGross reaches grossTotal");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0);

        vm.prank(keeper);
        vm.expectRevert(AlreadyClaimed.selector);
        draw.claimRefund(NATIVE_DAY, alice);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("Open->Refunding lone player", NATIVE_DAY, "keeper", "not-applicable", "fresh", State.Refunding);
    }

    /// @notice Refunding has no claim deadline: the keeper credits two buyers immediately and the third
    ///         claims five years later, once, with the second attempt reverting (§5.2, D7).
    function test_D7_Refunding_ClaimsSucceedOnceYearsLater() public {
        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _depositNative(carol, 1 ether);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(bob, NATIVE_DAY, 0.02 ether);
        _buy(carol, NATIVE_DAY, 0.03 ether);

        _step(DAY_CUTOFF); // step 1
        vm.prank(stranger);
        draw.closeRound(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest));

        _step(draw.getRound(NATIVE_DAY).requestDeadline); // step 2: nobody ever requested
        vm.prank(stranger);
        draw.expireUnrequested(NATIVE_DAY);

        vm.startPrank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        draw.claimRefund(NATIVE_DAY, bob);
        vm.stopPrank();

        _step(block.timestamp + 5 * 365 days); // step 3: five years pass before the last claim
        vm.prank(stranger);
        draw.claimRefund(NATIVE_DAY, carol);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(vault.balanceOf(alice, NATIVE_ASSET), 1 ether);
        assertEq(vault.balanceOf(bob, NATIVE_ASSET), 1 ether);
        assertEq(vault.balanceOf(carol, NATIVE_ASSET), 1 ether, "no expiry and no processing charge");
        assertEq(round.refundedGross, round.grossTotal, "D8: refundedGross equals the sum of refunded buyers");
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0);

        vm.prank(carol);
        vm.expectRevert(AlreadyClaimed.selector);
        draw.claimRefund(NATIVE_DAY, carol);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Refunding claim five years later",
            NATIVE_DAY,
            "keeper+stranger",
            "not-applicable",
            "fresh",
            State.Refunding
        );
    }

    // =====================================================================
    // Open -> AwaitingRequest
    // =====================================================================

    /// @notice Two addresses at the cutoff reach AwaitingRequest while the frozen feed is stale: closing
    ///         consults no price, so an oracle outage can never strand a funded round (A10, §6.2).
    function test_D7_OpenToAwaitingRequest_CutoffWithTwoAddressesAndAStalePrice() public {
        _twoBuyers(NATIVE_DAY);

        _stepStale(DAY_CUTOFF); // step 1: no feed republication
        // The feed really is stale at this instant: a still-open round of the same pool says so.
        assertEq(uint8(draw.quoteBuy(NATIVE_WEEK, alice, 0.01 ether).reason), uint8(QuoteReason.PriceStale));

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.closeReason), uint8(CloseReason.Cutoff));
        assertEq(round.closedAt, DAY_CUTOFF);
        assertEq(round.requestDeadline, DAY_CUTOFF + REQUEST_WINDOW);
        assertEq(vault.getEscrow(NATIVE_DAY).amount, round.grossTotal, "D1: escrow still equals gross");
        assertEq(draw.getRound(_successor(NATIVE_DAY)).sequence, round.sequence + 1);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Open->AwaitingRequest cutoff, stale price",
            NATIVE_DAY,
            "keeper",
            "not-applicable",
            "stale",
            State.AwaitingRequest
        );
    }

    /// @notice The same close with a feed that reverts on every call.
    function test_D7_OpenToAwaitingRequest_CutoffWithAnUnavailableFeed() public {
        _twoBuyers(NATIVE_DAY);

        _step(DAY_CUTOFF); // step 1
        feed.setRevert(true, true); // the aggregator is unreachable from this point on
        assertEq(uint8(draw.quoteBuy(NATIVE_WEEK, alice, 0.01 ether).reason), uint8(QuoteReason.PriceUnavailable));

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        assertEq(uint8(draw.getRound(NATIVE_DAY).closeReason), uint8(CloseReason.Cutoff));
        assertEq(vault.getEscrow(NATIVE_DAY).amount, draw.getRound(NATIVE_DAY).grossTotal);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Open->AwaitingRequest cutoff, dead feed",
            NATIVE_DAY,
            "keeper",
            "not-applicable",
            "unavailable",
            State.AwaitingRequest
        );
    }

    /// @notice A purchase whose fresh observation lifts the pot to the frozen target closes the round inside
    ///         that transaction, before the cutoff, and opens the successor (D10, A51). No time step at all.
    function test_D7_OpenToAwaitingRequest_TargetReachedBeforeTheCutoff() public {
        _depositToken(alice, 200_00);
        _depositToken(bob, 200_00);

        _buy(alice, TOKEN_DAY, 60_00); // USD 60 of a USD 100 target
        assertEq(uint8(_state(TOKEN_DAY)), uint8(State.Open));
        assertTrue(draw.quoteBuy(TOKEN_DAY, bob, 40_00).reachesTarget, "the quote predicts the close");

        _buy(bob, TOKEN_DAY, 40_00); // USD 100: closes in this purchase

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(uint8(round.closeReason), uint8(CloseReason.TargetReached));
        assertEq(round.closedAt, uint64(block.timestamp));
        assertTrue(round.closedAt < round.closesAt, "the cutoff was the maximum, not the actual end");
        assertEq(round.requestDeadline, round.closedAt + REQUEST_WINDOW, "A54: 24h from the close, not the cutoff");
        assertEq(round.playerCount, 2);

        uint256 successor = _successor(TOKEN_DAY);
        assertEq(uint8(_state(successor)), uint8(State.Open));
        assertFalse(draw.getRound(successor).seeded, "the successor is left unseeded for the keeper");
        _assertConservation(address(tkn2), _ids(TOKEN_DAY, successor));

        _evidence(
            "Open->AwaitingRequest target reached", TOKEN_DAY, "buyer", "not-applicable", "fresh", State.AwaitingRequest
        );
    }

    /// @notice A stale price can never close a round by target: the purchase that would have reached it
    ///         reverts and the round stays Open until a fresh price or its cutoff arrives (D10, §11.3).
    function test_D7_OpenStaysOpen_WhenTheTargetPriceIsStale() public {
        _depositToken(alice, 200_00);
        _depositToken(bob, 200_00);
        _buy(alice, TOKEN_DAY, 60_00);

        _stepStale(START + MAX_AGE + 1); // step 1: one second past the freshness window, before the cutoff

        vm.prank(bob);
        vm.expectRevert(PriceStale.selector);
        draw.buy(TOKEN_DAY, 40_00, 0, uint64(block.timestamp + 300));

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(round.grossTotal, 60_00, "nothing was debited");
        assertEq(round.rangeCount, 1);
        assertEq(round.playerCount, 1);
        assertEq(round.closedAt, 0, "no close happened");
        assertTrue(block.timestamp < round.closesAt, "the cutoff is still the backstop");
        _assertConservation(address(tkn2), _ids(TOKEN_DAY));

        _evidence("Open stays Open, stale target price", TOKEN_DAY, "buyer", "not-applicable", "stale", State.Open);
    }

    /// @notice The same for an invalid answer: an aggregator reporting zero blocks the entry and therefore
    ///         the target close, without touching the round.
    function test_D7_OpenStaysOpen_WhenTheTargetPriceIsInvalid() public {
        _depositToken(alice, 200_00);
        _depositToken(bob, 200_00);
        _buy(alice, TOKEN_DAY, 60_00);

        feed2.set(1, 0, block.timestamp); // answer 0: PriceInvalid, no time step needed

        vm.prank(bob);
        vm.expectRevert(PriceInvalid.selector);
        draw.buy(TOKEN_DAY, 40_00, 0, uint64(block.timestamp + 300));

        assertEq(draw.getRound(TOKEN_DAY).grossTotal, 60_00);
        assertEq(draw.getRound(TOKEN_DAY).rangeCount, 1);
        _assertConservation(address(tkn2), _ids(TOKEN_DAY));

        _evidence("Open stays Open, invalid target price", TOKEN_DAY, "buyer", "not-applicable", "invalid", State.Open);
    }

    // =====================================================================
    // AwaitingRequest -> Drawing / Refunding
    // =====================================================================

    /// @notice A non-owner requests randomness inside the 24-hour window and the round reaches Drawing.
    /// @dev Delivery assumption: none. This scenario stops at Drawing on purpose.
    function test_D7_AwaitingRequestToDrawing_RequestedByAnUnrelatedAddress() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(stranger);
        draw.closeRound(NATIVE_DAY);

        _step(draw.getRound(NATIVE_DAY).requestDeadline - 1); // step 2: the last second of the window
        vm.prank(stranger);
        draw.requestDraw(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertTrue(round.requestId != 0, "a nonzero, unused request id was recorded");
        assertEq(draw.getRequest(round.requestId), NATIVE_DAY, "D8: byRequest is injective");
        assertEq(round.requestedAt, uint64(block.timestamp));
        assertEq(draw.pendingRequests(), 1);
        assertEq(vault.getEscrow(NATIVE_DAY).amount, round.grossTotal, "D1: escrow intact while Drawing");
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("AwaitingRequest->Drawing by a stranger", NATIVE_DAY, "stranger", "never", "fresh", State.Drawing);
    }

    /// @notice Nobody requests before the deadline: at the deadline a request is forbidden and anyone may
    ///         expire the round into full refunds (A18, §6.2).
    function test_D7_AwaitingRequestToRefunding_NobodyRequestsBeforeTheDeadline() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        _step(draw.getRound(NATIVE_DAY).requestDeadline); // step 2: at the deadline exactly
        vm.prank(stranger);
        vm.expectRevert(RequestWindowClosed.selector);
        draw.requestDraw(NATIVE_DAY);

        vm.prank(stranger);
        draw.expireUnrequested(NATIVE_DAY);
        assertEq(uint8(draw.getRound(NATIVE_DAY).refundReason), uint8(RefundReason.RequestDeadlineExpired));

        vm.startPrank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        draw.claimRefund(NATIVE_DAY, bob);
        vm.stopPrank();

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.refundedGross, round.grossTotal);
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), 0, "reserved fees are waived, not earned");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "AwaitingRequest->Refunding unrequested",
            NATIVE_DAY,
            "keeper+stranger",
            "not-applicable",
            "fresh",
            State.Refunding
        );
    }

    /// @notice A deregistered key hash blocks every request until the deadline passes, and the round then
    ///         expires into refunds instead of locking (A42, §6.2, §7.1).
    function test_D7_AwaitingRequestToRefunding_KeyHashDeregisteredUntilTheDeadline() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        coordinator.deregisterKey(KEY_HASH); // the lane the Draw is permanently fixed to disappears

        _step(draw.getRound(NATIVE_DAY).requestDeadline - 1); // step 2
        vm.prank(keeper);
        vm.expectRevert(KeyHashUnsupported.selector);
        draw.requestDraw(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest), "the failed request changed nothing");
        assertEq(draw.getRound(NATIVE_DAY).requestId, 0);

        _step(draw.getRound(NATIVE_DAY).requestDeadline); // step 3
        vm.prank(stranger);
        draw.expireUnrequested(NATIVE_DAY);
        assertEq(uint8(draw.getRound(NATIVE_DAY).refundReason), uint8(RefundReason.RequestDeadlineExpired));

        vm.startPrank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        draw.claimRefund(NATIVE_DAY, bob);
        vm.stopPrank();
        assertEq(draw.getRound(NATIVE_DAY).refundedGross, draw.getRound(NATIVE_DAY).grossTotal);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "AwaitingRequest->Refunding key hash gone",
            NATIVE_DAY,
            "keeper+stranger",
            "not-applicable",
            "fresh",
            State.Refunding
        );
    }

    /// @notice An underfunded subscription blocks the request; a top-up before the deadline lets the same
    ///         keeper retry successfully, so a reverted attempt is not a terminal outcome (A16, A42).
    function test_D7_AwaitingRequestToDrawing_AfterASubscriptionTopUpBeforeTheDeadline() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        coordinator.fundNative(subId, 0);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionUnderfunded.selector);
        draw.requestDraw(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest), "AwaitingRequest survives the failure");

        // Exactly (pendingRequests + 1) x maxRequestCostNative is enough.
        coordinator.fundNative(subId, uint96(MAX_REQUEST_COST));
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);

        assertTrue(draw.getRound(NATIVE_DAY).requestId != 0);
        assertEq(draw.pendingRequests(), 1);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("AwaitingRequest->Drawing after top-up", NATIVE_DAY, "keeper", "never", "fresh", State.Drawing);
    }

    // =====================================================================
    // Drawing -> Ready / Drawing
    // =====================================================================

    /// @notice Under valid delivery of two words the round reaches Ready.
    function test_D7_DrawingToReady_UnderValidDelivery() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);

        uint256 requestId = draw.getRound(NATIVE_DAY).requestId;
        assertTrue(_fulfill(requestId, 12_345, 67_890), "the coordinator callback succeeded");

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.word0, 12_345);
        assertEq(round.word1, 67_890);
        assertEq(draw.pendingRequests(), 0, "the funding pre-check counter is released on delivery");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, round.grossTotal, "D1: escrow intact until settlement");
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("Drawing->Ready valid delivery", NATIVE_DAY, "keeper", "delivered", "fresh", State.Ready);
    }

    /// @notice Delivery never arrives. SPEC §7.3 makes this an accepted limitation, so this scenario asserts
    ///         only that the contract alone offers no transition and no refund path; it makes no liveness
    ///         claim and no claim about operator make-whole payments, which are off-chain by design.
    function test_D7_DrawingStaysDrawing_WhenDeliveryNeverHappens() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);
        uint256 escrowed = vault.getEscrow(NATIVE_DAY).amount;

        _step(block.timestamp + 3_650 days); // step 2: ten years with no callback

        vm.startPrank(stranger);
        vm.expectRevert(WrongState.selector);
        draw.expireUnrequested(NATIVE_DAY); // no timeout refund after an accepted request
        vm.expectRevert(WrongState.selector);
        draw.claimRefund(NATIVE_DAY, alice); // no refund path
        vm.expectRevert(WrongState.selector);
        draw.settle(NATIVE_DAY); // no settlement without words
        vm.expectRevert(WrongState.selector);
        draw.closeRound(NATIVE_DAY); // the round cannot be reset to Open
        vm.expectRevert(WrongState.selector);
        draw.requestDraw(NATIVE_DAY); // and no second request may be accepted
        vm.stopPrank();

        assertEq(vault.getEscrow(NATIVE_DAY).amount, escrowed, "the gross, reserved fee included, stays locked");
        assertEq(draw.pendingRequests(), 1, "the request is still counted against subscription funding");

        // Other rounds and available balances stay independent (§7.3): the pool keeps running normally
        // across the stuck round's whole lifetime, and the buyers' remaining balances still exit.
        uint256 stale = _successor(NATIVE_DAY); // opened at the cutoff, itself long past its cutoff by now
        vm.prank(stranger);
        draw.closeRound(stale); // empty: Void, and one fresh successor opens
        uint256 fresh = draw.getCurrent(NATIVE_POOL, Kind.Day100);
        assertEq(uint8(_state(fresh)), uint8(State.Open));
        _depositNative(carol, 1 ether);
        _buy(carol, fresh, 0.01 ether);
        uint256 aliceAvailable = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(alice);
        vault.withdraw(NATIVE_ASSET, aliceAvailable);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, stale, fresh));

        _evidence("Drawing stays Drawing, no delivery", NATIVE_DAY, "keeper+stranger", "never", "fresh", State.Drawing);
    }

    /// @notice A request accepted at deadline-1 stays valid afterwards: delivery 30 days past the deadline
    ///         still reaches Ready and then Settled, and no refund path opens in between (A17).
    function test_D7_DrawingToSettled_WithDeliveryAfterTheRequestDeadline() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        _step(draw.getRound(NATIVE_DAY).requestDeadline - 1); // step 2
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);
        uint256 requestId = draw.getRound(NATIVE_DAY).requestId;

        _step(block.timestamp + 30 days); // step 3: long past the request deadline

        vm.prank(stranger);
        vm.expectRevert(WrongState.selector);
        draw.expireUnrequested(NATIVE_DAY); // an accepted request has no expiry

        assertTrue(_fulfill(requestId, 0, 0.015 ether), "late delivery is still accepted");
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Ready));

        vm.prank(stranger);
        draw.settle(NATIVE_DAY);
        assertEq(draw.getRound(NATIVE_DAY).winner, bob, "index 0.015 lies in bob's range [0.01, 0.02)");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Drawing->Settled late delivery",
            NATIVE_DAY,
            "keeper+stranger",
            "late-after-deadline",
            "fresh",
            State.Settled
        );
    }

    /// @notice Two zero words are valid data, not a missing-word marker: index 0 selects the first range
    ///         and the round settles normally (A22).
    function test_D7_DrawingToSettled_WithTwoZeroWords() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);

        assertTrue(_fulfill(draw.getRound(NATIVE_DAY).requestId, 0, 0), "zero words delivered");
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Ready));

        vm.prank(stranger);
        draw.settle(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.winningIndex, 0);
        assertEq(round.winner, alice, "index 0 lies in the first range");
        assertEq(round.prizePot + round.feeReserved, round.grossTotal, "D3: releases sum to gross");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("Drawing->Settled zero words", NATIVE_DAY, "keeper+stranger", "zero-words", "fresh", State.Settled);
    }

    /// @notice A malformed delivery is ignored and the round stays Drawing. The coordinator records that
    ///         request as fulfilled and never retries it (§7.3), so this is the locked-escrow limitation in
    ///         practice, not a recoverable state; no liveness is asserted.
    function test_D7_DrawingStaysDrawing_OnAMalformedDelivery() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);
        uint256 requestId = draw.getRound(NATIVE_DAY).requestId;

        uint256[] memory three = new uint256[](3);
        three[0] = 1;
        three[1] = 2;
        three[2] = 3;
        assertTrue(coordinator.fulfill(requestId, three), "the callback returns without reverting");

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertFalse(round.word0 != 0 || round.word1 != 0, "no words were stored");
        assertEq(draw.pendingRequests(), 1, "the request is still outstanding");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, round.grossTotal, "escrow stays locked");

        vm.expectRevert(abi.encodeWithSelector(MockVRFCoordinatorV2Plus.AlreadyFulfilled.selector, requestId));
        coordinator.fulfill(requestId, three); // the coordinator never retries a delivered request

        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));
        _evidence("Drawing ignores a malformed delivery", NATIVE_DAY, "keeper", "malformed", "fresh", State.Drawing);
    }

    // =====================================================================
    // Ready -> Settled
    // =====================================================================

    /// @notice Settlement needs no owner, no price and no unpaused system: an unrelated address settles a
    ///         Ready round with every pause flag set and the aggregator dead (A25, §6.2, §7.2).
    function test_D7_ReadyToSettled_ByAStrangerWithEveryPauseOnAndADeadFeed() public {
        _twoBuyers(NATIVE_DAY);
        _step(DAY_CUTOFF); // step 1
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        draw.requestDraw(NATIVE_DAY);
        assertTrue(_fulfill(draw.getRound(NATIVE_DAY).requestId, 0, 0.015 ether));

        vm.startPrank(owner);
        draw.setBuysPaused(true);
        draw.setPoolBuysPaused(NATIVE_POOL, true);
        vault.setDepositsPaused(true);
        vault.setDepositsEnabled(NATIVE_ASSET, false);
        vm.stopPrank();
        feed.setRevert(true, true);

        uint256 prize = draw.getRound(NATIVE_DAY).prizePot;
        uint256 fee = draw.getRound(NATIVE_DAY).feeReserved;

        vm.prank(stranger);
        draw.settle(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.winner, bob);
        assertEq(vault.balanceOf(bob, NATIVE_ASSET), 1 ether - 0.01 ether + prize);
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), fee, "the round's frozen fee account was paid");
        assertEq(vault.balanceOf(stranger, NATIVE_ASSET), 0, "the settling caller receives nothing");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0, "D1: zero escrow in Settled");

        // The pauses never gate an exit either (V3).
        uint256 credited = vault.balanceOf(bob, NATIVE_ASSET);
        vm.prank(bob);
        vault.withdraw(NATIVE_ASSET, credited);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Ready->Settled, all pauses on, dead feed",
            NATIVE_DAY,
            "keeper+stranger",
            "delivered",
            "unavailable",
            State.Settled
        );
    }

    // =====================================================================
    // Long keeper absence (A15)
    // =====================================================================

    /// @notice Three missed monthly periods produce one late close and exactly one successor, whose own
    ///         cutoff is the next boundary after the close, with no backfilled sequences (A15, §6.1, D4).
    function test_D7_KeeperAbsentForMonths_OneLateCloseOpensOneSuccessor() public {
        uint256 roundsBefore = draw.roundCount();
        _step(1_798_588_800); // step 1: 2026-12-30 00:00 UTC, 90 days after the 2026-10-01 cutoff

        vm.prank(keeper);
        draw.closeRound(NATIVE_MONTH);

        assertEq(draw.roundCount(), roundsBefore + 1, "A15: exactly one successor, no backfill loop");
        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Month100k);
        ILuckyDraw.RoundView memory next = draw.getRound(successor);
        assertEq(next.sequence, 2, "sequence advances by one, not by the number of missed months");
        assertEq(next.opensAt, uint64(block.timestamp), "creation never backdates availability");
        assertEq(next.closesAt, 1_798_761_600, "closes at 2027-01-01 00:00 UTC, the next boundary");
        assertEq(uint8(next.state), uint8(State.Open), "a two-day round is simply a short round");
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), NATIVE_DAY, "other sequences are untouched");

        _evidence("Keeper absent 90 days, empty month", NATIVE_MONTH, "keeper", "not-applicable", "fresh", State.Void);
    }

    /// @notice A funded round closed a full 24 hours after its cutoff has no request window at all and goes
    ///         straight to Refunding, while still recording closedAt and requestDeadline uniformly (D8).
    function test_D7_KeeperAbsentPastTheRequestWindow_ClosesStraightIntoRefunding() public {
        _twoBuyers(NATIVE_DAY);
        uint256 roundsBefore = draw.roundCount();

        _step(DAY_CUTOFF + REQUEST_WINDOW); // step 1: exactly 24 hours late

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.refundReason), uint8(RefundReason.RequestDeadlineExpired));
        assertEq(uint8(round.closeReason), uint8(CloseReason.Cutoff));
        assertEq(round.closedAt, DAY_CUTOFF + REQUEST_WINDOW);
        assertEq(round.requestDeadline, round.closedAt + REQUEST_WINDOW, "D8 holds even where no request is possible");
        assertEq(draw.roundCount(), roundsBefore + 1, "A15: one successor");

        vm.prank(stranger);
        vm.expectRevert(WrongState.selector);
        draw.requestDraw(NATIVE_DAY);

        vm.startPrank(keeper);
        draw.claimRefund(NATIVE_DAY, alice);
        draw.claimRefund(NATIVE_DAY, bob);
        vm.stopPrank();
        assertEq(round.grossTotal, draw.getRound(NATIVE_DAY).refundedGross);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence(
            "Keeper absent past the request window", NATIVE_DAY, "keeper", "not-applicable", "fresh", State.Refunding
        );
    }

    // =====================================================================
    // No owner is ever required
    // =====================================================================

    /// @notice The whole lifecycle runs after ownership has moved to a fresh address that never acts again:
    ///         seed, purchases, close, request, delivery and settlement are all driven by a stranger (D6, D7).
    function test_D7_NoOwnerIsRequired_AfterOwnershipMovesToAnAddressThatNeverActs() public {
        // Configuration first, by the deploying owner.
        _seedTheDailyRoundConfigOnly();
        vm.prank(owner);
        draw.transferOwnership(quietOwner);
        vm.prank(quietOwner); // its only action ever: accepting the two-step transfer
        draw.acceptOwnership();
        assertEq(draw.owner(), quietOwner);

        // From here on, only `stranger` and ordinary buyers act.
        vm.prank(stranger);
        draw.seedRound(NATIVE_DAY);
        assertEq(draw.getRound(NATIVE_DAY).seedAccount, seedSafe);

        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(bob, NATIVE_DAY, 0.01 ether);

        _step(DAY_CUTOFF); // step 1
        vm.prank(stranger);
        draw.closeRound(NATIVE_DAY);
        vm.prank(stranger);
        draw.requestDraw(NATIVE_DAY);
        assertTrue(_fulfill(draw.getRound(NATIVE_DAY).requestId, 0, 0));
        vm.prank(stranger);
        draw.settle(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.winner, seedSafe, "index 0 lies in the seed's own range; the seed wins like any buyer");
        assertEq(vault.balanceOf(quietOwner, NATIVE_ASSET), 0, "the owner never receives or moves money");
        assertEq(vault.balanceOf(stranger, NATIVE_ASSET), 0, "neither does the caller");
        assertEq(round.prizePot + round.feeReserved, round.grossTotal, "D3");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0);
        _assertConservation(NATIVE_ASSET, _ids(NATIVE_DAY, _successor(NATIVE_DAY)));

        _evidence("Full lifecycle with an absent owner", NATIVE_DAY, "stranger", "delivered", "fresh", State.Settled);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    /// @dev One time step with both feeds republished at the new timestamp.
    function _step(uint256 when) private {
        vm.warp(when);
        _refreshFeeds();
        _steps += 1;
    }

    /// @dev One time step that deliberately leaves the feeds where they were, so they go stale.
    function _stepStale(uint256 when) private {
        vm.warp(when);
        _steps += 1;
    }

    /// @dev Two distinct addresses, 0.01 ether each, in the unseeded native daily round.
    function _twoBuyers(uint256 roundId) private {
        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _buy(alice, roundId, 0.01 ether);
        _buy(bob, roundId, 0.01 ether);
        assertEq(draw.getRound(roundId).playerCount, 2);
    }

    /// @dev Points and funds the operator seed without entering it.
    function _seedTheDailyRoundConfigOnly() private {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 1 ether);
    }

    /// @dev Points, funds and enters the operator seed in the native daily round.
    function _seedTheDailyRound() private {
        _seedTheDailyRoundConfigOnly();
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        assertTrue(draw.getRound(NATIVE_DAY).seeded);
    }

    /// @dev The successor the closing transaction opened for the same pool and kind.
    function _successor(uint256 roundId) private view returns (uint256 successor) {
        ILuckyDraw.RoundView memory round = draw.getRound(roundId);
        successor = draw.getCurrent(round.poolId, round.kind);
        assertTrue(successor != roundId && successor != 0, "exactly one successor exists");
    }

    /// @dev Asserts the reached state and prints the scenario's D7 evidence row.
    function _evidence(
        string memory scenario,
        uint256 roundId,
        string memory caller,
        string memory vrf,
        string memory oracle,
        State reached
    ) private view {
        assertEq(uint8(_state(roundId)), uint8(reached), scenario);
        console2.log(
            string.concat(
                "D7 | ",
                scenario,
                " | steps=",
                vm.toString(_steps),
                " | caller=",
                caller,
                " | vrf=",
                vrf,
                " | oracle=",
                oracle,
                " | reached=",
                _stateName(reached)
            )
        );
    }

    /// @dev Enum name for the printed row.
    function _stateName(State value) private pure returns (string memory) {
        if (value == State.Open) return "Open";
        if (value == State.AwaitingRequest) return "AwaitingRequest";
        if (value == State.Drawing) return "Drawing";
        if (value == State.Ready) return "Ready";
        if (value == State.Settled) return "Settled";
        if (value == State.Refunding) return "Refunding";
        return "Void";
    }
}
