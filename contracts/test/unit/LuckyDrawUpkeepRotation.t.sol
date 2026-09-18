// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {LuckyDrawUpkeep} from "../../src/LuckyDrawUpkeep.sol";
import {WrongState} from "../../src/Errors.sol";
import {Kind, KIND_COUNT, NATIVE_ASSET} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockUpkeepDraw} from "../mocks/MockUpkeepDraw.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";

/// @notice Rotation coverage and the `performUpkeep` revalidation guard (SPEC §10.3, ADR 039).
/// @dev Both questions are about `checkUpkeep`'s *arithmetic* over a sequence far longer than a test can close
///      on the production Draw, and about a guard the production Draw hides behind its own identical revert, so
///      this suite runs against `MockUpkeepDraw`. The gas budget, which is only meaningful against real storage,
///      is measured against the production Draw in `LuckyDrawUpkeepGasTest` below.
contract LuckyDrawUpkeepRotationTest is Test {
    MockUpkeepDraw internal drawMock;
    LuckyDrawUpkeep internal upkeep;

    uint256 internal constant SEQUENCE = 1_000;

    function setUp() public {
        drawMock = new MockUpkeepDraw();
        upkeep = new LuckyDrawUpkeep(address(drawMock));
    }

    function _roundPages(uint256 total) internal view returns (uint256) {
        uint256 per = upkeep.ROUNDS_PER_CHECK();
        return (total + per - 1) / per;
    }

    /// @dev The block, relative to zero, at which `checkUpkeep` first names `roundId`, or `type(uint256).max`.
    function _firstBlockNaming(uint256 roundId, uint256 blocks) internal returns (uint256) {
        for (uint256 b = 0; b < blocks; ++b) {
            vm.roll(b);
            (bool needed, bytes memory performData) = upkeep.checkUpkeep("");
            if (!needed) continue;
            (, uint256 found) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
            if (found == roundId) return b;
        }
        return type(uint256).max;
    }

    // ---- H1/M1: rotation reaches every page ---------------------------------

    /// @dev The regression this design exists for. Round 1 sits 999 identifiers behind the newest, so the
    ///      newest-first page alone never names it; rotation reaches it within one full cycle of the pages.
    function test_Rotation_AnOldRoundOutsideTheNewestPageIsStillReached() public {
        drawMock.setCounts(0, SEQUENCE);
        drawMock.setDue(1, true);

        vm.roll(0);
        (bool onPageZero,) = upkeep.checkUpkeep("");
        assertFalse(onPageZero, "the newest page alone cannot see round 1 of 1,000 -- that was the starvation");

        uint256 pages = _roundPages(SEQUENCE);
        uint256 window = pages * upkeep.ROTATE_BLOCKS();
        uint256 at = _firstBlockNaming(1, window);
        assertLt(at, window, "round 1 is named within ceil(roundCount / ROUNDS_PER_CHECK) * ROTATE_BLOCKS blocks");
        console2.log("rotation: roundCount 1000 covered in blocks", window);
    }

    /// @dev Every identifier, not just an interesting one: the pages tile 1..roundCount with no gap and no
    ///      identifier that only an off-by-one would reach.
    function test_Rotation_EveryHistoryPageIsReachableAsBlocksAdvance() public {
        drawMock.setCounts(0, SEQUENCE);
        uint256 window = _roundPages(SEQUENCE) * upkeep.ROTATE_BLOCKS();

        uint256[6] memory ids = [uint256(1), 2, 96, 97, 999, SEQUENCE];
        for (uint256 i = 0; i < ids.length; ++i) {
            drawMock.setDue(ids[i], true);
            assertLt(_firstBlockNaming(ids[i], window), window, "identifier unreachable within one rotation");
            drawMock.setDue(ids[i], false);
        }
    }

    /// @dev Phase 1 rotates on its own index: a sixteen-pool deployment is four pool pages, and the last one is
    ///      reached as surely as the first.
    function test_Rotation_ThePoolPageRotatesToo() public {
        drawMock.setCounts(16, 0);
        drawMock.setCurrent(16, Kind.Month100k, 4_242);
        drawMock.setDue(4_242, true);

        vm.roll(0);
        (bool onPageZero,) = upkeep.checkUpkeep("");
        assertFalse(onPageZero, "pool 16 is not on pool page 0");

        uint256 window = ((16 + upkeep.POOLS_PER_CHECK() - 1) / upkeep.POOLS_PER_CHECK()) * upkeep.ROTATE_BLOCKS();
        assertLt(_firstBlockNaming(4_242, window), window, "the last pool page is reached within one rotation");
    }

    /// @dev A page is held for `ROTATE_BLOCKS` blocks, which is what gives a `performUpkeep` time to be built and
    ///      included while its page is still the one being simulated.
    function test_Rotation_APageIsHeldForRotateBlocks() public {
        drawMock.setCounts(0, SEQUENCE);
        drawMock.setDue(1, true);
        uint256 rotate = upkeep.ROTATE_BLOCKS();
        uint256 at = _firstBlockNaming(1, _roundPages(SEQUENCE) * rotate);
        assertEq(at % rotate, 0, "a page begins on a multiple of ROTATE_BLOCKS");

        for (uint256 b = at; b < at + rotate; ++b) {
            vm.roll(b);
            (bool needed, bytes memory performData) = upkeep.checkUpkeep("");
            (, uint256 found) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
            assertTrue(needed && found == 1, "the page stays put for the whole hold");
        }
        vm.roll(at + rotate);
        (, bytes memory after_) = upkeep.checkUpkeep("");
        (, uint256 next) = abi.decode(after_, (LuckyDrawUpkeep.Action, uint256));
        assertTrue(next != 1, "and moves on afterwards");
    }

    /// @dev The operator override: an explicit cursor pins one page, and no amount of block progress moves it.
    function test_ExplicitCheckDataDoesNotRotate() public {
        drawMock.setCounts(0, SEQUENCE);
        drawMock.setDue(1, true);
        bytes memory pinned = abi.encode(uint256(0), uint256(0), uint256(0), uint256(96));

        for (uint256 b = 0; b < 5 * upkeep.ROTATE_BLOCKS(); b += 7) {
            vm.roll(b);
            (bool needed, bytes memory performData) = upkeep.checkUpkeep(pinned);
            (, uint256 found) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
            assertTrue(needed && found == 1, "a pinned page answers the same at every block");
        }
    }

    // ---- M2: the revalidation guard is load-bearing --------------------------

    /// @dev Mutation proof for `performUpkeep`'s `if (_stateAction(round) != action) revert WrongState();`.
    ///      Against the production Draw this guard is invisible: deleting it still reverts `WrongState`, because
    ///      the Draw refuses the same call with the same selector. This Draw does *not* refuse -- it records the
    ///      call and returns -- so without the guard `performUpkeep` succeeds and reaches `closeRound`, and both
    ///      assertions below fail. Re-run with the line deleted to confirm.
    function test_PerformUpkeep_RevalidationRefusesBeforeTheDrawIsReached() public {
        drawMock.setCounts(0, 1); // round 1 exists and is terminal, so no action is due on it

        vm.expectCall(address(drawMock), abi.encodeCall(MockUpkeepDraw.closeRound, (1)), 0);
        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.CloseRound, uint256(1)));

        assertEq(drawMock.closeRoundCalls(1), 0, "the Draw was never reached");
    }

    /// @dev The same for the three other branches, so the guard cannot be half-removed either.
    function test_PerformUpkeep_RevalidationRefusesEveryOtherBranchToo() public {
        drawMock.setCounts(0, 1);

        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.RequestDraw, uint256(1)));
        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.ExpireUnrequested, uint256(1)));
        vm.expectRevert(WrongState.selector);
        upkeep.performUpkeep(abi.encode(LuckyDrawUpkeep.Action.Settle, uint256(1)));

        assertEq(drawMock.requestDrawCalls(), 0, "requestDraw was never reached");
        assertEq(drawMock.expireUnrequestedCalls(), 0, "expireUnrequested was never reached");
        assertEq(drawMock.settleCalls(), 0, "settle was never reached");
    }
}

