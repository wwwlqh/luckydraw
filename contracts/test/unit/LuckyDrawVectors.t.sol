// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {Kind} from "../../src/Types.sol";
import {LuckyDrawBase, LuckyDrawHarness} from "./LuckyDrawBase.t.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Reads one group of reference vectors per call.
/// @dev The 148 KB document is loaded and discarded inside this contract's own frame, once per group, so the
///      EVM's quadratic memory cost never accumulates in the test contract (the pattern PriceReader.t.sol
///      established). Integers are read field by field because the generator writes large values as JSON
///      strings and small ones as numbers; `parseJsonUint` coerces both.
contract DrawVectors {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant FILE = "./test/vectors/spec_vectors.json";

    /// @param i Sequence index in `feeSequences[]`.
    /// @return found False once the index is past the end.
    /// @return gross Each purchase's gross.
    /// @return feeDelta Expected fee added by that purchase.
    /// @return grossTotal Expected cumulative gross after it.
    /// @return feeReserved Expected cumulative reserved fee after it.
    function feeSequence(uint256 i)
        external
        view
        returns (
            bool found,
            uint256[] memory gross,
            uint256[] memory feeDelta,
            uint256[] memory grossTotal,
            uint256[] memory feeReserved
        )
    {
        string memory json = VM.readFile(FILE);
        string memory base = string.concat(".feeSequences[", VM.toString(i), "]");
        if (!stdJson.keyExists(json, string.concat(base, "[0].gross"))) {
            return (false, gross, feeDelta, grossTotal, feeReserved);
        }
        found = true;

        uint256 n;
        while (stdJson.keyExists(json, string.concat(base, "[", VM.toString(n), "].gross"))) {
            ++n;
        }
        gross = new uint256[](n);
        feeDelta = new uint256[](n);
        grossTotal = new uint256[](n);
        feeReserved = new uint256[](n);
        for (uint256 k = 0; k < n; ++k) {
            string memory element = string.concat(base, "[", VM.toString(k), "]");
            gross[k] = stdJson.readUint(json, string.concat(element, ".gross"));
            feeDelta[k] = stdJson.readUint(json, string.concat(element, ".feeDelta"));
            grossTotal[k] = stdJson.readUint(json, string.concat(element, ".grossTotal"));
            feeReserved[k] = stdJson.readUint(json, string.concat(element, ".feeReserved"));
        }
    }

    /// @param max Upper bound on rows to read.
    /// @return count Rows actually present.
    /// @return word0 High words.
    /// @return word1 Low words.
    /// @return weight Round gross totals.
    /// @return index Expected winning indexes.
    function indexRows(uint256 max)
        external
        view
        returns (
            uint256 count,
            uint256[] memory word0,
            uint256[] memory word1,
            uint256[] memory weight,
            uint256[] memory index
        )
    {
        string memory json = VM.readFile(FILE);
        word0 = new uint256[](max);
        word1 = new uint256[](max);
        weight = new uint256[](max);
        index = new uint256[](max);
        while (count < max) {
            string memory element = string.concat(".indexModular[", VM.toString(count), "]");
            if (!stdJson.keyExists(json, string.concat(element, ".weight"))) break;
            word0[count] = stdJson.readUint(json, string.concat(element, ".word0"));
            word1[count] = stdJson.readUint(json, string.concat(element, ".word1"));
            weight[count] = stdJson.readUint(json, string.concat(element, ".weight"));
            index[count] = stdJson.readUint(json, string.concat(element, ".index"));
            ++count;
        }
    }

    /// @param i Group index in `binarySearch[]`.
    /// @return found False once the index is past the end.
    /// @return buyers Owner identifier of each range.
    /// @return cumulative Each range's cumulative gross.
    /// @return caseIndex Winning indexes to look up.
    /// @return caseBuyer Expected owner identifier for each index.
    function binaryGroup(uint256 i)
        external
        view
        returns (
            bool found,
            uint256[] memory buyers,
            uint256[] memory cumulative,
            uint256[] memory caseIndex,
            uint256[] memory caseBuyer
        )
    {
        string memory json = VM.readFile(FILE);
        string memory base = string.concat(".binarySearch[", VM.toString(i), "]");
        if (!stdJson.keyExists(json, string.concat(base, ".ranges[0].buyer"))) {
            return (false, buyers, cumulative, caseIndex, caseBuyer);
        }
        found = true;

        uint256 n;
        while (stdJson.keyExists(json, string.concat(base, ".ranges[", VM.toString(n), "].buyer"))) {
            ++n;
        }
        uint256 m;
        while (stdJson.keyExists(json, string.concat(base, ".cases[", VM.toString(m), "].index"))) {
            ++m;
        }

        buyers = new uint256[](n);
        cumulative = new uint256[](n);
        for (uint256 k = 0; k < n; ++k) {
            string memory element = string.concat(base, ".ranges[", VM.toString(k), "]");
            buyers[k] = stdJson.readUint(json, string.concat(element, ".buyer"));
            cumulative[k] = stdJson.readUint(json, string.concat(element, ".cumulativeGross"));
        }
        caseIndex = new uint256[](m);
        caseBuyer = new uint256[](m);
        for (uint256 k = 0; k < m; ++k) {
            string memory element = string.concat(base, ".cases[", VM.toString(k), "]");
            caseIndex[k] = stdJson.readUint(json, string.concat(element, ".index"));
            caseBuyer[k] = stdJson.readUint(json, string.concat(element, ".buyer"));
        }
    }
}

