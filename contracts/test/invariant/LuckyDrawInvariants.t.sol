// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LuckyDrawHandler} from "./LuckyDrawHandler.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {KIND_COUNT, Kind, NATIVE_ASSET, PricingConfig, ReferenceKind} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @notice The deployment both invariant-suite entry points share: the campaign below and the handler-honesty
///         unit tests in `HandlerHonesty.t.sol`, which must build the same handler to prove that a failure
///         inside a handler action really does reach an invariant function.
/// @dev Abstract, so `forge test` never collects it as a test contract; `_deployFixture()` stops just short of
///      the fuzz targeting, which only the campaign wants.
abstract contract LuckyDrawInvariantFixture is Test {
    LuckyVault internal vault;
    LuckyDraw internal draw;
    MockVRFCoordinatorV2Plus internal coordinator;
    MockAggregatorV3 internal nativeFeed;
    MockAggregatorV3 internal tokenFeed;
    MockERC20 internal tkn;
    LuckyDrawHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal feeAcc = makeAddr("feeAccount");
    address internal seedSafe = makeAddr("seedSafe");
    address internal seedSafe2 = makeAddr("seedSafe2");
    address internal keeper = makeAddr("keeper");

    /// @dev 2026-09-11 12:00:00 UTC, a Friday: the first cutoff of every kind is a partial period.
    uint256 internal constant START = 1_789_128_000;
    bytes32 internal constant KEY_HASH = keccak256("luckydraw.invariant.gaslane");
    uint16 internal constant CONFIRMATIONS = 200;
    uint32 internal constant CALLBACK_GAS = 300_000;
    uint256 internal constant MAX_REQUEST_COST = 0.01 ether;
    uint8 internal constant FEED_DECIMALS = 8;
    uint32 internal constant MAX_AGE = 3600;

    /// @dev Deploys the Vault, Draw, mocks and pools, wires the seed authorisations and bootstraps the handler.
    function _deployFixture() internal {
        vm.warp(START);

        vault = new LuckyVault(owner);
        coordinator = new MockVRFCoordinatorV2Plus();
        uint256 subId = coordinator.createSubscription();
        draw = new LuckyDraw(
            address(vault),
            address(coordinator),
            subId,
            KEY_HASH,
            CONFIRMATIONS,
            CALLBACK_GAS,
            MAX_REQUEST_COST,
            feeAcc,
            owner
        );
        coordinator.addConsumer(subId, address(draw));
        coordinator.registerKey(KEY_HASH, 100 gwei);
        coordinator.fundNative(subId, 10 ether);

        nativeFeed = new MockAggregatorV3(FEED_DECIMALS);
        nativeFeed.set(1, 600e8, START);
        tokenFeed = new MockAggregatorV3(FEED_DECIMALS);
        tokenFeed.set(1, 1e8, START);
        tkn = new MockERC20("Two", "TWO", 2);

        vm.startPrank(owner);
        vault.setDraw(address(draw));
        vault.listAsset(NATIVE_ASSET, 18);
        vault.setDepositsEnabled(NATIVE_ASSET, true);
        vault.listAsset(address(tkn), 2);
        vault.setDepositsEnabled(address(tkn), true);
        draw.addPool(NATIVE_ASSET, _pricing(address(nativeFeed)));
        draw.addPool(address(tkn), _pricing(address(tokenFeed)));
        draw.setSeedAccount(seedSafe);
        draw.setSeedAmount(1, 0.01 ether);
        draw.setSeedAmount(2, 500);
        vm.stopPrank();

        // Consent lives with the seed Safes themselves (SPEC §5.4): both authorise, so the owner pointer can
        // move between them without the campaign losing its seed.
        vm.startPrank(seedSafe);
        vault.authorizeSeed(NATIVE_ASSET, 1 ether);
        vault.authorizeSeed(address(tkn), 1 ether);
        vm.stopPrank();
        vm.startPrank(seedSafe2);
        vault.authorizeSeed(NATIVE_ASSET, 1 ether);
        vault.authorizeSeed(address(tkn), 1 ether);
        vm.stopPrank();

        handler = new LuckyDrawHandler(
            LuckyDrawHandler.Wiring({
                draw: draw,
                vault: vault,
                token: tkn,
                coordinator: coordinator,
                nativeFeed: nativeFeed,
                tokenFeed: tokenFeed,
                owner: owner,
                keeper: keeper,
                feeAccount: feeAcc,
                players: [alice, bob, carol, dave],
                seedSafes: [seedSafe, seedSafe2]
            })
        );
        handler.bootstrap();
    }

    function _pricing(address feed_) internal pure returns (PricingConfig memory) {
        return PricingConfig({
            feed: feed_,
            feedDecimals: FEED_DECIMALS,
            maxPriceAge: MAX_AGE,
            referenceKind: ReferenceKind.ExactToken,
            minAnswer: 0,
            maxAnswer: 0
        });
    }
}

