// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {Range, State} from "../../src/Types.sol";
import {InvalidId, WrongState} from "../../src/Errors.sol";
import {LuckyDrawBase, LuckyDrawHarness} from "./LuckyDrawBase.t.sol";

/// @notice Winner selection and settlement releases (SPEC §5.2, §7.2; ACCEPTANCE A04, A23, A24).
contract LuckyDrawSettleTest is LuckyDrawBase {
    function test_Settle_ReleasesPrizeToWinnerAndFeeToTheRoundsFeeAccount() public {
        _tokenRound(); // 1.00 + 2.00 + 7.00 in the 2-decimal pool
        _driveToReady(TOKEN_DAY, 0, 5); // index 5 lies inside alice's [0, 100) range

        uint256 aliceBefore = vault.balanceOf(alice, address(tkn2));
        uint256 feeBefore = vault.balanceOf(feeAcc, address(tkn2));

        vm.prank(keeper);
        draw.settle(TOKEN_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(TOKEN_DAY);
        assertEq(uint8(round.state), uint8(State.Settled));
        assertEq(round.winner, alice);
        assertEq(round.winningIndex, 5);
        assertEq(round.settledAt, uint64(block.timestamp));
        assertEq(vault.balanceOf(alice, address(tkn2)) - aliceBefore, 970, "prize 9.70");
        assertEq(vault.balanceOf(feeAcc, address(tkn2)) - feeBefore, 30, "earned fee 0.30");
        assertEq(vault.getEscrow(TOKEN_DAY).amount, 0, "escrow empty in Settled");
        assertEq(970 + 30, round.grossTotal, "releases sum to gross");

        vm.prank(keeper);
        vm.expectRevert(WrongState.selector);
        draw.settle(TOKEN_DAY);
    }

    function test_Settle_RevertWhen_RoundIsNotReady() public {
        vm.prank(keeper);
        vm.expectRevert(WrongState.selector);
        draw.settle(TOKEN_DAY);

        vm.prank(keeper);
        vm.expectRevert(InvalidId.selector);
        draw.settle(123456);
    }

    function test_Settle_WinnerCanBeTheFeeAccount() public {
        _depositToken(feeAcc, 300);
        _depositToken(bob, 700);
        vm.prank(feeAcc);
        draw.buy(TOKEN_DAY, 300, 0, uint64(block.timestamp + 300));
        vm.prank(bob);
        draw.buy(TOKEN_DAY, 700, 0, uint64(block.timestamp + 300));

        _driveToReady(TOKEN_DAY, 0, 12); // inside [0, 300)
        uint256 before = vault.balanceOf(feeAcc, address(tkn2));
        vm.prank(keeper);
        draw.settle(TOKEN_DAY);

        assertEq(draw.getRound(TOKEN_DAY).winner, feeAcc);
        assertEq(vault.balanceOf(feeAcc, address(tkn2)) - before, 1000, "both credits arrive and equal gross");
        assertEq(vault.getEscrow(TOKEN_DAY).amount, 0);
    }

    function test_Settle_UsesTheFeeAccountFrozenAtRoundCreation() public {
        _tokenRound();
        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        draw.setFeeAccount(newTreasury);

        _driveToReady(TOKEN_DAY, 0, 5);
        vm.prank(keeper);
        draw.settle(TOKEN_DAY);

        assertEq(vault.balanceOf(feeAcc, address(tkn2)), 30, "the round's own recipient is paid");
        assertEq(vault.balanceOf(newTreasury, address(tkn2)), 0, "a later change cannot redirect a live round");
        assertEq(draw.getRound(TOKEN_DAY).feeAccount, feeAcc);
    }

    function test_Settle_IsIndependentOfCallerAndTimestamp() public {
        _tokenRound();
        _driveToReady(TOKEN_DAY, 12345, 67890);

        uint256 snapshot = vm.snapshotState();
        vm.prank(keeper);
        draw.settle(TOKEN_DAY);
        address first = draw.getRound(TOKEN_DAY).winner;
        uint256 firstIndex = draw.getRound(TOKEN_DAY).winningIndex;

        vm.revertToState(snapshot);
        vm.warp(block.timestamp + 30 days);
        vm.prank(dave);
        draw.settle(TOKEN_DAY);
        assertEq(draw.getRound(TOKEN_DAY).winner, first, "same winner");
        assertEq(draw.getRound(TOKEN_DAY).winningIndex, firstIndex, "same index");
    }

    // ---- Range boundaries (A23) ---------------------------------------------

    function test_Settle_IndexAtEveryRangeBoundaryPicksTheOwningRange() public {
        // alice 1.00, bob 2.00, alice 7.00: a repeated buyer with two disjoint ranges.
        _depositToken(alice, 800);
        _depositToken(bob, 200);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
        vm.prank(bob);
        draw.buy(TOKEN_DAY, 200, 0, uint64(block.timestamp + 300));
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 700, 0, uint64(block.timestamp + 300));

        (Range[] memory ranges,) = draw.getRanges(TOKEN_DAY, 0, 100);
        assertEq(ranges.length, 3);
        assertEq(ranges[0].cumulativeGross, 100);
        assertEq(ranges[1].cumulativeGross, 300);
        assertEq(ranges[2].cumulativeGross, 1000);

        // The production binary search, fed with exactly the ranges the Draw stored.
        LuckyDrawHarness probe = _harness();
        for (uint256 i = 0; i < ranges.length; ++i) {
            probe.pushRange(ranges[i].buyer, ranges[i].cumulativeGross);
        }
        assertEq(probe.findRange(0), alice, "first unit of the first range");
        assertEq(probe.findRange(99), alice, "last unit of the first range");
        assertEq(probe.findRange(100), bob, "first unit of the second range");
        assertEq(probe.findRange(299), bob, "last unit of the second range");
        assertEq(probe.findRange(300), alice, "first unit of the third range");
        assertEq(probe.findRange(999), alice, "last unit of the round");

        // And the same boundaries decided by a real settlement.
        _driveToReady(TOKEN_DAY, 0, 299);
        vm.prank(keeper);
        draw.settle(TOKEN_DAY);
        assertEq(draw.getRound(TOKEN_DAY).winner, bob, "index 299 is the last unit bob owns");
    }

    function test_Settle_GrossWeightDecidesTheWinnerForEveryIndex() public {
        _tokenRound();
        _driveToReady(TOKEN_DAY, 0, 350); // index 350 lies inside carol's [300, 1000) range
        vm.prank(keeper);
        draw.settle(TOKEN_DAY);
        assertEq(draw.getRound(TOKEN_DAY).winner, carol);
    }

    // ---- Helpers ------------------------------------------------------------

    function _tokenRound() private {
        _depositToken(alice, 100);
        _depositToken(bob, 200);
        _depositToken(carol, 700);
        vm.prank(alice);
        draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
        vm.prank(bob);
        draw.buy(TOKEN_DAY, 200, 0, uint64(block.timestamp + 300));
        vm.prank(carol);
        draw.buy(TOKEN_DAY, 700, 0, uint64(block.timestamp + 300));
    }
}
