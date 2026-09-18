// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyDrawUpkeep} from "../../src/LuckyDrawUpkeep.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {Kind, KIND_COUNT, State} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";
import {LuckyDrawBase} from "../unit/LuckyDrawBase.t.sol";

/// @notice Stateful handler that drives the Draw only through the Automation executor.
/// @dev Deliberately small and separate from `LuckyDrawHandler`: this campaign asks one question -- can an
///      unattended `checkUpkeep`/`performUpkeep` loop put a round anywhere the SPEC §6.2 table does not allow, or
///      leave an eligible round behind -- and answering it needs no ghost ledger, no money conservation and no
///      owner actions, all of which `LuckyDrawInvariants.t.sol` already covers against the Draw's own methods.
///
///      Assertions are *recorded*, never asserted here: the invariant profile tolerates reverts, and an assertion
///      that fails inside a handler call is discarded with the call, so a real violation would be invisible. The
///      invariant functions on the test contract read `violations` instead.
contract UpkeepHandler is Test {
    LuckyDraw internal immutable DRAW;
    LuckyDrawUpkeep internal immutable UPKEEP;
    MockVRFCoordinatorV2Plus internal immutable COORDINATOR;
    MockAggregatorV3 internal immutable FEED;
    MockAggregatorV3 internal immutable FEED2;

    address[] internal actors;

    /// @notice Actions the executor actually performed in this run.
    uint256 public performed;
    /// @notice Times `checkUpkeep` reported nothing due and the independent sweep agreed.
    uint256 public idleAgreements;
    /// @notice One line per violation; the invariant functions assert this is empty.
    string[] public violations;

    /// @dev Round identifiers the idle cross-check covers. Smaller than `ROUNDS_PER_CHECK` on purpose: the point is
    ///      to compare two readings of the same window, not to re-measure the contract's page size, and a constant
    ///      window keeps a long campaign's per-call cost flat.
    uint256 internal constant SWEEP_WINDOW = 64;

    constructor(
        LuckyDraw draw_,
        LuckyDrawUpkeep upkeep_,
        MockVRFCoordinatorV2Plus coordinator_,
        MockAggregatorV3 feed_,
        MockAggregatorV3 feed2_,
        address[] memory actors_
    ) {
        DRAW = draw_;
        UPKEEP = upkeep_;
        COORDINATOR = coordinator_;
        FEED = feed_;
        FEED2 = feed2_;
        actors = actors_;
    }

    function violationCount() external view returns (uint256) {
        return violations.length;
    }

    /// @notice One unattended Automation cycle: simulate, then execute whatever was suggested.
    function pump() external {
        _pumpOnce();
    }

    function _pumpOnce() private returns (bool acted) {
        (bool needed, bytes memory performData) = UPKEEP.checkUpkeep("");
        if (!needed) return false;
        (LuckyDrawUpkeep.Action action, uint256 roundId) = abi.decode(performData, (LuckyDrawUpkeep.Action, uint256));
        State before = DRAW.getRound(roundId).state;

        try UPKEEP.performUpkeep(performData) {
            ++performed;
            State next = DRAW.getRound(roundId).state;
            if (!_legalTransition(action, before, next)) {
                violations.push(
                    string.concat(
                        "round ",
                        vm.toString(roundId),
                        ": action ",
                        vm.toString(uint256(action)),
                        " moved ",
                        vm.toString(uint256(before)),
                        " to ",
                        vm.toString(uint256(next))
                    )
                );
            }
        } catch {
            // `checkUpkeep` had just simulated this exact action against this exact state in the same
            // transaction context, so a revert here is the executor contradicting itself.
            violations.push(
                string.concat("round ", vm.toString(roundId), ": performUpkeep reverted on its own suggestion")
            );
        }
        return true;
    }

    /// @notice Compares an idle `checkUpkeep` with an independent sweep of the same rounds.
    /// @dev The reference is the SPEC §6.2 table written out again here, from `getRound` fields only, over the
    ///      same window the default `checkData` covers. It is the contract's answer checked against a second,
    ///      independently written reading of the same table -- the on-chain equivalent of `keeper/src/decide.ts`.
    function sweep() external {
        // Run the executor to exhaustion first: an idle `checkUpkeep` is the only state in which the claim
        // "nothing is due" is worth cross-checking, and a random call sequence rarely lands on one by itself.
        for (uint256 i = 0; i < 8; ++i) {
            if (!_pumpOnce()) break;
        }
        // An explicit window, so the cross-check covers exactly the rounds the contract was asked about and the
        // sweep stays a constant number of `getRound` calls however long the campaign runs.
        uint256 total = DRAW.roundCount();
        uint256 start = total > SWEEP_WINDOW ? total - SWEEP_WINDOW : 0;
        (bool needed,) = UPKEEP.checkUpkeep(abi.encode(uint256(0), uint256(0), start, SWEEP_WINDOW));
        if (needed) return;

        for (uint256 id = start + 1; id <= total; ++id) {
            if (_referenceAction(DRAW.getRound(id)) != LuckyDrawUpkeep.Action.None) {
                violations.push(
                    string.concat("round ", vm.toString(id), ": eligible while checkUpkeep reported nothing due")
                );
                return;
            }
        }
        ++idleAgreements;
    }

    function buy(uint256 actorSeed, uint256 roundSeed, uint256 amountSeed) external {
        uint256 total = DRAW.roundCount();
        if (total == 0) return;
        uint256 roundId = (roundSeed % total) + 1;
        ILuckyDraw.RoundView memory round = DRAW.getRound(roundId);
        if (round.state != State.Open || block.timestamp >= round.closesAt) return;
        if (round.asset != address(0)) return; // the native pool is enough to exercise the lifecycle

        address actor = actors[actorSeed % actors.length];
        uint256 amount = 0.005 ether + (amountSeed % 0.05 ether);
        vm.deal(actor, amount);
        vm.prank(actor);
        try DRAW.VAULT().depositNative{value: amount}() {}
        catch {
            return;
        }
        vm.prank(actor);
        try DRAW.buy(roundId, amount, 0, uint64(block.timestamp + 300)) {} catch {}
    }

    function warp(uint256 stepSeed) external {
        vm.warp(block.timestamp + 600 + (stepSeed % 3 days));
        FEED.set(uint80(block.timestamp), 600e8, block.timestamp);
        FEED2.set(uint80(block.timestamp), 1e8, block.timestamp);
    }

    function fulfill(uint256 roundSeed, uint256 word0, uint256 word1) external {
        uint256 total = DRAW.roundCount();
        if (total == 0) return;
        uint256 roundId = (roundSeed % total) + 1;
        ILuckyDraw.RoundView memory round = DRAW.getRound(roundId);
        if (round.state != State.Drawing || round.requestId == 0) return;
        uint256[] memory words = new uint256[](2);
        words[0] = word0;
        words[1] = word1;
        COORDINATOR.fulfill(round.requestId, words);
    }

    /// @dev The §6.2 rows this executor is allowed to drive, written independently of the contract's own enum
    ///      dispatch. Every other pairing is a violation.
    function _legalTransition(LuckyDrawUpkeep.Action action, State before, State next) private pure returns (bool) {
        if (action == LuckyDrawUpkeep.Action.CloseRound) {
            return
                before == State.Open && (next == State.AwaitingRequest || next == State.Refunding || next == State.Void);
        }
        if (action == LuckyDrawUpkeep.Action.RequestDraw) {
            return before == State.AwaitingRequest && next == State.Drawing;
        }
        if (action == LuckyDrawUpkeep.Action.ExpireUnrequested) {
            return before == State.AwaitingRequest && next == State.Refunding;
        }
        if (action == LuckyDrawUpkeep.Action.Settle) {
            return before == State.Ready && next == State.Settled;
        }
        return false;
    }

    function _referenceAction(ILuckyDraw.RoundView memory round) private view returns (LuckyDrawUpkeep.Action) {
        if (round.state == State.Open) {
            return block.timestamp >= round.closesAt ? LuckyDrawUpkeep.Action.CloseRound : LuckyDrawUpkeep.Action.None;
        }
        if (round.state == State.AwaitingRequest) {
            if (block.timestamp >= round.requestDeadline) return LuckyDrawUpkeep.Action.ExpireUnrequested;
            // The §6.2 VRF pre-checks, read from the coordinator here rather than through `UPKEEP.requestReady()`:
            // the contract under test may not be its own reference, or U2 proves only that it agrees with itself.
            (bool keyRegistered,) = COORDINATOR.s_provingKeys(DRAW.KEY_HASH());
            if (!keyRegistered) return LuckyDrawUpkeep.Action.None;
            (, uint96 nativeBalance,,,) = COORDINATOR.getSubscription(DRAW.SUBSCRIPTION_ID());
            bool funded = uint256(nativeBalance) >= (DRAW.pendingRequests() + 1) * DRAW.MAX_REQUEST_COST_NATIVE();
            return funded ? LuckyDrawUpkeep.Action.RequestDraw : LuckyDrawUpkeep.Action.None;
        }
        if (round.state == State.Ready) return LuckyDrawUpkeep.Action.Settle;
        return LuckyDrawUpkeep.Action.None;
    }
}