/// @notice The stateful invariant campaign required by SPEC §11.2 ("Stateful") and ACCEPTANCE's scale
///         evidence: generated actions across both assets, all three sequence kinds, several players plus the
///         operator seed Safe, keeper and owner, with V1–V5, D1–D6 and D8–D10 asserted after every call.
/// @dev Structure:
///      - `LuckyDrawHandler` owns every generated action and an independent ghost ledger (`GhostLedger`). It
///        verifies the touched round and the global ledger after each applied action and *records* any
///        violation instead of reverting, because `fail_on_revert = false` would otherwise discard both the
///        failing call and the evidence.
///      - The invariant functions below assert those records, each naming the property it owns, and add the
///        instant-wide checks that are cheap enough to run after every generated call.
///      - `afterInvariant()` sweeps every round of the run through the full per-round checker and prints the
///        per-action-type counters for the campaign record.
contract LuckyDrawInvariantsTest is LuckyDrawInvariantFixture {
    function setUp() public {
        _deployFixture();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](22);
        selectors[0] = LuckyDrawHandler.actDeposit.selector;
        selectors[1] = LuckyDrawHandler.actWithdraw.selector;
        selectors[2] = LuckyDrawHandler.actBuy.selector;
        selectors[3] = LuckyDrawHandler.actBuyLarge.selector;
        selectors[4] = LuckyDrawHandler.actBuyToTarget.selector;
        selectors[5] = LuckyDrawHandler.actBuyInvalid.selector;
        selectors[6] = LuckyDrawHandler.actSeedRound.selector;
        selectors[7] = LuckyDrawHandler.actWarp.selector;
        selectors[8] = LuckyDrawHandler.actCloseRound.selector;
        selectors[9] = LuckyDrawHandler.actEnsureCurrent.selector;
        selectors[10] = LuckyDrawHandler.actRequestDraw.selector;
        selectors[11] = LuckyDrawHandler.actFulfill.selector;
        selectors[12] = LuckyDrawHandler.actFulfillEdge.selector;
        selectors[13] = LuckyDrawHandler.actExpireUnrequested.selector;
        selectors[14] = LuckyDrawHandler.actSettle.selector;
        selectors[15] = LuckyDrawHandler.actClaimRefund.selector;
        selectors[16] = LuckyDrawHandler.actTogglePause.selector;
        selectors[17] = LuckyDrawHandler.actOwnerConfig.selector;
        selectors[18] = LuckyDrawHandler.actPriceUpdate.selector;
        selectors[19] = LuckyDrawHandler.actCoordinatorFault.selector;
        selectors[20] = LuckyDrawHandler.actDonate.selector;
        selectors[21] = LuckyDrawHandler.actWithdrawUnderDuress.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---------------------------------------------------------------------
    // Vault conservation (SPEC §4.3)
    // ---------------------------------------------------------------------

    /// @notice V1: for every asset the Vault's actual custody covers the ledger exactly, as
    ///         `B == A + E + surplus`, where the surplus is the donated and forced-in balance the ghost tracks
    ///         separately. Never gated: checked after every generated call.
    function invariant_V1_CustodyCoversLedgerPlusSurplus() public view {
        _noViolation(handler.P_V1());
        address[2] memory assets = [NATIVE_ASSET, address(tkn)];
        for (uint256 i = 0; i < 2; ++i) {
            uint256 b = handler.custodyOf(assets[i]);
            uint256 a = vault.totalAvailable(assets[i]);
            uint256 e = vault.totalEscrow(assets[i]);
            assertEq(b, a + e + handler.surplusOf(assets[i]), "V1: B != A + E + surplus");
            assertGe(b, a + e, "V1: B < A + E");
        }
    }

    /// @notice V2: `totalAvailable` equals the sum of the individual balances and `totalEscrow` equals the sum
    ///         of the registered round escrows; every individual balance matches the independent ledger, so a
    ///         release cannot have spent another round's escrow.
    function invariant_V2_TotalsEqualTheirSums() public view {
        _noViolation(handler.P_V2());
        (uint8 property, string memory detail) = handler.checkBalances();
        assertEq(property, 0, detail);
    }

    /// @notice V3: an available withdrawal is never gated by a pause, a price or round state. The handler
    ///         probes this directly: under every pause, disabled pools and unreadable feeds a holder must be
    ///         able to withdraw its whole balance; the probe runs against a state snapshot and is rolled back.
    function invariant_V3_WithdrawalIsNeverGated() public view {
        _noViolation(handler.P_V3());
    }

    /// @notice V4: the only external asset movements are deposits in and withdrawals to their own caller, so
    ///         `custody + withdrawn == deposited + donated` for every asset at every instant.
    function invariant_V4_OnlyWithdrawalMovesAssetsOut() public view {
        _noViolation(handler.P_V4());
        address[2] memory assets = [NATIVE_ASSET, address(tkn)];
        for (uint256 i = 0; i < 2; ++i) {
            assertEq(
                handler.custodyOf(assets[i]) + handler.withdrawnOf(assets[i]),
                handler.depositedOf(assets[i]) + handler.surplusOf(assets[i]),
                "V4: custody moved outside deposit/withdraw/donation"
            );
        }
    }

    /// @notice V5: the Vault's own per-round limits hold whatever Draw does: `lockedBy` equals the gross that
    ///         account entered, no refund exceeds it, the escrow closes exactly once and no later lock lands,
    ///         a seed debit exists only through `lockSeed` within the authorised cap and once per round, and
    ///         an account holding a seed authorisation is never debited through the player path.
    function invariant_V5_VaultPerRoundLimits() public view {
        _noViolation(handler.P_V5());
    }

    // ---------------------------------------------------------------------
    // Draw properties (SPEC §11.1)
    // ---------------------------------------------------------------------

    /// @notice D1: a round's escrow equals grossTotal while it is live, grossTotal-refundedGross while
    ///         refunding and zero once Settled or Void; the per-round escrows sum to the Vault total per asset.
    function invariant_D1_EscrowMatchesRoundState() public view {
        _noViolation(handler.P_D1());
        address[2] memory assets = [NATIVE_ASSET, address(tkn)];
        for (uint256 i = 0; i < 2; ++i) {
            assertEq(vault.totalEscrow(assets[i]), handler.escrowTotalOf(assets[i]), "D1: totalEscrow != sum");
        }
    }

    /// @notice D2: range ends increase strictly to grossTotal, grossByUser sums to grossTotal, playerCount is
    ///         the number of distinct nonzero buyers and the stored ranges reproduce every buyer weight.
    function invariant_D2_RangesReproduceWeights() public view {
        _noViolation(handler.P_D2());
    }

    /// @notice D3: feeReserved is floor(grossTotal x 3%) and prizePot the remainder at every instant; a
    ///         settlement releases exactly grossTotal as prize plus fee; a cancelled round earns no fee and
    ///         its eventual gross refunds add up to grossTotal.
    function invariant_D3_FeeAndPrizeArithmetic() public view {
        _noViolation(handler.P_D3());
    }

    /// @notice D4: at most one Open round exists per pool and kind, `current` is nonzero exactly when one
    ///         exists, closing or `ensureCurrent` never duplicates a successor, and an unrelated callback
    ///         never moves the pointer.
    function invariant_D4_OneOpenRoundPerPoolAndKind() public view {
        _noViolation(handler.P_D4());
        assertEq(draw.roundCount(), handler.ghostRoundCount(), "D4: roundCount != rounds the ghost saw open");
        for (uint256 p = 1; p <= 2; ++p) {
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                uint256 current = draw.getCurrent(p, Kind(k));
                uint256 open = handler.ghostOpenCount(p, Kind(k));
                assertLe(open, 1, "D4: more than one Open round for a pool/kind");
                assertEq(current, handler.ghostCurrent(p, Kind(k)), "D4: current diverged from the ghost pointer");
                assertEq(current == 0, open == 0, "D4: current is not nonzero exactly when an Open round exists");
                if (current != 0) {
                    assertEq(uint256(draw.getRound(current).poolId), p, "D4: current belongs to another pool");
                    assertEq(uint256(draw.getRound(current).kind), k, "D4: current belongs to another kind");
                    assertEq(uint256(draw.getRound(current).state), 0, "D4: current names a round that is not Open");
                }
            }
        }
    }

    /// @notice D5: frozen terms never change, entries stop at the close (target or cutoff) and never continue
    ///         past it, an accepted request id and its words are never overwritten, and a settled outcome is
    ///         immutable and determined only by the frozen ranges and words.
    function invariant_D5_FrozenTermsAndOutcomesAreImmutable() public view {
        _noViolation(handler.P_D5());
    }

    /// @notice D6: no owner action debits, releases or sets a price answer, winner or randomness; only the
    ///         bound Draw moves internal money and only the immutable coordinator supplies accepted words.
    function invariant_D6_AdminNeverMovesMoney() public view {
        _noViolation(handler.P_D6());
        assertEq(vault.draw(), address(draw), "D6: the Vault's Draw binding changed");
        assertEq(address(draw.VAULT()), address(vault), "D6: the Draw's Vault immutable changed");
        assertEq(vault.owner(), owner, "D6: Vault ownership moved");
        assertEq(draw.owner(), owner, "D6: Draw ownership moved");
    }

    /// @notice D8: sequences increase by one per pool and kind, `byRequest` is injective and maps back to its
    ///         round, refundedGross equals the sum of grossByUser over refunded buyers, every closesAt is the
    ///         calendar cutoff of its opensAt, and a closed round has closedAt set exactly once with
    ///         requestDeadline == closedAt + 86400.
    function invariant_D8_SequenceAndBookkeeping() public view {
        _noViolation(handler.P_D8());
        (uint8 property, string memory detail) = handler.checkRequests();
        assertEq(property, 0, detail);
    }

    /// @notice D9: the operator seed is debited only through `lockSeed`, only from an account that authorised
    ///         its own per-round cap, within that cap and the configured seedAmount, at most once per round
    ///         and only while Open before the cutoff; round.seedAccount and seedGross record that debit, a
    ///         Void round returns exactly seedGross to that account even after the pointer moved, a seed-only
    ///         round never requests randomness and claimRefund credits only the named buyer, once.
    function invariant_D9_OperatorSeedRules() public view {
        _noViolation(handler.P_D9());
    }

    /// @notice D10: a TargetReached close happens only inside a player purchase whose fresh, valid price
    ///         values grossTotal at or above the frozen target with at least two addresses, at a timestamp
    ///         before the cutoff, and never from a seed entry or a stale, future or invalid price.
    function invariant_D10_TargetClosesAreEarned() public view {
        _noViolation(handler.P_D10());
    }

    /// @notice D7 liveness, as SPEC §11.2 ("Stateful") budgets it: no protocol call on a target the ghost
    ///         deemed eligible ever reverted. The whole-run 20% revert ceiling is asserted in `afterInvariant`.
    /// @dev The eligible branches of closeRound, requestDraw, expireUnrequested, settle and claimRefund record
    ///      `P_LIVE` from their catch, so a bug that permanently bricks one of them for a class of rounds fails
    ///      here instead of quietly moving calls from the applied bucket to the reverted one.
    function invariant_D7_EligibleCallsNeverRevert() public view {
        _noViolation(handler.P_LIVE());
    }

    /// @notice Quote parity (SPEC §8.1, A32): a purchase that `quoteBuy` reports as admissible executes in the
    ///         same block, and every deliberately inadmissible purchase is already rejected by the preview.
    function invariant_QuoteMatchesExecution() public view {
        _noViolation(handler.P_QUOTE());
    }

    // ---------------------------------------------------------------------
    // Live checks over the contracts themselves
    // ---------------------------------------------------------------------

    /// @notice Runs the whole instant-wide checker (V1, V2 totals, V4, D1, D4, D6) against the live contracts
    ///         after every generated call, independently of the counters the handler records.
    function invariant_GlobalLedgerHoldsNow() public view {
        (uint8 property, string memory detail) = handler.checkGlobals();
        assertEq(property, 0, detail);
    }

    /// @notice Runs the full per-round checker (V5, D1, D2, D3, D5, D8, D9, D10) against one rotating round,
    ///         so every round of a sequence is re-verified from the live contracts as the campaign advances.
    function invariant_RoundSampleHoldsNow() public view {
        uint256 count = handler.ghostRoundCount();
        if (count == 0) return;
        uint256 roundId = handler.ghostRoundAt(handler.totalApplied() % count);
        (uint8 property, string memory detail) = handler.checkRound(roundId);
        assertEq(property, 0, detail);
    }

    // ---------------------------------------------------------------------
    // End of run: exhaustive sweep and the campaign record
    // ---------------------------------------------------------------------

    /// @dev Called at the end of each invariant run. Every round created during the run goes through the full
    ///      per-round checker, then the per-action-type counters are printed for the §15 campaign record.
    function afterInvariant() public view {
        uint256 count = handler.ghostRoundCount();
        for (uint256 i = 0; i < count; ++i) {
            (uint8 property, string memory detail) = handler.checkRound(handler.ghostRoundAt(i));
            assertEq(property, 0, detail);
        }
        (uint8 gp, string memory gd) = handler.checkGlobals();
        assertEq(gp, 0, gd);
        (uint8 bp, string memory bd) = handler.checkBalances();
        assertEq(bp, 0, bd);
        (uint8 rp, string memory rd) = handler.checkRequests();
        assertEq(rp, 0, rd);
        for (uint8 property = 1; property < handler.P_COUNT(); ++property) {
            _noViolation(property);
        }
        // SPEC section 11.2 budgets the deliberate-revert share over the whole run, so the 20% ceiling is
        // asserted here at the end of the sequence rather than after every call, where the first hundred
        // calls of a run are still dominated by the always-reverting probes.
        uint256 reverted = handler.totalReverted();
        uint256 calls = handler.totalApplied() + reverted;
        if (calls >= 100) assertLe(reverted * 5, calls, "D7: reverted share above 20% over the run");
        handler.report();
        handler.reportCsv();
    }

    function _noViolation(uint8 property) internal view {
        uint256 count = handler.violations(property);
        if (count != 0) {
            assertEq(count, 0, handler.firstViolation(property));
        }
    }
}
