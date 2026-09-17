// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LuckyDrawInvariantFixture} from "./LuckyDrawInvariants.t.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {State} from "../../src/Types.sol";

/// @notice Proves the stateful suite would actually notice a bricked protocol call.
/// @dev The campaign runs with `fail_on_revert = false`, so an assertion that fails inside a handler action is
///      silently discarded: the handler therefore *records* violations and the `invariant_*` functions assert
///      the records. That indirection is only worth anything if the recording really happens, and a liveness
///      bug is the case where it is easiest to lose — a call that reverts leaves the ghost untouched, so every
///      balance, escrow and state check still passes and the campaign ends with zero violations. These are
///      ordinary unit tests (not invariants): they brick one protocol function with `vm.mockCallRevert` on a
///      target the ghost considers eligible and check that `P_LIVE` was recorded, which is what
///      `invariant_D7_EligibleCallsNeverRevert` asserts.
contract HandlerHonestyTest is LuckyDrawInvariantFixture {
    function setUp() public {
        _deployFixture();
    }

    /// @dev A keeper's `closeRound` on an Open round past its cutoff: nothing the campaign can configure may
    ///      reject it, so a revert there is a D7 liveness failure and must be recorded.
    function test_ClosingAnEligibleRoundThatRevertsIsRecorded() public {
        // Round 1 is pool 1's Day100 round (`addPool` opens the daily tiers first), so its cutoff is the first to pass.
        vm.warp(uint256(draw.getRound(1).closesAt) + 1);
        assertEq(handler.violationCount(), 0, "the fixture should start clean");

        vm.mockCallRevert(address(draw), abi.encodeWithSelector(LuckyDraw.closeRound.selector), "bricked");
        handler.actCloseRound(0, 0);
        vm.clearMockedCalls();

        assertEq(handler.violations(handler.P_LIVE()), 1, "a bricked closeRound was not recorded as P_LIVE");
        assertEq(handler.violationCount(), 1, "the bricked call recorded something other than P_LIVE");
        assertEq(handler.revertedOf(handler.A_CLOSE()), 1, "the reverted bucket did not see the call");
        assertEq(handler.totalApplied(), 0, "a bricked call must not be counted as applied");
        assertEq(uint256(draw.getRound(1).state), uint256(State.Open), "the bricked round left Open");
    }

    /// @dev The same for `settle` on a Ready round, driven there through the handler's own actions so the ghost
    ///      stays in step: settlement reads only frozen terms, the stored words and the stored ranges, so it
    ///      must succeed for any caller at any later time.
    function test_SettlingAnEligibleRoundThatRevertsIsRecorded() public {
        uint256 ready = _driveToReady();
        assertTrue(ready != 0, "the handler did not reach a Ready round");
        assertEq(handler.violationCount(), 0, "driving the handler to Ready recorded a violation");

        uint256 revertedBefore = handler.revertedOf(handler.A_SETTLE());
        vm.mockCallRevert(address(draw), abi.encodeWithSelector(LuckyDraw.settle.selector), "bricked");
        handler.actSettle(0);
        vm.clearMockedCalls();

        assertEq(handler.violations(handler.P_LIVE()), 1, "a bricked settle was not recorded as P_LIVE");
        assertEq(handler.violationCount(), 1, "the bricked call recorded something other than P_LIVE");
        assertEq(handler.revertedOf(handler.A_SETTLE()), revertedBefore + 1, "the reverted bucket did not see it");
        assertEq(handler.settledRounds(), 0, "no round should have settled");
        assertEq(uint256(draw.getRound(ready).state), uint256(State.Ready), "the bricked round left Ready");
    }

    /// @dev Buys into the open rounds with several actors, then cycles close / request / fulfil until one round
    ///      is Ready. Every step goes through the handler, so the ghost ledger tracks the whole sequence.
    function _driveToReady() private returns (uint256) {
        for (uint256 i = 0; i < 40; ++i) {
            handler.actBuy(i, i, i);
            handler.actBuy(i + 100, i, i + 7);
        }
        for (uint256 k = 0; k < 60; ++k) {
            handler.actCloseRound(k, k);
            handler.actRequestDraw(k);
            handler.actFulfill(k, k + 1, k + 2);
            uint256 ready = _firstReady();
            if (ready != 0) return ready;
        }
        return 0;
    }

    function _firstReady() private view returns (uint256) {
        uint256 count = draw.roundCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (draw.getRound(id).state == State.Ready) return id;
        }
        return 0;
    }
}