/// @notice Solidity reproduces every LuckyDraw reference vector written by `scripts/spec_reference.py`
///         (SPEC §5.2, §7.2, §11.2 "Math"; ACCEPTANCE A03, A11, A12, A23).
contract LuckyDrawVectorsTest is LuckyDrawBase {
    DrawVectors internal vectors;
    LuckyDrawHarness internal harness;

    function setUp() public override {
        super.setUp();
        vectors = new DrawVectors();
        harness = _harness();
    }

    function test_Vectors_FeeSequencesMatchCumulativeRoundFeeArithmetic() public view {
        uint256 checked;
        for (uint256 i = 0; i < 64; ++i) {
            (
                bool found,
                uint256[] memory gross,
                uint256[] memory feeDelta,
                uint256[] memory grossTotal,
                uint256[] memory feeReserved
            ) = vectors.feeSequence(i);
            if (!found) break;

            uint256 runningGross;
            uint256 runningFee;
            for (uint256 k = 0; k < gross.length; ++k) {
                (uint256 delta, uint256 net) = harness.feeSplit(runningGross, runningFee, gross[k]);
                assertEq(delta, feeDelta[k], "feeDelta");
                assertEq(net, gross[k] - feeDelta[k], "netDelta");
                runningGross += gross[k];
                runningFee += delta;
                assertEq(runningGross, grossTotal[k], "grossTotal");
                assertEq(runningFee, feeReserved[k], "feeReserved");
                ++checked;
            }
        }
        assertGt(checked, 100, "vectors were actually read");
    }

    function test_Vectors_IndexModularMatchesTheOnChainReduction() public view {
        (uint256 count, uint256[] memory w0, uint256[] memory w1, uint256[] memory weight, uint256[] memory index) =
            vectors.indexRows(256);
        assertGt(count, 100, "vectors were actually read");
        for (uint256 i = 0; i < count; ++i) {
            assertEq(harness.winningIndexOf(w0[i], w1[i], weight[i]), index[i], "512-bit modulo");
            assertLt(index[i], weight[i], "index stays inside the pot");
        }
    }

    function test_Vectors_BinarySearchPicksTheOwningRange() public {
        uint256 groups;
        uint256 cases;
        for (uint256 i = 0; i < 64; ++i) {
            (
                bool found,
                uint256[] memory buyers,
                uint256[] memory cumulative,
                uint256[] memory caseIndex,
                uint256[] memory caseBuyer
            ) = vectors.binaryGroup(i);
            if (!found) break;
            ++groups;

            harness.clearRanges();
            for (uint256 k = 0; k < buyers.length; ++k) {
                harness.pushRange(_buyerAddress(buyers[k]), cumulative[k]);
            }
            for (uint256 k = 0; k < caseIndex.length; ++k) {
                assertEq(harness.findRange(caseIndex[k]), _buyerAddress(caseBuyer[k]), "first end above the index");
                ++cases;
            }
        }
        assertEq(groups, 20, "every group read");
        assertGt(cases, 100, "every case checked");
    }

    /// @notice The contract path itself reproduces a reference sequence, not only the pure helper.
    function test_Vectors_FirstSequenceReplayedThroughRealPurchases() public {
        (bool found, uint256[] memory gross,, uint256[] memory grossTotal, uint256[] memory feeReserved) =
            vectors.feeSequence(5);
        assertTrue(found);

        (, uint256 roundId, MockERC20 token) = _vectorPool();
        uint256 total;
        for (uint256 k = 0; k < gross.length; ++k) {
            total += gross[k];
        }
        token.mint(alice, total);
        vm.startPrank(alice);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), total);
        for (uint256 k = 0; k < gross.length; ++k) {
            draw.buy(roundId, gross[k], 0, uint64(block.timestamp + 300));
            ILuckyDraw.RoundView memory round = draw.getRound(roundId);
            assertEq(round.grossTotal, grossTotal[k], "grossTotal");
            assertEq(round.feeReserved, feeReserved[k], "feeReserved");
            assertEq(round.prizePot, grossTotal[k] - feeReserved[k], "prizePot");
        }
        vm.stopPrank();
    }

    // ---- Helpers ------------------------------------------------------------

    /// @dev A pool whose USD 1 minimum is exactly one raw unit, so the small reference amounts are admissible:
    ///      a 2-decimal token quoted at USD 100 gives `10^(2+8) / 100e8 == 1`. One buyer only, so no target
    ///      close can interfere.
    function _vectorPool() private returns (uint256 poolId, uint256 roundId, MockERC20 token) {
        token = new MockERC20("Vector", "VEC", 2);
        MockAggregatorV3 vectorFeed = new MockAggregatorV3(FEED_DECIMALS);
        vectorFeed.set(1, 100e8, block.timestamp);

        vm.startPrank(owner);
        vault.listAsset(address(token), 2);
        vault.setDepositsEnabled(address(token), true);
        poolId = draw.addPool(address(token), _pricing(address(vectorFeed)));
        vm.stopPrank();
        roundId = draw.getCurrent(poolId, Kind.Month100k);
    }

    function _buyerAddress(uint256 id) private pure returns (address) {
        return address(uint160(0xB0000 + id));
    }
}
