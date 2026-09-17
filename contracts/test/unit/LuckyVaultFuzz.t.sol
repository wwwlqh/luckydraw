// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LuckyVaultBase} from "./LuckyVaultBase.t.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {ReleaseReason} from "../../src/Types.sol";

/// @notice Randomised deposit/lock/release/withdraw sequences checked against an independent ghost ledger
///         (SPEC §4.3 V1 and V2). The ghost is only advanced when the Vault call actually succeeds, so a
///         reverted action must leave every tracked number exactly where it was.
contract LuckyVaultFuzzTest is LuckyVaultBase {
    uint256 internal constant ACTIONS = 24;

    address[3] internal actors;
    address[2] internal assets;
    uint256[2] internal rounds;

    // Ghost ledger, maintained independently of the contract.
    mapping(address user => mapping(address asset => uint256 amount)) internal gBalance;
    mapping(address asset => uint256 amount) internal gAvailable;
    mapping(address asset => uint256 amount) internal gEscrow;
    mapping(uint256 roundId => uint256 amount) internal gRoundEscrow;

    uint256 internal appliedActions;
    uint256 internal revertedActions;

    function setUp() public override {
        super.setUp();

        actors = [alice, bob, carol];
        assets = [NATIVE, address(tkn)];
        rounds = [uint256(1), uint256(2)];

        // Round 1 escrows native, round 2 escrows the token. Both close far beyond the fuzz horizon; the
        // cutoff rule itself is covered by the deterministic V5 suite.
        drawMock.registerRound(rounds[0], assets[0], uint64(START + 3650 days));
        drawMock.registerRound(rounds[1], assets[1], uint64(START + 3650 days));

        vm.deal(address(this), 1_000_000 ether);

        // Prefund the ghost through the ordinary deposit path so later locks, releases and withdrawals have
        // material to move; these are not counted as fuzz actions.
        for (uint256 u = 0; u < actors.length; u++) {
            for (uint256 a = 0; a < assets.length; a++) {
                _stepDeposit(actors[u], assets[a], 50 ether);
            }
        }
        appliedActions = 0;
        revertedActions = 0;
    }

    function testFuzz_GhostLedgerPreservesV1AndV2(uint256 seed) public {
        for (uint256 i = 0; i < ACTIONS; i++) {
            // The first two steps are fixed deposits so every run exercises the Vault regardless of seed.
            if (i < 2) {
                _stepDeposit(actors[i], assets[i], 5 ether);
            } else {
                _step(uint256(keccak256(abi.encode(seed, i))));
            }
            _assertGhost(i);
        }

        assertGe(appliedActions, 2, "the campaign actually mutated the Vault");
        assertEq(appliedActions + revertedActions, ACTIONS, "every action is accounted for");
    }

    function _step(uint256 r) internal {
        uint256 kind = _kind(r % 20);
        address actor = actors[(r >> 8) % 3];
        uint256 roundIndex = (r >> 16) % 2;
        uint256 roundId = rounds[roundIndex];
        address asset = assets[roundIndex];
        uint256 amount = ((r >> 24) % 51) * 1e17; // 0 .. 5.0 in 0.1 steps, including the zero case
        // Most actions are steered into a satisfiable range so the sequence reaches deep states; the rest
        // stay unconstrained so guard rejections are exercised too.
        bool preferValid = ((r >> 48) % 8) != 0;
        if (preferValid && amount == 0) amount = 1e17;

        address freeAsset = assets[(r >> 32) % 2];

        if (kind == 0) {
            _stepDeposit(actor, freeAsset, amount);
        } else if (kind == 1) {
            _stepWithdraw(actor, freeAsset, _sized(amount, vault.balanceOf(actor, freeAsset), preferValid));
        } else if (kind == 2) {
            _stepLock(roundId, asset, actor, _sized(amount, vault.balanceOf(actor, asset), preferValid));
        } else if (kind == 3) {
            ReleaseReason reason = ReleaseReason(uint8((r >> 40) % 3));
            uint256 cap = vault.getEscrow(roundId).amount;
            if (reason == ReleaseReason.Refund) {
                uint256 headroom = vault.lockedBy(roundId, actor) - vault.refundedTo(roundId, actor);
                if (headroom < cap) cap = headroom;
            }
            _stepRelease(roundId, asset, actor, _sized(amount, cap, preferValid), reason);
        } else {
            _stepClose(roundId);
        }
    }

    /// @dev Action mix: deposits and locks dominate so sequences reach deep states; `closeEscrow` is rare
    ///      because a round can only be closed once.
    function _kind(uint256 roll) internal pure returns (uint256) {
        if (roll < 6) return 0; // deposit
        if (roll < 10) return 1; // withdraw
        if (roll < 15) return 2; // lock
        if (roll < 19) return 3; // release
        return 4; // closeEscrow
    }

    /// @dev Squeezes a random amount into [1, cap] when `preferValid`, otherwise leaves it alone.
    function _sized(uint256 amount, uint256 cap, bool preferValid) internal pure returns (uint256) {
        if (!preferValid || cap == 0) return amount;
        return 1 + (amount % cap);
    }

    function _stepDeposit(address actor, address asset, uint256 amount) internal {
        if (asset == NATIVE) {
            vm.deal(actor, actor.balance + amount);
            vm.prank(actor);
            try vault.depositNative{value: amount}() {
                gBalance[actor][asset] += amount;
                gAvailable[asset] += amount;
                appliedActions++;
            } catch {
                revertedActions++;
            }
        } else {
            vm.prank(actor);
            try vault.deposit(asset, amount) {
                gBalance[actor][asset] += amount;
                gAvailable[asset] += amount;
                appliedActions++;
            } catch {
                revertedActions++;
            }
        }
    }

    function _stepWithdraw(address actor, address asset, uint256 amount) internal {
        vm.prank(actor);
        try vault.withdraw(asset, amount) {
            gBalance[actor][asset] -= amount;
            gAvailable[asset] -= amount;
            appliedActions++;
        } catch {
            revertedActions++;
        }
    }

    function _stepLock(uint256 roundId, address asset, address actor, uint256 amount) internal {
        vm.prank(address(drawMock));
        try vault.lock(roundId, actor, amount) {
            gBalance[actor][asset] -= amount;
            gAvailable[asset] -= amount;
            gEscrow[asset] += amount;
            gRoundEscrow[roundId] += amount;
            appliedActions++;
        } catch {
            revertedActions++;
        }
    }

    function _stepRelease(uint256 roundId, address asset, address actor, uint256 amount, ReleaseReason reason)
        internal
    {
        vm.prank(address(drawMock));
        try vault.release(roundId, actor, amount, reason) {
            gBalance[actor][asset] += amount;
            gAvailable[asset] += amount;
            gEscrow[asset] -= amount;
            gRoundEscrow[roundId] -= amount;
            appliedActions++;
        } catch {
            revertedActions++;
        }
    }

    function _stepClose(uint256 roundId) internal {
        vm.prank(address(drawMock));
        try vault.closeEscrow(roundId) {
            appliedActions++;
        } catch {
            revertedActions++;
        }
    }

    function _assertGhost(uint256 step) internal view {
        string memory at = string.concat("step ", vm.toString(step), ": ");

        for (uint256 a = 0; a < assets.length; a++) {
            address asset = assets[a];

            // V2: A equals the sum of user balances, E equals the sum of registered escrows.
            uint256 summed;
            for (uint256 u = 0; u < actors.length; u++) {
                assertEq(vault.balanceOf(actors[u], asset), gBalance[actors[u]][asset], string.concat(at, "balance"));
                summed += vault.balanceOf(actors[u], asset);
            }
            assertEq(vault.totalAvailable(asset), gAvailable[asset], string.concat(at, "A matches the ghost"));
            assertEq(vault.totalAvailable(asset), summed, string.concat(at, "V2: A == sum(balances)"));

            uint256 summedEscrow;
            for (uint256 i = 0; i < rounds.length; i++) {
                ILuckyVault.Escrow memory e = vault.getEscrow(rounds[i]);
                if (e.asset == asset) {
                    assertEq(e.amount, gRoundEscrow[rounds[i]], string.concat(at, "round escrow"));
                    summedEscrow += e.amount;
                }
            }
            assertEq(vault.totalEscrow(asset), gEscrow[asset], string.concat(at, "E matches the ghost"));
            assertEq(vault.totalEscrow(asset), summedEscrow, string.concat(at, "V2: E == sum(escrows)"));

            // V1: custody covers the ledger. No donations occur here, so it holds with equality.
            assertEq(
                _vaultBalance(asset),
                vault.totalAvailable(asset) + vault.totalEscrow(asset),
                string.concat(at, "V1: B == A+E with no surplus")
            );
        }
    }
}
