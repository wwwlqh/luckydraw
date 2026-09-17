// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LuckyVaultBase} from "./LuckyVaultBase.t.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {ReleaseReason} from "../../src/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {
    EscrowClosed as EscrowIsClosed,
    EntryWindowClosed,
    InsufficientBalance,
    InvalidAmount,
    InvalidAsset,
    InvalidConfig,
    InvalidId,
    InvalidRecipient,
    RefundExceedsLocked,
    SeedAccountCannotBuy,
    SeedAlreadyLocked,
    SeedCapExceeded,
    SeedNotAuthorized
} from "../../src/Errors.sol";

/// @notice Round registration, escrow movement and the V5 limits against a faulty Draw
///         (A24, A38, A43, A50, A55; SPEC §4.2, §4.3, §5.4).
contract LuckyVaultEscrowTest is LuckyVaultBase {
    uint256 internal constant ROUND = 1;
    uint256 internal constant ROUND_2 = 2;
    uint64 internal closesAt;

    function setUp() public override {
        super.setUp();
        closesAt = uint64(START + DAY);
    }

    function _register(uint256 id, address asset) internal {
        drawMock.registerRound(id, asset, closesAt);
    }

    // ---- registerRound --------------------------------------------------------

    function test_RegisterRoundStoresAssetAndCutoff() public {
        vm.expectEmit(true, true, false, false, address(vault));
        emit ILuckyVault.RoundRegistered(ROUND, address(tkn));
        _register(ROUND, address(tkn));

        ILuckyVault.Escrow memory e = vault.getEscrow(ROUND);
        assertTrue(e.registered, "registered");
        assertEq(e.asset, address(tkn), "asset stored");
        assertEq(e.amount, 0, "zero escrow at registration");
        assertEq(e.closesAt, closesAt, "cutoff stored");
        assertFalse(e.closed, "not closed");
        assertFalse(e.released, "not released");
    }

    function test_RegisterRoundWorksWhileDepositsAreDisabledAndPaused() public {
        vm.startPrank(owner);
        vault.setDepositsEnabled(address(tkn), false);
        vault.setDepositsPaused(true);
        vm.stopPrank();

        _register(ROUND, address(tkn));
        assertTrue(vault.getEscrow(ROUND).registered, "registration is independent of deposit enablement");
    }

    function test_RegisterRoundGuards() public {
        vm.expectRevert(InvalidId.selector);
        drawMock.registerRound(0, address(tkn), closesAt);

        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        vm.expectRevert(InvalidAsset.selector);
        drawMock.registerRound(ROUND, address(stranger), closesAt);

        vm.expectRevert(InvalidConfig.selector);
        drawMock.registerRound(ROUND, address(tkn), uint64(block.timestamp));

        vm.expectRevert(InvalidConfig.selector);
        drawMock.registerRound(ROUND, address(tkn), uint64(block.timestamp - 1));

        _register(ROUND, address(tkn));
        vm.expectRevert(InvalidId.selector);
        drawMock.registerRound(ROUND, address(tkn), closesAt);
    }

    // ---- lock -----------------------------------------------------------------

    function test_LockMovesAvailableToEscrowExactly() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        vm.expectEmit(true, true, true, true, address(vault));
        emit ILuckyVault.FundsLocked(ROUND, alice, address(tkn), 40 ether);
        drawMock.lock(ROUND, alice, 40 ether);

        assertEq(vault.balanceOf(alice, address(tkn)), 60_000_000_000_000_000_000, "100 - 40 = 60 available");
        assertEq(vault.totalAvailable(address(tkn)), 60_000_000_000_000_000_000, "A follows the debit");
        assertEq(vault.totalEscrow(address(tkn)), 40_000_000_000_000_000_000, "E follows the credit");
        assertEq(vault.getEscrow(ROUND).amount, 40_000_000_000_000_000_000, "round escrow");
        assertEq(vault.lockedBy(ROUND, alice), 40_000_000_000_000_000_000, "lockedBy recorded");
        assertEq(tkn.balanceOf(address(vault)), 100_000_000_000_000_000_000, "no token left the Vault");

        _assertConservation(address(tkn), _holders(), _ids(ROUND), "after lock");
    }

    function test_LockAccumulatesAcrossPurchases() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.lock(ROUND, alice, 25 ether);

        assertEq(vault.lockedBy(ROUND, alice), 35_000_000_000_000_000_000, "10 + 25 = 35");
        assertEq(vault.getEscrow(ROUND).amount, 35_000_000_000_000_000_000, "escrow accumulates");
        assertEq(vault.balanceOf(alice, address(tkn)), 65_000_000_000_000_000_000, "100 - 35 = 65");
    }

    function test_LockGuards() public {
        _deposit(alice, address(tkn), 100 ether);

        vm.expectRevert(InvalidId.selector);
        drawMock.lock(ROUND, alice, 1 ether);

        _register(ROUND, address(tkn));

        vm.expectRevert(InvalidRecipient.selector);
        drawMock.lock(ROUND, address(0), 1 ether);

        vm.expectRevert(InvalidAmount.selector);
        drawMock.lock(ROUND, alice, 0);

        vm.expectRevert(InsufficientBalance.selector);
        drawMock.lock(ROUND, alice, 100 ether + 1);

        vm.expectRevert(InsufficientBalance.selector);
        drawMock.lock(ROUND, bob, 1);

        // Nothing above changed the ledger.
        assertEq(vault.balanceOf(alice, address(tkn)), 100 ether, "balance untouched by failed locks");
        assertEq(vault.totalEscrow(address(tkn)), 0, "escrow untouched by failed locks");
    }

    // ---- A43: V5 limits against a faulty Draw ---------------------------------

    function test_A43_LockAtOrAfterClosesAtReverts() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        // One second before the cutoff still works.
        vm.warp(closesAt - 1);
        drawMock.lock(ROUND, alice, 1 ether);

        // Exactly at the cutoff does not.
        vm.warp(closesAt);
        vm.expectRevert(EntryWindowClosed.selector);
        drawMock.lock(ROUND, alice, 1 ether);

        vm.warp(uint256(closesAt) + 1);
        vm.expectRevert(EntryWindowClosed.selector);
        drawMock.lock(ROUND, alice, 1 ether);

        assertEq(vault.getEscrow(ROUND).amount, 1 ether, "only the in-window lock landed");
        assertEq(vault.balanceOf(alice, address(tkn)), 99 ether, "balances unchanged by the late attempts");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "after late locks");
    }

    function test_A43_LockAfterCloseEscrowReverts() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);

        vm.expectEmit(true, false, false, false, address(vault));
        emit ILuckyVault.RoundEscrowClosed(ROUND);
        drawMock.closeEscrow(ROUND);

        assertTrue(vault.getEscrow(ROUND).closed, "closed flag set");
        assertLt(block.timestamp, closesAt, "the cutoff has not passed: only closeEscrow blocks this");

        vm.expectRevert(EscrowIsClosed.selector);
        drawMock.lock(ROUND, alice, 1 ether);

        vm.expectRevert(EscrowIsClosed.selector);
        drawMock.lockSeed(ROUND, seedSafe, 1 ether);

        assertEq(vault.getEscrow(ROUND).amount, 10 ether, "escrow unchanged");
        assertEq(vault.balanceOf(alice, address(tkn)), 90 ether, "balance unchanged");
    }

    function test_A43_DoubleCloseEscrowReverts() public {
        _register(ROUND, address(tkn));
        drawMock.closeEscrow(ROUND);
        vm.expectRevert(EscrowIsClosed.selector);
        drawMock.closeEscrow(ROUND);

        vm.expectRevert(InvalidId.selector);
        drawMock.closeEscrow(ROUND_2);
    }

    function test_A43_LockAfterFirstReleaseReverts() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.release(ROUND, alice, 4 ether, ReleaseReason.Prize);

        assertTrue(vault.getEscrow(ROUND).released, "released flag set");
        assertFalse(vault.getEscrow(ROUND).closed, "the faulty Draw never called closeEscrow");

        vm.expectRevert(EscrowIsClosed.selector);
        drawMock.lock(ROUND, alice, 1 ether);

        vm.expectRevert(EscrowIsClosed.selector);
        drawMock.lockSeed(ROUND, seedSafe, 1 ether);

        assertEq(vault.getEscrow(ROUND).amount, 6 ether, "10 - 4 remains in escrow");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "after release-then-lock attempts");
    }

    function test_A43_OverRefundReverts() public {
        _deposit(alice, address(tkn), 100 ether);
        _deposit(bob, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.lock(ROUND, bob, 30 ether);

        // Alice locked 10: refunding 10 works, one raw unit more does not.
        vm.expectRevert(RefundExceedsLocked.selector);
        drawMock.release(ROUND, alice, 10 ether + 1, ReleaseReason.Refund);

        drawMock.release(ROUND, alice, 6 ether, ReleaseReason.Refund);
        assertEq(vault.refundedTo(ROUND, alice), 6 ether, "partial refund recorded");

        vm.expectRevert(RefundExceedsLocked.selector);
        drawMock.release(ROUND, alice, 4 ether + 1, ReleaseReason.Refund);

        drawMock.release(ROUND, alice, 4 ether, ReleaseReason.Refund);
        assertEq(vault.refundedTo(ROUND, alice), 10 ether, "exactly what she locked");

        vm.expectRevert(RefundExceedsLocked.selector);
        drawMock.release(ROUND, alice, 1, ReleaseReason.Refund);

        // Bob's allowance is untouched by Alice's refunds.
        assertEq(vault.balanceOf(alice, address(tkn)), 100 ether, "90 available + 10 refunded");
        assertEq(vault.getEscrow(ROUND).amount, 30 ether, "bob's gross still escrowed");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "after refunds");
    }

    function test_A43_RefundCannotBorrowAnotherBuyersLock() public {
        _deposit(alice, address(tkn), 100 ether);
        _deposit(bob, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.lock(ROUND, bob, 30 ether);

        // Carol locked nothing in this round, so no Refund release can name her.
        vm.expectRevert(RefundExceedsLocked.selector);
        drawMock.release(ROUND, carol, 1, ReleaseReason.Refund);
        assertEq(vault.balanceOf(carol, address(tkn)), 0, "carol credited nothing");
    }

    function test_A49_RefundCreditsOnlyTheNamedRecipientAndNeverTheCaller() public {
        _deposit(alice, address(tkn), 100 ether);
        _deposit(bob, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.lock(ROUND, bob, 30 ether);

        // The Draw is the caller; the credit must land on the named buyer only.
        drawMock.release(ROUND, alice, 10 ether, ReleaseReason.Refund);

        assertEq(vault.balanceOf(alice, address(tkn)), 100 ether, "the named buyer is made whole");
        assertEq(vault.balanceOf(bob, address(tkn)), 70 ether, "the other buyer is untouched");
        assertEq(vault.balanceOf(address(drawMock), address(tkn)), 0, "the caller receives nothing");
        assertEq(tkn.balanceOf(address(drawMock)), 0, "and holds no tokens either");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "third-party refund");
    }

    function test_ReleaseCannotSpendAnotherRoundsEscrow() public {
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        _register(ROUND_2, address(tkn));
        drawMock.lock(ROUND, alice, 40 ether);
        drawMock.lock(ROUND_2, alice, 5 ether);

        assertEq(vault.totalEscrow(address(tkn)), 45 ether, "combined escrow");

        // Round 2 holds only 5: a 6 release fails even though the asset total is 45 (V2).
        vm.expectRevert(InsufficientBalance.selector);
        drawMock.release(ROUND_2, alice, 6 ether, ReleaseReason.Prize);

        drawMock.release(ROUND_2, alice, 5 ether, ReleaseReason.Prize);
        assertEq(vault.getEscrow(ROUND).amount, 40 ether, "round 1 untouched");
        assertEq(vault.totalEscrow(address(tkn)), 40 ether, "E reduced by exactly round 2's escrow");
        _assertConservation(address(tkn), _holders(), _ids(ROUND, ROUND_2), "cross-round isolation");
    }

    function test_ReleaseGuards() public {
        _deposit(alice, address(tkn), 100 ether);

        vm.expectRevert(InvalidId.selector);
        drawMock.release(ROUND, alice, 1, ReleaseReason.Prize);

        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);

        vm.expectRevert(InvalidRecipient.selector);
        drawMock.release(ROUND, address(0), 1, ReleaseReason.Prize);

        // A faulty Draw must not strand funds in the Vault or credit the Draw itself.
        vm.expectRevert(InvalidRecipient.selector);
        drawMock.release(ROUND, address(vault), 1, ReleaseReason.Prize);
        vm.expectRevert(InvalidRecipient.selector);
        drawMock.release(ROUND, address(drawMock), 1, ReleaseReason.Prize);

        vm.expectRevert(InvalidAmount.selector);
        drawMock.release(ROUND, alice, 0, ReleaseReason.Prize);

        vm.expectRevert(InsufficientBalance.selector);
        drawMock.release(ROUND, alice, 10 ether + 1, ReleaseReason.Prize);
    }

    // ---- A24 / A38: settlement credits ---------------------------------------

    function test_A24_WinnerEqualsFeeAccountAndTotalsReconcile() public {
        _deposit(feeAccount, address(tkn), 100 ether);
        _deposit(bob, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        // Gross 40: feeReserved = floor(40e18 * 300 / 10000) = 1.2e18, prizePot = 38.8e18 (SPEC §5.2).
        drawMock.lock(ROUND, feeAccount, 10 ether);
        drawMock.lock(ROUND, bob, 30 ether);
        assertEq(vault.getEscrow(ROUND).amount, 40_000_000_000_000_000_000, "gross escrowed");

        uint256 feeAccountAvailableBefore = vault.balanceOf(feeAccount, address(tkn));
        assertEq(feeAccountAvailableBefore, 90_000_000_000_000_000_000, "100 deposited - 10 locked");

        drawMock.release(ROUND, feeAccount, 38_800_000_000_000_000_000, ReleaseReason.Prize);
        drawMock.release(ROUND, feeAccount, 1_200_000_000_000_000_000, ReleaseReason.Fee);

        assertEq(
            vault.balanceOf(feeAccount, address(tkn)),
            90_000_000_000_000_000_000 + 40_000_000_000_000_000_000,
            "both credits arrive and sum to the round gross"
        );
        assertEq(vault.getEscrow(ROUND).amount, 0, "escrow is empty");
        assertEq(vault.totalEscrow(address(tkn)), 0, "E is zero");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "winner equals fee account");
    }

    function test_A38_CreditsChangeOnlyVaultBalances() public {
        _deposit(alice, address(tkn), 100 ether);
        _deposit(bob, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lock(ROUND, alice, 10 ether);
        drawMock.lock(ROUND, bob, 30 ether);

        uint256 vaultTokensBefore = tkn.balanceOf(address(vault));
        uint256 aliceWalletBefore = tkn.balanceOf(alice);
        uint256 feeWalletBefore = tkn.balanceOf(feeAccount);
        uint256 drawAllowance = tkn.allowance(alice, address(drawMock));

        drawMock.release(ROUND, alice, 38_800_000_000_000_000_000, ReleaseReason.Prize);
        drawMock.release(ROUND, feeAccount, 1_200_000_000_000_000_000, ReleaseReason.Fee);

        assertEq(tkn.balanceOf(address(vault)), vaultTokensBefore, "no token moved out of the Vault");
        assertEq(tkn.balanceOf(alice), aliceWalletBefore, "the winner's wallet is unchanged");
        assertEq(tkn.balanceOf(feeAccount), feeWalletBefore, "the fee wallet is unchanged");
        assertEq(tkn.allowance(alice, address(drawMock)), drawAllowance, "no allowance to Draw is created");
        assertEq(drawAllowance, 0, "and none existed to begin with");

        // The credits are real: the winner can withdraw them.
        assertEq(vault.balanceOf(alice, address(tkn)), 128_800_000_000_000_000_000, "90 + 38.8");
        _withdraw(alice, address(tkn), 128_800_000_000_000_000_000);
        assertEq(tkn.balanceOf(alice), aliceWalletBefore + 128_800_000_000_000_000_000, "withdrawal moves tokens");
    }

    // ---- Seed path: A50, A55, SPEC §5.4 --------------------------------------

    // ---- Per-asset seed consent (SPEC §5.4, D9) -----------------------------

    function test_A55_SeedConsentIsPerAssetAndNeverCrossesAssets() public {
        // The Safe consents for the 18-decimal token only.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _deposit(seedSafe, address(tkn6), 1_000e6);
        _register(ROUND, address(tkn));
        _register(ROUND_2, address(tkn6));

        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn)), 5 ether, "consent recorded for TKN");
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn6)), 0, "and for nothing else");
        assertEq(vault.seedMaxPerRound(seedSafe, NATIVE), 0, "not for native either");

        // A round in another asset is refused outright, however small the amount.
        vm.expectRevert(SeedNotAuthorized.selector);
        drawMock.lockSeed(ROUND_2, seedSafe, 1);
        assertEq(vault.balanceOf(seedSafe, address(tkn6)), 1_000e6, "no debit in the unauthorized asset");

        // The authorized asset still seeds normally.
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 95 ether, "the authorized asset is debited");

        // Consent for the second asset is a second, separately sized decision.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn6), 5e6);
        drawMock.lockSeed(ROUND_2, seedSafe, 5e6);
        assertEq(vault.balanceOf(seedSafe, address(tkn6)), 995e6, "5.000000 SIX seeded");

        // Revoking one asset leaves the other untouched.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 0);
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn)), 0, "TKN revoked");
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn6)), 5e6, "SIX consent survives");
    }

    /// @dev The reviewed drain: a raw-unit cap sized for an 18-decimal asset used to be unlimited consent in
    ///      a low-decimal pool, so one `seedRound` could take the Safe's whole SIX balance (SPEC §5.4).
    function test_A55_AnEighteenDecimalCapIsNotConsentInASixDecimalPool() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether); // 5e18 raw units, sized for TKN
        _deposit(seedSafe, address(tkn6), 1_000_000e6); // the Safe's whole SIX float
        _register(ROUND, address(tkn6));

        // A compromised owner points the SIX pool's seedAmount at the entire balance. 1e12 raw SIX is far
        // below the 5e18 cap, so the old shared cap would have allowed it.
        vm.expectRevert(SeedNotAuthorized.selector);
        drawMock.lockSeed(ROUND, seedSafe, 1_000_000e6);
        assertEq(vault.balanceOf(seedSafe, address(tkn6)), 1_000_000e6, "the float is intact");
        assertEq(vault.getEscrow(ROUND).amount, 0, "nothing reached escrow");

        // Even after a deliberate SIX consent, the drain is bounded by the SIX-denominated cap.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn6), 5e6);
        vm.expectRevert(SeedCapExceeded.selector);
        drawMock.lockSeed(ROUND, seedSafe, 1_000_000e6);
        drawMock.lockSeed(ROUND, seedSafe, 5e6);
        assertEq(vault.balanceOf(seedSafe, address(tkn6)), 999_995e6, "one capped debit, not the float");
        _assertConservation(address(tkn6), _holders(), _ids(ROUND), "per-asset cap held");
    }

    function test_A50_APerAssetCapBelowTheSeedAmountRevertsSeedCapExceeded() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn6), 5e6);
        _deposit(seedSafe, address(tkn6), 1_000e6);
        _register(ROUND, address(tkn6));

        vm.expectRevert(SeedCapExceeded.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5e6 + 1);
        drawMock.lockSeed(ROUND, seedSafe, 5e6);
        assertEq(vault.seedLocked(ROUND, seedSafe), 5e6, "the cap is inclusive per asset");
    }

    function test_A50_AConsentingAccountMayStillBuyInAnotherAsset() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _deposit(seedSafe, address(tkn6), 1_000e6);
        _register(ROUND, address(tkn));
        _register(ROUND_2, address(tkn6));

        // Blocked in the asset it consented to ...
        vm.expectRevert(SeedAccountCannotBuy.selector);
        drawMock.lock(ROUND, seedSafe, 1 ether);

        // ... and an ordinary player everywhere else.
        drawMock.lock(ROUND_2, seedSafe, 10e6);
        assertEq(vault.balanceOf(seedSafe, address(tkn6)), 990e6, "the player path works in SIX");
        assertEq(vault.lockedBy(ROUND_2, seedSafe), 10e6, "recorded as an ordinary entry");
    }

    function test_AuthorizeSeedOnAnUnlistedAssetReverts() public {
        address unlisted = makeAddr("unlisted");
        vm.prank(seedSafe);
        vm.expectRevert(InvalidAsset.selector);
        vault.authorizeSeed(unlisted, 5 ether);
        assertEq(vault.seedMaxPerRound(seedSafe, unlisted), 0, "nothing recorded");

        // Revoking an asset that was never listed is refused for the same reason.
        vm.prank(seedSafe);
        vm.expectRevert(InvalidAsset.selector);
        vault.authorizeSeed(unlisted, 0);
    }

    function test_SeedAuthorizedCarriesTheAssetItCovers() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit ILuckyVault.SeedAuthorized(seedSafe, address(tkn6), 0, 5e6);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn6), 5e6);

        vm.expectEmit(true, true, false, true, address(vault));
        emit ILuckyVault.SeedAuthorized(seedSafe, address(tkn6), 5e6, 7e6);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn6), 7e6);
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn6)), 7e6, "raised in place");
    }

    function test_LockSeedHappyPathRecordsCapUsage() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        vm.expectEmit(true, true, true, true, address(vault));
        emit ILuckyVault.FundsLocked(ROUND, seedSafe, address(tkn), 5 ether);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);

        assertEq(vault.seedLocked(ROUND, seedSafe), 5_000_000_000_000_000_000, "seedLocked recorded");
        assertEq(vault.lockedBy(ROUND, seedSafe), 5_000_000_000_000_000_000, "lockedBy recorded too");
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 95_000_000_000_000_000_000, "100 - 5 = 95");
        assertEq(vault.getEscrow(ROUND).amount, 5_000_000_000_000_000_000, "escrow holds the seed");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "after lockSeed");
    }

    function test_A50_LockSeedTwiceInOneRoundReverts() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        vm.expectRevert(SeedAlreadyLocked.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        vm.expectRevert(SeedAlreadyLocked.selector);
        drawMock.lockSeed(ROUND, seedSafe, 1);

        assertEq(vault.balanceOf(seedSafe, address(tkn)), 95 ether, "exposure is one capped debit per round");

        // A different round may still seed, up to the same cap.
        _register(ROUND_2, address(tkn));
        drawMock.lockSeed(ROUND_2, seedSafe, 5 ether);
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 90 ether, "one debit per round, not per call");
        _assertConservation(address(tkn), _holders(), _ids(ROUND, ROUND_2), "two seeded rounds");
    }

    function test_A50_LockSeedAboveTheAuthorizedCapReverts() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        vm.expectRevert(SeedCapExceeded.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether + 1);

        vm.expectRevert(InvalidAmount.selector);
        drawMock.lockSeed(ROUND, seedSafe, 0);

        // Exactly the cap is allowed.
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        assertEq(vault.seedLocked(ROUND, seedSafe), 5 ether, "the cap is inclusive");
    }

    function test_A55_LockSeedForAnAccountThatNeverAuthorizedReverts() public {
        // The owner may point Draw anywhere; pointing is not consent (SPEC §5.4).
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        assertEq(vault.seedMaxPerRound(alice, address(tkn)), 0, "an ordinary depositor has no authorization");
        vm.expectRevert(SeedNotAuthorized.selector);
        drawMock.lockSeed(ROUND, alice, 1);

        vm.expectRevert(SeedNotAuthorized.selector);
        drawMock.lockSeed(ROUND, address(0), 1);

        assertEq(vault.balanceOf(alice, address(tkn)), 100 ether, "the depositor's balance is untouched");
        assertEq(vault.totalEscrow(address(tkn)), 0, "no debit occurred");
    }

    function test_A55_RevokingTheCapStopsFurtherSeeding() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        _register(ROUND_2, address(tkn));

        drawMock.lockSeed(ROUND, seedSafe, 5 ether);

        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 0);

        vm.expectRevert(SeedNotAuthorized.selector);
        drawMock.lockSeed(ROUND_2, seedSafe, 5 ether);
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 95 ether, "no further debit after revocation");
    }

    function test_A50_PlayerPathCannotDebitAnAuthorizedSeedAccount() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        vm.expectRevert(SeedAccountCannotBuy.selector);
        drawMock.lock(ROUND, seedSafe, 1);

        vm.expectRevert(SeedAccountCannotBuy.selector);
        drawMock.lock(ROUND, seedSafe, 100 ether);

        assertEq(vault.balanceOf(seedSafe, address(tkn)), 100 ether, "untouched by the player path");

        // Revoking restores the ordinary player path.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 0);
        drawMock.lock(ROUND, seedSafe, 1 ether);
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 99 ether, "ordinary lock works once unauthorized");
    }

    function test_A50_LockSeedAfterCutoffReverts() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));

        vm.warp(closesAt);
        vm.expectRevert(EntryWindowClosed.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);

        vm.warp(uint256(closesAt) + 1000);
        vm.expectRevert(EntryWindowClosed.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);

        assertEq(vault.balanceOf(seedSafe, address(tkn)), 100 ether, "balance unchanged");
    }

    function test_A50_LockSeedOnAnUnregisteredRoundReverts() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);

        vm.expectRevert(InvalidId.selector);
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
    }

    function test_A50_LockSeedWithoutFundsReverts() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 50 ether);
        _deposit(seedSafe, address(tkn), 10 ether);
        _register(ROUND, address(tkn));

        vm.expectRevert(InsufficientBalance.selector);
        drawMock.lockSeed(ROUND, seedSafe, 50 ether);
        assertEq(vault.seedLocked(ROUND, seedSafe), 0, "a failed seed leaves no record");
    }

    function test_SeedReturnOnAVoidRoundIsARefund() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);

        // A seed-only round closes Void and returns exactly the seed gross (SPEC §5.4, D9).
        drawMock.closeEscrow(ROUND);
        drawMock.release(ROUND, seedSafe, 5 ether, ReleaseReason.Refund);

        assertEq(vault.balanceOf(seedSafe, address(tkn)), 100_000_000_000_000_000_000, "seed fully returned");
        assertEq(vault.getEscrow(ROUND).amount, 0, "escrow empty");

        // And not a wei more: the escrow is empty, so the amount check fires first.
        vm.expectRevert(InsufficientBalance.selector);
        drawMock.release(ROUND, seedSafe, 1, ReleaseReason.Refund);
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "void round returned");
    }

    function test_SeedRefundIsCappedByWhatTheSeedLocked() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 100 ether);
        _deposit(alice, address(tkn), 100 ether);
        _register(ROUND, address(tkn));
        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        drawMock.lock(ROUND, alice, 30 ether);

        // 35 sits in escrow, but the seed only locked 5: a 6 refund is refused on the per-user limit.
        assertEq(vault.getEscrow(ROUND).amount, 35 ether, "combined escrow");
        vm.expectRevert(RefundExceedsLocked.selector);
        drawMock.release(ROUND, seedSafe, 5 ether + 1, ReleaseReason.Refund);

        drawMock.release(ROUND, seedSafe, 5 ether, ReleaseReason.Refund);
        assertEq(vault.balanceOf(seedSafe, address(tkn)), 100 ether, "exactly the seed back");
        assertEq(vault.getEscrow(ROUND).amount, 30 ether, "alice's gross is untouched");
        _assertConservation(address(tkn), _holders(), _ids(ROUND), "seed refund capped");
    }

    // ---- Native escrow --------------------------------------------------------

    function test_NativeEscrowRoundTrip() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        _register(ROUND, NATIVE);

        drawMock.lock(ROUND, alice, 2 ether);
        drawMock.lock(ROUND, bob, 8 ether);
        assertEq(vault.totalEscrow(NATIVE), 10 ether, "escrow in native units");
        assertEq(address(vault).balance, 20 ether, "no BNB left the Vault during escrow");

        // Gross 10: fee = 0.3, prize = 9.7.
        drawMock.release(ROUND, bob, 9_700_000_000_000_000_000, ReleaseReason.Prize);
        drawMock.release(ROUND, feeAccount, 300_000_000_000_000_000, ReleaseReason.Fee);

        assertEq(vault.balanceOf(bob, NATIVE), 11_700_000_000_000_000_000, "2 available + 9.7 prize");
        assertEq(vault.balanceOf(feeAccount, NATIVE), 300_000_000_000_000_000, "fee credited");
        assertEq(vault.totalEscrow(NATIVE), 0, "escrow empty");
        _assertConservation(NATIVE, _holders(), _ids(ROUND), "native settlement");

        uint256 bobWallet = bob.balance;
        _withdraw(bob, NATIVE, 11_700_000_000_000_000_000);
        assertEq(bob.balance, bobWallet + 11_700_000_000_000_000_000, "credits are withdrawable");
        assertEq(address(vault).balance, 8_300_000_000_000_000_000, "20 - 11.7");
    }
}
