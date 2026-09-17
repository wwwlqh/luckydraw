// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {REQUEST_WINDOW, State} from "../../src/Types.sol";
import {LuckyDrawBase, LuckyDrawHarness} from "./LuckyDrawBase.t.sol";
import {SampleConsumer} from "../mocks/SampleConsumer.sol";

/// @notice Measured gas against the SPEC §11.2 "Gas/scale" targets, under the pinned compiler settings.
/// @dev Every figure is execution gas inside the call, the same quantity `forge test --gas-report` prints;
///      the 21,000 intrinsic transaction cost and roughly 600-1,000 gas of calldata sit on top of it. Targets
///      are compared against execution gas and the assertions fail on a miss, so a regression fails here. Run
///      with `-vv` to print the table. Since SPEC §5.4 moved seeding out of round creation, closing and
///      target-closing transactions no longer pay for an extra entry, and the seed is measured on its own.
contract LuckyDrawGasTest is LuckyDrawBase {
    function test_Gas_SeedRoundAndBuyIntoASeededRound() public {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 100 ether);
        _depositNative(bob, 100 ether);

        // The keeper's own transaction: the first entry of the round, so every round aggregate, the range
        // pair, `seedAccount`/`seedGross` and the Vault's escrow slots are all cold zero-to-nonzero writes.
        // The operator-paid seed has its own 400,000 execution-gas budget.
        vm.prank(keeper);
        uint256 g0 = gasleft();
        draw.seedRound(NATIVE_DAY);
        uint256 seedGas = g0 - gasleft();
        console2.log("seedRound", seedGas, 400_000);
        assertLt(seedGas, 400_000, "regression: seedRound");

        // First player purchase into an already-seeded round.
        vm.prank(alice);
        g0 = gasleft();
        draw.buy(NATIVE_DAY, 0.01 ether, 0, uint64(block.timestamp + 300));
        _report("buy (first player, round already seeded)", g0 - gasleft(), 250_000);

        vm.prank(alice);
        g0 = gasleft();
        draw.buy(NATIVE_DAY, 0.01 ether, 0, uint64(block.timestamp + 300));
        _report("buy (subsequent, repeat buyer)", g0 - gasleft(), 250_000);

        vm.prank(bob);
        g0 = gasleft();
        draw.buy(NATIVE_DAY, 0.01 ether, 0, uint64(block.timestamp + 300));
        _report("buy (subsequent, new address)", g0 - gasleft(), 250_000);

        // The purchase that reaches the target also closes the round and registers the successor.
        uint256 remaining = TARGET_NATIVE_100 - draw.getRound(NATIVE_DAY).grossTotal;
        vm.prank(bob);
        g0 = gasleft();
        draw.buy(NATIVE_DAY, remaining, 0, uint64(block.timestamp + 300));
        uint256 targetBuy = g0 - gasleft();
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest));
        _report("buy (target close + successor, no seed)", targetBuy, 500_000);
    }

    function test_Gas_BuyThatPerformsTheFallbackSeed() public {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 100 ether);
        assertFalse(draw.getRound(NATIVE_DAY).seeded, "the keeper has not seeded this round yet");

        // Fallback: the first player purchase seeds the round first, so it pays for two entries.
        vm.prank(alice);
        uint256 g0 = gasleft();
        draw.buy(NATIVE_DAY, 0.01 ether, 0, uint64(block.timestamp + 300));
        uint256 used = g0 - gasleft();
        assertTrue(draw.getRound(NATIVE_DAY).seeded);
        _report("buy (with fallback seed)", used, 550_000);
    }

    function test_Gas_FallbackSeedAndTargetCloseInTheSamePurchase() public {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 1 ether);
        assertFalse(draw.getRound(NATIVE_DAY).seeded);
        assertTrue(draw.quoteBuy(NATIVE_DAY, alice, 0.2 ether).reachesTarget);

        vm.prank(alice);
        uint256 g0 = gasleft();
        draw.buy(NATIVE_DAY, 0.2 ether, 0, uint64(block.timestamp + 300));
        uint256 used = g0 - gasleft();
        _report("buy (fallback seed + target close + successor)", used, 800_000);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest));
        assertTrue(draw.getRound(NATIVE_DAY).seeded);
        assertEq(draw.getRound(NATIVE_DAY).grossTotal, 0.22 ether);
        uint256 successor = draw.getCurrent(NATIVE_POOL, draw.getRound(NATIVE_DAY).kind);
        assertTrue(successor != NATIVE_DAY);
        assertEq(uint8(_state(successor)), uint8(State.Open));
        assertFalse(draw.getRound(successor).seeded, "successor is seeded separately by the keeper");
    }

    function test_Gas_CloseRequestSettleAndCallback() public {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(bob, NATIVE_DAY, 0.01 ether);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        uint256 g0 = gasleft();
        draw.closeRound(NATIVE_DAY);
        _report("closeRound (with successor, no seed)", g0 - gasleft(), 350_000);

        // The mock coordinator stores a whole Request struct, which the production coordinator does not; its
        // own cost is measured separately so the Draw-side figure is visible.
        SampleConsumer probe = new SampleConsumer(address(coordinator));
        coordinator.addConsumer(subId, address(probe));
        g0 = gasleft();
        probe.requestRandomWords(KEY_HASH, subId, CONFIRMATIONS, CALLBACK_GAS, 2);
        uint256 coordinatorGas = g0 - gasleft();

        vm.prank(keeper);
        g0 = gasleft();
        draw.requestDraw(NATIVE_DAY);
        uint256 requestGas = g0 - gasleft();
        console2.log("requestDraw (incl. mock coordinator)", requestGas, 250_000);
        console2.log("  of which the mock coordinator     ", coordinatorGas);
        // The mock stores a whole Request struct; the production coordinator stores one commitment hash.
        _report("requestDraw (Draw side only)", requestGas - coordinatorGas, 250_000);

        uint256 requestId = draw.getRound(NATIVE_DAY).requestId;
        uint256[] memory words = new uint256[](2);
        words[0] = type(uint256).max;
        words[1] = type(uint256).max - 1;
        assertTrue(coordinator.fulfill(requestId, words), "callback succeeded");
        uint256 callbackGas = coordinator.lastCallbackGasUsed();
        _report("callback (two nonzero words, cold)", callbackGas, 150_000);
        assertLt(callbackGas, 150_000, "callback must stay well inside the 300,000 coordinator budget");

        vm.prank(keeper);
        g0 = gasleft();
        draw.settle(NATIVE_DAY);
        _report("settle (3 ranges)", g0 - gasleft(), 250_000);
    }

    function test_Gas_CallbackWithZeroWords() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(bob, NATIVE_DAY, 0.01 ether);
        _closeAtCutoff(NATIVE_DAY);
        uint256 requestId = _request(NATIVE_DAY);

        uint256[] memory words = new uint256[](2);
        assertTrue(coordinator.fulfill(requestId, words));
        _report("callback (two zero words)", coordinator.lastCallbackGasUsed(), 150_000);
    }

    function test_Gas_ClaimRefund() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        _buy(alice, NATIVE_DAY, 0.01 ether);
        _buy(bob, NATIVE_DAY, 0.01 ether);
        _closeAtCutoff(NATIVE_DAY);
        vm.warp(block.timestamp + REQUEST_WINDOW);
        vm.prank(keeper);
        draw.expireUnrequested(NATIVE_DAY);

        vm.prank(keeper);
        uint256 g0 = gasleft();
        draw.claimRefund(NATIVE_DAY, alice);
        _report("claimRefund", g0 - gasleft(), 160_000);
    }

    function test_Gas_SettleAtOneThousandRanges() public {
        _depositNative(alice, 2_000 ether);
        _depositNative(bob, 2_000 ether);
        for (uint256 i = 0; i < 999; ++i) {
            _buy(alice, NATIVE_MONTH, MIN_NATIVE);
        }
        _buy(bob, NATIVE_MONTH, MIN_NATIVE);
        assertEq(draw.getRound(NATIVE_MONTH).rangeCount, 1000);

        _warp(MONTH_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_MONTH);
        uint256 requestId = _request(NATIVE_MONTH);
        assertTrue(_fulfill(requestId, type(uint256).max, 12_345_678));

        vm.prank(keeper);
        uint256 g0 = gasleft();
        draw.settle(NATIVE_MONTH);
        _report("settle (1,000 ranges)", g0 - gasleft(), 250_000);
    }

    /// @notice Search depth at scale, measured on the production binary search through the harness.
    /// @dev A test transaction is capped at about 1.07 billion gas in the default profile and appending one
    ///      range costs roughly 42,000, so 100,000 real ranges cannot be built here. This test measures the
    ///      per-iteration slope only; the 100,000-range settlement itself is measured end to end in
    ///      `LuckyDrawScale.t.sol` under the `scale` profile (240,342 execution gas at 17 iterations,
    ///      2026-09-11). The slope here agrees with that measurement to within 1.5%, so this test is a cheap
    ///      regression guard on the slope rather than the source of the 100,000-range figure.
    function test_Gas_SearchDepthAtScale() public {
        LuckyDrawHarness harness = _harness();
        uint256 previous;
        uint256 first;
        uint256 last;
        uint256[3] memory sizes = [uint256(1_000), 10_000, 20_000];
        for (uint256 i = 0; i < sizes.length; ++i) {
            harness.pushRanges(alice, sizes[i] - previous, 1);
            previous = sizes[i];
            assertEq(harness.rangeCount(), sizes[i]);

            uint256 g0 = gasleft();
            harness.findRange(sizes[i] - 1); // deepest index
            uint256 used = g0 - gasleft();
            console2.log("binary search: ranges, gas", sizes[i], used);
            if (i == 0) first = used;
            last = used;
        }

        // 1,000 ranges is 10 iterations, 20,000 is 15: the slope is the per-iteration cost.
        uint256 perIteration = (last - first) / 5;
        console2.log("  gas per search iteration          ", perIteration);
        console2.log("  extrapolated search at 100,000    ", last + 2 * perIteration);
        assertLt(last + 2 * perIteration, 60_000, "search stays bounded at 100,000 ranges");
    }

    /// @dev Prints `label`, the execution-gas measurement and the SPEC target, and fails when it is missed.
    function _report(string memory label, uint256 used, uint256 target) private pure {
        console2.log(label, used, target);
        assertLe(used, target, label);
    }
}
