// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {CloseReason, NATIVE_ASSET, State} from "../../src/Types.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";

/// @notice A plain buyer contract, so that building a large round costs one test-side call instead of one
///         `vm.prank` per entry. Labeled test helper: it holds an ordinary Vault balance, has no privilege
///         and no authorization, and every entry it makes goes through the production `LuckyDraw.buy`.
contract BulkBuyer {
    LuckyDraw private immutable DRAW;
    LuckyVault private immutable VAULT;

    constructor(LuckyDraw draw_, LuckyVault vault_) {
        DRAW = draw_;
        VAULT = vault_;
    }

    /// @notice Deposits the forwarded BNB into this contract's own Vault available balance.
    function fund() external payable {
        VAULT.depositNative{value: msg.value}();
    }

    /// @notice One production purchase.
    /// @param roundId The round to enter.
    /// @param gross Gross raw units.
    function buy(uint256 roundId, uint256 gross) external {
        DRAW.buy(roundId, gross, 0, type(uint64).max);
    }

    /// @notice `count` production purchases of `gross` each: one accepted entry and one range apiece.
    /// @param roundId The round to enter.
    /// @param count How many purchases to make.
    /// @param gross Gross raw units per purchase.
    function buyMany(uint256 roundId, uint256 count, uint256 gross) external {
        for (uint256 i = 0; i < count; ++i) {
            DRAW.buy(roundId, gross, 0, type(uint64).max);
        }
    }
}

