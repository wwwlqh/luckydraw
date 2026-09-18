// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LuckyDrawUpkeep} from "../../src/LuckyDrawUpkeep.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {InvalidAmount, InvalidConfig, InvalidId, WrongState} from "../../src/Errors.sol";
import {Kind, KIND_COUNT, NATIVE_ASSET, State} from "../../src/Types.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";

/// @notice Unit suite for the Chainlink Automation executor (SPEC §10.3, §6.2, ADR 039).
/// @dev Uses the shared `LuckyDrawBase` fixture, so the Draw, the Vault, the labeled mock coordinator and the two
///      mock feeds are the same ones every other lifecycle suite runs against. Nothing here grants the upkeep a
///      role: it is deployed as an ordinary unprivileged address.
contract LuckyDrawUpkeepTest is LuckyDrawBase {
    LuckyDrawUpkeep internal upkeep;

    /// @dev `checkData` that makes `_scanCurrent` scan nothing, so a test can isolate the historical sweep.
    ///      `poolCursor == poolCount` is past the end of the pool list, which returns an empty page.
    function _historyOnly(uint256 cursor, uint256 limit) internal view returns (bytes memory) {
        return abi.encode(draw.poolCount(), uint256(1), cursor, limit);
    }

    function setUp() public virtual override {
        super.setUp();
        upkeep = new LuckyDrawUpkeep(address(draw));
    }

    function _check(bytes memory checkData) internal view returns (bool needed, LuckyDrawUpkeep.Action, uint256) {
        bytes memory performData;
        (needed, performData) = upkeep.checkUpkeep(checkData);
        (LuckyDrawUpkeep.Action action, uint256 roundId) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
        return (needed, action, roundId);
    }

    /// @dev Runs check/perform until nothing is due, at most `budget` times. Returns the actions performed.
    function _drain(uint256 budget) internal returns (uint256 performed) {
        for (uint256 i = 0; i < budget; ++i) {
            (bool needed, bytes memory performData) = upkeep.checkUpkeep("");
            if (!needed) return performed;
            upkeep.performUpkeep(performData);
            ++performed;
        }
        return performed;
    }

    // ---- construction -------------------------------------------------------

    function test_Constructor_BindsTheDrawImmutably() public view {
        assertEq(address(upkeep.DRAW()), address(draw), "DRAW");
        assertEq(upkeep.MAX_POOL_PAGE(), 16, "MAX_POOL_PAGE");
        assertEq(upkeep.MAX_ROUND_PAGE(), 256, "MAX_ROUND_PAGE");
    }

    function test_Constructor_RevertWhen_DrawIsZero() public {
        vm.expectRevert(InvalidConfig.selector);
        new LuckyDrawUpkeep(address(0));
    }

    function test_Constructor_RevertWhen_DrawHasNoCode() public {
        vm.expectRevert(InvalidConfig.selector);
        new LuckyDrawUpkeep(alice);
    }

    // ---- nothing due --------------------------------------------------------

    function test_NoActionWhileEveryRoundIsOpenBeforeItsCutoff() public view {
        (bool needed, LuckyDrawUpkeep.Action action, uint256 roundId) = _check("");
        assertFalse(needed, "nothing is due at START");
        assertEq(uint256(action), uint256(LuckyDrawUpkeep.Action.None), "action");
        assertEq(roundId, 0, "roundId");
    }

    function test_NoActionWhileDrawing() public {
        _fundAndBuy(alice, NATIVE_DAY, SMALL);
        _fundAndBuy(bob, NATIVE_DAY, SMALL);
        _closeAtCutoff(NATIVE_DAY);
        _request(NATIVE_DAY);
        assertEq(uint256(_state(NATIVE_DAY)), uint256(State.Drawing), "Drawing");

        (bool needed,,) = _check(_historyOnly(NATIVE_DAY - 1, 1));
        assertFalse(needed, "Drawing waits for the authenticated callback (SPEC 7.3)");
    }

    /// @dev USD 6 at the fixture's USD 600 feed: two of these stay well under every kind's target, so a round
    ///      closes at its cutoff rather than inside the purchase that would have reached the target.
    uint256 internal constant SMALL = 0.01 ether;

    function test_NoActionOnAVoidRound() public {
        _closeAtCutoff(NATIVE_DAY); // no entries at all
        assertEq(uint256(_state(NATIVE_DAY)), uint256(State.Void), "Void");
        (bool needed,,) = _check(_historyOnly(NATIVE_DAY - 1, 1));
        assertFalse(needed, "Void is terminal");
    }

    function test_NoActionOnARefundingRound() public {
        _fundAndBuy(alice, NATIVE_WEEK, SMALL); // one player only
        _closeAtCutoff(NATIVE_WEEK);
        assertEq(uint256(_state(NATIVE_WEEK)), uint256(State.Refunding), "Refunding");
        (bool needed,,) = _check(_historyOnly(NATIVE_WEEK - 1, 1));
        assertFalse(needed, "claimRefund credits a named buyer and is never an upkeep action (D9)");
    }

    function test_NoActionOnASettledRound() public {
        _fundAndBuy(alice, NATIVE_WEEK, SMALL);
        _fundAndBuy(bob, NATIVE_WEEK, SMALL);
        _driveToReady(NATIVE_WEEK, 1, 0);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.Settle, NATIVE_WEEK));
        assertEq(uint256(_state(NATIVE_WEEK)), uint256(State.Settled), "Settled");
        (bool needed,,) = _check(_historyOnly(NATIVE_WEEK - 1, 1));
        assertFalse(needed, "Settled is terminal");
    }

    // ---- closeRound ---------------------------------------------------------

    function test_CloseRound_IsNotOfferedOneSecondBeforeTheCutoff() public {
        _warp(uint256(draw.getRound(NATIVE_DAY).closesAt) - 1);
        (bool needed,,) = _check("");
        assertFalse(needed, "closeRound reverts RoundNotClosed before closesAt");
    }

    function test_CloseRound_IsOfferedExactlyAtTheCutoff() public {
        _warp(draw.getRound(NATIVE_DAY).closesAt);
        (bool needed, LuckyDrawUpkeep.Action action, uint256 roundId) = _check("");
        assertTrue(needed, "due at closesAt");
        assertEq(uint256(action), uint256(LuckyDrawUpkeep.Action.CloseRound), "action");
        assertEq(roundId, NATIVE_DAY, "the first pool's first kind is scanned first");
    }

    function test_PerformUpkeep_ClosesAndAdvancesTheSequence() public {
        _fundAndBuy(alice, NATIVE_DAY, SMALL);
        _fundAndBuy(bob, NATIVE_DAY, SMALL);
        _warp(draw.getRound(NATIVE_DAY).closesAt);

        uint256 before = draw.roundCount();
        (, bytes memory performData) = upkeep.checkUpkeep("");
        vm.expectEmit(true, true, true, true, address(upkeep));
        emit LuckyDrawUpkeep.UpkeepPerformed(LuckyDrawUpkeep.Action.CloseRound, NATIVE_DAY, address(this));
        upkeep.performUpkeep(performData);

        assertEq(uint256(_state(NATIVE_DAY)), uint256(State.AwaitingRequest), "AwaitingRequest");
        assertEq(draw.roundCount(), before + 1, "successor opened");
        assertEq(draw.getCurrent(NATIVE_POOL, Kind.Day100), before + 1, "current advanced");
    }

    /// @dev A target close happens inside `buy`, never through `closeRound` (SPEC §6.2, ADR 031), so a round that
    ///      reached its target is already closed and the executor has a request to offer, not a close.
    function test_ATargetClosedRoundIsOfferedARequestNotAClose() public {
        _fundAndBuy(alice, NATIVE_DAY, TARGET_NATIVE_100);
        _fundAndBuy(bob, NATIVE_DAY, TARGET_NATIVE_100);
        assertEq(uint256(_state(NATIVE_DAY)), uint256(State.AwaitingRequest), "target close");

        (bool needed, LuckyDrawUpkeep.Action action, uint256 roundId) = _check(_historyOnly(NATIVE_DAY - 1, 1));
        assertTrue(needed, "due");
        assertEq(uint256(action), uint256(LuckyDrawUpkeep.Action.RequestDraw), "action");
        assertEq(roundId, NATIVE_DAY, "roundId");
    }

    // ---- requestDraw and its SPEC 6.2 pre-checks ----------------------------

    function _awaitingRequest() internal returns (uint256 roundId) {
        roundId = NATIVE_WEEK;
        _fundAndBuy(alice, roundId, SMALL);
        _fundAndBuy(bob, roundId, SMALL);
        _closeAtCutoff(roundId);
        assertEq(uint256(_state(roundId)), uint256(State.AwaitingRequest), "AwaitingRequest");
    }

    function test_RequestDraw_IsOfferedInsideTheWindowAndPerforms() public {
        uint256 roundId = _awaitingRequest();
        bytes memory checkData = _historyOnly(roundId - 1, 1);

        (bool needed, LuckyDrawUpkeep.Action action,) = _check(checkData);
        assertTrue(needed && action == LuckyDrawUpkeep.Action.RequestDraw, "RequestDraw");

        (, bytes memory performData) = upkeep.checkUpkeep(checkData);
        upkeep.performUpkeep(performData);
        assertEq(uint256(_state(roundId)), uint256(State.Drawing), "Drawing");
        assertGt(draw.getRound(roundId).requestId, 0, "requestId recorded");
    }

    function test_RequestDraw_IsNotOfferedWhenTheKeyHashIsDeregistered() public {
        uint256 roundId = _awaitingRequest();
        coordinator.deregisterKey(KEY_HASH);
        assertFalse(upkeep.requestReady(), "requestReady");

        (bool needed,,) = _check(_historyOnly(roundId - 1, 1));
        assertFalse(needed, "an unfulfillable request is never offered (SPEC 6.2 KeyHashUnsupported)");
    }

    function test_RequestDraw_IsNotOfferedWhenTheSubscriptionIsUnderfunded() public {
        uint256 roundId = _awaitingRequest();
        coordinator.fundNative(subId, uint96(MAX_REQUEST_COST - 1));
        assertFalse(upkeep.requestReady(), "requestReady");

        (bool needed,,) = _check(_historyOnly(roundId - 1, 1));
        assertFalse(needed, "SPEC 6.2 SubscriptionUnderfunded");
    }

    /// @dev The pre-checks gate `checkUpkeep` only. `performUpkeep` revalidates state, so a subscription that
    ///      drained between the simulation and the transaction surfaces as the Draw's own named error, which is
    ///      the one the §10.3 alert table is written around.
    function test_PerformUpkeep_SurfacesTheDrawsOwnPrecheckError() public {
        uint256 roundId = _awaitingRequest();
        (, bytes memory performData) = upkeep.checkUpkeep(_historyOnly(roundId - 1, 1));
        coordinator.fundNative(subId, 0);

        vm.expectRevert(bytes4(keccak256("SubscriptionUnderfunded()")));
        upkeep.performUpkeep(performData);
    }

    // ---- expireUnrequested at the deadline boundary -------------------------

    function test_ExpireUnrequested_TheDeadlineIsTheBoundary() public {
        uint256 roundId = _awaitingRequest();
        uint64 deadline = draw.getRound(roundId).requestDeadline;
        bytes memory checkData = _historyOnly(roundId - 1, 1);

        _warp(uint256(deadline) - 1);
        (, LuckyDrawUpkeep.Action before,) = _check(checkData);
        assertEq(uint256(before), uint256(LuckyDrawUpkeep.Action.RequestDraw), "request is allowed up to the deadline");

        _warp(deadline);
        (bool needed, LuckyDrawUpkeep.Action at, uint256 id) = _check(checkData);
        assertTrue(needed, "due");
        assertEq(uint256(at), uint256(LuckyDrawUpkeep.Action.ExpireUnrequested), "at the deadline, expire");
        assertEq(id, roundId, "roundId");

        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.ExpireUnrequested, roundId));
        assertEq(uint256(_state(roundId)), uint256(State.Refunding), "Refunding");
    }

    /// @dev An expired round is offered even when the VRF pre-checks fail: refunds must not depend on the
    ///      subscription (SPEC §6.2 "expires into refunds instead of locking").
    function test_ExpireUnrequested_IsOfferedEvenWithADeadCoordinator() public {
        uint256 roundId = _awaitingRequest();
        coordinator.deregisterKey(KEY_HASH);
        _warp(draw.getRound(roundId).requestDeadline);

        (bool needed, LuckyDrawUpkeep.Action action,) = _check(_historyOnly(roundId - 1, 1));
        assertTrue(needed && action == LuckyDrawUpkeep.Action.ExpireUnrequested, "expire is always available");
    }

    // ---- settle -------------------------------------------------------------

    function test_Settle_IsOfferedWhenReadyAndPerformsTheDraw() public {
        _fundAndBuy(alice, NATIVE_WEEK, SMALL);
        _fundAndBuy(bob, NATIVE_WEEK, SMALL);
        _driveToReady(NATIVE_WEEK, 0, 0);
        bytes memory checkData = _historyOnly(NATIVE_WEEK - 1, 1);

        (bool needed, LuckyDrawUpkeep.Action action, uint256 roundId) = _check(checkData);
        assertTrue(needed, "due");
        assertEq(uint256(action), uint256(LuckyDrawUpkeep.Action.Settle), "action");
        assertEq(roundId, NATIVE_WEEK, "roundId");

        (, bytes memory performData) = upkeep.checkUpkeep(checkData);
        upkeep.performUpkeep(performData);
        assertEq(uint256(_state(NATIVE_WEEK)), uint256(State.Settled), "Settled");
        assertEq(draw.getRound(NATIVE_WEEK).winner, alice, "word 0 selects the first range");
    }

    // ---- historical unresolved rounds --------------------------------------

    /// @dev `closeRound` advances `current` in the same transaction, so a round that still needs a request is no
    ///      longer any pool's current round. The historical window is what finds it.
    function test_AnUnresolvedRoundBehindCurrentIsFound() public {
        uint256 roundId = _awaitingRequest();
        assertTrue(draw.getCurrent(NATIVE_POOL, Kind.Week1k) != roundId, "no longer current");

        // Phase 1 alone sees nothing on this pool/kind: its current round is a fresh Open one.
        ILuckyDraw.RoundView memory current = draw.getRound(draw.getCurrent(NATIVE_POOL, Kind.Week1k));
        assertEq(uint256(current.state), uint256(State.Open), "successor is Open");
        assertEq(uint256(upkeep.stateAction(current)), uint256(LuckyDrawUpkeep.Action.None), "successor is not yet due");

        (bool needed, LuckyDrawUpkeep.Action action, uint256 found) = _check(_historyOnly(roundId - 1, 1));
        assertTrue(needed, "the historical sweep finds it");
        assertEq(uint256(action), uint256(LuckyDrawUpkeep.Action.RequestDraw), "action");
        assertEq(found, roundId, "roundId");
    }

    /// @dev The default `checkData` covers both phases, so an unattended registration drives a round from Open to
    ///      Settled without any cursor tuning.
    function test_DefaultCheckDataDrivesARoundAllTheWayToSettled() public {
        _fundAndBuy(alice, NATIVE_WEEK, SMALL);
        _fundAndBuy(bob, NATIVE_WEEK, SMALL);
        _warp(WEEK_CUTOFF);

        uint256 performed = _drain(256);
        assertGt(performed, 0, "the executor acted");
        assertEq(uint256(_state(NATIVE_WEEK)), uint256(State.Drawing), "Drawing: the callback is the coordinator's");

        assertTrue(_fulfill(draw.getRound(NATIVE_WEEK).requestId, 3, 0), "callback");
        _drain(256);
        assertEq(uint256(_state(NATIVE_WEEK)), uint256(State.Settled), "Settled");

        (bool needed,,) = _check("");
        assertFalse(needed, "a drained deployment offers nothing");
    }

    // ---- pagination ---------------------------------------------------------

    function test_Pagination_APageCoversOnlyItsOwnPools() public {
        _warp(DAY_CUTOFF); // every daily round of both pools is now past its cutoff

        // Pool 1 only.
        (, LuckyDrawUpkeep.Action first, uint256 firstId) =
            _check(abi.encode(uint256(0), uint256(1), uint256(0), uint256(1)));
        assertEq(uint256(first), uint256(LuckyDrawUpkeep.Action.CloseRound), "pool 1 close");
        assertEq(firstId, NATIVE_DAY, "pool 1, Day100");

        // Pool 2 only: the second page starts at cursor 1.
        (, LuckyDrawUpkeep.Action second, uint256 secondId) =
            _check(abi.encode(uint256(1), uint256(1), uint256(0), uint256(1)));
        assertEq(uint256(second), uint256(LuckyDrawUpkeep.Action.CloseRound), "pool 2 close");
        assertEq(secondId, TOKEN_DAY, "pool 2, Day100");

        // A cursor past the end scans no pool, and round id 1 is the only history entry in this window.
        (, LuckyDrawUpkeep.Action third, uint256 thirdId) =
            _check(abi.encode(uint256(9), uint256(1), uint256(0), uint256(1)));
        assertEq(uint256(third), uint256(LuckyDrawUpkeep.Action.CloseRound), "history window");
        assertEq(thirdId, 1, "only round 1 is inside the window");
    }

    function test_Pagination_TogetherThePagesCoverEveryPoolAndKind() public {
        _warp(MONTH_CUTOFF); // past every cutoff of both pools

        bool[15] memory seen;
        for (uint256 page = 0; page < 2; ++page) {
            bytes memory checkData = abi.encode(page, uint256(1), uint256(0), uint256(1));
            for (uint256 i = 0; i < KIND_COUNT; ++i) {
                (bool needed, bytes memory performData) = upkeep.checkUpkeep(checkData);
                assertTrue(needed, "each kind of each page is due in turn");
                (, uint256 roundId) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
                seen[roundId] = true;
                upkeep.performUpkeep(performData);
            }
        }
        for (uint256 id = 1; id <= 14; ++id) {
            assertTrue(seen[id], "every one of the fourteen first rounds was closed through its own page");
        }
    }

    function test_Pagination_AWindowOutsideTheRoundExcludesIt() public {
        uint256 roundId = _awaitingRequest();
        // A window over rounds 1..3 cannot see round 4. Those three daily rounds are themselves past their
        // cutoff by now, so the window is not empty -- it simply never names the round outside it.
        (bool needed,, uint256 other) = _check(_historyOnly(0, 3));
        assertTrue(needed && other != roundId, "the window answers from inside itself");
        assertLe(other, 3, "and never from outside it");
        (bool inWindow,, uint256 found) = _check(_historyOnly(0, roundId));
        assertTrue(inWindow, "and inside a wider one it is found");
        assertEq(found, roundId, "roundId");
    }

    function test_Pagination_LimitsAreClampedToTheConstants() public {
        _warp(DAY_CUTOFF);
        // An oversized pool limit is clamped rather than passed to `getPools`, which reverts above 100.
        (bool needed,, uint256 roundId) =
            _check(abi.encode(uint256(0), type(uint256).max, uint256(0), type(uint256).max));
        assertTrue(needed, "clamped, not reverted");
        assertEq(roundId, NATIVE_DAY, "same first answer as the default page");
    }

    function test_CheckUpkeep_RevertWhen_CheckDataIsMalformed() public {
        vm.expectRevert();
        upkeep.checkUpkeep(hex"1234");
    }

    // ---- revalidation -------------------------------------------------------

    function test_PerformUpkeep_RevertWhen_TheStateMovedAfterTheSimulation() public {
        _warp(draw.getRound(NATIVE_DAY).closesAt);
        (, bytes memory performData) = upkeep.checkUpkeep("");

        // Somebody else closes it first: the identical action is no longer applicable.
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(performData);
    }

    function test_PerformUpkeep_RevertWhen_TheActionWasNeverApplicable() public {
        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.Settle, NATIVE_DAY));
    }

    function test_PerformUpkeep_RevertWhen_TheActionIsNone() public {
        vm.expectRevert(InvalidAmount.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.None, NATIVE_DAY));
    }

    function test_PerformUpkeep_RevertWhen_TheRoundIdIsZero() public {
        vm.expectRevert(InvalidAmount.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.CloseRound, uint256(0)));
    }

    function test_PerformUpkeep_RevertWhen_TheRoundIsUnknown() public {
        vm.expectRevert(InvalidId.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.CloseRound, uint256(9_999)));
    }

    function test_PerformUpkeep_RevertWhen_TheActionIsOutsideTheEnum() public {
        vm.expectRevert();
        upkeep.performUpkeep(abi.encode(uint8(9), NATIVE_DAY));
    }

    // ---- no role, no funds, no other call ----------------------------------

    /// @dev The whole authority of this contract is four selectors on one immutable Draw. There is no fallback to
    ///      relay a call through, no payable path to fund it, and the Draw grants it nothing.
    function test_TheUpkeepIsAnOrdinaryUnprivilegedAddress() public {
        assertEq(address(upkeep).balance, 0, "holds nothing");
        assertTrue(draw.owner() != address(upkeep), "not the owner");
        assertTrue(draw.pendingOwner() != address(upkeep), "not the pending owner");
        assertTrue(draw.getSeedAccount() != address(upkeep), "not the seed account");
        assertTrue(draw.feeAccount() != address(upkeep), "not the fee account");
        assertEq(vault.balanceOf(address(upkeep), NATIVE_ASSET), 0, "no Vault balance");
    }

    function test_TheUpkeepRefusesValueAndUnknownSelectors() public {
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(upkeep).call{value: 1 wei}("");
        assertFalse(sent, "no receive or fallback");

        // Nothing in the ABI can be talked into calling something else on the Draw: every owner selector, the
        // seed and the refund are simply absent.
        (bool owned,) = address(upkeep).call(abi.encodeWithSignature("transferOwnership(address)", alice));
        assertFalse(owned, "no ownership surface");
        (bool seeded,) = address(upkeep).call(abi.encodeWithSignature("seedRound(uint256)", NATIVE_DAY));
        assertFalse(seeded, "no seed surface (SPEC 5.4)");
        (bool claimed,) =
            address(upkeep).call(abi.encodeWithSignature("claimRefund(uint256,address)", NATIVE_DAY, alice));
        assertFalse(claimed, "no refund surface (D9)");
        (bool relayed,) = address(upkeep).call(abi.encodeWithSignature("execute(address,bytes)", address(draw), ""));
        assertFalse(relayed, "no arbitrary-call surface");
    }

    /// @dev `performUpkeep` never seeds: an unseeded Open round that is past its cutoff is closed, not seeded,
    ///      even with a fully configured and funded seed account.
    function test_PerformUpkeepNeverSpendsTheSeedAccount() public {
        _configureSeed(NATIVE_POOL, 1 ether, 1 ether);
        _depositNative(seedSafe, 100 ether);
        uint256 seedBefore = vault.balanceOf(seedSafe, NATIVE_ASSET);

        _warp(draw.getRound(NATIVE_DAY).closesAt);
        (, bytes memory performData) = upkeep.checkUpkeep("");
        upkeep.performUpkeep(performData);

        assertFalse(draw.getRound(NATIVE_DAY).seeded, "the closed round was never seeded by the executor");
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET), seedBefore, "the seed account was not debited");
    }
}