/// @notice Stateful invariants for `LuckyDrawUpkeep` (SPEC §11.2 "Stateful", ADR 039).
/// @dev The campaign drives the Draw *only* through the executor, so anything the rounds do is something the
///      executor did. Two properties, both recorded by the handler and asserted here:
///        U1  every action the executor performs is one of the SPEC §6.2 rows, from the state that row starts in
///            to a state that row ends in;
///        U2  when the executor reports nothing due, an independently written reading of the same table over the
///            same rounds agrees -- no eligible round is silently left behind.
contract LuckyDrawUpkeepInvariants is LuckyDrawBase {
    LuckyDrawUpkeep internal upkeep;
    UpkeepHandler internal handler;

    function setUp() public override {
        super.setUp();
        upkeep = new LuckyDrawUpkeep(address(draw));

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = dave;
        handler = new UpkeepHandler(draw, upkeep, coordinator, feed, feed2, actors);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = UpkeepHandler.pump.selector;
        selectors[1] = UpkeepHandler.sweep.selector;
        selectors[2] = UpkeepHandler.buy.selector;
        selectors[3] = UpkeepHandler.warp.selector;
        selectors[4] = UpkeepHandler.fulfill.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice U1/U2: the handler recorded no illegal transition and no missed eligible round.
    function invariant_UpkeepOnlyWalksTheStateTable() public {
        uint256 count = handler.violationCount();
        if (count != 0) {
            emit log_named_string("first violation", handler.violations(0));
        }
        assertEq(count, 0, "LuckyDrawUpkeep violated the SPEC 6.2 state table or missed an eligible round");
    }

    /// @notice The run is only evidence if the executor actually did something.
    function afterInvariant() public view {
        assertGt(handler.performed(), 0, "the campaign never performed an upkeep: the run proves nothing");
        assertGt(handler.idleAgreements(), 0, "the campaign never observed an idle cycle to cross-check");
    }
}