/// @notice Settlement at scale: 100,000 real ranges in contract storage, the production `settle` executed
///         over them, and the index and arithmetic bounds behind the SPEC §11.2 "Gas/scale" row and the
///         ACCEPTANCE item "Settlement: 100,000 purchase ranges plus arithmetic/index bounds analysis".
/// @dev Nothing in the measured path is synthetic. Every range is appended by `LuckyDraw.buy`, the escrow is
///      real Vault escrow moved by `LuckyVault.lock`, the round is closed by the production target branch,
///      the words arrive through the authenticated coordinator callback and `settle` is the production
///      function. No storage is written with `vm.store` and no aggregate is mirrored by hand, so the
///      measured figure is the execution gas a BSC transaction would pay (the 21,000 intrinsic cost and
///      calldata sit on top, exactly as in `LuckyDrawGas.t.sol`).
///
///      Round shape: one "whale" contract makes `n-1` purchases of the USD 1 minimum. `playerCount` stays 1
///      throughout, so the target check of §5.3 never fires (A52: a lone player at or above the target does
///      not close the round). A second address then makes the final purchase, which lifts `playerCount` to 2
///      and closes the round as TargetReached in that same transaction. Every range is therefore the same
///      width, which makes the winning index, the range that owns it and the search depth exactly
///      computable outside the contract, so the production binary search is checked against an independent
///      answer rather than against itself.
///
///      The two large cases are skipped unless `LUCKYDRAW_SCALE=true` is exported, because building 100,000
///      real entries costs roughly 6.8e9 gas, far above Foundry's default 1,073,741,824 test gas limit.
///      Run them from `contracts/` with the `scale` profile, which raises only the gas limit (CI runs this):
///        export PATH="$HOME/.foundry/bin:$PATH"
///        LUCKYDRAW_SCALE=true FOUNDRY_PROFILE=scale forge test --match-path "test/unit/LuckyDrawScale.t.sol" -vv
contract LuckyDrawScaleTest is LuckyDrawBase {
    /// @dev SPEC §11.2: `settle` at 100,000 ranges must stay at or below 250,000 execution gas.
    uint256 private constant SETTLE_TARGET = 250_000;

    /// @dev SPEC §11.2: the budget one standalone purchase transaction may use. The per-entry figure this
    ///      file measures is the warm cost of an append inside one long transaction and is deliberately not
    ///      used as the per-transaction bound.
    uint256 private constant BUY_TARGET = 250_000;

    /// @dev Measured 2026-09-11 under the pinned compiler: each extra binary-search iteration costs this
    ///      much, from 222,667 gas at 10 iterations, 232,767 at 14 and 240,342 at 17. Used only to report
    ///      how many further iterations fit inside the SPEC target.
    uint256 private constant SEARCH_GAS_PER_ITERATION = 2_525;

    /// @dev BSC block gas limit used for the per-block entry bound below. Operator input confirmed at
    ///      deployment (SPEC §15 "Chain"); BSC has raised this repeatedly, so it is quoted, not assumed.
    uint256 private constant BSC_BLOCK_GAS_LIMIT = 140_000_000;

    address private _whale;
    address private _closer;

    // -----------------------------------------------------------------------
    // Default run
    // -----------------------------------------------------------------------

    /// @notice 1,000 real ranges: the comparison baseline for the two scale runs.
    function test_Scale_SettleAtOneThousandRanges() public {
        _measure(NATIVE_DAY, 1_000);
    }

    /// @notice Index and arithmetic bounds of the production winner lookup, proved without gas.
    /// @dev Replays the exact `lo`/`hi` recurrence of `LuckyDraw._findRange` against cumulative values
    ///      computed arithmetically instead of read from storage, so the iteration count is exact rather
    ///      than inferred from a gas slope. The scanned sizes confirm that the worst case over every index
    ///      is `ceil(log2 n)`, which is then applied to the two sizes that are too large to scan here.
    function test_Scale_SearchDepthBounds() public pure {
        uint256[11] memory sizes = [uint256(1), 2, 3, 5, 8, 9, 100, 1_000, 1_024, 1_025, 2_048];
        for (uint256 i = 0; i < sizes.length; ++i) {
            assertEq(_worstDepth(sizes[i]), _ceilLog2(sizes[i]), "worst-case depth is ceil(log2 n)");
        }

        // Applied to the acceptance sizes. 2^16 = 65,536 < 100,000 <= 131,072 = 2^17.
        assertEq(_ceilLog2(1_000), 10);
        assertEq(_ceilLog2(10_000), 14);
        assertEq(_ceilLog2(100_000), 17, "the 100,000-range search-depth bound");
        assertEq(_ceilLog2(131_072), 17, "2^17 ranges still cost 17 iterations");
        assertEq(_ceilLog2(131_073), 18);
        // Seven more iterations than the 1,000-range case, not a hundred times the work.
        assertEq(_ceilLog2(100_000) - _ceilLog2(1_000), 7);

        // Arithmetic bounds. The index is reduced modulo grossTotal, so it is strictly below the last
        // range's cumulative value and the search always terminates inside the array; the midpoint
        // `lo + (hi - lo) / 2` cannot overflow for any `lo <= hi`, including the uint256 extremes.
        assertEq(_depth(2, type(uint256).max - 1, type(uint256).max / 2), 1, "extreme cumulative values");
        assertLt(type(uint256).max / 2 + (type(uint256).max - type(uint256).max / 2) / 2, type(uint256).max);

        console2.log("search depth at 1,000 / 10,000 / 100,000 ranges");
        console2.log(_ceilLog2(1_000), _ceilLog2(10_000), _ceilLog2(100_000));
    }

    // -----------------------------------------------------------------------
    // Scale runs (LUCKYDRAW_SCALE=true)
    // -----------------------------------------------------------------------

    /// @notice 10,000 real ranges.
    function test_Scale_SettleAtTenThousandRanges() public {
        vm.skip(!vm.envOr("LUCKYDRAW_SCALE", false));
        _measure(NATIVE_WEEK, 10_000);
    }

    /// @notice 100,000 real ranges: the ACCEPTANCE settlement evidence, measured rather than extrapolated.
    function test_Scale_SettleAtOneHundredThousandRanges() public {
        vm.skip(!vm.envOr("LUCKYDRAW_SCALE", false));
        _measure(NATIVE_MONTH, 100_000);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Builds a round of exactly `ranges` real entries, drives it to Ready on the deepest possible
    ///      winning index, settles it with the production function and reports the measured gas.
    function _measure(uint256 roundId, uint256 ranges) private {
        uint256 buildGas = _build(roundId, ranges);

        // One weight unit per raw unit, so range i covers [i*step, (i+1)*step): the deepest index and the
        // range that owns it are both computed here, outside the contract.
        uint256 worstIndex = _worstIndex(ranges) * MIN_NATIVE;
        address expectedWinner = worstIndex / MIN_NATIVE + 1 == ranges ? _closer : _whale;

        uint256 requestId = _request(roundId);
        // word0 = 0 makes the winning index exactly word1: `_winningIndexOf(0, w, W) == w` for every w < W,
        // so the target index needs no modulo reasoning here. The 512-bit reduction itself is checked
        // against the big-integer reference in `LuckyDrawVectors.t.sol`.
        assertTrue(_fulfill(requestId, 0, worstIndex), "callback failed");
        assertEq(uint8(_state(roundId)), uint8(State.Ready));

        uint256 g0 = gasleft();
        draw.settle(roundId);
        uint256 settleGas = g0 - gasleft();

        assertEq(draw.getRound(roundId).winningIndex, worstIndex, "winning index");
        assertEq(draw.getRound(roundId).winner, expectedWinner, "the production search found the owning range");
        assertEq(uint8(_state(roundId)), uint8(State.Settled));
        assertEq(vault.getEscrow(roundId).amount, 0, "D1: zero escrow in Settled");
        assertEq(
            vault.balanceOf(expectedWinner, NATIVE_ASSET),
            draw.getRound(roundId).prizePot,
            "the prize is credited to the range owner the search returned"
        );
        assertEq(vault.balanceOf(feeAcc, NATIVE_ASSET), draw.getRound(roundId).feeReserved, "D3: fee released");
        _assertConservation(NATIVE_ASSET, _ids(roundId));

        // Index bound. Settlement cost is base plus depth, so the remaining SPEC headroom is expressed in
        // further search iterations, and each iteration doubles the number of ranges a round may hold.
        uint256 spareIterations = (SETTLE_TARGET - settleGas) / SEARCH_GAS_PER_ITERATION;
        uint256 perBlock = BSC_BLOCK_GAS_LIMIT / BUY_TARGET;

        console2.log("-- settlement at scale -----------------------------------");
        console2.log("  ranges (real, in contract storage)", draw.getRound(roundId).rangeCount);
        console2.log("  search iterations (worst index)   ", _ceilLog2(ranges));
        console2.log("  settle execution gas / SPEC target", settleGas, SETTLE_TARGET);
        console2.log("  spare iterations inside the target", spareIterations);
        console2.log("  ranges still settling under target", uint256(1) << (_ceilLog2(ranges) + spareIterations));
        console2.log("  gas to append all entries         ", buildGas);
        console2.log("  warm gas per append (one tx)      ", buildGas / ranges);
        console2.log("  entries per BSC block at 250k each", perBlock);
        console2.log("  blocks of nothing but these buys  ", (ranges + perBlock - 1) / perBlock);
        assertLe(settleGas, SETTLE_TARGET, "SPEC 11.2: settle at 100,000 ranges");
    }

    /// @dev Appends `ranges` real entries through `LuckyDraw.buy` and closes the round through the
    ///      production target branch. Returns the execution gas the entries cost, which is the quantity that
    ///      actually bounds how large a round can become on chain.
    function _build(uint256 roundId, uint256 ranges) private returns (uint256 buildGas) {
        BulkBuyer whale = new BulkBuyer(draw, vault);
        BulkBuyer closer = new BulkBuyer(draw, vault);
        _whale = address(whale);
        _closer = address(closer);
        vm.label(_whale, "whale");
        vm.label(_closer, "closer");

        uint256 bulk = ranges - 1;
        vm.deal(address(this), (ranges + 2) * MIN_NATIVE);
        whale.fund{value: bulk * MIN_NATIVE}();
        closer.fund{value: MIN_NATIVE}();

        uint256 g0 = gasleft();
        whale.buyMany(roundId, bulk, MIN_NATIVE);
        buildGas = g0 - gasleft();

        // A lone player at or above the target does not close the round (A52), which is what lets a single
        // address build the whole pot before the closing purchase arrives.
        assertEq(uint8(_state(roundId)), uint8(State.Open), "a lone buyer never closes the round");
        assertEq(draw.getRound(roundId).playerCount, 1);
        assertEq(draw.getRound(roundId).rangeCount, bulk);

        g0 = gasleft();
        closer.buy(roundId, MIN_NATIVE);
        buildGas += g0 - gasleft();

        assertEq(draw.getRound(roundId).rangeCount, ranges, "every purchase appended exactly one range");
        assertEq(draw.getRound(roundId).playerCount, 2);
        assertEq(draw.getRound(roundId).grossTotal, ranges * MIN_NATIVE, "D2: ranges end at grossTotal");
        assertEq(vault.getEscrow(roundId).amount, ranges * MIN_NATIVE, "D1: escrow equals gross when closed");
        assertEq(uint8(_state(roundId)), uint8(State.AwaitingRequest));
        assertEq(uint8(draw.getRound(roundId).closeReason), uint8(CloseReason.TargetReached));
    }

    /// @dev Iterations `LuckyDraw._findRange` performs for `index` over `length` equal-width ranges. Mirrors
    ///      the production recurrence exactly: `cumulativeGross` of range `mid` is `(mid + 1) * step`.
    function _depth(uint256 length, uint256 index, uint256 step) private pure returns (uint256 iterations) {
        uint256 lo = 0;
        uint256 hi = length - 1;
        while (lo < hi) {
            ++iterations;
            uint256 mid = lo + (hi - lo) / 2;
            if ((mid + 1) * step > index) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
    }

    /// @dev Deepest iteration count over every range of a round with `length` equal-width ranges.
    function _worstDepth(uint256 length) private pure returns (uint256 worst) {
        for (uint256 i = 0; i < length; ++i) {
            uint256 depth = _depth(length, i, 1);
            if (depth > worst) worst = depth;
        }
    }

    /// @dev The first range index that attains the deepest search.
    function _worstIndex(uint256 length) private pure returns (uint256 best) {
        uint256 worst;
        for (uint256 i = 0; i < length; ++i) {
            uint256 depth = _depth(length, i, 1);
            if (depth > worst) {
                worst = depth;
                best = i;
            }
        }
    }

    /// @dev `ceil(log2 n)` for n >= 1, the closed form of `_worstDepth`.
    function _ceilLog2(uint256 n) private pure returns (uint256 bits) {
        uint256 value = 1;
        while (value < n) {
            value <<= 1;
            ++bits;
        }
    }
}