/// @notice The H1 gas budget, measured against the production Draw with real storage.
/// @dev Chainlink Automation publishes `checkGasLimit` 10,000,000 and `performGasLimit` 5,000,000 for BNB Chain
///      56 and 97 (docs.chain.link, Automation → Supported Networks, read 2026-09-18). A `checkUpkeep` that
///      exceeds `checkGasLimit` does not fail loudly: the registry simply records nothing due, and the upkeep
///      goes quiet. The budget asserted here is 8,000,000, 20% under the limit, at both maxima at once: a full
///      `POOLS_PER_CHECK` page of pools (28 current rounds at seven kinds) and a full `ROUNDS_PER_CHECK` page of
///      historical identifiers, with nothing due anywhere so every read is actually made.
contract LuckyDrawUpkeepGasTest is LuckyDrawBase {
    LuckyDrawUpkeep internal upkeep;

    /// @notice SPEC §10.3 / ADR 039 budget: 20% under the 10,000,000 published `checkGasLimit`.
    uint256 internal constant CHECK_GAS_BUDGET = 8_000_000;

    function setUp() public override {
        super.setUp();
        upkeep = new LuckyDrawUpkeep(address(draw));
        _growToFourPools();
        _mintRounds();
    }

    /// @dev Two more pools, so `poolCount` reaches `POOLS_PER_CHECK` and phase 1 is measured at its maximum.
    function _growToFourPools() internal {
        for (uint256 i = 0; i < 2; ++i) {
            MockERC20 token = new MockERC20("Extra", "EXT", 18);
            MockAggregatorV3 extraFeed = new MockAggregatorV3(FEED_DECIMALS);
            extraFeed.set(1, PRICE_600, block.timestamp);
            vm.startPrank(owner);
            vault.listAsset(address(token), 18);
            vault.setDepositsEnabled(address(token), true);
            draw.addPool(address(token), _pricing(address(extraFeed)));
            vm.stopPrank();
        }
        assertEq(draw.poolCount(), upkeep.POOLS_PER_CHECK(), "four pools");
    }

    /// @dev Closes every current round past its cutoff, day after day, until the global sequence is longer than
    ///      one full historical page. No entries anywhere, so every closed round is `Void` and terminal and the
    ///      measured call finds nothing due -- which is the worst case, because it reads every identifier.
    function _mintRounds() internal {
        uint256 day = uint256(DAY_CUTOFF);
        while (draw.roundCount() < upkeep.ROUNDS_PER_CHECK() + 16) {
            _warp(day);
            for (uint256 poolId = 1; poolId <= draw.poolCount(); ++poolId) {
                for (uint256 k = 0; k < KIND_COUNT; ++k) {
                    uint256 roundId = draw.getCurrent(poolId, Kind(k));
                    if (roundId == 0) continue;
                    if (block.timestamp < draw.getRound(roundId).closesAt) continue;
                    vm.prank(keeper);
                    draw.closeRound(roundId);
                }
            }
            day += 1 days;
        }
    }

    /// @dev Every measurement below is the *first* `checkUpkeep` of its test. A second call in the same
    ///      transaction would read warm storage and understate the figure by a third, and a registry's simulation
    ///      is always a cold one.
    function test_CheckUpkeepAtBothMaximaStaysUnderTheBudget() public {
        vm.roll(0); // page 0 of each phase: the full pool page and the newest full page of identifiers
        assertGe(draw.roundCount(), upkeep.ROUNDS_PER_CHECK(), "a full historical page exists");

        uint256 before = gasleft();
        (bool needed,) = upkeep.checkUpkeep("");
        uint256 used = before - gasleft();

        assertFalse(needed, "nothing is due, so the whole page is actually read");
        console2.log("checkUpkeep gas, both maxima:", used);
        assertLt(used, CHECK_GAS_BUDGET, "checkUpkeep must stay 20% under the 10,000,000 checkGasLimit");
    }

    /// @dev Phase 1 alone: a full pool page, with a historical window that is empty by construction.
    function test_PhaseOneAloneIsMeasured() public view {
        bytes memory poolsOnly = abi.encode(uint256(0), upkeep.POOLS_PER_CHECK(), draw.roundCount(), uint256(1));
        uint256 before = gasleft();
        (bool needed,) = upkeep.checkUpkeep(poolsOnly);
        uint256 used = before - gasleft();

        assertFalse(needed, "nothing is due");
        console2.log("checkUpkeep gas, 4 pools x 7 kinds:", used);
        assertLt(used, CHECK_GAS_BUDGET, "phase 1 alone is well inside the budget");
    }

    /// @dev Phase 2 alone: a pool cursor past the end scans no pool, then a full page of identifiers.
    function test_PhaseTwoAloneIsMeasured() public view {
        bytes memory historyOnly = abi.encode(
            draw.poolCount(), uint256(1), draw.roundCount() - upkeep.ROUNDS_PER_CHECK(), upkeep.ROUNDS_PER_CHECK()
        );
        uint256 before = gasleft();
        (bool needed,) = upkeep.checkUpkeep(historyOnly);
        uint256 used = before - gasleft();

        assertFalse(needed, "nothing is due");
        console2.log("checkUpkeep gas, 96 historical ids:", used);
        console2.log("checkUpkeep gas per historical id:", used / upkeep.ROUNDS_PER_CHECK());
        assertLt(used, CHECK_GAS_BUDGET, "phase 2 alone is inside the budget");
    }
}
